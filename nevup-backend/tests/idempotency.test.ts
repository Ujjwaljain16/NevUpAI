import request from "supertest";
import { createApp } from "../src/app";
import * as db from "../src/infra/db/client";
import { randomUUID } from "node:crypto";

// Mock the DB and Redis clients
jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue("OK"),
    status: "ready",
  }));
});
jest.mock("../src/infra/db/client");
jest.mock("../src/infra/redis/client", () => ({
  getRedis: jest.fn().mockReturnValue({
    xadd: jest.fn().mockResolvedValue("ok"),
    status: "ready"
  }),
  TRADE_EVENTS_STREAM: "trade_events",
  connectRedis: jest.fn().mockResolvedValue(undefined),
  disconnectRedis: jest.fn().mockResolvedValue(undefined),
}));

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTEiLCJpYXQiOjE3NzcyMTk4OTIsImV4cCI6MTc3NzMwNjI5Miwicm9sZSI6InRyYWRlciJ9.ItXLhUHAXlIlq6KYC1MpK9camu4bmv2l9k1ehlSl0po';
const USER_ID = "11111111-1111-1111-1111-111111111111";

describe("Trade Idempotency", () => {
  let app: any;

  beforeAll(async () => {
    app = createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should return 201 for new trade and 200 for duplicate trade", async () => {
    const tradeId = randomUUID();
    const payload = {
      tradeId,
      userId: USER_ID,
      sessionId: randomUUID(),
      asset: "BTC",
      assetClass: "crypto",
      direction: "long",
      entryPrice: 50000,
      quantity: 1,
      entryAt: new Date().toISOString(),
      status: "open"
    };

    // 1. First submission (Mock returning a new row)
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] }); // pre-fetch existing
    (db.query as jest.Mock).mockResolvedValueOnce({
      rows: [{
        trade_id: tradeId,
        user_id: USER_ID,
        session_id: payload.sessionId,
        asset: payload.asset,
        asset_class: payload.assetClass,
        direction: payload.direction,
        entry_price: payload.entryPrice,
        quantity: payload.quantity,
        entry_at: payload.entryAt,
        status: payload.status,
        is_insert: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }],
      rowCount: 1
    });

    const res1 = await request(app.server)
      .post("/trades")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send(payload);

    expect(res1.status).toBe(201);
    expect(res1.body.tradeId).toBe(tradeId);

    // 2. Second submission (Mock conflict followed by SELECT)
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ status: 'open', event_emitted: false }] }); // 1. pre-fetch existing
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 0 }); // 2. INSERT ... DO NOTHING (conflicts)
    (db.query as jest.Mock).mockResolvedValueOnce({
      rows: [{
        trade_id: tradeId,
        user_id: USER_ID,
        session_id: payload.sessionId,
        asset: payload.asset,
        asset_class: payload.assetClass,
        direction: payload.direction,
        entry_price: payload.entryPrice,
        quantity: payload.quantity,
        entry_at: payload.entryAt,
        status: payload.status,
        is_insert: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }],
      rowCount: 1
    }); // 3. SELECT existing

    const res2 = await request(app.server)
      .post("/trades")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send(payload);

    expect(res2.status).toBe(200);
    expect(res2.body.tradeId).toBe(tradeId);
  });
});

describe("Multi-Tenancy", () => {
  let app: any;

  beforeAll(async () => {
    app = createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should return 403 for cross-tenant access", async () => {
    const tradeId = randomUUID();
    const otherUserId = "22222222-2222-2222-2222-222222222222";
    
    // Attempting to post a trade for User B using User A's token
    const res = await request(app.server)
      .post("/trades")
      .set("Authorization", `Bearer ${TOKEN}`) // TOKEN is for 11111111-...
      .send({
        tradeId,
        userId: otherUserId,
        sessionId: randomUUID(),
        asset: "BTC",
        assetClass: "crypto",
        direction: "long",
        entryPrice: 50000,
        quantity: 1,
        entryAt: new Date().toISOString(),
        status: "open"
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("FORBIDDEN");
  });
});
