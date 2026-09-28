import "@incidentlab/runtime/src/telemetry";
import express, { Request, Response, Application } from "express";
import { randomUUID } from "node:crypto";
import { logger } from "@incidentlab/runtime/src/logger";

const app: Application = express();
const PORT = 3002;

let latencyMs = Number(process.env.LATENCY_MS ?? "0");
let errorRate = Number(process.env.ERROR_RATE ?? "0");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

app.use(express.json());

app.post("/charge", async (req: Request, res: Response) => {
  if (latencyMs > 0) {
    await sleep(latencyMs);
  }

  if (Math.random() < errorRate) {
    logger.warn({ idempotencyKey: req.header("Idempotency-Key") }, "charge failed (simulated)");
    res.sendStatus(503);
    return;
  }

  const ref = randomUUID();
  logger.info({ ref, idempotencyKey: req.header("Idempotency-Key") }, "charge succeeded");
  res.json({ ref });
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
