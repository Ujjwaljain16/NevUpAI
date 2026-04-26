import { FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";

export async function traceMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const headerTrace = request.headers["x-trace-id"];
  const traceId = typeof headerTrace === "string" && headerTrace.length > 0 ? headerTrace : randomUUID();
  
  request.appContext = {
    traceId,
    userId: null,
    startTime: Date.now(),
  };

  reply.header("X-Trace-Id", traceId);
}
