export interface PaymentResilienceConfig {
  retryMaxAttempts: number;
  retryBaseMs: number;
  retryJitter: "full" | "none";
  timeoutMs: number;
  breakerThreshold: number;
  breakerOpenMs: number;
  dbPoolMax: number;
}

/**
 * Reads env vars fresh on every call - deliberately not cached. Milestone 4 swaps
 * this to read live config from the deploy registry instead; calling it per-request
 * rather than once at startup is what makes that a one-line change later.
 */
export function getConfig(): PaymentResilienceConfig {
  return {
    retryMaxAttempts: Number(process.env.PAYMENT_RETRY_MAX_ATTEMPTS ?? "5"),
    retryBaseMs: Number(process.env.PAYMENT_RETRY_BASE_MS ?? "100"),
    retryJitter: process.env.PAYMENT_RETRY_JITTER === "none" ? "none" : "full",
    timeoutMs: Number(process.env.PAYMENT_TIMEOUT_MS ?? "2000"),
    breakerThreshold: Number(process.env.PAYMENT_BREAKER_THRESHOLD ?? "5"),
    breakerOpenMs: Number(process.env.PAYMENT_BREAKER_OPEN_MS ?? "10000"),
    dbPoolMax: Number(process.env.DB_POOL_MAX ?? "10"),
  };
}
