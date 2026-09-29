import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ENV_KEYS = [
  "OTEL_SERVICE_NAME",
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
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Each test gets its own module instance, since config.ts keeps module-level state. */
async function freshConfigModule() {
  vi.resetModules();
  return import("./config");
}

describe("getConfig / startConfigPolling", () => {
  it("returns env defaults before any poll has run", async () => {
    const { getConfig } = await freshConfigModule();
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

  it("adopts the registry's config after the first poll", async () => {
    process.env.OTEL_SERVICE_NAME = "payment-service";
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 3,
        last_change_id: "chg-0003",
        config: { retry: { baseMs: 0, jitter: "none", maxAttempts: 5 } },
      }),
    } as Response);

    const { startConfigPolling, getConfig, getConfigMeta } = await freshConfigModule();
    await startConfigPolling();

    expect(getConfig().retryBaseMs).toBe(0);
    expect(getConfig().retryJitter).toBe("none");
    expect(getConfigMeta()).toEqual({ version: 3, changeId: "chg-0003" });
  });

  it("keeps the last known config when the registry is unreachable", async () => {
    process.env.OTEL_SERVICE_NAME = "payment-service";
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const { startConfigPolling, getConfig } = await freshConfigModule();
    await startConfigPolling();

    // fetch rejected, so we should still see plain env defaults, not a crash.
    expect(getConfig().retryBaseMs).toBe(100);
  });

  it("keeps the last known config on a non-ok response (e.g. 404, not seeded yet)", async () => {
    process.env.OTEL_SERVICE_NAME = "unknown-service";
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);

    const { startConfigPolling, getConfig } = await freshConfigModule();
    await startConfigPolling();

    expect(getConfig().retryBaseMs).toBe(100);
  });

  it("notifies onConfigChange listeners when the version changes", async () => {
    process.env.OTEL_SERVICE_NAME = "payment-service";
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        last_change_id: "chg-0001",
        config: { breaker: { threshold: 3, openMs: 5000 } },
      }),
    } as Response);

    const { startConfigPolling, onConfigChange } = await freshConfigModule();
    const listener = vi.fn();
    onConfigChange(listener);
    await startConfigPolling();

    expect(listener).toHaveBeenCalledTimes(1);
    const [config, meta] = listener.mock.calls[0];
    expect(config.breakerThreshold).toBe(3);
    expect(meta).toEqual({ version: 1, changeId: "chg-0001" });
  });

  it("does not notify listeners again for an unchanged version", async () => {
    process.env.OTEL_SERVICE_NAME = "payment-service";
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: 1, last_change_id: "chg-0001", config: {} }),
    } as Response);

    const { startConfigPolling, onConfigChange } = await freshConfigModule();
    const listener = vi.fn();
    onConfigChange(listener);

    // startConfigPolling awaits exactly one poll - calling it twice simulates two
    // ticks at the same version without waiting on the real 5s setInterval.
    await startConfigPolling();
    await startConfigPolling();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
