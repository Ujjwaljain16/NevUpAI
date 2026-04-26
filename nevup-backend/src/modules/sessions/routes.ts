import { FastifyInstance } from "fastify";
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

  // ── GET /users/:userId/sessions/:sessionId ──────────────────────────────
  app.get<{ Params: { userId: string; sessionId: string } }>(
    "/users/:userId/sessions/:sessionId",
    { preHandler: [authMiddleware, tenancyMiddleware] },
    async (request, reply) => {
      const traceId = request.appContext?.traceId ?? "unknown";
      const { userId, sessionId } = request.params;

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

      return reply.status(200).send({
        data: {
          sessionId,
          userId,
          tiltIndex,
          tradeCount: trades.length,
          overtrading,
          trades,
        },
        meta: {
          traceId,
          generatedAt: new Date().toISOString(),
        },
      });
    },
  );

  // ── POST /users/:userId/sessions/:sessionId/debrief ─────────────────────
  app.post<{ Params: { userId: string; sessionId: string } }>(
    "/users/:userId/sessions/:sessionId/debrief",
    { preHandler: [authMiddleware, tenancyMiddleware] },
    async (request, reply) => {
      const traceId = request.appContext?.traceId ?? "unknown";
      return reply.status(201).send({
        data: {
          debriefId: "placeholder",
          sessionId: request.params.sessionId,
          savedAt: new Date().toISOString(),
        },
        meta: {
          traceId,
          generatedAt: new Date().toISOString(),
        },
      });
    },
  );

  // ── GET /users/:userId/sessions/:sessionId/coaching ─────────────────────
  app.get<{ Params: { userId: string; sessionId: string } }>(
    "/users/:userId/sessions/:sessionId/coaching",
    { preHandler: [authMiddleware, tenancyMiddleware] },
    async (request, reply) => {
      // SSE placeholder
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.write("event: done\ndata: {\"fullMessage\": \"AI Coaching placeholder\"}\n\n");
      return reply.raw.end();
    },
  );
}
