import { runMigrations } from "../infra/db/migrate";
import { closeDb } from "../infra/db/client";

// CLI utility for manual schema updates outside of standard startup flow
async function main(): Promise<void> {
  await runMigrations();
  await closeDb();
}

void main();
