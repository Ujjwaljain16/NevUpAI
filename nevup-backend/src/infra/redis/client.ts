import Redis from "ioredis";
import { env } from "../../config/env";
import { logger } from "../logger";
import { hostname } from "node:os";

// Stream constants for the event-driven metrics pipeline
export const TRADE_EVENTS_STREAM = "trade_events";
export const CONSUMER_GROUP = "metrics-group";
export const WORKER_NAME = `worker-${hostname()}-${process.pid}`;

// Persistent Redis client with custom retry strategy to survive transient network partitions
const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null, // Required for blocking stream commands (XREADGROUP)
  retryStrategy: (times) => Math.min(times * 200, 3000),
});

let readySeen = false;
let sawDisconnect = false;

// Warn on connectivity issues without crashing the process
redis.on("error", (error) => {
  logger.warn({
    message: "Redis client error",
    error: error.message,
  });
});

// Detects disconnects to manage eventual consistency expectations during partitions
redis.on("close", () => {
  if (!readySeen) return;
  sawDisconnect = true;
  logger.warn({
    event: "REDIS_DISCONNECTED",
    message: "Redis connection closed",
  });
});

// Logs reconnection events to signal recovery of the event-driven pipeline
redis.on("ready", () => {
  if (readySeen && sawDisconnect) {
    logger.info({
      event: "REDIS_RECONNECT",
      missedEvents: "unknown",
    });
    sawDisconnect = false;
    return;
  }
  readySeen = true;
});

export function getRedis(): Redis {
  return redis;
}

export async function connectRedis(): Promise<void> {
  if (redis.status === "ready" || redis.status === "connecting") return;
  await redis.connect();
}

export async function disconnectRedis(): Promise<void> {
  if (redis.status !== "end") {
    await redis.quit();
  }
}

export async function checkRedisHealth(): Promise<"connected" | "disconnected"> {
  try {
    const pong = await redis.ping();
    return pong === "PONG" ? "connected" : "disconnected";
  } catch {
    return "disconnected";
  }
}

// Monitors pending message count to track consumer lag and system backpressure
export async function getQueueLag(): Promise<number> {
  try {
    const res = await redis.xpending(TRADE_EVENTS_STREAM, CONSUMER_GROUP) as any;
    return Number(res[0] ?? 0);
  } catch {
    return -1;
  }
}
