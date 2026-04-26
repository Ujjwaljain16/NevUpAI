import request from "supertest";
import { createApp } from "../../src/app";
import { connectRedis, disconnectRedis } from "../../src/infra/redis/client";

// Validates the deep-health endpoint which verifies both DB and Redis connectivity
describe("Health Integration", () => {
  let app: any;

  beforeAll(async () => {
    app = createApp();
    await app.ready();
    await connectRedis();
  });

  afterAll(async () => {
    await app.close();
    await disconnectRedis();
  });

  // Intent: ensure the API correctly reports operational status when all dependencies are reachable
  it("should return 200 and connected status when services are up", async () => {
    const res = await request(app.server).get("/health");

    if (res.status !== 200) {
      console.log("Health Check Failed Body:", res.body);
    }

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.dbConnection).toBe("connected");
    expect(typeof res.body.queueLag).toBe("number");
  });
});
