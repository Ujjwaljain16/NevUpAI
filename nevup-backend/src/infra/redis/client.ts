import Redis from "ioredis";
import { env } from "../../config/env";
import { logger } from "../logger";

import { hostname } from "node:os";
export const TRADE_EVENTS_STREAM = "trade_events";
export const CONSUMER_GROUP = "metrics-group";
export const WORKER_NAME = `worker-${hostname()}-${process.pid}`;

const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 200, 3000),
});

let readySeen = false;
let sawDisconnect = false;

redis.on("error", (error) => {
  logger.warn({
    message: "Redis client error",
    error: error.message,
  });
});

redis.on("close", () => {
  if (!readySeen) {
    return;
  }

  sawDisconnect = true;
  logger.warn({
    event: "REDIS_DISCONNECTED",
    message: "Redis connection closed",
  });
});

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
  if (redis.status === "ready" || redis.status === "connecting") {
    return;
  }
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

export async function getQueueLag(): Promise<number> {
  try {
    const res = await redis.xpending(TRADE_EVENTS_STREAM, CONSUMER_GROUP) as any;
    return Number(res[0] ?? 0); // The first element of xpending response is the count
  } catch {
    return -1;
  }
}
