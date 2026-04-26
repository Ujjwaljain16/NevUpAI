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
  computeRevengeFlag,
  computePlanAdherence,
  computeSessionTilt,
  detectOvertrading,
} from "./metrics";

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

const RECONCILIATION_INTERVAL_MS = 60_000;
let reconciliationInProgress = false;

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

// Establishes a persistent consumer group to track progress across worker restarts
async function ensureConsumerGroup(): Promise<void> {
  const redis = getRedis();
  try {
    // 0 = Start from the beginning of the stream; MKSTREAM creates stream if missing
    await redis.xgroup("CREATE", TRADE_EVENTS_STREAM, CONSUMER_GROUP, "0", "MKSTREAM");
    logger.info({ event: "CONSUMER_GROUP_CREATED", group: CONSUMER_GROUP, stream: TRADE_EVENTS_STREAM });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("BUSYGROUP")) {
      logger.info({ event: "CONSUMER_GROUP_EXISTS", group: CONSUMER_GROUP });
    } else {
      throw err;
    }
  }
}

// Recovers abandoned messages from dead workers to ensure no events are lost
async function reclaimPendingMessages(): Promise<void> {
  const redis = getRedis();
  try {
    const pending = await redis.xpending(TRADE_EVENTS_STREAM, CONSUMER_GROUP);
    const pendingCount = pending[0] as number;

    if (pendingCount === 0) return;

    logger.info({ event: "PENDING_RECOVERY_START", pendingCount, source: "worker" });

    // Claims messages that have been idle too long, re-assigning them to the current worker
    const claimed = await redis.xclaim(
      TRADE_EVENTS_STREAM,
      CONSUMER_GROUP,
      WORKER_NAME,
      60000, 
      "0-0", 
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

// Periodically refreshes all projections from the authoritative DB snapshot
// This self-healing loop corrects any drift caused by transient event loss or race conditions
async function reconcileMetricsFromSnapshot(): Promise<void> {
  if (reconciliationInProgress) return;

  reconciliationInProgress = true;
  const traceId = `reconcile-${Date.now()}`;
  const pool = getPool();
  const client = await pool.connect();

  try {
    const usersResult = await client.query<{ user_id: string }>(
      "SELECT DISTINCT user_id::text AS user_id FROM trades",
    );

    for (const row of usersResult.rows) {
      await computeWinRateByEmotion(client, row.user_id, traceId);
      await computePlanAdherence(client, row.user_id, traceId);
    }

    const sessionsResult = await client.query<{ user_id: string; session_id: string }>(
      `SELECT DISTINCT user_id::text AS user_id, session_id::text AS session_id
       FROM trades
       WHERE status = 'closed'`,
    );

    for (const row of sessionsResult.rows) {
      await computeSessionTilt(client, row.user_id, row.session_id, traceId);
      await detectOvertrading(client, row.user_id, row.session_id, traceId);
    }

    logger.info({
      event: "METRICS_RECONCILIATION_COMPLETE",
      traceId,
      users: usersResult.rowCount,
      sessions: sessionsResult.rowCount,
      source: "worker",
    });
  } catch (err) {
    logger.error({
      event: "METRICS_RECONCILIATION_FAILED",
      traceId,
      error: err instanceof Error ? err.message : String(err),
      source: "worker",
    });
  } finally {
    reconciliationInProgress = false;
    client.release();
  }
}

// Implements exactly-once semantics by wrapping compute logic and event claiming in a DB transaction
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

    // Idempotency gate: only process each event once even if Redis redelivers it
    const claim = await client.query(
      "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [eventId],
    );
    const isNewEvent = claim.rowCount === 1;

    if (!isNewEvent) {
      await client.query("COMMIT");
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

    const tradeResult = await client.query(
      "SELECT * FROM trades WHERE trade_id = $1",
      [tradeId],
    );
    const trade = tradeResult.rows[0];

    if (!trade) {
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

    // Trigger behavioral metric re-computation after the state transition
    const metricsUpdated: string[] = [];
    await computeWinRateByEmotion(client, userId, traceId);
    metricsUpdated.push("winRateByEmotion");

    await computeRevengeFlag(client, userId, tradeId, traceId);
    metricsUpdated.push("revengeFlag");

    await computePlanAdherence(client, userId, traceId);
    metricsUpdated.push("planAdherence");

    await computeSessionTilt(client, userId, sessionId, traceId);
    metricsUpdated.push("sessionTilt");

    await detectOvertrading(client, userId, sessionId, traceId);
    metricsUpdated.push("overtradingDetection");

    await client.query("COMMIT");

    // ACK only after DB persistence to guarantee no data loss (At-Least-Once delivery at Redis level)
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
    // Rollback ensures the event remains in the PEL (Pending Entry List) for retry
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

export async function startWorker(): Promise<void> {
  await connectRedis();
  const redis = getRedis();

  logger.info({ event: "WORKER_STARTING", stream: TRADE_EVENTS_STREAM, source: "worker" });

  await ensureConsumerGroup();
  await reclaimPendingMessages();

  await reconcileMetricsFromSnapshot();
  setInterval(() => {
    void reconcileMetricsFromSnapshot();
  }, RECONCILIATION_INTERVAL_MS);

  logger.info({ event: "WORKER_READY", group: CONSUMER_GROUP, consumer: WORKER_NAME, source: "worker" });

  for (;;) {
    let events;
    try {
      // Blocking read minimizes CPU usage while maintaining low latency for new events
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

    if (!events || events.length === 0) continue;

    const [, entries] = events[0] as [string, [string, string[]][]];
    for (const [streamMessageId, fields] of entries) {
      const parsed = parseFields(fields);
      const tradeEvent = toTradeEvent(parsed);
      await processEvent(streamMessageId, tradeEvent);
    }
  }
}
