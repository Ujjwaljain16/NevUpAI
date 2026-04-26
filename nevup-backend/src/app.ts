import Fastify from "fastify";
import { traceMiddleware } from "./infra/logger/trace.middleware";
import { requestLogger } from "./infra/logger/request.logger";
import { errorHandler, notFoundHandler } from "./infra/errors/error.handler";
import { registerHealthRoutes } from "./modules/health/routes";
import { registerTradeRoutes } from "./modules/trades/routes";
import { registerMetricRoutes } from "./modules/metrics/routes";
import { registerSessionRoutes } from "./modules/sessions/routes";

export function createApp() {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", traceMiddleware);
  app.addHook("onResponse", requestLogger);

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  app.register(registerHealthRoutes);
  app.register(registerTradeRoutes);
  app.register(registerMetricRoutes);
  app.register(registerSessionRoutes);

  return app;
}
