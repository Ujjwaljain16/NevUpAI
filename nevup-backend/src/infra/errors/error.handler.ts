import { FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../logger";

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const traceId = request.appContext?.traceId ?? "unknown";

  logger.error({
    event: "ERROR",
    traceId,
    error: error.message,
    stack: error.stack, // Internal only
  });

  // Default to 500
  let statusCode = 500;
  let errorCode = "INTERNAL";
  let message = "Unexpected internal error.";

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

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  const traceId = request.appContext?.traceId ?? "unknown";

  reply.status(404).send({
    error: "NOT_FOUND",
    message: "Resource not found.",
    traceId,
  });
}
