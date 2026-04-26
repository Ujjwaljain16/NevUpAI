import { FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../logger";

// Standardizes error responses across the system to ensure consistent client-side handling
// and provides trace mapping for backend debugging.
export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const traceId = request.appContext?.traceId ?? "unknown";

  // Logs the full stack trace internally for auditability without leaking details to the client
  logger.error({
    event: "ERROR",
    traceId,
    error: error.message,
    stack: error.stack,
  });

  // Default fallback prevents leaking raw infrastructure errors to the end-user
  let statusCode = 500;
  let errorCode = "INTERNAL";
  let message = "Unexpected internal error.";

  // Maps internal Fastify/Schema errors to well-defined public API contracts
  if (error.statusCode) {
    statusCode = error.statusCode;
    if (statusCode === 400) {
      errorCode = "BAD_REQUEST";
      message = error.message;
    } else if (statusCode === 401) {
      errorCode = "UNAUTHORIZED";
      message = error.message;
    } else if (statusCode === 403) {
      errorCode = "FORBIDDEN";
      message = error.message;
    } else if (statusCode === 404) {
      errorCode = "NOT_FOUND";
      message = error.message || "Resource not found.";
    }
  }

  reply.status(statusCode).send({
    error: errorCode,
    message,
    traceId,
  });
}

// Explicitly handles missing routes to maintain uniform 404 behavior and trace propagation
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  const traceId = request.appContext?.traceId ?? "unknown";

  reply.status(404).send({
    error: "NOT_FOUND",
    message: "Resource not found.",
    traceId,
  });
}
