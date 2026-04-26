import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../../src/app";
import { query } from "../../src/infra/db/client";
import { connectRedis, disconnectRedis } from "../../src/infra/redis/client";
import jwt from "jsonwebtoken";
import { env } from "../../src/config/env";

// Validates session lifecycle management, post-session reflection (debriefing), and tenancy boundaries
describe("Sessions Integration", () => {
  let app: any;
  const TEST_USER_ID = randomUUID();
  const TOKEN = jwt.sign({ 
    sub: TEST_USER_ID,
    role: "trader",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  }, env.jwtSecret);
  const SESSION_ID = randomUUID();
  const OTHER_USER_ID = randomUUID();
  const OTHER_TOKEN = jwt.sign({
    sub: OTHER_USER_ID,
    role: "trader",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }, env.jwtSecret);

  beforeAll(async () => {
    app = createApp();
    await app.ready();
    await connectRedis();

    // Intent: verify that a session is correctly derived from its constituent trades
    await query(
      `INSERT INTO trades (
        trade_id, user_id, session_id, asset, asset_class, direction, entry_price, quantity, entry_at, status, outcome, pnl
      ) VALUES ($1, $2, $3, 'ETH', 'crypto', 'long', 2000, 1, '2025-01-05T10:00:00Z', 'closed', 'win', 100)`,
      [randomUUID(), TEST_USER_ID, SESSION_ID]
    );
  });

  afterAll(async () => {
    await query("DELETE FROM session_debriefs WHERE user_id = $1", [TEST_USER_ID]);
    await query("DELETE FROM trades WHERE user_id = $1", [TEST_USER_ID]);
    await app.close();
    await disconnectRedis();
  });

  it("should get session summary", async () => {
    const res = await request(app.server)
      .get(`/sessions/${SESSION_ID}`)
      .set("Authorization", `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(SESSION_ID);
    expect(res.body.totalPnl).toBe(100);
    expect(res.body.trades).toHaveLength(1);
  });

  it("should submit and persist a debrief", async () => {
    const payload = {
      overallMood: "calm",
      keyMistake: "None today",
      keyLesson: "Stick to the plan works",
      planAdherenceRating: 5,
      willReviewTomorrow: true
    };

    const res = await request(app.server)
      .post(`/sessions/${SESSION_ID}/debrief`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.debriefId).toBeDefined();

    // Verify persistence in DB
    const dbResult = await query("SELECT * FROM session_debriefs WHERE session_id = $1", [SESSION_ID]);
    expect(dbResult.rowCount).toBe(1);
    expect(dbResult.rows[0].overall_mood).toBe("calm");
  });

  // Intent: ensure cross-tenant data leakage is prevented at the session level
  it("should return 403 when debriefing another user's session", async () => {
    const OTHER_SESSION_ID = randomUUID();
    
    await query(
      `INSERT INTO trades (
        trade_id, user_id, session_id, asset, asset_class, direction, entry_price, quantity, entry_at, status
      ) VALUES ($1, $2, $3, 'BTC', 'crypto', 'short', 40000, 1, NOW(), 'open')`,
      [randomUUID(), OTHER_USER_ID, OTHER_SESSION_ID]
    );

    const res = await request(app.server)
      .post(`/sessions/${OTHER_SESSION_ID}/debrief`)
      .set("Authorization", `Bearer ${TOKEN}`) 
      .send({ overallMood: "neutral", planAdherenceRating: 3 });

    expect(res.status).toBe(403);
  });

  it("should return 403 when fetching another user's session", async () => {
    const otherSessionId = randomUUID();
    const ownerUserId = randomUUID();

    await query(
      `INSERT INTO trades (
        trade_id, user_id, session_id, asset, asset_class, direction, entry_price, quantity, entry_at, status
      ) VALUES ($1, $2, $3, 'BTC', 'crypto', 'long', 30000, 1, NOW(), 'open')`,
      [randomUUID(), ownerUserId, otherSessionId],
    );

    const res = await request(app.server)
      .get(`/sessions/${otherSessionId}`)
      .set("Authorization", `Bearer ${TOKEN}`);

    expect(res.status).toBe(403);
  });

  it("should return 403 for cross-tenant coaching stream", async () => {
    const res = await request(app.server)
      .get(`/sessions/${SESSION_ID}/coaching`)
      .set("Authorization", `Bearer ${OTHER_TOKEN}`);

    expect(res.status).toBe(403);
  });
});
