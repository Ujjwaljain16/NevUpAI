import { FastifyInstance } from "fastify";
import { checkDbHealth } from "../../infra/db/client";
import { checkRedisHealth, getQueueLag } from "../../infra/redis/client";

// Registers deep-health monitoring endpoints to verify infrastructure availability
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/health",
    {
      // Open endpoint ensures external monitoring tools (e.g. Docker, K8s) can verify status
      config: { auth: false },
    },
    async (_request, reply) => {
      // Parallel checks minimize latency for monitoring probes
      const [dbConnection, redisConnection, queueLag] = await Promise.all([
        checkDbHealth(),
        checkRedisHealth(),
        getQueueLag(),
      ]);

      // System is only 'ok' if all critical storage layers are fully reachable
      const healthy = dbConnection === "connected" && redisConnection === "connected";
      const status = healthy ? "ok" : "degraded";

      return reply.status(healthy ? 200 : 503).send({
        status,
        dbConnection,
        queueLag,
        timestamp: new Date().toISOString(),
      });
    },
  );
}
