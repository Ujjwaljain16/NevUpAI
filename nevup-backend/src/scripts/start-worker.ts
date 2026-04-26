import { logger } from "../infra/logger";
import { prepareDatabase, waitForInfrastructure } from "./bootstrap";
import { startWorker } from "../worker";

// Entry point for the background metrics processor
// Ensures infrastructure is fully available before consuming the event stream
async function start(): Promise<void> {
  await waitForInfrastructure();
  await prepareDatabase();

  logger.info({ message: "Worker process starting" });
  await startWorker();
}

void start();
