import { Pool, QueryResult, QueryResultRow } from "pg";
import { env } from "../../config/env";
import { logger } from "../logger";

// Main connection pool for PostgreSQL
const pool = new Pool({
  connectionString: env.databaseUrl,
  // 17 connections: (2 * 8 CPU cores + 1) for optimal hackathon infra throughput
  max: 17, 
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000, // 5s query timeout as per global resilience rule
});

// Logs fatal errors within the connection pool
pool.on("error", (error) => {
  logger.error({
    message: "PostgreSQL pool error",
    error: error.message,
  });
});

// Helper for standard SQL queries
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

// Access to raw pool for specialized operations (e.g. manual connection control)
export function getPool(): Pool {
  return pool;
}

// Validates database connectivity
export async function checkDbHealth(): Promise<"connected" | "disconnected"> {
  try {
    await pool.query("SELECT 1");
    return "connected";
  } catch {
    return "disconnected";
  }
}

// Gracefully shuts down the connection pool
export async function closeDb(): Promise<void> {
  await pool.end();
}
