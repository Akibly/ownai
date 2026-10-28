import { homedir } from "node:os";
import { join } from "node:path";
import { envValue } from "./migrate.ts";

export interface BridgeConfig {
  /** Loopback port. Default 8787. */
  port: number;
  dataDir: string;
  /** Max JSON body size in bytes. */
  bodyLimit: number;
  /** Abort a native stream that produces no output within this many ms. */
  firstByteTimeoutMs: number;
  /** Absolute deadline for any generation. */
  totalTimeoutMs: number;
  /** Browser origins allowed to call the API. Empty: every request carrying an Origin header is refused. */
  allowedOrigins: string[];
  /** Days of content-free request metadata kept locally. 0 disables recording. */
  eventRetentionDays: number;
  /** Print one content-free line per request. */
  logRequests: boolean;
}

export function defaultDataDir(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "OwnAI");
  }
  return join(homedir(), ".ownai");
}

function intEnv(name: string, fallback: number): number {
  const raw = envValue(name);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    port: intEnv("OWNAI_PORT", 8787),
    dataDir: envValue("OWNAI_DATA_DIR") || defaultDataDir(),
    bodyLimit: intEnv("OWNAI_BODY_LIMIT", 1_048_576),
    firstByteTimeoutMs: intEnv("OWNAI_FIRST_BYTE_TIMEOUT_MS", 20_000),
    totalTimeoutMs: intEnv("OWNAI_TOTAL_TIMEOUT_MS", 120_000),
    allowedOrigins: (envValue("OWNAI_ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    eventRetentionDays: intEnv("OWNAI_EVENT_RETENTION_DAYS", 7),
    logRequests: envValue("OWNAI_LOG_REQUESTS") === "1",
    ...overrides,
  };
}
