import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { query } from "../../infra/db/client";
import { logger } from "../../infra/logger";
import { getRedis, TRADE_EVENTS_STREAM } from "../../infra/redis/client";
import { authMiddleware } from "../auth/auth.middleware";
import { tenancyMiddleware } from "../auth/tenancy.middleware";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TradeRow = {
  trade_id: string;
  user_id: string;
  session_id: string;
  asset: string;
  asset_class: "equity" | "crypto" | "forex";
  direction: "long" | "short";
  entry_price: string;
  exit_price: string | null;
  quantity: string;
  entry_at: string;
  exit_at: string | null;
  status: "open" | "closed" | "cancelled";
  plan_adherence: number | null;
  emotional_state: "calm" | "anxious" | "greedy" | "fearful" | "neutral" | null;
  entry_rationale: string | null;
  outcome: "win" | "loss" | null;
  pnl: string | null;
  revenge_flag: boolean;
  event_emitted: boolean;
  created_at: string;
  updated_at: string;
  is_insert: boolean; // from (xmax = 0) in RETURNING
};

type TradeInput = {
  tradeId: string;
  userId: string;
  sessionId: string;
  asset: string;
  assetClass: "equity" | "crypto" | "forex";
  direction: "long" | "short";
  entryPrice: number;
  exitPrice?: number | null;
  quantity: number;
  entryAt: string;
  exitAt?: string | null;
  status: "open" | "closed" | "cancelled";
  planAdherence?: number | null;
  emotionalState?: "calm" | "anxious" | "greedy" | "fearful" | "neutral" | null;
  entryRationale?: string | null;
};

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

function toTradeResponse(row: TradeRow) {
  return {
    tradeId: row.trade_id,
    userId: row.user_id,
    sessionId: row.session_id,
    asset: row.asset,
    assetClass: row.asset_class,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    exitPrice: row.exit_price === null ? null : Number(row.exit_price),
    quantity: Number(row.quantity),
    entryAt: row.entry_at,
    exitAt: row.exit_at,
    status: row.status,
    planAdherence: row.plan_adherence,
    emotionalState: row.emotional_state,
    entryRationale: row.entry_rationale,
    outcome: row.outcome,
    pnl: row.pnl === null ? null : Number(row.pnl),
    revengeFlag: row.revenge_flag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerTradeRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /users/:userId/trades ──────────────────────────────────────────
  app.post<{ Body: TradeInput; Params: { userId: string } }>(
    "/users/:userId/trades",
    { preHandler: [authMiddleware, tenancyMiddleware] },
    async (request, reply) => {
      const traceId = request.appContext?.traceId ?? "unknown";
      const { tradeId, userId } = request.body;

      // ── Step 1: Pre-fetch previous state ────────────────────────────────
      const existing = await query<{ status: string; event_emitted: boolean }>(
        "SELECT status, event_emitted FROM trades WHERE trade_id = $1",
        [tradeId],
      );
      const previousStatus = existing.rows[0]?.status ?? null;
      const alreadyEmitted = existing.rows[0]?.event_emitted ?? false;

      // ── Step 2: Controlled upsert with insert detection ─────────────────
      const upsertResult = await query<TradeRow>(
        `
        INSERT INTO trades (
          trade_id, user_id, session_id, asset, asset_class, direction,
          entry_price, exit_price, quantity, entry_at, exit_at, status,
          plan_adherence, emotional_state, entry_rationale
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15
        )
        ON CONFLICT (trade_id) DO UPDATE SET
          status = EXCLUDED.status,
          exit_price = COALESCE(EXCLUDED.exit_price, trades.exit_price),
          exit_at = COALESCE(EXCLUDED.exit_at, trades.exit_at),
          updated_at = NOW()
        RETURNING *, (xmax = 0) AS is_insert
        `,
        [
          tradeId,
          userId,
          request.body.sessionId,
          request.body.asset,
          request.body.assetClass,
          request.body.direction,
          request.body.entryPrice,
          request.body.exitPrice ?? null,
          request.body.quantity,
          request.body.entryAt,
          request.body.exitAt ?? null,
          request.body.status,
          request.body.planAdherence ?? null,
          request.body.emotionalState ?? null,
          request.body.entryRationale ?? null,
        ],
      );

      const row = upsertResult.rows[0];

      if (!row) {
        throw Object.assign(new Error("Trade could not be persisted."), {
          statusCode: 500,
          errorCode: "TRADE_WRITE_FAILED",
        });
      }

      const isInsert = row.is_insert;
      const isNowClosed = row.status === "closed";
      const wasClosedBefore = previousStatus === "closed";
      const httpStatus = isInsert ? 201 : 200;

      // ── Step 3: Log trade write ─────────────────────────────────────────
      logger.info({
        event: "TRADE_WRITE",
        traceId,
        tradeId,
        userId,
        status: row.status,
        idempotent: !isInsert,
        isInsert,
      });

      // ── Step 4: Determine emission decision ─────────────────────────────
      let decision: "emit" | "skip" = "skip";
      let reason: string;

      if (!isNowClosed) {
        reason = "status_not_closed";
      } else if (alreadyEmitted) {
        reason = "already_closed";
      } else if (isInsert) {
        decision = "emit";
        reason = "insert_closed";
      } else if (!wasClosedBefore) {
        decision = "emit";
        reason = "transition_closed";
      } else {
        reason = "already_closed";
      }

      logger.info({
        event: "WRITE_DECISION",
        traceId,
        tradeId,
        isInsert,
        isNowClosed,
        wasClosedBefore,
        alreadyEmitted,
        decision,
        reason,
      });

      // ── Step 5: Atomic claim + fire-and-forget emission ─────────────────
      if (decision === "emit") {
        const claim = await query<{ trade_id: string }>(
          "UPDATE trades SET event_emitted = TRUE WHERE trade_id = $1 AND event_emitted = FALSE RETURNING trade_id",
          [tradeId],
        );
        const iOwnEmission = claim.rowCount === 1;

        if (iOwnEmission) {
          const eventId = randomUUID();

          setImmediate(async () => {
            try {
              const redis = getRedis();
              await redis.xadd(
                TRADE_EVENTS_STREAM,
                "*",
                "eventId", eventId,
                "type", "TRADE_CLOSED",
                "tradeId", row.trade_id,
                "userId", row.user_id,
                "sessionId", row.session_id,
                "timestamp", new Date().toISOString(),
                "traceId", traceId,
                "version", "1",
                "source", "api",
              );

              logger.info({
                event: "EVENT_EMITTED",
                traceId,
                eventId,
                tradeId: row.trade_id,
              });
            } catch (err) {
              logger.error({
                event: "EVENT_EMIT_FAILED",
                traceId,
                tradeId: row.trade_id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          });
        } else {
          logger.info({
            event: "EVENT_SKIPPED",
            traceId,
            tradeId,
            reason: "already_emitted_race",
          });
        }
      } else {
        logger.info({
          event: "EVENT_SKIPPED",
          traceId,
          tradeId,
          reason,
        });
      }

      return reply.status(httpStatus).send(toTradeResponse(row));
    },
  );

  // ── GET /users/:userId/trades/:tradeId ────────────────────────────────
  app.get<{ Params: { tradeId: string; userId: string } }>(
    "/users/:userId/trades/:tradeId",
    { preHandler: [authMiddleware, tenancyMiddleware] },
    async (request, reply) => {
      const result = await query<TradeRow>(
        "SELECT * FROM trades WHERE trade_id = $1",
        [request.params.tradeId],
      );
      const row = result.rows[0];

      if (!row) {
        throw Object.assign(
          new Error("Trade with the given tradeId does not exist."),
          { statusCode: 404, errorCode: "TRADE_NOT_FOUND" },
        );
      }

      return reply.status(200).send(toTradeResponse(row));
    },
  );
}
