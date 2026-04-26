import { FastifyInstance } from "fastify";
import { authMiddleware } from "../auth/auth.middleware";
import { tenancyMiddleware } from "../auth/tenancy.middleware";

export async function registerMetricRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/users/:userId/metrics",
    {
      preHandler: [authMiddleware, tenancyMiddleware],
    },
    async (request, reply) => {
      // Phase 1+ implementation will go here.
      return reply.status(200).send({
        userId: (request.params as any).userId,
        timeseries: [],
      });
    }
  );

  app.get(
    "/users/:userId/profile",
    {
      preHandler: [authMiddleware, tenancyMiddleware],
    },
    async (request, reply) => {
      return reply.status(200).send({
        userId: (request.params as any).userId,
        dominantPathologies: [],
      });
    }
  );
}
