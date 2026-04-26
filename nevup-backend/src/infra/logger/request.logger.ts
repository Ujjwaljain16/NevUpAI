import { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "./index";

// Observability hook: captures request metadata and performance metrics
// Essential for troubleshooting cross-tenant boundaries and system latency
export async function requestLogger(request: FastifyRequest, reply: FastifyReply) {
  const { traceId, userId, startTime } = request.appContext || {};
  const latency = startTime ? Date.now() - startTime : undefined;

  // Emits structured log to satisfy operational visibility requirements
  logger.info({
    traceId,
    userId: userId ?? null,
    latency,
    statusCode: reply.statusCode,
    method: request.method,
    route: request.routeOptions.url,
    path: request.url,
  });
}
