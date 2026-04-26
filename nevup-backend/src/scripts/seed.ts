import { closeDb } from "../infra/db/client";
import { runSeed } from "../../seeds/seed";

// CLI utility for manual data seeding during development or testing
async function main(): Promise<void> {
  await runSeed();
  await closeDb();
}

void main();
