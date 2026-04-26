import { createApp } from "./app";
import { env } from "./config/env";

async function start(): Promise<void> {
  const app = createApp();
  await app.listen({ port: env.port, host: "0.0.0.0" });
}

void start();
