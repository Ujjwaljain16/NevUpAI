import { FastifyInstance } from "fastify";
import { query } from "../../infra/db/client";
import { logger } from "../../infra/logger";
import { authMiddleware } from "../auth/auth.middleware";
import { tenancyMiddleware } from "../auth/tenancy.middleware";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_GRANULARITIES = new Set(["hourly", "daily", "rolling30d"]);

function validateMetricsQuery(params: {
  from?: string;
  to?: string;
  granularity?: string;
}): string | null {
  if (!params.from || !params.to || !params.granularity) {
    return "Missing required query parameters: from, to, granularity";
  }

  const fromDate = new Date(params.from);
  const toDate = new Date(params.to);

  if (isNaN(fromDate.getTime())) {
    return "'from' is not a valid ISO timestamp";
  }
  if (isNaN(toDate.getTime())) {
    return "'to' is not a valid ISO timestamp";
  }
  if (fromDate >= toDate) {
    return "'from' must be before 'to'";
  }
  if (!VALID_GRANULARITIES.has(params.granularity)) {
    return `'granularity' must be one of: ${[...VALID_GRANULARITIES].join(", ")}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerMetricRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /users/:userId/metrics ──────────────────────────────────────────
  app.get<{ Params: { userId: string }; Querystring: { from?: string; to?: string; granularity?: string } }>(
    "/users/:userId/metrics",
    { preHandler: [authMiddleware, tenancyMiddleware] },
    async (request, reply) => {
      const traceId = request.appContext?.traceId ?? "unknown";
      const startTime = Date.now();
      const { userId } = request.params;
      const { from, to, granularity } = request.query;

      // ── Validate ────────────────────────────────────────────────────────
      const validationError = validateMetricsQuery({ from, to, granularity });
      if (validationError) {
        throw Object.assign(new Error(validationError), { statusCode: 400 });
      }

      // ── Metrics computed for the specific range ──────────────────────────
      // This ensures compliance with "queryable via the read API with date range filtering"

      // 1. Win rate by emotion for the range
      const emotionResult = await query<{
        emotional_state: string;
        wins: number;
        losses: number;
      }>(
        `SELECT
          emotional_state,
          COUNT(*) FILTER (WHERE outcome = 'win')::INTEGER AS wins,
          COUNT(*) FILTER (WHERE outcome = 'loss')::INTEGER AS losses
         FROM trades
         WHERE user_id = $1 AND entry_at BETWEEN $2 AND $3 AND status = 'closed'
         GROUP BY emotional_state`,
        [userId, from, to],
      );

      const winRateByEmotionalState: Record<string, any> = {};
      emotionResult.rows.forEach(row => {
        const wins = Number(row.wins);
        const losses = Number(row.losses);
        winRateByEmotionalState[row.emotional_state || 'neutral'] = {
          wins,
          losses,
          winRate: (wins + losses) > 0 ? Number((wins / (wins + losses)).toFixed(4)) : 0,
        };
      });

      // 2. Plan adherence score for the range
      const adherenceResult = await query<{ score: string }>(
        `SELECT AVG(plan_adherence)::NUMERIC(8, 4) AS score
         FROM trades
         WHERE user_id = $1 AND entry_at BETWEEN $2 AND $3 AND plan_adherence IS NOT NULL`,
        [userId, from, to],
      );
      const planAdherenceScore = adherenceResult.rows[0]?.score
        ? Number(adherenceResult.rows[0].score)
        : null;

      // 3. Session tilt index for the range
      // Spec: "Ratio of (loss-following trades / total trades) in the current sessionId"
      // For a range, we'll calculate the aggregate ratio across all trades in that range.
      const tiltResult = await query<{ loss_following: number; total: number }>(
        `WITH ordered AS (
           SELECT outcome, LAG(outcome) OVER (PARTITION BY session_id ORDER BY entry_at) AS prev_outcome
           FROM trades
           WHERE user_id = $1 AND entry_at BETWEEN $2 AND $3 AND status = 'closed'
         )
         SELECT
           COUNT(*) FILTER (WHERE prev_outcome = 'loss')::INTEGER AS loss_following,
           COUNT(*)::INTEGER AS total
         FROM ordered`,
        [userId, from, to],
      );
      const sessionTiltIndex = (tiltResult.rows[0]?.total ?? 0) > 0
        ? Number((tiltResult.rows[0].loss_following / tiltResult.rows[0].total).toFixed(4))
        : 0;

      // ── Overtrading event count (within range) ──────────────────────────
      const overtradingResult = await query<{ count: string }>(
        `SELECT COUNT(*)::INTEGER AS count
         FROM overtrading_events
         WHERE user_id = $1
           AND detected_at BETWEEN $2 AND $3`,
        [userId, from, to],
      );
      const overtradingEvents = Number(overtradingResult.rows[0]?.count ?? 0);

      const latency = Date.now() - startTime;

      logger.info({
        event: "METRICS_QUERY",
        traceId,
        userId,
        range: { from, to },
        granularity,
        latency,
        source: "api",
      });

      // ── Revenge trades count ───────────────────────────────────────────
      const revengeResult = await query<{ count: string }>(
        `SELECT COUNT(*)::INTEGER AS count
         FROM trades
         WHERE user_id = $1
           AND revenge_flag = TRUE
           AND entry_at BETWEEN $2 AND $3`,
        [userId, from, to],
      );
      const revengeTrades = Number(revengeResult.rows[0]?.count ?? 0);

      // ── Timeseries bucketing ───────────────────────────────────────────
      let timeseriesQuery = "";
      if (granularity === "hourly") {
        timeseriesQuery = `
          SELECT
            date_trunc('hour', entry_at) AS bucket,
            COUNT(*)::INTEGER AS trade_count,
            COUNT(*) FILTER (WHERE outcome = 'win')::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE status = 'closed'), 0)::NUMERIC AS win_rate,
            SUM(pnl)::NUMERIC AS pnl,
            AVG(plan_adherence)::NUMERIC AS avg_plan_adherence
          FROM trades
          WHERE user_id = $1 AND entry_at BETWEEN $2 AND $3
          GROUP BY bucket
          ORDER BY bucket ASC
        `;
      } else if (granularity === "daily" || granularity === "rolling30d") {
        timeseriesQuery = `
          SELECT
            date_trunc('day', entry_at) AS bucket,
            COUNT(*)::INTEGER AS trade_count,
            COUNT(*) FILTER (WHERE outcome = 'win')::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE status = 'closed'), 0)::NUMERIC AS win_rate,
            SUM(pnl)::NUMERIC AS pnl,
            AVG(plan_adherence)::NUMERIC AS avg_plan_adherence
          FROM trades
          WHERE user_id = $1 AND entry_at BETWEEN $2 AND $3
          GROUP BY bucket
          ORDER BY bucket ASC
        `;
      }

      const timeseriesResult = await query<{
        bucket: string;
        trade_count: number;
        win_rate: number | null;
        pnl: number | null;
        avg_plan_adherence: number | null;
      }>(timeseriesQuery, [userId, from, to]);

      const timeseries = timeseriesResult.rows.map(row => ({
        bucket: row.bucket,
        tradeCount: Number(row.trade_count),
        winRate: row.win_rate !== null ? Number(Number(row.win_rate).toFixed(4)) : 0,
        pnl: row.pnl !== null ? Number(Number(row.pnl).toFixed(2)) : 0,
        avgPlanAdherence: row.avg_plan_adherence !== null ? Number(Number(row.avg_plan_adherence).toFixed(2)) : null,
      }));

      return reply.status(200).send({
        userId,
        granularity,
        from,
        to,
        planAdherenceScore,
        sessionTiltIndex,
        winRateByEmotionalState,
        revengeTrades,
        overtradingEvents,
        timeseries,
      });
    },
  );

  // ── GET /users/:userId/profile ──────────────────────────────────────────
  app.get<{ Params: { userId: string } }>(
    "/users/:userId/profile",
    { preHandler: [authMiddleware, tenancyMiddleware] },
    async (request, reply) => {
      const traceId = request.appContext?.traceId ?? "unknown";
      const { userId } = request.params;

      // Latest plan adherence
      const adherenceResult = await query<{ score: string; calculated_at: string }>(
        "SELECT score, calculated_at FROM plan_adherence_scores WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 1",
        [userId],
      );

      // Dominant emotional patterns (sorted by total trades)
      const emotionResult = await query<{
        emotional_state: string;
        wins: number;
        losses: number;
      }>(
        "SELECT emotional_state, wins, losses FROM win_rate_by_emotion WHERE user_id = $1 ORDER BY (wins + losses) DESC",
        [userId],
      );

      const dominantPatterns = emotionResult.rows.map((row) => ({
        emotion: row.emotional_state,
        totalTrades: Number(row.wins) + Number(row.losses),
        winRate: (Number(row.wins) + Number(row.losses)) > 0
          ? Number((Number(row.wins) / (Number(row.wins) + Number(row.losses))).toFixed(4))
          : 0,
      }));

      return reply.status(200).send({
        userId,
        generatedAt: new Date().toISOString(),
        latestPlanAdherence: adherenceResult.rows[0]
          ? { score: Number(adherenceResult.rows[0].score), calculatedAt: adherenceResult.rows[0].calculated_at }
          : null,
        dominantPatterns,
      });
    },
  );
}
