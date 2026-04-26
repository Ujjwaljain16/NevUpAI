import "fastify";

declare module "fastify" {
  // Extends the base FastifyRequest to include cross-cutting system concerns
  interface FastifyRequest {
    // appContext enables unified tracing and performance monitoring across the request lifecycle
    appContext: {
      traceId: string;
      userId: string | null;
      startTime: number;
    };
    // user stores the validated identity from the JWT payload for tenancy enforcement
    user?: {
      userId: string;
      role: string;
      iat: number;
      exp: number;
    };
  }
}
