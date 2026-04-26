import { FastifyInstance } from "fastify";
import { query } from "../../infra/db/client";
import { logger } from "../../infra/logger";
import { authMiddleware } from "../auth/auth.middleware";
import { tenancyMiddleware } from "../auth/tenancy.middleware";

const VALID_GRANULARITIES = new Set(["hourly", "daily", "rolling30d"]);

type MetricsQuery = {
  from?: string;
  to?: string;
  granularity?: string;
};

type TimeseriesRow = {
  bucket: string;
  trade_count: number | string;
  win_rate: number | string | null;
  pnl: number | string | null;
  avg_plan_adherence: number | string | null;
};

type Pathology = {
  pathology:
    | "revenge_trading"
    | "overtrading"
    | "fomo_entries"
    | "plan_non_adherence"
    | "premature_exit"
    | "loss_running"
    | "session_tilt"
    | "time_of_day_bias"
    | "position_sizing_inconsistency";
  confidence: number;
  evidenceSessions: string[];
  evidenceTrades: string[];
};

// Enforces strict temporal and granularity constraints for analytical consistency
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

  if (isNaN(fromDate.getTime())) return "'from' is not a valid ISO timestamp";
  if (isNaN(toDate.getTime())) return "'to' is not a valid ISO timestamp";
  if (fromDate >= toDate) return "'from' must be before 'to'";
  if (!VALID_GRANULARITIES.has(params.granularity)) {
    return `'granularity' must be one of: ${[...VALID_GRANULARITIES].join(", ")}`;
  }

  return null;
}

// Heuristic engine that transforms raw quantitative data into qualitative coaching insights
function buildBehavioralContext(metrics: any) {
  const insights = [];
  const totalTrades = metrics.timeseries.reduce((acc: number, bucket: any) => acc + bucket.tradeCount, 0);

  // Intent: identify impulse-driven recovery attempts that destroy edge
  if (metrics.revengeTrades > 0 && totalTrades > 0) {
    const revengeRate = metrics.revengeTrades / totalTrades;
    if (revengeRate > 0.15) {
      insights.push({
        signal: 'revenge_trading',
        severity: revengeRate > 0.3 ? 'high' : 'moderate',
        finding: `${(revengeRate * 100).toFixed(0)}% of trades show revenge pattern`,
        coachingHint: 'Mandatory 5-minute cooldown after any losing trade would have prevented these entries.'
      });
    }
  }

  // Intent: isolate performance gaps caused by emotional instability
  const emotionData = metrics.winRateByEmotionalState;
  if (emotionData.calm && emotionData.anxious) {
    const gap = emotionData.calm.winRate - emotionData.anxious.winRate;
    if (gap > 0.2) {
      insights.push({
        signal: 'emotional_performance_gap',
        severity: gap > 0.4 ? 'high' : 'moderate',
        finding: `Win rate drops ${(gap * 100).toFixed(0)}% when anxious vs calm`,
        coachingHint: 'Anxiety-state trades are destroying edge. Consider a hard rule: no entries when emotional state is anxious or fearful.'
      });
    }
  }

  // Intent: detect post-loss 'tilt' patterns to prevent catastrophic drawdown
  if (metrics.sessionTiltIndex > 0.5) {
    insights.push({
      signal: 'session_tilt',
      severity: metrics.sessionTiltIndex > 0.7 ? 'high' : 'moderate',
      finding: `${(metrics.sessionTiltIndex * 100).toFixed(0)}% of trades follow a loss`,
      coachingHint: 'Stop trading after 2 consecutive losses per session. The data shows recovery attempts consistently deepen the drawdown.'
    });
  }

  // Intent: verify plan discipline as a foundational trading habit
  if (metrics.planAdherenceScore && metrics.planAdherenceScore < 2.5) {
    insights.push({
      signal: 'plan_non_adherence',
      severity: 'high',
      finding: `Average plan adherence: ${metrics.planAdherenceScore.toFixed(1)}/5`,
      coachingHint: 'Adherent trades have a higher win rate in this dataset. The plan is not the problem — not following it is.'
    });
  }

  return {
    dominantPattern: insights.sort((a, b) => b.severity === 'high' ? 1 : -1)[0]?.signal ?? null,
    insights,
    generatedAt: new Date().toISOString(),
  };
}

export async function registerMetricRoutes(app: FastifyInstance): Promise<void> {

  // Analytical endpoint for aggregated performance and behavioral metrics
  app.get<{ Params: { userId: string }; Querystring: MetricsQuery }>(
    "/users/:userId/metrics",
    { preHandler: [authMiddleware, tenancyMiddleware] },
    async (request, reply) => {
      const traceId = request.appContext?.traceId ?? "unknown";
      const startTime = Date.now();
      const { userId } = request.params;
      const { from, to, granularity } = request.query;

      const validationError = validateMetricsQuery({ from, to, granularity });
      if (validationError) {
        throw Object.assign(new Error(validationError), { statusCode: 400 });
      }

      // Compute on-the-fly: win rate by emotion with date range filter
      const emotionResult = await query<{
        emotional_state: string;
        wins: string | number;
        losses: string | number;
      }>(
        `SELECT
           COALESCE(emotional_state, 'neutral') AS emotional_state,
           COUNT(*) FILTER (WHERE outcome = 'win')::INTEGER AS wins,
           COUNT(*) FILTER (WHERE outcome = 'loss')::INTEGER AS losses
         FROM trades
         WHERE user_id = $1
           AND status = 'closed'
           AND entry_at BETWEEN $2 AND $3
         GROUP BY COALESCE(emotional_state, 'neutral')`,
        [userId, from, to],
      );

      const winRateByEmotionalState: Record<string, { wins: number; losses: number; winRate: number }> = {};
      emotionResult.rows.forEach(row => {
        const wins = Number(row.wins);
        const losses = Number(row.losses);
        winRateByEmotionalState[row.emotional_state || "neutral"] = {
          wins,
          losses,
          winRate: (wins + losses) > 0 ? Number((wins / (wins + losses)).toFixed(4)) : 0,
        };
      });

      // Read projection: rolling-10 plan adherence snapshot
      const adherenceResult = await query<{ score: string | number }>(
        `SELECT score
         FROM plan_adherence_scores
         WHERE user_id = $1 AND calculated_at <= $2
         ORDER BY calculated_at DESC
         LIMIT 1`,
        [userId, to],
      );
      const planAdherenceScore = adherenceResult.rows[0]?.score
        ? Number(adherenceResult.rows[0].score)
        : null;

      // Read projection: session tilt for sessions active in range
      const tiltResult = await query<{ tilt_index: string | number | null }>(
        `SELECT AVG(st.tilt_index)::NUMERIC(8,4) AS tilt_index
         FROM session_tilt st
         WHERE st.user_id = $1
           AND EXISTS (
             SELECT 1
             FROM trades t
             WHERE t.user_id = $1
               AND t.session_id = st.session_id
               AND t.entry_at BETWEEN $2 AND $3
           )`,
        [userId, from, to],
      );
      const sessionTiltIndex = tiltResult.rows[0]?.tilt_index
        ? Number(tiltResult.rows[0].tilt_index)
        : 0;

      // Read projection: overtrading event count in range
      const overtradingResult = await query<{ count: string }>(
        `SELECT COUNT(*)::INTEGER AS count
         FROM overtrading_events
         WHERE user_id = $1
           AND detected_at BETWEEN $2 AND $3`,
        [userId, from, to],
      );
      const overtradingEvents = Number(overtradingResult.rows[0]?.count ?? 0);

      // Read trade log directly for high-precision revenge detection
      const revengeResult = await query<{ count: string }>(
        `SELECT COUNT(*)::INTEGER AS count
         FROM trades
         WHERE user_id = $1
           AND revenge_flag = TRUE
           AND entry_at BETWEEN $2 AND $3`,
        [userId, from, to],
      );
      const revengeTrades = Number(revengeResult.rows[0]?.count ?? 0);

      // Timeseries bucketing handles different granularities (hourly/daily/rolling)
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
      } else if (granularity === "daily") {
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
      } else {
        timeseriesQuery = `
          WITH daily_bounds AS (
            SELECT generate_series(
              date_trunc('day', $2::timestamptz),
              date_trunc('day', $3::timestamptz),
              interval '1 day'
            ) AS day_bucket
          )
          SELECT
            d.day_bucket AS bucket,
            COUNT(t.trade_id)::INTEGER AS trade_count,
            COUNT(t.trade_id) FILTER (WHERE t.outcome = 'win')::NUMERIC
              / NULLIF(COUNT(t.trade_id) FILTER (WHERE t.status = 'closed'), 0)::NUMERIC AS win_rate,
            SUM(t.pnl)::NUMERIC AS pnl,
            AVG(t.plan_adherence)::NUMERIC AS avg_plan_adherence
          FROM daily_bounds d
          LEFT JOIN trades t
            ON t.user_id = $1
           AND t.entry_at >= d.day_bucket - interval '29 days'
           AND t.entry_at < d.day_bucket + interval '1 day'
          GROUP BY d.day_bucket
          ORDER BY d.day_bucket ASC
        `;
      }

      const timeseriesResult = await query<TimeseriesRow>(timeseriesQuery, [userId, from, to]);

      const timeseries = timeseriesResult.rows.map(row => ({
        bucket: row.bucket,
        tradeCount: Number(row.trade_count),
        winRate: row.win_rate !== null ? Number(Number(row.win_rate).toFixed(4)) : 0,
        pnl: row.pnl !== null ? Number(Number(row.pnl).toFixed(2)) : 0,
        avgPlanAdherence: row.avg_plan_adherence !== null ? Number(Number(row.avg_plan_adherence).toFixed(2)) : null,
      }));

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

      const responsePayload = {
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
      };

      return reply.status(200).send({
        ...responsePayload,
        behavioralContext: buildBehavioralContext(responsePayload),
      });
    },
  );

  // Behavioral profile: combines long-term statistical evidence into a psychological baseline
  app.get<{ Params: { userId: string } }>(
    "/users/:userId/profile",
    { preHandler: [authMiddleware, tenancyMiddleware] },
    async (request, reply) => {
      const { userId } = request.params;

      const totalTradesResult = await query<{ count: string }>(
        "SELECT COUNT(*)::INTEGER AS count FROM trades WHERE user_id = $1",
        [userId],
      );

      if (Number(totalTradesResult.rows[0]?.count ?? 0) === 0) {
        throw Object.assign(new Error("Behavioral profile not available for this user."), {
          statusCode: 404,
          errorCode: "NOT_FOUND",
        });
      }

      // Read current projections and evidence logs
      const adherenceResult = await query<{ score: string | number }>(
        "SELECT score FROM plan_adherence_scores WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 1",
        [userId],
      );
      const latestAdherence = adherenceResult.rows[0]?.score
        ? Number(adherenceResult.rows[0].score)
        : null;

      const revengeEvidence = await query<{ trade_id: string; session_id: string }>(
        `SELECT trade_id::text AS trade_id, session_id::text AS session_id
         FROM trades
         WHERE user_id = $1 AND revenge_flag = TRUE
         ORDER BY entry_at DESC
         LIMIT 10`,
        [userId],
      );

      const overtradingEvidence = await query<{ session_id: string; trade_count: number | string }>(
        `SELECT session_id::text AS session_id, MAX(trade_count) AS trade_count
         FROM overtrading_events
         WHERE user_id = $1
         GROUP BY session_id
         ORDER BY MAX(trade_count) DESC
         LIMIT 10`,
        [userId],
      );

      const tiltEvidence = await query<{ session_id: string; tilt_index: string | number }>(
        `SELECT session_id::text AS session_id, tilt_index
         FROM session_tilt
         WHERE user_id = $1 AND tilt_index >= 0.5
         ORDER BY tilt_index DESC
         LIMIT 10`,
        [userId],
      );

      const calmPerformance = await query<{ wins: number | string; total: number | string }>(
        `SELECT
           COUNT(*) FILTER (WHERE outcome = 'win')::INTEGER AS wins,
           COUNT(*) FILTER (WHERE outcome IN ('win', 'loss'))::INTEGER AS total
         FROM trades
         WHERE user_id = $1
           AND status = 'closed'
           AND emotional_state = 'calm'`,
        [userId],
      );

      // Intent: find the optimal trading window based on historical win rate density
      const peakWindow = await query<{ hour_utc: number; wins: number | string; closed_count: number | string }>(
        `SELECT
           EXTRACT(HOUR FROM entry_at)::INTEGER AS hour_utc,
           COUNT(*) FILTER (WHERE outcome = 'win')::INTEGER AS wins,
           COUNT(*) FILTER (WHERE outcome IN ('win', 'loss'))::INTEGER AS closed_count
         FROM trades
         WHERE user_id = $1
           AND status = 'closed'
         GROUP BY hour_utc
         HAVING COUNT(*) FILTER (WHERE outcome IN ('win', 'loss')) > 0
         ORDER BY (
           COUNT(*) FILTER (WHERE outcome = 'win')::NUMERIC /
           COUNT(*) FILTER (WHERE outcome IN ('win', 'loss'))::NUMERIC
         ) DESC,
         COUNT(*) FILTER (WHERE outcome IN ('win', 'loss')) DESC
         LIMIT 1`,
        [userId],
      );

      // Transform evidence into high-confidence pathology signals
      const dominantPathologies: Pathology[] = [];

      if ((revengeEvidence.rowCount ?? 0) > 0) {
        dominantPathologies.push({
          pathology: "revenge_trading",
          confidence: Number(Math.min(1, (revengeEvidence.rowCount ?? 0) / 10).toFixed(2)),
          evidenceSessions: [...new Set(revengeEvidence.rows.map((row) => row.session_id))],
          evidenceTrades: revengeEvidence.rows.map((row) => row.trade_id),
        });
      }

      if ((overtradingEvidence.rowCount ?? 0) > 0) {
        dominantPathologies.push({
          pathology: "overtrading",
          confidence: Number(Math.min(1, (overtradingEvidence.rowCount ?? 0) / 5).toFixed(2)),
          evidenceSessions: overtradingEvidence.rows.map((row) => row.session_id),
          evidenceTrades: [],
        });
      }

      if ((tiltEvidence.rowCount ?? 0) > 0) {
        const highestTilt = Math.max(...tiltEvidence.rows.map((row) => Number(row.tilt_index)));
        dominantPathologies.push({
          pathology: "session_tilt",
          confidence: Number(Math.min(1, highestTilt).toFixed(2)),
          evidenceSessions: tiltEvidence.rows.map((row) => row.session_id),
          evidenceTrades: [],
        });
      }

      if (latestAdherence !== null && latestAdherence < 3.5) {
        const lowAdherenceTrades = await query<{ trade_id: string; session_id: string }>(
          `SELECT trade_id::text AS trade_id, session_id::text AS session_id
           FROM trades
           WHERE user_id = $1
             AND plan_adherence IS NOT NULL
             AND plan_adherence <= 3
           ORDER BY entry_at DESC
           LIMIT 10`,
          [userId],
        );

        dominantPathologies.push({
          pathology: "plan_non_adherence",
          confidence: Number(Math.min(1, (3.5 - latestAdherence) / 2.5).toFixed(2)),
          evidenceSessions: [...new Set(lowAdherenceTrades.rows.map((row) => row.session_id))],
          evidenceTrades: lowAdherenceTrades.rows.map((row) => row.trade_id),
        });
      }

      dominantPathologies.sort((a, b) => b.confidence - a.confidence);

      const strengths: string[] = [];
      const calmWins = Number(calmPerformance.rows[0]?.wins ?? 0);
      const calmTotal = Number(calmPerformance.rows[0]?.total ?? 0);
      
      if (calmTotal > 0 && calmWins / calmTotal >= 0.6) {
        strengths.push("Strong performance under calm emotional state");
      }
      if (latestAdherence !== null && latestAdherence >= 4) {
        strengths.push("Consistent plan adherence in recent closed trades");
      }
      if ((revengeEvidence.rowCount ?? 0) === 0) {
        strengths.push("No revenge-trading flags detected");
      }

      const peakPerformanceWindow = peakWindow.rows[0]
        ? {
            startHour: peakWindow.rows[0].hour_utc,
            endHour: (peakWindow.rows[0].hour_utc + 1) % 24,
            winRate: Number(
              (
                Number(peakWindow.rows[0].wins) /
                Number(peakWindow.rows[0].closed_count)
              ).toFixed(4),
            ),
          }
        : null;

      return reply.status(200).send({
        userId,
        generatedAt: new Date().toISOString(),
        dominantPathologies,
        strengths,
        peakPerformanceWindow,
      });
    },
  );
}
