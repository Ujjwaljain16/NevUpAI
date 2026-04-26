import { FastifyReply, FastifyRequest } from "fastify";

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
