import { createApp } from "./app";
import { env } from "./config/env";

// Minimal entry point for local development or simple server activation
// In production/orchestrated environments, the scripts/start-api.ts entry point is preferred
async function start(): Promise<void> {
  const app = createApp();
  await app.listen({ port: env.port, host: "0.0.0.0" });
}

void start();
