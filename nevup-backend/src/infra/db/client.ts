import { Pool, QueryResult, QueryResultRow } from "pg";
import { env } from "../../config/env";
import { logger } from "../logger";

const pool = new Pool({ connectionString: env.databaseUrl });

pool.on("error", (error) => {
  logger.error({
    message: "PostgreSQL pool error",
    error: error.message,
  });
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export function getPool(): Pool {
  return pool;
}

export async function checkDbHealth(): Promise<"connected" | "disconnected"> {
  try {
    await pool.query("SELECT 1");
    return "connected";
  } catch {
    return "disconnected";
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
