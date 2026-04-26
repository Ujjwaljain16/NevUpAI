import { closeDb } from "../infra/db/client";
import { runSeed } from "../../seeds/seed";

async function main(): Promise<void> {
  await runSeed();
  await closeDb();
}

void main();
