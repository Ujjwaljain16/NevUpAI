import { createApp } from "../app";
import { env } from "../config/env";
import { query } from "../infra/db/client";
import { logger } from "../infra/logger";
import { checkRedisHealth } from "../infra/redis/client";
import { checkDbHealth } from "../infra/db/client";
import { prepareDatabase, waitForInfrastructure } from "./bootstrap";

async function start(): Promise<void> {
  await waitForInfrastructure();
  await prepareDatabase();

  const app = createApp();
  await app.listen({ host: "0.0.0.0", port: env.port });

  logger.info({ message: "API started", port: env.port });

  const [db, redis, seedCounts] = await Promise.all([
    checkDbHealth(),
    checkRedisHealth(),
    query<{ trades: string; users: string }>(
      "SELECT COUNT(*)::text AS trades, COUNT(DISTINCT user_id)::text AS users FROM trades",
    ),
  ]);

  const counts = seedCounts.rows[0] ?? { trades: "0", users: "0" };

  logger.info({
    event: "SYSTEM_READY",
    services: {
      api: "up",
      db,
      redis,
      worker: "running",
    },
    seed: {
      trades: Number(counts.trades),
      users: Number(counts.users),
    },
  });
}

void start();
