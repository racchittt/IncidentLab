import "@incidentlab/runtime/src/telemetry";
import express, { Request, Response, Application } from "express";
import { randomUUID } from "node:crypto";
import { logger } from "@incidentlab/runtime/src/logger";

const app: Application = express();
const PORT = 3002;

let latencyMs = Number(process.env.LATENCY_MS ?? "0");
let errorRate = Number(process.env.ERROR_RATE ?? "0");

// Real payment APIs rate-limit per client (e.g. Stripe: a few hundred/sec per
// account, but plenty of providers are much tighter). This is the feedback
// loop INC-01 depends on: calls/sec is a straight function of how many
// distinct charges are outstanding times how many attempts each one needs.
// With backoff, a fixed error rate needs a fixed number of extra attempts,
// spread out - calls/sec stays under the limit. Remove backoff and those same
// extra attempts land back-to-back instead of spread out, pushing calls/sec
// over the limit, which mints MORE 429s, which need MORE retries - a real
// load-based storm, not a timing artifact of one specific retry gap.
const RATE_LIMIT_PER_SEC = Number(process.env.RATE_LIMIT_PER_SEC ?? "15");
// Burst allowance, separate from the steady refill rate - most real token
// buckets have both. A full second's worth of burst room (the old design)
// meant the bucket only ever cared about the average rate over ~1s, which
// made it just as blind to short bursts as the raw concurrency counter this
// replaced. A small burst cap is what actually distinguishes "many retries
// spread over 1.6s" from "the same retries landing within a few ms of each
// other" - the thing backoff controls.
const BUCKET_CAPACITY = Number(process.env.BUCKET_CAPACITY ?? "8");
let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();

function tryConsumeToken(): boolean {
  const now = Date.now();
  const elapsedSec = (now - lastRefill) / 1000;
  tokens = Math.min(BUCKET_CAPACITY, tokens + elapsedSec * RATE_LIMIT_PER_SEC);
  lastRefill = now;
  if (tokens >= 1) {
    tokens -= 1;
    return true;
  }
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

app.use(express.json());

app.post("/charge", async (req: Request, res: Response) => {
  const idempotencyKey = req.header("Idempotency-Key");

  if (!tryConsumeToken()) {
    logger.warn({ idempotencyKey, limitPerSec: RATE_LIMIT_PER_SEC }, "charge rejected (rate limited)");
    res.sendStatus(429);
    return;
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
});

// Live knobs for fault experiments, same pattern as order-service's
// /admin/inject-fault: no container restart needed to tune.
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

app.listen(PORT, () =>
  logger.info(`mock-payment-provider on ${PORT}, rate limit ${RATE_LIMIT_PER_SEC}/s, burst ${BUCKET_CAPACITY}`)
);
