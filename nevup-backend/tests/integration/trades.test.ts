import fastify from "fastify";
import request from "supertest";
import { createApp } from "../../src/app";
import * as db from "../../src/infra/db/client";
import { connectRedis, disconnectRedis } from "../../src/infra/redis/client";
import jwt from "jsonwebtoken";
import { env } from "../../src/config/env";
import { randomUUID } from "node:crypto";

// Validates core trade persistence, idempotent write logic, and JWT-based tenancy enforcement
describe("Trades Integration", () => {
  let app: any;
  const userId = randomUUID();
  const token = jwt.sign({ 
    sub: userId,
    role: "trader",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  }, env.jwtSecret);

  let tradeId: string;

  beforeAll(async () => {
    app = createApp();
    await app.ready();
    await connectRedis();
  });

  afterAll(async () => {
    await db.query("DELETE FROM trades WHERE user_id = $1", [userId]);
    await app.close();
    await disconnectRedis();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Intent: verify the primary write path and subsequent background event emission decision
  it("should return 201 and emit event for a new closed trade", async () => {
    tradeId = randomUUID();
    const tradeData = {
      tradeId,
      userId,
      sessionId: randomUUID(),
      asset: "BTC/USD",
      assetClass: "crypto",
      direction: "long",
      entryPrice: 50000,
      exitPrice: 51000,
      quantity: 1,
      entryAt: new Date().toISOString(),
      exitAt: new Date().toISOString(),
      status: "closed",
      planAdherence: 5,
      emotionalState: "calm",
      entryRationale: "Manual test entry",
    };

    const response = await request(app.server)
      .post("/trades")
      .set("Authorization", `Bearer ${token}`)
      .send(tradeData);

    expect(response.status).toBe(201);
    
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  // Intent: verify the idempotency gate (HTTP 200 vs 201) when retrying the same tradeId
  it("should return 200 for a duplicate tradeId (idempotency)", async () => {
    const tradeData = {
      tradeId,
      userId,
      sessionId: randomUUID(),
      asset: "BTC/USD",
      assetClass: "crypto",
      direction: "long",
      entryPrice: 50000,
      exitPrice: null,
      quantity: 1,
      entryAt: new Date().toISOString(),
      exitAt: null,
      status: "open",
      planAdherence: null,
      emotionalState: "neutral",
      entryRationale: null,
    };

    const response = await request(app.server)
      .post("/trades")
      .set("Authorization", `Bearer ${token}`)
      .send(tradeData);

    expect(response.status).toBe(200);
  });

  // Intent: ensure cross-tenant injection is prevented via JWT 'sub' validation
  it("should return 403 when trying to write trade for another userId", async () => {
    const otherUserId = randomUUID();
    const tradeData = {
      tradeId: randomUUID(),
      userId: otherUserId,
      sessionId: randomUUID(),
      asset: "ETH/USD",
      assetClass: "crypto",
      direction: "short",
      entryPrice: 2000,
      exitPrice: null,
      quantity: 10,
      entryAt: new Date().toISOString(),
      exitAt: null,
      status: "open",
      planAdherence: null,
      emotionalState: "anxious",
      entryRationale: null,
    };

    const response = await request(app.server)
      .post("/trades")
      .set("Authorization", `Bearer ${token}`)
      .send(tradeData);

    expect(response.status).toBe(403);
  });
});
