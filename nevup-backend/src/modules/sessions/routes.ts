import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { query } from "../../infra/db/client";
import { logger } from "../../infra/logger";
import { authMiddleware } from "../auth/auth.middleware";
import { tenancyMiddleware } from "../auth/tenancy.middleware";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TradeRow = {
  trade_id: string;
  asset: string;
  asset_class: string;
  direction: string;
  entry_price: string;
  exit_price: string | null;
  quantity: string;
  entry_at: string;
  exit_at: string | null;
  status: string;
  emotional_state: string | null;
  outcome: string | null;
  pnl: string | null;
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /sessions/:sessionId ───────────────────────────────────────────
  app.get<{ Params: { sessionId: string } }>(
    "/sessions/:sessionId",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const traceId = request.appContext?.traceId ?? "unknown";
      const { sessionId } = request.params;
      const userId = request.user?.userId;

      // ── Fetch trades for this session ─────────────────────────────────
      const tradesResult = await query<TradeRow>(
        `SELECT trade_id, asset, asset_class, direction,
                entry_price, exit_price, quantity,
                entry_at, exit_at, status,
                emotional_state, outcome, pnl
         FROM trades
         WHERE user_id = $1 AND session_id = $2
         ORDER BY entry_at ASC`,
        [userId, sessionId],
      );

      if (tradesResult.rows.length === 0) {
        throw Object.assign(
          new Error("Session not found or has no trades."),
          { statusCode: 404, errorCode: "SESSION_NOT_FOUND" },
        );
      }

      // ── Fetch tilt index (worker-computed) ────────────────────────────
      const tiltResult = await query<{ tilt_index: string }>(
        "SELECT tilt_index FROM session_tilt WHERE user_id = $1 AND session_id = $2",
        [userId, sessionId],
      );
      const tiltIndex = tiltResult.rows[0]
        ? Number(tiltResult.rows[0].tilt_index)
        : null;

      // ── Check overtrading (worker-computed) ───────────────────────────
      const overtradingResult = await query<{ count: string }>(
        "SELECT COUNT(*)::INTEGER AS count FROM overtrading_events WHERE user_id = $1 AND session_id = $2",
        [userId, sessionId],
      );
      const overtrading = Number(overtradingResult.rows[0]?.count ?? 0) > 0;

      // ── Map trades to response shape ──────────────────────────────────
      const trades = tradesResult.rows.map((row) => ({
        tradeId: row.trade_id,
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
      }));

      logger.info({
        event: "SESSION_QUERY",
        traceId,
        userId,
        sessionId,
        tradeCount: trades.length,
        source: "api",
      });

      // ── Calculate aggregate metrics ──────────────────────────────────
      const winTrades = trades.filter(t => t.outcome === "win").length;
      const closedTrades = trades.filter(t => t.status === "closed").length;
      const winRate = closedTrades > 0 ? Number((winTrades / closedTrades).toFixed(4)) : 0;
      const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
      const sessionDate = trades.length > 0 ? trades[0].entryAt : new Date().toISOString();

      return reply.status(200).send({
        sessionId,
        userId: request.user?.userId,
        date: sessionDate,
        notes: null, // No storage for session-level notes yet
        tiltIndex,
        tradeCount: trades.length,
        winRate,
        totalPnl,
        overtrading,
        trades,
      });
    },
  );

  // ── POST /sessions/:sessionId/debrief ──────────────────────────────────
  app.post<{ Params: { sessionId: string }; Body: { overallMood: string; keyMistake?: string; keyLesson?: string; planAdherenceRating: number; willReviewTomorrow: boolean } }>(
    "/sessions/:sessionId/debrief",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const traceId = request.appContext?.traceId ?? "unknown";
      const { sessionId } = request.params;
      const userId = request.user?.userId;
      const { overallMood, keyMistake, keyLesson, planAdherenceRating, willReviewTomorrow } = request.body;

      // 1. Verify session exists and belongs to user (using trades as session anchor)
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

      // 2. Persist debrief
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

  // ── GET /sessions/:sessionId/coaching ──────────────────────────────────
  app.get<{ Params: { sessionId: string } }>(
    "/sessions/:sessionId/coaching",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { sessionId } = request.params;

      // 1. Set SSE headers
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");

      // 2. Simulated AI coaching message based on the session
      const fullMessage = "You showed strong discipline today by following your plan on 80% of trades. However, your anxiety spiked after the second loss, leading to a slightly larger position size on the final trade. Focus on maintaining fixed risk per trade regardless of previous outcomes tomorrow.";
      const tokens = fullMessage.split(" ");

      // 3. Stream tokens
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] + (i === tokens.length - 1 ? "" : " ");
        const data = JSON.stringify({ token, index: i });
        reply.raw.write(`event: token\ndata: ${data}\n\n`);
        
        // Add a small delay to simulate generation
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // 4. Send completion event
      const finalData = JSON.stringify({ fullMessage });
      reply.raw.write(`event: done\ndata: ${finalData}\n\n`);
      
      return reply.raw.end();
    },
  );
}
