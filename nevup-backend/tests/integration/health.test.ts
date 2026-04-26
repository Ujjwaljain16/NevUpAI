import request from "supertest";
import { createApp } from "../../src/app";
import { connectRedis, disconnectRedis } from "../../src/infra/redis/client";

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

  it("should return 200 and connected status when services are up", async () => {
    const res = await request(app.server).get("/health");

    if (res.status !== 200) {
      console.log("Health Check Failed Body:", res.body);
    }

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db).toBe("connected");
    expect(res.body.redis).toBe("connected");
    expect(typeof res.body.queueLag).toBe("number");
  });
});
