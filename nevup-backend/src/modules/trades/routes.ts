import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { query } from "../../infra/db/client";
import { logger } from "../../infra/logger";
import { getRedis, TRADE_EVENTS_STREAM } from "../../infra/redis/client";
import { authMiddleware } from "../auth/auth.middleware";
import { tenancyMiddleware } from "../auth/tenancy.middleware";
import { TradeRow, TradeInput } from "../../types/database";

// Encapsulates business rules for calculating final trade outcomes and performance delta (PnL)
function deriveOutcomeAndPnl(input: TradeInput): {
  outcome: "win" | "loss" | null;
  pnl: number | null;
} {
  if (input.status !== "closed") {
    return { outcome: null, pnl: null };
  }

  if (input.exitPrice === null || input.exitPrice === undefined) {
    throw Object.assign(new Error("'exitPrice' is required when status is 'closed'"), {
      statusCode: 400,
      errorCode: "BAD_REQUEST",
    });
  }

  if (!input.exitAt) {
    throw Object.assign(new Error("'exitAt' is required when status is 'closed'"), {
      statusCode: 400,
      errorCode: "BAD_REQUEST",
    });
  }

  const rawPnl =
    input.direction === "long"
      ? (input.exitPrice - input.entryPrice) * input.quantity
      : (input.entryPrice - input.exitPrice) * input.quantity;

  const pnl = Number(rawPnl.toFixed(8));
  const outcome = pnl > 0 ? "win" : "loss";

  return { outcome, pnl };
}

// Canonical mapping of database rows to public API surface
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

export async function registerTradeRoutes(app: FastifyInstance): Promise<void> {

  // Primary entry point for trade capture. Implements idempotent writes to handle client retries safely.
  app.post<{ Body: TradeInput }>(
    "/trades",
    {
      preHandler: [authMiddleware, tenancyMiddleware],
      schema: {
        body: {
          type: "object",
          required: [
            "tradeId",
            "userId",
            "sessionId",
            "asset",
            "assetClass",
            "direction",
            "entryPrice",
            "quantity",
            "entryAt",
            "status",
          ],
          properties: {
            tradeId: { type: "string", format: "uuid" },
            userId: { type: "string", format: "uuid" },
            sessionId: { type: "string", format: "uuid" },
            asset: { type: "string", minLength: 1 },
            assetClass: { type: "string", enum: ["equity", "crypto", "forex"] },
            direction: { type: "string", enum: ["long", "short"] },
            entryPrice: { type: "number" },
            exitPrice: { type: ["number", "null"] },
            quantity: { type: "number", exclusiveMinimum: 0 },
            entryAt: { type: "string", format: "date-time" },
            exitAt: { type: ["string", "null"], format: "date-time" },
            status: { type: "string", enum: ["open", "closed", "cancelled"] },
            planAdherence: { type: ["integer", "null"], minimum: 1, maximum: 5 },
            emotionalState: {
              type: ["string", "null"],
              enum: ["calm", "anxious", "greedy", "fearful", "neutral", null],
            },
            entryRationale: { type: ["string", "null"], maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const traceId = request.appContext?.traceId ?? "unknown";
      const { tradeId, userId } = request.body;
      const { outcome, pnl } = deriveOutcomeAndPnl(request.body);

      // Idempotent upsert: ensures duplicate client retries do not create multiple trades
      let upsertResult = await query<TradeRow & { is_insert?: boolean }>(
        `
        INSERT INTO trades (
          trade_id, user_id, session_id, asset, asset_class, direction,
          entry_price, exit_price, quantity, entry_at, exit_at, status,
          plan_adherence, emotional_state, entry_rationale, outcome, pnl
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17
        )
        ON CONFLICT (trade_id) DO NOTHING
        RETURNING *, true AS is_insert
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
          outcome,
          pnl,
        ],
      );

      // Best-effort retrieval if the trade already existed (standard idempotent behavior)
      if (upsertResult.rowCount === 0) {
        upsertResult = await query<TradeRow & { is_insert?: boolean }>(
          "SELECT *, false AS is_insert FROM trades WHERE trade_id = $1",
          [tradeId],
        );
      }

      const row = upsertResult.rows[0];
      if (!row) {
        throw Object.assign(new Error("Trade could not be persisted."), {
          statusCode: 500,
          errorCode: "TRADE_WRITE_FAILED",
        });
      }

      const isInsert = row.is_insert;
      const alreadyEmitted = row.event_emitted;
      const isNowClosed = row.status === "closed";
      const httpStatus = isInsert ? 201 : 200;

      logger.info({
        event: "TRADE_WRITE",
        traceId,
        tradeId,
        userId,
        status: row.status,
        idempotent: !isInsert,
        isInsert,
      });

      // Determines if a background metric calculation event is required
      let decision: "emit" | "skip" = "skip";
      let reason: string;

      if (!isNowClosed) {
        reason = "status_not_closed";
      } else if (alreadyEmitted) {
        reason = "already_closed";
      } else {
        decision = "emit";
        reason = isInsert ? "insert_closed" : "closed_not_emitted";
      }

      logger.info({
        event: "WRITE_DECISION",
        traceId,
        tradeId,
        isInsert,
        isNowClosed,
        alreadyEmitted,
        decision,
        reason,
      });

      // Atomic claim + fire-and-forget emission ensures we process each 'closed' transition exactly once
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

              // Revert claim to allow subsequent retry or background sweep
              await query(
                "UPDATE trades SET event_emitted = FALSE WHERE trade_id = $1",
                [row.trade_id],
              );
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

  // Point-in-time retrieval of trade state with tenancy enforcement
  app.get<{ Params: { tradeId: string } }>(
    "/trades/:tradeId",
    { preHandler: [authMiddleware] },
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

      if (row.user_id !== request.user?.userId) {
        throw Object.assign(new Error("Cross-tenant access denied"), {
          statusCode: 403,
          errorCode: "FORBIDDEN",
        });
      }

      return reply.status(200).send(toTradeResponse(row));
    },
  );
}
