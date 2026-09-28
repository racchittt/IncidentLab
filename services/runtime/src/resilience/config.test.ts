import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfig } from "./config";

const ENV_KEYS = [
  "PAYMENT_RETRY_MAX_ATTEMPTS",
  "PAYMENT_RETRY_BASE_MS",
  "PAYMENT_RETRY_JITTER",
  "PAYMENT_TIMEOUT_MS",
  "PAYMENT_BREAKER_THRESHOLD",
  "PAYMENT_BREAKER_OPEN_MS",
  "DB_POOL_MAX",
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe("getConfig", () => {
  it("returns sensible defaults when no env vars are set", () => {
    expect(getConfig()).toEqual({
      retryMaxAttempts: 5,
      retryBaseMs: 100,
      retryJitter: "full",
      timeoutMs: 2000,
      breakerThreshold: 5,
      breakerOpenMs: 10_000,
      dbPoolMax: 10,
    });
  });

  it("reads overridden env vars", () => {
    process.env.PAYMENT_RETRY_MAX_ATTEMPTS = "8";
    process.env.PAYMENT_RETRY_JITTER = "none";
    process.env.DB_POOL_MAX = "20";

    const config = getConfig();

    expect(config.retryMaxAttempts).toBe(8);
    expect(config.retryJitter).toBe("none");
    expect(config.dbPoolMax).toBe(20);
  });

  it("re-reads env vars on every call instead of caching the first result", () => {
    process.env.PAYMENT_TIMEOUT_MS = "1000";
    expect(getConfig().timeoutMs).toBe(1000);

    process.env.PAYMENT_TIMEOUT_MS = "5000";
    expect(getConfig().timeoutMs).toBe(5000);
  });
});
