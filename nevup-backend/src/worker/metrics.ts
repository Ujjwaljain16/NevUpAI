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
  entry_at: string;
  exit_at: string | null;
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
    FROM trades
    WHERE user_id = $1
      AND status = 'closed'
      AND plan_adherence IS NOT NULL
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
  const result = await client.query<{ total: string; losses: string }>(
    `
    SELECT
      COUNT(*)::INTEGER AS total,
      COUNT(*) FILTER (WHERE outcome = 'loss')::INTEGER AS losses
    FROM trades
    WHERE user_id = $1
      AND session_id = $2
      AND status = 'closed'
    `,
    [userId, sessionId],
  );

  const total = Number(result.rows[0]?.total ?? 0);
  const losses = Number(result.rows[0]?.losses ?? 0);

  if (total === 0) {
    return;
  }

  const tiltIndex = Number((losses / total).toFixed(4));

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
// Overtrading Detection — 30-min sliding window
// ---------------------------------------------------------------------------

export async function detectOvertrading(
  client: PoolClient,
  userId: string,
  sessionId: string,
  traceId: string,
): Promise<void> {
  const WINDOW_MINUTES = 30;
  const THRESHOLD = 5;

  // Find trade clusters within 30-min windows in this session
  const result = await client.query<{ window_start: string; trade_count: string }>(
    `
    SELECT
      date_trunc('hour', entry_at) + INTERVAL '30 min' * FLOOR(EXTRACT(MINUTE FROM entry_at) / 30) AS window_start,
      COUNT(*)::INTEGER AS trade_count
    FROM trades
    WHERE user_id = $1
      AND session_id = $2
      AND status = 'closed'
    GROUP BY window_start
    HAVING COUNT(*) >= $3
    `,
    [userId, sessionId, THRESHOLD],
  );

  for (const row of result.rows) {
    // Idempotent insert: unique per (user, session, window_start)
    await client.query(
      `
      INSERT INTO overtrading_events (event_id, user_id, session_id, detected_at, trade_count, window_minutes)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
      `,
      [userId, sessionId, row.window_start, Number(row.trade_count), WINDOW_MINUTES],
    );
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
