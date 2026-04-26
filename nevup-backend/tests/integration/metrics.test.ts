import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../../src/app";
import { query } from "../../src/infra/db/client";
import { connectRedis, disconnectRedis } from "../../src/infra/redis/client";
import jwt from "jsonwebtoken";
import { env } from "../../src/config/env";

// Validates the behavior engine by verifying that the API correctly aggregates raw trades
// into the high-level psychological profiles and performance metrics
describe("Metrics Integration", () => {
  let app: any;
  const TEST_USER_ID = randomUUID();
  const TOKEN = jwt.sign({ 
    sub: TEST_USER_ID,
    role: "trader",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  }, env.jwtSecret);

  beforeAll(async () => {
    app = createApp();
    await app.ready();
    await connectRedis();

    // Intent: verify the system can correctly join static projections with real-time aggregates
    const sessionId = randomUUID();
    const trades = [
      { id: randomUUID(), status: 'closed', outcome: 'win', adherence: 5, entryAt: '2025-01-01T10:00:00Z', price: 100, qty: 1, pnl: 10, emotion: 'calm' },
      { id: randomUUID(), status: 'closed', outcome: 'loss', adherence: 3, entryAt: '2025-01-01T11:00:00Z', price: 105, qty: 1, pnl: -5, emotion: 'anxious' },
      { id: randomUUID(), status: 'closed', outcome: 'win', adherence: 4, entryAt: '2025-01-02T10:00:00Z', price: 110, qty: 1, pnl: 20, emotion: 'calm' },
    ];

    for (const t of trades) {
      await query(
        `INSERT INTO trades (
          trade_id, user_id, session_id, asset, asset_class, direction, entry_price, quantity, entry_at, status, outcome, plan_adherence, pnl, emotional_state
        ) VALUES ($1, $2, $3, 'BTC', 'crypto', 'long', $4, $5, $6, $7, $8, $9, $10, $11)`,
        [t.id, TEST_USER_ID, sessionId, t.price, t.qty, t.entryAt, t.status, t.outcome, t.adherence, t.pnl, t.emotion]
      );
    }

    await query(
      `INSERT INTO win_rate_by_emotion (user_id, emotional_state, wins, losses)
       VALUES
         ($1, 'calm', 2, 0),
         ($1, 'anxious', 0, 1)
       ON CONFLICT (user_id, emotional_state)
       DO UPDATE SET wins = EXCLUDED.wins, losses = EXCLUDED.losses`,
      [TEST_USER_ID],
    );

    await query(
      `INSERT INTO plan_adherence_scores (user_id, calculated_at, score)
       VALUES ($1, '2025-01-02T12:00:00Z', 4.0000)`,
      [TEST_USER_ID],
    );

    await query(
      `INSERT INTO session_tilt (user_id, session_id, tilt_index)
       VALUES ($1, $2, 0.5000)
       ON CONFLICT (user_id, session_id)
       DO UPDATE SET tilt_index = EXCLUDED.tilt_index`,
      [TEST_USER_ID, sessionId],
    );
  });

  afterAll(async () => {
    await query("DELETE FROM session_tilt WHERE user_id = $1", [TEST_USER_ID]);
    await query("DELETE FROM plan_adherence_scores WHERE user_id = $1", [TEST_USER_ID]);
    await query("DELETE FROM win_rate_by_emotion WHERE user_id = $1", [TEST_USER_ID]);
    await query("DELETE FROM trades WHERE user_id = $1", [TEST_USER_ID]);
    await app.close();
    await disconnectRedis();
  });

  it("should return correct metrics for the specified range", async () => {
    const from = "2025-01-01T00:00:00Z";
    const to = "2025-01-03T00:00:00Z";
    const res = await request(app.server)
      .get(`/users/${TEST_USER_ID}/metrics?from=${from}&to=${to}&granularity=daily`)
      .set("Authorization", `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(TEST_USER_ID);
    expect(res.body.planAdherenceScore).toBe(4); 
    expect(res.body.winRateByEmotionalState.calm.winRate).toBe(1); 
    expect(res.body.winRateByEmotionalState.anxious.winRate).toBe(0); 
    expect(res.body.timeseries).toHaveLength(2); 
    
    const jan1 = res.body.timeseries.find((t: any) => t.bucket.startsWith("2025-01-01"));
    expect(jan1.tradeCount).toBe(2);
    expect(jan1.winRate).toBe(0.5);
    expect(jan1.pnl).toBe(5); 
  });
});
