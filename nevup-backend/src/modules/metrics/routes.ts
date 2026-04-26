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

      // ── Win rate by emotion (from worker-computed table) ────────────────
      const emotionResult = await query<{
        emotional_state: string;
        wins: number;
        losses: number;
      }>(
        "SELECT emotional_state, wins, losses FROM win_rate_by_emotion WHERE user_id = $1",
        [userId],
      );

      const byEmotion = emotionResult.rows.map((row) => ({
        emotion: row.emotional_state,
        wins: Number(row.wins),
        losses: Number(row.losses),
        winRate: (Number(row.wins) + Number(row.losses)) > 0
          ? Number((Number(row.wins) / (Number(row.wins) + Number(row.losses))).toFixed(4))
          : 0,
      }));

      // Overall win rate from emotion aggregates
      const totalWins = byEmotion.reduce((sum, e) => sum + e.wins, 0);
      const totalLosses = byEmotion.reduce((sum, e) => sum + e.losses, 0);
      const overallWinRate = (totalWins + totalLosses) > 0
        ? Number((totalWins / (totalWins + totalLosses)).toFixed(4))
        : null;

      // ── Plan adherence (latest snapshot) ────────────────────────────────
      const adherenceResult = await query<{ score: string }>(
        "SELECT score FROM plan_adherence_scores WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 1",
        [userId],
      );
      const avgPlanAdherence = adherenceResult.rows[0]
        ? Number(adherenceResult.rows[0].score)
        : null;

      // ── Average tilt index ──────────────────────────────────────────────
      const tiltResult = await query<{ avg_tilt: string }>(
        `SELECT AVG(tilt_index)::NUMERIC(8,4) AS avg_tilt
         FROM session_tilt
         WHERE user_id = $1`,
        [userId],
      );
      const avgTiltIndex = tiltResult.rows[0]?.avg_tilt
        ? Number(tiltResult.rows[0].avg_tilt)
        : null;

      // ── Overtrading event count (within range) ──────────────────────────
      const overtradingResult = await query<{ count: string }>(
        `SELECT COUNT(*)::INTEGER AS count
         FROM overtrading_events
         WHERE user_id = $1
           AND detected_at BETWEEN $2 AND $3`,
        [userId, from, to],
      );
      const overtradingEvents = Number(overtradingResult.rows[0]?.count ?? 0);

      // ── Build summary ───────────────────────────────────────────────────
      const hasSummary = overallWinRate !== null || avgPlanAdherence !== null || avgTiltIndex !== null;

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

      return reply.status(200).send({
        data: {
          userId,
          range: { from, to },
          granularity,
          summary: hasSummary
            ? { winRate: overallWinRate, avgPlanAdherence, avgTiltIndex }
            : null,
          byEmotion,
          overtradingEvents,
        },
        meta: {
          traceId,
          generatedAt: new Date().toISOString(),
        },
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
        data: {
          userId,
          latestPlanAdherence: adherenceResult.rows[0]
            ? { score: Number(adherenceResult.rows[0].score), calculatedAt: adherenceResult.rows[0].calculated_at }
            : null,
          dominantPatterns,
        },
        meta: {
          traceId,
          generatedAt: new Date().toISOString(),
        },
      });
    },
  );
}
