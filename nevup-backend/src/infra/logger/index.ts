import pino from "pino";

// High-performance logger configured for structured output (JSON)
// Structured logs allow for automated audit trials and performance monitoring
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined, // Removes pid/hostname to reduce log volume and noise
  timestamp: pino.stdTimeFunctions.isoTime,
});
