import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function toPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: toPort(process.env.PORT ?? "3000"),
  databaseUrl: requireEnv("DATABASE_URL"),
  redisUrl: requireEnv("REDIS_URL"),
  jwtSecret: requireEnv("JWT_SECRET"),
};
