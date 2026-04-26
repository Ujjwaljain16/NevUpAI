import { FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";

// Initializes the request-scoped context to enable distributed tracing across service boundaries
export async function traceMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // Prefer upstream trace IDs for observability across multiple hops (e.g. Gateway → API)
  const headerTrace = request.headers["x-trace-id"];
  const traceId = typeof headerTrace === "string" && headerTrace.length > 0 ? headerTrace : randomUUID();
  
  // Attaches trace state to the request object to ensure subsequent logs share the same context
  request.appContext = {
    traceId,
    userId: null,
    startTime: Date.now(),
  };

  // Propagates the trace ID back to the client for support and debugging reference
  reply.header("X-Trace-Id", traceId);
}
