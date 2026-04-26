import { logger } from "../infra/logger";
import { prepareDatabase, waitForInfrastructure } from "./bootstrap";
import { startWorker } from "../worker";

async function start(): Promise<void> {
  await waitForInfrastructure();
  await prepareDatabase();

  logger.info({ message: "Worker process starting" });
  await startWorker();
}

void start();
