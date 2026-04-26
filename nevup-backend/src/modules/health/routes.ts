import { FastifyInstance } from "fastify";
import { checkDbHealth } from "../../infra/db/client";
import { checkRedisHealth, getQueueLag } from "../../infra/redis/client";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/health",
    {
      config: { auth: false },
    },
    async (_request, reply) => {
      const [dbConnection, redisConnection, queueLag] = await Promise.all([
        checkDbHealth(),
        checkRedisHealth(),
        getQueueLag(),
      ]);

      const healthy = dbConnection === "connected" && redisConnection === "connected";
      const status = healthy ? "ok" : "degraded";

      return reply.status(healthy ? 200 : 503).send({
        status,
        db: dbConnection,
        redis: redisConnection,
        queueLag,
        timestamp: new Date().toISOString(),
      });
    },
  );
}
