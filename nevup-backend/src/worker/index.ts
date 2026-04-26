import { logger } from "../infra/logger";
import { getPool } from "../infra/db/client";
import {
  connectRedis,
  getRedis,
  TRADE_EVENTS_STREAM,
  CONSUMER_GROUP,
  WORKER_NAME,
} from "../infra/redis/client";
import {
  computeWinRateByEmotion,
  computePlanAdherence,
  computeSessionTilt,
  detectOvertrading,
} from "./metrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TradeEvent {
  eventId: string;
  type: string;
  tradeId: string;
  userId: string;
  sessionId: string;
  traceId: string;
  timestamp: string;
  version: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFields(fields: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    map[fields[i]] = fields[i + 1];
  }
  return map;
}

function toTradeEvent(parsed: Record<string, string>): TradeEvent {
  return {
    eventId: parsed.eventId ?? "",
    type: parsed.type ?? "",
    tradeId: parsed.tradeId ?? "",
    userId: parsed.userId ?? "",
    sessionId: parsed.sessionId ?? "",
    traceId: parsed.traceId ?? "unknown",
    timestamp: parsed.timestamp ?? "",
    version: parsed.version ?? "1",
    source: parsed.source ?? "unknown",
  };
}

// ---------------------------------------------------------------------------
// Consumer Group Setup
// ---------------------------------------------------------------------------

async function ensureConsumerGroup(): Promise<void> {
  const redis = getRedis();
  try {
    await redis.xgroup("CREATE", TRADE_EVENTS_STREAM, CONSUMER_GROUP, "$", "MKSTREAM");
    logger.info({ event: "CONSUMER_GROUP_CREATED", group: CONSUMER_GROUP, stream: TRADE_EVENTS_STREAM });
  } catch (err: unknown) {
    // Group already exists — safe to ignore
    if (err instanceof Error && err.message.includes("BUSYGROUP")) {
      logger.info({ event: "CONSUMER_GROUP_EXISTS", group: CONSUMER_GROUP });
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Pending Message Recovery
// ---------------------------------------------------------------------------

async function reclaimPendingMessages(): Promise<void> {
  const redis = getRedis();
  try {
    const pending = await redis.xpending(TRADE_EVENTS_STREAM, CONSUMER_GROUP);
    const pendingCount = pending[0] as number;

    if (pendingCount === 0) {
      return;
    }

    logger.info({ event: "PENDING_RECOVERY_START", pendingCount, source: "worker" });

    // Claim messages idle for > 60 seconds
    const claimed = await redis.xclaim(
      TRADE_EVENTS_STREAM,
      CONSUMER_GROUP,
      WORKER_NAME,
      60000, // min idle time ms
      "0-0", // claim from the beginning
    );

    if (Array.isArray(claimed) && claimed.length > 0) {
      logger.info({ event: "PENDING_RECLAIMED", count: claimed.length, source: "worker" });
    }
  } catch (err) {
    logger.warn({
      event: "PENDING_RECOVERY_FAILED",
      error: err instanceof Error ? err.message : String(err),
      source: "worker",
    });
  }
}

// ---------------------------------------------------------------------------
// Process Single Event (Transactional)
// ---------------------------------------------------------------------------

async function processEvent(
  streamMessageId: string,
  tradeEvent: TradeEvent,
): Promise<void> {
  const { eventId, traceId, userId, sessionId, tradeId } = tradeEvent;
  const redis = getRedis();
  const pool = getPool();
  const client = await pool.connect();

  logger.info({
    event: "EVENT_RECEIVED",
    eventId,
    traceId,
    type: tradeEvent.type,
    source: "worker",
  });

  try {
    await client.query("BEGIN");

    // ── Claim the event (idempotency gate) ──────────────────────────────
    const claim = await client.query(
      "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [eventId],
    );
    const isNewEvent = claim.rowCount === 1;

    if (!isNewEvent) {
      await client.query("COMMIT");
      // Duplicate — ACK immediately, no compute
      await redis.xack(TRADE_EVENTS_STREAM, CONSUMER_GROUP, streamMessageId);
      logger.info({
        event: "EVENT_PROCESS_DECISION",
        eventId,
        traceId,
        action: "skip",
        reason: "duplicate",
        source: "worker",
      });
      return;
    }

    logger.info({
      event: "EVENT_PROCESS_DECISION",
      eventId,
      traceId,
      action: "process",
      reason: "valid",
      source: "worker",
    });

    // ── Fetch trade from DB (authoritative source) ──────────────────────
    const tradeResult = await client.query(
      "SELECT * FROM trades WHERE trade_id = $1",
      [tradeId],
    );
    const trade = tradeResult.rows[0];

    if (!trade) {
      // Trade doesn't exist in DB — commit processed_events to avoid retry loops
      await client.query("COMMIT");
      await redis.xack(TRADE_EVENTS_STREAM, CONSUMER_GROUP, streamMessageId);
      logger.warn({
        event: "EVENT_PROCESS_SKIPPED",
        eventId,
        traceId,
        reason: "trade_not_found",
        tradeId,
        source: "worker",
      });
      return;
    }

    // ── Compute metrics from DB snapshot ─────────────────────────────────
    const metricsUpdated: string[] = [];

    await computeWinRateByEmotion(client, userId, traceId);
    metricsUpdated.push("winRateByEmotion");

    await computePlanAdherence(client, userId, traceId);
    metricsUpdated.push("planAdherence");

    await computeSessionTilt(client, userId, sessionId, traceId);
    metricsUpdated.push("sessionTilt");

    await detectOvertrading(client, userId, sessionId, traceId);
    metricsUpdated.push("overtradingDetection");

    // ── Commit everything atomically ────────────────────────────────────
    await client.query("COMMIT");

    // ── ACK only after successful commit ────────────────────────────────
    await redis.xack(TRADE_EVENTS_STREAM, CONSUMER_GROUP, streamMessageId);

    logger.info({
      event: "EVENT_PROCESSED",
      eventId,
      traceId,
      userId,
      sessionId,
      tradeId,
      metricsUpdated,
      source: "worker",
    });
  } catch (err) {
    // Rollback — event stays unacked for retry
    await client.query("ROLLBACK");

    logger.error({
      event: "EVENT_PROCESS_FAILED",
      eventId,
      traceId,
      error: err instanceof Error ? err.message : String(err),
      source: "worker",
    });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Main Worker Loop
// ---------------------------------------------------------------------------

export async function startWorker(): Promise<void> {
  await connectRedis();
  const redis = getRedis();

  logger.info({ event: "WORKER_STARTING", stream: TRADE_EVENTS_STREAM, source: "worker" });

  await ensureConsumerGroup();
  await reclaimPendingMessages();

  logger.info({ event: "WORKER_READY", group: CONSUMER_GROUP, consumer: WORKER_NAME, source: "worker" });

  for (;;) {
    let events;
    try {
      events = await redis.xreadgroup(
        "GROUP", CONSUMER_GROUP, WORKER_NAME,
        "COUNT", "10",
        "BLOCK", "5000",
        "STREAMS", TRADE_EVENTS_STREAM,
        ">",
      );
    } catch (error) {
      logger.warn({
        event: "WORKER_READ_FAILED",
        error: error instanceof Error ? error.message : String(error),
        source: "worker",
      });
      continue;
    }

    if (!events || events.length === 0) {
      continue;
    }

    const [, entries] = events[0] as [string, [string, string[]][]];

    for (const [streamMessageId, fields] of entries) {
      const parsed = parseFields(fields);
      const tradeEvent = toTradeEvent(parsed);

      await processEvent(streamMessageId, tradeEvent);
    }
  }
}
