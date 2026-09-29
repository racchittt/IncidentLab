import "@incidentlab/runtime/src/telemetry";
import express, { Request, Response, Application } from "express";
import { Pool } from "pg";
import { logger } from "@incidentlab/runtime/src/logger";
import { getConfig, startConfigPolling, onConfigChange } from "@incidentlab/runtime/src/resilience/config";
import { retry } from "@incidentlab/runtime/src/resilience/retry";
import { withTimeout } from "@incidentlab/runtime/src/resilience/timeout";
import { CircuitBreaker } from "@incidentlab/runtime/src/resilience/circuitBreaker";
import {
  retryAttempts,
  providerDuration,
  callsPerCharge,
  retryDelay,
  registerCircuitStateGauge,
  registerDbPoolGauges,
} from "./metrics";

const app: Application = express();
const PORT = 3003;
const PROVIDER_URL = "http://toxiproxy:8666/charge";

interface ProviderResponse {
  ref: string;
}

let pool: Pool;
let breaker: CircuitBreaker;

function buildBreaker(cfg: ReturnType<typeof getConfig>): CircuitBreaker {
  return new CircuitBreaker({
    failureThreshold: cfg.breakerThreshold,
    openMs: cfg.breakerOpenMs,
    onStateChange: (from, to) => logger.info({ from, to }, "circuit breaker state changed"),
  });
}

app.use(express.json());

app.post("/charges", async (req: Request, res: Response) => {
  const { orderId, amountCents } = req.body ?? {};
  if (typeof orderId !== "string" || typeof amountCents !== "number") {
    res.status(400).json({ error: "orderId (string) and amountCents (number) are required" });
    return;
  }

  // Read fresh per request - retry/timeout are "hot" keys, live within 5s of a
  // deploy with no restart, because getConfig() itself is backed by a poller now
  // (see runtime/src/resilience/config.ts) instead of reading env vars directly.
  const cfg = getConfig();

  const startedAt = Date.now();
  let providerCalls = 1; // the first attempt, before any retry

  try {
    const { ref } = await breaker.execute(() =>
      retry(
        () =>
          withTimeout(async (signal) => {
            const response = await fetch(PROVIDER_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Idempotency-Key": orderId },
              body: JSON.stringify({ orderId, amountCents }),
              signal,
            });
            if (!response.ok) {
              const error: Error & { status?: number } = new Error(`provider responded ${response.status}`);
              error.status = response.status;
              throw error;
            }
            return (await response.json()) as ProviderResponse;
          }, cfg.timeoutMs),
        {
          maxAttempts: cfg.retryMaxAttempts,
          baseMs: cfg.retryBaseMs,
          jitter: cfg.retryJitter,
          onAttempt: ({ attempt, delayMs, error }) => {
            providerCalls++;
            retryDelay.record(delayMs);
            retryAttempts.add(1, { outcome: "retry" });
            logger.warn({ orderId, attempt, delayMs, err: error }, "retrying provider charge");
          },
        }
      )
    );

    retryAttempts.add(1, { outcome: "success" });
    providerDuration.record(Date.now() - startedAt);
    callsPerCharge.record(providerCalls);

    await pool.query(
      `INSERT INTO payments (order_id, amount_cents, status, provider_ref)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, amountCents, "charged", ref]
    );

    logger.info({ orderId, ref }, "payment charged");
    res.status(201).json({ orderId, status: "charged", ref });
  } catch (error: unknown) {
    retryAttempts.add(1, { outcome: "giveup" });
    providerDuration.record(Date.now() - startedAt);
    callsPerCharge.record(providerCalls);
    logger.error({ orderId, err: error }, "charge failed");
    res.sendStatus(503);
  }
});

async function main(): Promise<void> {
  // Awaits one real poll before anything else, so a fresh container picks up the
  // latest registry config immediately instead of starting from env defaults.
  await startConfigPolling();

  // Pool size is restart-required: constructed once from whatever was live at
  // startup. Changing db.poolMax needs deployctl's --restart, not a hot rebuild.
  pool = new Pool({ max: getConfig().dbPoolMax });
  registerDbPoolGauges(pool);

  // Breaker threshold/openMs are hot in the sense that we rebuild the breaker in
  // place on a config change rather than requiring a restart - rebuilding does
  // drop whatever open/half-open state it was in, which is an accepted trade-off.
  breaker = buildBreaker(getConfig());
  registerCircuitStateGauge(() => breaker);

  onConfigChange((cfg) => {
    breaker = buildBreaker(cfg);
    logger.info(
      { threshold: cfg.breakerThreshold, openMs: cfg.breakerOpenMs },
      "circuit breaker rebuilt from live config"
    );
  });

  app.listen(PORT, () => logger.info(`payment-service on ${PORT}`));
}

main();
