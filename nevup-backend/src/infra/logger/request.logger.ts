import { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "./index";

export async function requestLogger(request: FastifyRequest, reply: FastifyReply) {
  const { traceId, userId, startTime } = request.appContext || {};
  const latency = startTime ? Date.now() - startTime : undefined;

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
