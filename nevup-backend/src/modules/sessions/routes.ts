import { FastifyInstance } from "fastify";
import { authMiddleware } from "../auth/auth.middleware";
import { tenancyMiddleware } from "../auth/tenancy.middleware";

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  // All session routes are implicitly user-data, but we need userId in the path
  // to use tenancyMiddleware easily. If we stick to /sessions/:sessionId,
  // we would need a separate tenancy check that looks up the session's owner.
  // For Phase 1 normalization, we use /users/:userId/sessions/...
  
  app.get(
    "/users/:userId/sessions/:sessionId",
    {
      preHandler: [authMiddleware, tenancyMiddleware],
    },
    async (request, reply) => {
      return reply.status(200).send({
        sessionId: (request.params as any).sessionId,
        userId: (request.params as any).userId,
        trades: [],
      });
    }
  );

  app.post(
    "/users/:userId/sessions/:sessionId/debrief",
    {
      preHandler: [authMiddleware, tenancyMiddleware],
    },
    async (request, reply) => {
      return reply.status(201).send({
        debriefId: "placeholder",
        sessionId: (request.params as any).sessionId,
        savedAt: new Date().toISOString(),
      });
    }
  );

  app.get(
    "/users/:userId/sessions/:sessionId/coaching",
    {
      preHandler: [authMiddleware, tenancyMiddleware],
    },
    async (request, reply) => {
      // SSE placeholder
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.write("event: done\ndata: {\"fullMessage\": \"AI Coaching placeholder\"}\n\n");
      return reply.raw.end();
    }
  );
}
