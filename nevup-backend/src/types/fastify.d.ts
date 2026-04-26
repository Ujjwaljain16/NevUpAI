import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    appContext: {
      traceId: string;
      userId: string | null;
      startTime: number;
    };
    user?: {
      userId: string;
      role: string;
      iat: number;
      exp: number;
    };
  }
}
