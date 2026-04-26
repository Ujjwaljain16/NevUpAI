import { query } from "../infra/db/client";
import { logger } from "../infra/logger";
import { connectRedis, getRedis, TRADE_EVENTS_STREAM } from "../infra/redis/client";
import { randomUUID } from "node:crypto";

export async function startWorker(): Promise<void> {
  await connectRedis();
  const redis = getRedis();
  let cursor = "$";

  const context = {
    traceId: randomUUID(),
    source: "worker",
  };

  logger.info({ message: "Worker started", stream: TRADE_EVENTS_STREAM, context });

  for (;;) {
    let events;
    try {
      events = await redis.xread("BLOCK", "5000", "STREAMS", TRADE_EVENTS_STREAM, cursor);
    } catch (error) {
      logger.warn({
        message: "Worker stream read failed; waiting for Redis reconnect",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!events || events.length === 0) {
      continue;
    }

    const [, entries] = events[0];
    for (const [eventId, fields] of entries) {
      const alreadyProcessed = await query<{ event_id: string }>(
        "SELECT event_id FROM processed_events WHERE event_id = $1",
        [eventId],
      );

      if (alreadyProcessed.rowCount) {
        cursor = eventId;
        continue;
      }

      // Phase 0 worker skeleton: consume and record idempotent processing marker.
      await query("INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING", [eventId]);
      cursor = eventId;

      const getUserIdFromFields = (f: string[]) => {
        const i = f.indexOf("userId");
        return i !== -1 ? f[i + 1] : null;
      };

      logger.info({
        context: {
          ...context,
          userId: getUserIdFromFields(fields),
        },
        eventId,
        fields,
        message: "Processed trade event",
      });
    }
  }
}
