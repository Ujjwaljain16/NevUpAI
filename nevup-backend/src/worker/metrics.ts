import { PoolClient } from "pg";
import { logger } from "../infra/logger";
import { getRedis, TRADE_EVENTS_STREAM } from "../infra/redis/client";

// Re-computes win-rate distributions across emotional states
// Intent: highlight how specific moods (e.g. anxious) correlate with lower edge
export async function computeWinRateByEmotion(
  client: PoolClient,
  userId: string,
  traceId: string,
): Promise<void> {
  // Full recompute ensures the projection perfectly matches the authoritative trade history
  await client.query("DELETE FROM win_rate_by_emotion WHERE user_id = $1", [userId]);

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

// Tracks the evolution of process discipline over the last 10 sessions
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
      ORDER BY entry_at DESC NULLS LAST
      LIMIT 10
    ) AS recent
    `,
    [userId],
  );

  const avgScore = result.rows[0]?.avg_score;
  if (avgScore === null || avgScore === undefined) return;

  // Upsert ensures we only keep the most recent calculated snapshot per user
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

// Measures performance degradation following losses (session-level instability)
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

  if (total === 0) return;

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

// Flags impulsive re-entries immediately following a negative outcome
// Heuristic: entry within 90s of a loss while in an unstable emotional state
export async function computeRevengeFlag(
  client: PoolClient,
  userId: string,
  tradeId: string,
  traceId: string,
): Promise<void> {
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

// Detects clusters of high-frequency activity that signal a loss of control
// Threshold: > 10 trades within a 30-minute window
export async function detectOvertrading(
  client: PoolClient,
  userId: string,
  sessionId: string,
  traceId: string,
): Promise<void> {
  const WINDOW_MINUTES = 30;
  const THRESHOLD = 10;

  const result = await client.query<{ window_start: string; trade_count: string; evidence_session_id: string }>(
    `
    SELECT
      t1.entry_at AS window_start,
      COUNT(t2.trade_id)::INTEGER AS trade_count,
      MIN(t1.session_id)::TEXT AS evidence_session_id
    FROM trades t1
    JOIN trades t2 ON t1.user_id = t2.user_id
      AND t2.entry_at BETWEEN t1.entry_at AND t1.entry_at + INTERVAL '30 minutes'
    WHERE t1.user_id = $1
    GROUP BY t1.trade_id, t1.entry_at
    HAVING COUNT(t2.trade_id) > $2
    ORDER BY t1.entry_at ASC
    `,
    [userId, THRESHOLD],
  );

  const redis = getRedis();

  for (const row of result.rows) {
    // Idempotent logging of overtrading alerts
    const insertResult = await client.query(
      `
      INSERT INTO overtrading_events (event_id, user_id, session_id, detected_at, trade_count, window_minutes)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
      ON CONFLICT (user_id, detected_at) DO NOTHING
      RETURNING event_id
      `,
      [userId, row.evidence_session_id, row.window_start, Number(row.trade_count), WINDOW_MINUTES],
    );

    if (insertResult.rowCount === 1) {
      // Propagate critical behavioral alerts back to the event bus
      await redis.xadd(
        TRADE_EVENTS_STREAM,
        "*",
        "eventId", insertResult.rows[0].event_id,
        "type", "SYSTEM_ALERT_OVERTRADING",
        "userId", userId,
        "sessionId", row.evidence_session_id,
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
