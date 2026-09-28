import "@incidentlab/runtime/src/telemetry";
import express, { Request, Response, Application } from "express";
import { Pool } from "pg";
import { logger } from "@incidentlab/runtime/src/logger";
import { getConfig } from "@incidentlab/runtime/src/resilience/config";
import { retry } from "@incidentlab/runtime/src/resilience/retry";
import { withTimeout } from "@incidentlab/runtime/src/resilience/timeout";
import { CircuitBreaker } from "@incidentlab/runtime/src/resilience/circuitBreaker";

const app: Application = express();
const PORT = 3003;
const PROVIDER_URL = "http://toxiproxy:8666/charge";

// Pool size and breaker threshold/openMs are read once - both are baked into a
// long-lived object's construction and can't change per-request the way retry and
// timeout settings can. getConfig() itself still re-reads env vars fresh; only the
// *call site* here is startup-scoped.
const pool = new Pool({ max: getConfig().dbPoolMax });

const breaker = new CircuitBreaker({
  failureThreshold: getConfig().breakerThreshold,
  openMs: getConfig().breakerOpenMs,
  onStateChange: (from, to) => logger.info({ from, to }, "circuit breaker state changed"),
});

interface ProviderResponse {
  ref: string;
}

app.use(express.json());

app.post("/charges", async (req: Request, res: Response) => {
  const { orderId, amountCents } = req.body ?? {};
  if (typeof orderId !== "string" || typeof amountCents !== "number") {
    res.status(400).json({ error: "orderId (string) and amountCents (number) are required" });
    return;
  }

  // Read fresh per request, unlike the pool/breaker above - this is what makes
  // swapping getConfig()'s implementation for a live deploy-registry read (planned
  // for Milestone 4) a one-line change instead of a rewrite of every call site.
  const cfg = getConfig();

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
          onAttempt: ({ attempt, delayMs, error }) =>
            logger.warn({ orderId, attempt, delayMs, err: error }, "retrying provider charge"),
        }
      )
    );

    await pool.query(
      `INSERT INTO payments (order_id, amount_cents, status, provider_ref)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, amountCents, "charged", ref]
    );

    logger.info({ orderId, ref }, "payment charged");
    res.status(201).json({ orderId, status: "charged", ref });
  } catch (error: unknown) {
    logger.error({ orderId, err: error }, "charge failed");
    res.sendStatus(503);
  }
});

app.listen(PORT, () => logger.info(`payment-service on ${PORT}`));
