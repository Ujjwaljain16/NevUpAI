import { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../../infra/logger";

// Enforces strict tenancy boundaries by matching requested resources against the authenticated user
export async function tenancyMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // Checks all possible input vectors for userId to ensure exhaustive coverage
  const paramsUserId = (request.params as Record<string, string>)?.userId;
  const bodyUserId = (request.body as Record<string, string>)?.userId;
  const queryUserId = (request.query as Record<string, string>)?.userId;

  const rawSources = [
    { value: paramsUserId, source: "params" },
    { value: bodyUserId, source: "body" },
    { value: queryUserId, source: "query" }
  ];

  const sources = rawSources.filter(s => s.value);
  const uniqueValues = new Set(sources.map(s => s.value));

  // Denies requests that cannot be tied to a specific tenant
  if (sources.length === 0) {
    throw Object.assign(new Error("Missing userId for tenancy check"), { statusCode: 400 });
  }

  // Prevents injection attacks where different IDs are passed in different parts of the request
  if (uniqueValues.size > 1) {
    logger.warn({
      event: "TENANCY_AMBIGUITY",
      traceId: request.appContext?.traceId,
      sources: sources.map(s => ({ source: s.source, value: s.value })),
      message: "Conflicting userId sources detected",
    });
    throw Object.assign(new Error("Conflicting userId sources for tenancy check"), { statusCode: 400 });
  }

  if (sources.length > 1 && uniqueValues.size === 1) {
    logger.info({
      event: "TENANCY_DUPLICATE_SOURCE",
      paramsUserId,
      bodyUserId,
      queryUserId,
      resolution: "matched",
      traceId: request.appContext?.traceId,
    });
  }

  const targetUserId = sources[0].value;

  // The core invariant: authenticated userId must exactly match the resource-scoped userId
  if (request.user?.userId !== targetUserId) {
    throw Object.assign(new Error("Cross-tenant access denied"), { statusCode: 403 });
  }

  // Audits the successful resolution of tenancy for the request lifecycle
  logger.info({
    event: "TENANCY_RESOLUTION",
    source: sources[0].source,
    userId: targetUserId,
    traceId: request.appContext?.traceId,
  });
}
