import { logger } from "../logger";

export interface PaymentResilienceConfig {
  retryMaxAttempts: number;
  retryBaseMs: number;
  retryJitter: "full" | "none";
  timeoutMs: number;
  breakerThreshold: number;
  breakerOpenMs: number;
  dbPoolMax: number;
}

export interface ConfigMeta {
  version: number;
  changeId: string | null;
}

type ConfigChangeListener = (config: PaymentResilienceConfig, meta: ConfigMeta) => void;

function envDefaults(): PaymentResilienceConfig {
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

function fromRegistryConfig(config: Record<string, any>): PaymentResilienceConfig {
  const fallback = envDefaults();
  return {
    retryMaxAttempts: config?.retry?.maxAttempts ?? fallback.retryMaxAttempts,
    retryBaseMs: config?.retry?.baseMs ?? fallback.retryBaseMs,
    retryJitter: config?.retry?.jitter ?? fallback.retryJitter,
    timeoutMs: config?.timeout?.ms ?? fallback.timeoutMs,
    breakerThreshold: config?.breaker?.threshold ?? fallback.breakerThreshold,
    breakerOpenMs: config?.breaker?.openMs ?? fallback.breakerOpenMs,
    dbPoolMax: config?.db?.poolMax ?? fallback.dbPoolMax,
  };
}

const REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://deploy-registry:3004";
const POLL_MS = 5000;

let current: PaymentResilienceConfig = envDefaults();
let currentVersion = 0;
let currentChangeId: string | null = null;
const listeners: ConfigChangeListener[] = [];

async function poll(): Promise<void> {
  const service = process.env.OTEL_SERVICE_NAME;
  if (!service) return;

  try {
    const response = await fetch(`${REGISTRY_URL}/config/${service}`);
    if (!response.ok) {
      // No config for this service yet (e.g. 404) - keep whatever we have.
      return;
    }
    const body = await response.json();
    if (body.version === currentVersion) {
      return;
    }

    current = fromRegistryConfig(body.config);
    currentVersion = body.version;
    currentChangeId = body.last_change_id ?? null;

    logger.info({ change_id: currentChangeId, version: currentVersion }, "config applied");
    for (const listener of listeners) {
      listener(current, { version: currentVersion, changeId: currentChangeId });
    }
  } catch (error) {
    // Registry down or unreachable: keep the last known-good config (env defaults,
    // if this is the very first poll) rather than throwing.
    logger.warn({ err: error }, "deploy-registry unreachable, keeping last known config");
  }
}

/**
 * Starts polling deploy-registry for this service's config every 5s. Awaits one
 * poll up front so callers that construct long-lived objects (a Pool, a
 * CircuitBreaker) from getConfig() at startup see real config, not just env
 * defaults, before the first interval tick.
 */
export async function startConfigPolling(): Promise<void> {
  await poll();
  setInterval(poll, POLL_MS);
}

/** Reads fresh on every call by design - see startConfigPolling for how "fresh" is kept up to date. */
export function getConfig(): PaymentResilienceConfig {
  return current;
}

export function getConfigMeta(): ConfigMeta {
  return { version: currentVersion, changeId: currentChangeId };
}

/**
 * Fires whenever a new config version is observed. Used for "restart-required"
 * keys that live on a stateful object (a CircuitBreaker) rather than being read
 * fresh per call - the listener rebuilds that object in place.
 */
export function onConfigChange(listener: ConfigChangeListener): void {
  listeners.push(listener);
}
