import { runMigrations } from "../infra/db/migrate";
import { closeDb } from "../infra/db/client";

async function main(): Promise<void> {
  await runMigrations();
  await closeDb();
}

void main();
