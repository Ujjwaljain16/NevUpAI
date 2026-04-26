import { runMigrations } from "../infra/db/migrate";
import { connectRedis } from "../infra/redis/client";
import { checkDbHealth, query } from "../infra/db/client";
import { logger } from "../infra/logger";
import { runSeed } from "../../seeds/seed";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Blocks execution until critical infrastructure (DB/Redis) is reachable
// Prevents container crash loops during orchestrated startups (e.g. Docker Compose)
export async function waitForInfrastructure(maxAttempts = 20): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await query("SELECT 1");
      await connectRedis();

      const dbState = await checkDbHealth();
      if (dbState !== "connected") {
        throw new Error("DB disconnected");
      }

      return;
    } catch (error) {
      logger.warn({
        attempt,
        maxAttempts,
        message: "Waiting for DB and Redis to become available",
        error: error instanceof Error ? error.message : String(error),
      });

      if (attempt === maxAttempts) {
        throw new Error("Startup checks failed: DB or Redis is not reachable.");
      }
      await sleep(2000);
    }
  }
}

// Ensures the database schema is up-to-date and populated with baseline data
export async function prepareDatabase(): Promise<void> {
  await runMigrations();
  await runSeed();
}
