import fs from "node:fs/promises";
import path from "node:path";
import { query } from "./client";

// Tracking table for idempotent schema updates
async function ensureMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// Executes pending SQL migrations in sorted order
export async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();

  const migrationsDir = path.resolve(process.cwd(), "migrations");
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const alreadyApplied = await query<{ filename: string }>(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      [file],
    );
    if (alreadyApplied.rowCount) {
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    
    // Transactions ensure atomic migration application
    await query("BEGIN");
    try {
      await query(sql);
      await query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await query("COMMIT");
    } catch (error) {
      await query("ROLLBACK");
      throw error;
    }
  }
}
