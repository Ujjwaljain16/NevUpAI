import Fastify from "fastify";
import { traceMiddleware } from "./infra/logger/trace.middleware";
import { requestLogger } from "./infra/logger/request.logger";
import { errorHandler, notFoundHandler } from "./infra/errors/error.handler";
import { registerHealthRoutes } from "./modules/health/routes";
import { registerTradeRoutes } from "./modules/trades/routes";
import { registerMetricRoutes } from "./modules/metrics/routes";
import { registerSessionRoutes } from "./modules/sessions/routes";

// Composition root: assembles core infrastructure, global middleware, and feature modules
export function createApp() {
  const app = Fastify({ logger: false });

  // Global hooks for unified observability across all endpoints
  app.addHook("onRequest", traceMiddleware);
  app.addHook("onResponse", requestLogger);

  // Standardized error handling ensures predictable client interactions and trace persistence
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // Modular route registration
  app.register(registerHealthRoutes);
  app.register(registerTradeRoutes);
  app.register(registerMetricRoutes);
  app.register(registerSessionRoutes);

  return app;
}
