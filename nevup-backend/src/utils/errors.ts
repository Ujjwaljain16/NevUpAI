import { FastifyReply, FastifyRequest } from "fastify";

// Helper for manually triggering standardized error responses
// Ensures that all error paths—even those outside the main handler—propagate the traceId
export function replyWithError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  error: string,
  message: string,
): FastifyReply {
  return reply.status(statusCode).send({
    error,
    message,
    traceId: request.appContext?.traceId,
  });
}
