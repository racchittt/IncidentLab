import "@incidentlab/runtime/src/telemetry";
import express, { Request, Response, Application } from "express";
import { randomUUID } from "node:crypto";
import { logger } from "@incidentlab/runtime/src/logger";

const app: Application = express();
const PORT = 3002;

let latencyMs = Number(process.env.LATENCY_MS ?? "0");
let errorRate = Number(process.env.ERROR_RATE ?? "0");
const CAPACITY = Number(process.env.CAPACITY ?? "3");
// ms of extra latency added per request while the provider is in an
// overloaded state - what turns "retries without backoff" into an actual
// feedback loop instead of just noise.
const OVERLOAD_MS_PER_REQUEST = 300;

// A retry storm isn't "many concurrent requests" here - at this traffic
// scale, concurrent in-flight calls to this provider are rarely more than 1
// or 2 regardless of backoff, so a concurrency counter alone never sees a
// difference. What backoff actually controls is TIMING: with it, a client's
// retry for the same charge lands 50ms-1.6s after the previous attempt; with
// it removed (baseMs: 0), it lands within a few ms - too fast for the
// provider's own event loop + network round trip to have moved on. Track
// same-idempotency-key re-attempts that arrive within RAPID_RETRY_MS of the
// previous attempt for that key as "rapid retries", and let a burst of those
// (not raw concurrency) drive the overload state, since that's the one
// signal that's structurally impossible to produce with backoff+jitter in
// place and trivial to produce without it.
const RAPID_RETRY_MS = 15;
const RAPID_RETRY_WINDOW_MS = 3000;
const lastAttemptByKey = new Map<string, number>();
let rapidRetryTimestamps: number[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

app.use(express.json());

app.post("/charge", async (req: Request, res: Response) => {
  const idempotencyKey = req.header("Idempotency-Key");
  const now = Date.now();

  if (idempotencyKey) {
    const lastAttempt = lastAttemptByKey.get(idempotencyKey);
    if (lastAttempt !== undefined && now - lastAttempt < RAPID_RETRY_MS) {
      rapidRetryTimestamps.push(now);
    }
    lastAttemptByKey.set(idempotencyKey, now);
  }
  rapidRetryTimestamps = rapidRetryTimestamps.filter((t) => now - t <= RAPID_RETRY_WINDOW_MS);
  const heat = rapidRetryTimestamps.length;

  try {
    // Above 2x capacity, real backends shed load outright rather than let
    // latency climb forever.
    if (heat > CAPACITY * 2) {
      logger.warn({ heat, capacity: CAPACITY }, "charge rejected (retry storm)");
      res.sendStatus(503);
      return;
    }

    if (heat > CAPACITY) {
      await sleep((heat - CAPACITY) * OVERLOAD_MS_PER_REQUEST);
    }

    if (latencyMs > 0) {
      await sleep(latencyMs);
    }

    if (Math.random() < errorRate) {
      logger.warn({ idempotencyKey }, "charge failed (simulated)");
      res.sendStatus(503);
      return;
    }

    const ref = randomUUID();
    logger.info({ ref, idempotencyKey }, "charge succeeded");
    res.json({ ref });
  } finally {
    // no per-request cleanup needed - heat decays via the timestamp filter above
  }
});

// Live knobs for the Task 5 retry-storm experiment, same pattern as
// order-service's /admin/inject-fault: no container restart needed to tune.
app.post("/admin/set-config", (req: Request, res: Response) => {
  if (typeof req.body?.latencyMs === "number") {
    latencyMs = req.body.latencyMs;
  }
  if (typeof req.body?.errorRate === "number") {
    errorRate = req.body.errorRate;
  }
  logger.info({ latencyMs, errorRate }, "mock-payment-provider config updated");
  res.json({ latencyMs, errorRate });
});

app.post("/admin/reset-config", (_req: Request, res: Response) => {
  latencyMs = Number(process.env.LATENCY_MS ?? "0");
  errorRate = Number(process.env.ERROR_RATE ?? "0");
  logger.info({ latencyMs, errorRate }, "mock-payment-provider config reset");
  res.json({ latencyMs, errorRate });
});

app.listen(PORT, () => logger.info(`mock-payment-provider on ${PORT}`));
