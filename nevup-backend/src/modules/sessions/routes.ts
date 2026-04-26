import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { query } from "../../infra/db/client";
import { logger } from "../../infra/logger";
import { authMiddleware } from "../auth/auth.middleware";
import { tenancyMiddleware } from "../auth/tenancy.middleware";
import { TradeRow } from "../../types/database";

const DEBRIEF_SCHEMA = {
  body: {
    type: "object",
    required: ["overallMood", "planAdherenceRating"],
    properties: {
      overallMood: { type: "string", minLength: 1 },
      keyMistake: { type: "string" },
      keyLesson: { type: "string" },
      planAdherenceRating: { type: "integer", minimum: 1, maximum: 5 },
      willReviewTomorrow: { type: "boolean" },
    },
    additionalProperties: false,
  },
};

// Generates a human-readable summary of session performance and behavioral health
function buildCoachingMessage(params: {
  tradeCount: number;
  winRate: number;
  avgPlanAdherence: number | null;
  anxiousOrFearfulCount: number;
  revengeCount: number;
  totalPnl: number;
}): string {
  const {
    tradeCount,
    winRate,
    avgPlanAdherence,
    anxiousOrFearfulCount,
    revengeCount,
    totalPnl,
  } = params;

  const adherenceText =
    avgPlanAdherence === null
      ? "No plan-adherence rating was captured yet"
      : `Your plan-adherence score averaged ${avgPlanAdherence.toFixed(2)} out of 5`;

  const emotionalText =
    anxiousOrFearfulCount === 0
      ? "You stayed emotionally stable across this session"
      : `You logged ${anxiousOrFearfulCount} anxious or fearful trade${anxiousOrFearfulCount > 1 ? "s" : ""}`;

  const revengeText =
    revengeCount === 0
      ? "No revenge-trading pattern was detected"
      : `${revengeCount} trade${revengeCount > 1 ? "s were" : " was"} flagged as revenge behavior`;

  const pnlText = totalPnl >= 0 ? `net PnL ended at +${totalPnl.toFixed(2)}` : `net PnL ended at ${totalPnl.toFixed(2)}`;

  return [
    `Session review: you executed ${tradeCount} trades with a ${(winRate * 100).toFixed(1)}% win rate and ${pnlText}.`,
    `${adherenceText}.`,
    `${emotionalText}.`,
    `${revengeText}.`,
    "Focus next session on preserving process quality after losses and keep position sizing unchanged after emotional swings.",
  ].join(" ");
}

// Analyzes trade sequences to identify psychological drift (tilt) and impulsive patterns
function buildSessionNarrative(trades: any[]) {
  const revengeCount = trades.filter(t => t.revengeFlag).length;
  
  // Intent: identify trades driven by an urgent need to recover losses rather than process
  const tiltedTrades = trades.filter(t => 
    t.entryRationale?.includes('recover') || 
    t.entryRationale?.includes('get back') ||
    t.entryRationale?.includes('green on the day')
  ).length;
  
  const firstLossIndex = trades.findIndex(t => t.outcome === 'loss');
  const tradesAfterFirstLoss = firstLossIndex >= 0 
    ? trades.slice(firstLossIndex + 1) 
    : [];
  
  // Intent: detect if performance collapses immediately following a negative outcome
  const postLossWinRate = tradesAfterFirstLoss.length > 0
    ? tradesAfterFirstLoss.filter(t => t.outcome === 'win').length / tradesAfterFirstLoss.length
    : null;

  const events = [];

  if (revengeCount > 0) {
    events.push(`${revengeCount} revenge trade${revengeCount > 1 ? 's' : ''} detected — rapid re-entries after losses in an anxious/fearful state`);
  }

  if (postLossWinRate !== null && postLossWinRate < 0.3 && tradesAfterFirstLoss.length >= 2) {
    events.push(`Win rate collapsed to ${(postLossWinRate * 100).toFixed(0)}% after the first loss (session tilt pattern)`);
  }

  if (tiltedTrades > 0) {
    events.push(`${tiltedTrades} trades with recovery-motivated rationale — a signal of session tilt`);
  }

  return {
    events,
    behavioralRating: events.length === 0 ? 'clean' : events.length === 1 ? 'caution' : 'poor',
    summary: events.length === 0
      ? 'Session shows disciplined execution with no detected behavioral anomalies.'
      : `Session shows ${events.length} behavioral warning signal${events.length > 1 ? 's' : ''}. Review the flagged trades before next session.`
  };
}

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {

  // Retrieves session context and behavioral metrics for a specific block of trading activity
  app.get<{ Params: { sessionId: string } }>(
    "/sessions/:sessionId",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const traceId = request.appContext?.traceId ?? "unknown";
      const { sessionId } = request.params;
      const userId = request.user?.userId;

      const tradesResult = await query<TradeRow>(
        `SELECT trade_id, asset, asset_class, direction,
                entry_price, exit_price, quantity,
                entry_at, exit_at, status,
                emotional_state, outcome, pnl, user_id, session_id,
                revenge_flag, entry_rationale
         FROM trades
         WHERE session_id = $1
         ORDER BY entry_at ASC`,
        [sessionId],
      );

      if (tradesResult.rows.length === 0) {
        throw Object.assign(
          new Error("Session not found or has no trades."),
          { statusCode: 404, errorCode: "SESSION_NOT_FOUND" },
        );
      }

      const ownerUserId = tradesResult.rows[0].user_id;
      if (ownerUserId !== userId) {
        throw Object.assign(new Error("Cross-tenant access denied"), {
          statusCode: 403,
          errorCode: "FORBIDDEN",
        });
      }

      const trades = tradesResult.rows.map((row) => ({
        tradeId: row.trade_id,
        userId: ownerUserId,
        sessionId: row.session_id,
        asset: row.asset,
        assetClass: row.asset_class,
        direction: row.direction,
        entryPrice: Number(row.entry_price),
        exitPrice: row.exit_price !== null ? Number(row.exit_price) : null,
        quantity: Number(row.quantity),
        entryAt: row.entry_at,
        exitAt: row.exit_at,
        status: row.status,
        emotionalState: row.emotional_state,
        outcome: row.outcome,
        pnl: row.pnl !== null ? Number(row.pnl) : null,
        revengeFlag: row.revenge_flag,
        entryRationale: row.entry_rationale,
      }));

      logger.info({
        event: "SESSION_QUERY",
        traceId,
        userId,
        sessionId,
        tradeCount: trades.length,
        source: "api",
      });

      const winTrades = trades.filter(t => t.outcome === "win").length;
      const closedTrades = trades.filter(t => t.status === "closed").length;
      const winRate = closedTrades > 0 ? Number((winTrades / closedTrades).toFixed(4)) : 0;
      const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
      const sessionDate = trades.length > 0 ? trades[0].entryAt : new Date().toISOString();

      return reply.status(200).send({
        sessionId,
        userId: ownerUserId,
        date: sessionDate,
        notes: null, 
        tradeCount: trades.length,
        winRate,
        totalPnl,
        trades,
        sessionNarrative: buildSessionNarrative(trades),
      });
    },
  );

  // Captures post-session reflection to enrich long-term behavioral profiling
  app.post<{ Params: { sessionId: string }; Body: { overallMood: string; keyMistake?: string; keyLesson?: string; planAdherenceRating: number; willReviewTomorrow: boolean } }>(
    "/sessions/:sessionId/debrief",
    {
      preHandler: [authMiddleware],
      schema: DEBRIEF_SCHEMA,
    },
    async (request, reply) => {
      const traceId = request.appContext?.traceId ?? "unknown";
      const { sessionId } = request.params;
      const userId = request.user?.userId;
      const { overallMood, keyMistake, keyLesson, planAdherenceRating, willReviewTomorrow } = request.body;

      const sessionCheck = await query(
        "SELECT user_id FROM trades WHERE session_id = $1 LIMIT 1",
        [sessionId],
      );

      if (sessionCheck.rowCount === 0) {
        throw Object.assign(new Error("Session not found or has no trades."), { statusCode: 404 });
      }

      if (sessionCheck.rows[0].user_id !== userId) {
        throw Object.assign(new Error("Cross-tenant debrief denied."), { statusCode: 403, errorCode: "FORBIDDEN" });
      }

      const debriefId = randomUUID();
      const result = await query(
        `INSERT INTO session_debriefs (
          debrief_id, session_id, user_id, overall_mood, key_mistake, key_lesson, plan_adherence_rating, will_review_tomorrow
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING saved_at`,
        [debriefId, sessionId, userId, overallMood, keyMistake ?? null, keyLesson ?? null, planAdherenceRating, willReviewTomorrow ?? false],
      );

      return reply.status(201).send({
        debriefId,
        sessionId,
        savedAt: result.rows[0].saved_at,
      });
    },
  );

  // High-engagement endpoint providing streamed coaching tokens via Server-Sent Events (SSE)
  app.get<{ Params: { sessionId: string } }>(
    "/sessions/:sessionId/coaching",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { sessionId } = request.params;
      const userId = request.user?.userId;

      const tradesResult = await query<TradeRow>(
        `SELECT trade_id, user_id, session_id, emotional_state, plan_adherence, outcome, pnl
         FROM trades
         WHERE session_id = $1
         ORDER BY entry_at ASC`,
        [sessionId],
      );

      if (tradesResult.rowCount === 0) {
        throw Object.assign(new Error("Session not found or has no trades."), {
          statusCode: 404,
          errorCode: "SESSION_NOT_FOUND",
        });
      }

      const ownerUserId = tradesResult.rows[0].user_id;
      if (ownerUserId !== userId) {
        throw Object.assign(new Error("Cross-tenant access denied"), {
          statusCode: 403,
          errorCode: "FORBIDDEN",
        });
      }

      const tradeCount = tradesResult.rows.length;
      const wins = tradesResult.rows.filter((t) => t.outcome === "win").length;
      const closedTrades = tradesResult.rows.filter((t) => t.outcome === "win" || t.outcome === "loss").length;
      const winRate = closedTrades > 0 ? wins / closedTrades : 0;
      const totalPnl = tradesResult.rows.reduce((sum, row) => sum + Number(row.pnl ?? 0), 0);
      const adherenceValues = tradesResult.rows
        .map((row) => row.plan_adherence)
        .filter((value): value is number => value !== null && value !== undefined);
      const avgPlanAdherence = adherenceValues.length > 0
        ? adherenceValues.reduce((sum, value) => sum + value, 0) / adherenceValues.length
        : null;

      const anxiousOrFearfulCount = tradesResult.rows.filter(
        (t) => t.emotional_state === "anxious" || t.emotional_state === "fearful",
      ).length;

      const revengeResult = await query<{ count: string }>(
        `SELECT COUNT(*)::INTEGER AS count
         FROM trades
         WHERE user_id = $1 AND session_id = $2 AND revenge_flag = TRUE`,
        [ownerUserId, sessionId],
      );
      const revengeCount = Number(revengeResult.rows[0]?.count ?? 0);

      // Enforces the event-stream contract for real-time delivery
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");

      const fullMessage = buildCoachingMessage({
        tradeCount,
        winRate,
        avgPlanAdherence,
        anxiousOrFearfulCount,
        revengeCount,
        totalPnl,
      });
      const tokens = fullMessage.split(" ");

      // Intent: simulate real-time generation to improve user perceived value (UX)
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] + (i === tokens.length - 1 ? "" : " ");
        const data = JSON.stringify({ token, index: i });
        reply.raw.write(`event: token\ndata: ${data}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      const finalData = JSON.stringify({ fullMessage });
      reply.raw.write(`event: done\ndata: ${finalData}\n\n`);
      
      return reply.raw.end();
    },
  );
}
