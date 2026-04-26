import { FastifyInstance } from "fastify";
import { query } from "../../infra/db/client";
import { getRedis, TRADE_EVENTS_STREAM } from "../../infra/redis/client";
import { authMiddleware } from "../auth/auth.middleware";
import { tenancyMiddleware } from "../auth/tenancy.middleware";

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
  created_at: string;
  updated_at: string;
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

async function publishCloseEvent(row: TradeRow): Promise<void> {
  if (row.status !== "closed") {
    return;
  }

  const redis = getRedis();
  await redis.xadd(
    TRADE_EVENTS_STREAM,
    "*",
    "eventType",
    "trade.closed",
    "tradeId",
    row.trade_id,
    "userId",
    row.user_id,
    "sessionId",
    row.session_id,
    "closedAt",
    row.exit_at ?? row.updated_at,
  );
}

export async function registerTradeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: TradeInput, Params: { userId: string } }>(
    "/users/:userId/trades",
    { preHandler: [authMiddleware, tenancyMiddleware] },
    async (request, reply) => {

    const insertResult = await query<TradeRow>(
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
      ON CONFLICT (trade_id) DO NOTHING
      RETURNING *;
      `,
      [
        request.body.tradeId,
        request.body.userId,
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

    let row: TradeRow | undefined = insertResult.rows[0];
    if (!row) {
      const existing = await query<TradeRow>("SELECT * FROM trades WHERE trade_id = $1", [request.body.tradeId]);
      row = existing.rows[0];
    }

    if (!row) {
      throw Object.assign(new Error("Trade could not be persisted."), { statusCode: 500, errorCode: "TRADE_WRITE_FAILED" });
    }

    await publishCloseEvent(row);
    return reply.status(200).send(toTradeResponse(row));
  });

  app.get<{ Params: { tradeId: string, userId: string } }>(
    "/users/:userId/trades/:tradeId",
    { preHandler: [authMiddleware, tenancyMiddleware] },
    async (request, reply) => {
      const result = await query<TradeRow>("SELECT * FROM trades WHERE trade_id = $1", [request.params.tradeId]);
      const row = result.rows[0];

      if (!row) {
        throw Object.assign(new Error("Trade with the given tradeId does not exist."), { statusCode: 404, errorCode: "TRADE_NOT_FOUND" });
      }

    return reply.status(200).send(toTradeResponse(row));
  });
}
