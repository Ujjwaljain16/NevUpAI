import { PoolClient } from "pg";
import { logger } from "../infra/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ClosedTrade = {
  trade_id: string;
  user_id: string;
  session_id: string;
  entry_price: string;
  exit_price: string | null;
  quantity: string;
  exit_at: string | null;
  status: string;
  emotional_state: string | null;
  plan_adherence: number | null;
  outcome: "win" | "loss" | null;
  pnl: string | null;
};

// ---------------------------------------------------------------------------
// Win Rate by Emotion — Full recompute (DELETE + INSERT)
// ---------------------------------------------------------------------------

export async function computeWinRateByEmotion(
  client: PoolClient,
  userId: string,
  traceId: string,
): Promise<void> {
  // Delete existing rows for this user — guarantees idempotency
  await client.query("DELETE FROM win_rate_by_emotion WHERE user_id = $1", [userId]);

  // Recompute from DB snapshot: all closed trades with emotional_state
  await client.query(
    `
    INSERT INTO win_rate_by_emotion (user_id, emotional_state, wins, losses, updated_at)
    SELECT
      user_id,
      emotional_state,
      COUNT(*) FILTER (WHERE outcome = 'win'),
      COUNT(*) FILTER (WHERE outcome = 'loss'),
      NOW()
    FROM trades
    WHERE user_id = $1
      AND status = 'closed'
      AND emotional_state IS NOT NULL
    GROUP BY user_id, emotional_state
    `,
    [userId],
  );

  logger.info({ event: "METRIC_UPDATED", metric: "winRateByEmotion", userId, traceId });
}

// ---------------------------------------------------------------------------
// Plan Adherence — Latest snapshot per user (UPSERT)
// ---------------------------------------------------------------------------

export async function computePlanAdherence(
  client: PoolClient,
  userId: string,
  traceId: string,
): Promise<void> {
  const result = await client.query<{ avg_score: string }>(
    `
    SELECT AVG(plan_adherence)::NUMERIC(8,4) AS avg_score
    FROM (
      SELECT plan_adherence
      FROM trades
      WHERE user_id = $1
        AND status = 'closed'
        AND plan_adherence IS NOT NULL
      ORDER BY exit_at DESC NULLS LAST
      LIMIT 10
    ) AS recent
    `,
    [userId],
  );

  const avgScore = result.rows[0]?.avg_score;
  if (avgScore === null || avgScore === undefined) {
    return; // No trades with plan_adherence data
  }

  // UPSERT: keep latest per user, avoid unbounded growth
  await client.query(
    `
    INSERT INTO plan_adherence_scores (user_id, calculated_at, score)
    VALUES ($1, NOW(), $2)
    ON CONFLICT (user_id, calculated_at) DO UPDATE SET score = EXCLUDED.score
    `,
    [userId, avgScore],
  );

  logger.info({ event: "METRIC_UPDATED", metric: "planAdherence", userId, score: avgScore, traceId });
}

// ---------------------------------------------------------------------------
// Session Tilt — Ratio of losses to total trades in session
// ---------------------------------------------------------------------------

export async function computeSessionTilt(
  client: PoolClient,
  userId: string,
  sessionId: string,
  traceId: string,
): Promise<void> {
  const result = await client.query<{ total: string; loss_following: string }>(
    `
    WITH ordered AS (
      SELECT
        trade_id,
        outcome,
        LAG(outcome) OVER (ORDER BY entry_at) AS prev_outcome
      FROM trades
      WHERE user_id = $1
        AND session_id = $2
        AND status = 'closed'
    )
    SELECT
      COUNT(*)::INTEGER AS total,
      COUNT(*) FILTER (WHERE prev_outcome = 'loss')::INTEGER AS loss_following
    FROM ordered
    `,
    [userId, sessionId],
  );

  const total = Number(result.rows[0]?.total ?? 0);
  const lossFollowing = Number(result.rows[0]?.loss_following ?? 0);

  if (total === 0) {
    return;
  }

  const tiltIndex = Number((lossFollowing / total).toFixed(4));

  await client.query(
    `
    INSERT INTO session_tilt (user_id, session_id, tilt_index, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (user_id, session_id)
    DO UPDATE SET tilt_index = EXCLUDED.tilt_index, updated_at = NOW()
    `,
    [userId, sessionId, tiltIndex],
  );

  logger.info({ event: "METRIC_UPDATED", metric: "sessionTilt", userId, sessionId, tiltIndex, traceId });
}

// ---------------------------------------------------------------------------
// Revenge Trade Flagging — 90s window + emotion check
// ---------------------------------------------------------------------------

export async function computeRevengeFlag(
  client: PoolClient,
  userId: string,
  tradeId: string,
  traceId: string,
): Promise<void> {
  // Find if this trade was opened within 90s of a losing close
  const result = await client.query<{ revenge_flag: boolean }>(
    `
    WITH current_trade AS (
      SELECT entry_at, emotional_state FROM trades WHERE trade_id = $1
    ),
    previous_loss AS (
      SELECT trade_id
      FROM trades t, current_trade c
      WHERE t.user_id = $2
        AND t.outcome = 'loss'
        AND t.exit_at BETWEEN c.entry_at - INTERVAL '90 seconds' AND c.entry_at
        AND c.emotional_state IN ('anxious', 'fearful')
      LIMIT 1
    )
    UPDATE trades
    SET revenge_flag = EXISTS (SELECT 1 FROM previous_loss)
    WHERE trade_id = $1
    RETURNING revenge_flag
    `,
    [tradeId, userId],
  );

  const isRevenge = result.rows[0]?.revenge_flag ?? false;
  if (isRevenge) {
    logger.info({ event: "METRIC_UPDATED", metric: "revengeFlagDetected", userId, tradeId, traceId });
  }
}

// ---------------------------------------------------------------------------
// Overtrading Detection — 30-min sliding window
// ---------------------------------------------------------------------------

export async function detectOvertrading(
  client: PoolClient,
  userId: string,
  sessionId: string,
  traceId: string,
): Promise<void> {
  const WINDOW_MINUTES = 30;
  const THRESHOLD = 10;

  // Find trade clusters within 30-min windows in this session (SLIDING WINDOW)
  const result = await client.query<{ window_start: string; trade_count: string }>(
    `
    SELECT
      t1.entry_at AS window_start,
      COUNT(t2.trade_id)::INTEGER AS trade_count
    FROM trades t1
    JOIN trades t2 ON t1.user_id = t2.user_id
      AND t2.entry_at BETWEEN t1.entry_at AND t1.entry_at + INTERVAL '30 minutes'
    WHERE t1.user_id = $1
      AND t1.session_id = $2
      AND t1.status = 'closed'
      AND t2.status = 'closed'
    GROUP BY t1.trade_id, t1.entry_at
    HAVING COUNT(t2.trade_id) >= $3
    ORDER BY t1.entry_at ASC
    `,
    [userId, sessionId, THRESHOLD],
  );

  const redis = require("../infra/redis/client").getRedis();
  const { TRADE_EVENTS_STREAM } = require("../infra/redis/client");

  for (const row of result.rows) {
    // Idempotent insert: unique per (user, session, window_start)
    const insertResult = await client.query(
      `
      INSERT INTO overtrading_events (event_id, user_id, session_id, detected_at, trade_count, window_minutes)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
      RETURNING event_id
      `,
      [userId, sessionId, row.window_start, Number(row.trade_count), WINDOW_MINUTES],
    );

    if (insertResult.rowCount === 1) {
      // Emit to event bus as required by spec
      await redis.xadd(
        TRADE_EVENTS_STREAM,
        "*",
        "eventId", insertResult.rows[0].event_id,
        "type", "SYSTEM_ALERT_OVERTRADING",
        "userId", userId,
        "sessionId", sessionId,
        "detectedAt", row.window_start,
        "tradeCount", row.trade_count,
        "traceId", traceId,
      );
    }
  }

  if (result.rows.length > 0) {
    logger.info({
      event: "METRIC_UPDATED",
      metric: "overtradingDetection",
      userId,
      sessionId,
      windowsDetected: result.rows.length,
      traceId,
    });
  }
}
