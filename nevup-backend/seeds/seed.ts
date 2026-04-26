import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { query, getPool } from "../src/infra/db/client";
import { logger } from "../src/infra/logger";
import {
  computeWinRateByEmotion,
  computePlanAdherence,
  computeSessionTilt,
  detectOvertrading
} from "../src/worker/metrics";

type SeedRow = {
  tradeId: string;
  userId: string;
  traderName: string;
  sessionId: string;
  asset: string;
  assetClass: "equity" | "crypto" | "forex";
  direction: "long" | "short";
  entryPrice: string;
  exitPrice: string;
  quantity: string;
  entryAt: string;
  exitAt: string;
  status: "open" | "closed" | "cancelled";
  outcome: "win" | "loss" | "";
  pnl: string;
  planAdherence: string;
  emotionalState: "calm" | "anxious" | "greedy" | "fearful" | "neutral" | "";
  entryRationale: string;
  revengeFlag: string;
  groundTruthPathologies: string;
};

// Finds the seed CSV file in expected locations
async function resolveSeedPath(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), "nevup_seed_dataset.csv"),
    path.resolve(process.cwd(), "..", "nevup_seed_dataset.csv"),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error("nevup_seed_dataset.csv not found in expected locations.");
}

// Main seeding logic: inserts trades and computes initial metrics
export async function runSeed(): Promise<void> {
  const filePath = await resolveSeedPath();
  const rawCsv = await fs.readFile(filePath, "utf8");
  const records = parse(rawCsv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as SeedRow[];

  const uniqueUsers = new Set<string>();
  const uniqueSessions = new Set<string>();
  const sessionTradeCounts = new Map<string, number>();
  let emotionalStateCount = 0;
  let planAdherenceCount = 0;
  const batchSize = 100;

  for (let i = 0; i < records.length; i += batchSize) {
    const chunk = records.slice(i, i + batchSize);
    for (const row of chunk) {
      uniqueUsers.add(row.userId);
      uniqueSessions.add(row.sessionId);

      const sessionKey = `${row.userId}:${row.sessionId}`;
      sessionTradeCounts.set(sessionKey, (sessionTradeCounts.get(sessionKey) ?? 0) + 1);

      if (row.emotionalState) {
        emotionalStateCount += 1;
      }

      if (row.planAdherence) {
        planAdherenceCount += 1;
      }

      await query(
        `
        INSERT INTO trades (
          trade_id, user_id, session_id, asset, asset_class, direction,
          entry_price, exit_price, quantity, entry_at, exit_at, status,
          plan_adherence, emotional_state, entry_rationale, outcome, pnl, revenge_flag
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18
        )
        ON CONFLICT (trade_id) DO NOTHING;
        `,
        [
          row.tradeId,
          row.userId,
          row.sessionId,
          row.asset,
          row.assetClass,
          row.direction,
          row.entryPrice,
          row.exitPrice || null,
          row.quantity,
          row.entryAt,
          row.exitAt || null,
          row.status,
          row.planAdherence ? Number(row.planAdherence) : null,
          row.emotionalState || null,
          row.entryRationale || null,
          row.outcome || null,
          row.pnl || null,
          row.revengeFlag === "true",
        ],
      );
    }
  }

  const hasSessionGrouping = Array.from(sessionTradeCounts.values()).some((count) => count > 1);

  logger.info({
    event: "SEED_VALIDATION",
    totalTrades: records.length,
    users: uniqueUsers.size,
    sessions: uniqueSessions.size,
    checks: {
      hasEmotionalStates: emotionalStateCount > 0,
      hasPlanAdherence: planAdherenceCount > 0,
      hasSessionGrouping,
    },
  });

  // Trigger metric computation for seeded data
  logger.info({ event: "SEED_METRICS_START", message: "Recomputing metrics for seeded data..." });
  const pool = getPool();
  const client = await pool.connect();

  try {
    // User-level metrics
    for (const userId of uniqueUsers) {
      await computeWinRateByEmotion(client, userId, "seed-trace");
      await computePlanAdherence(client, userId, "seed-trace");
    }

    // Session-level metrics
    for (const sessionKey of sessionTradeCounts.keys()) {
      const [userId, sessionId] = sessionKey.split(":");
      await computeSessionTilt(client, userId, sessionId, "seed-trace");
      await detectOvertrading(client, userId, sessionId, "seed-trace");
    }

    logger.info({ event: "SEED_METRICS_COMPLETE" });
  } catch (error) {
    logger.error({
      event: "SEED_METRICS_FAILED",
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    client.release();
  }
}
