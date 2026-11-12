import { randomBytes } from "node:crypto";
import * as path from "node:path";

export interface ServerConfig {
  baseUrl: string;
  dataDir: string;
  databaseUrl?: string;
  devAllowEphemeralKeys: boolean;
  functionTimeoutMs: number;
  host: string;
  masterKey: string;
  maxUploadBytes: number;
  nodeEnv: string;
  port: number;
  publicDir: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  seedDemo: boolean;
  sessionTtlMs: number;
  stripeApiBaseUrl: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Fail-closed configuration. The vault master key is REQUIRED in
 * production; in development an ephemeral key is generated only when the
 * operator explicitly opts in (DEV_ALLOW_EPHEMERAL_KEYS=true), and the
 * server logs a loud warning — vault secrets will not survive restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ServerConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const devAllowEphemeralKeys = env.DEV_ALLOW_EPHEMERAL_KEYS === "true";
  let masterKey = env.QUINLO_MASTER_KEY ?? "";
  if (!masterKey) {
    if (nodeEnv === "production" && !devAllowEphemeralKeys) {
      throw new Error("QUINLO_MASTER_KEY is required (refusing to start without a vault key)");
    }
    masterKey = randomBytes(32).toString("hex");
  }
  return {
    baseUrl: env.QUINLO_BASE_URL ?? "http://localhost:3000",
    dataDir: env.QUINLO_DATA_DIR ?? path.join(cwd, "data"),
    databaseUrl: env.DATABASE_URL || undefined,
    devAllowEphemeralKeys,
    functionTimeoutMs: envInt("QUINLO_FUNCTION_TIMEOUT_MS", 5000),
    host: env.HOST ?? "0.0.0.0",
    masterKey,
    maxUploadBytes: envInt("QUINLO_MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    nodeEnv,
    port: envInt("PORT", 3000),
    publicDir: env.QUINLO_PUBLIC_DIR ?? path.join(cwd, "apps", "web", "dist"),
    rateLimitMax: envInt("QUINLO_RATE_LIMIT_MAX", 300),
    rateLimitWindowMs: envInt("QUINLO_RATE_LIMIT_WINDOW_MS", 60_000),
    seedDemo: env.QUINLO_SEED_DEMO === "true",
    sessionTtlMs: envInt("QUINLO_SESSION_TTL_MS", 7 * 24 * 60 * 60 * 1000),
    stripeApiBaseUrl: env.QUINLO_STRIPE_API_BASE_URL ?? "https://api.stripe.com",
  };
}
