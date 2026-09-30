import "@incidentlab/runtime/src/telemetry";
import express, { Request, Response, Application } from "express";
import { logger } from "@incidentlab/runtime/src/logger";

const app: Application = express();
const PORT = 3005;
const ORDERS_URL = process.env.ORDERS_URL ?? "http://nginx/orders";

// Replaces k6: a k6 run can't have its rate changed mid-run without restarting
// the whole load generator, and several Milestone 5 incidents (INC-02, INC-10)
// are specifically "the fault is a traffic spike" - `load.set: { rps }` in a
// fault file needs a live-adjustable rate, not a fixed k6 scenario.
let rps = Number(process.env.RPS ?? "5");

// INC-03's traffic shape: one hot product (matching product 1 in
// infra/postgres/init.sql) takes most of the traffic, so a single cache
// expiry concentrates enough simultaneous misses to actually queue on
// order-service's pool (15rps * 0.7 * 0.4s pg_sleep =~ 4 concurrent misses
// vs. a pool of 2) instead of just nudging pool_in_use. Spreading the same
// share across 3 hot products (the original shape) diluted every expiry to
// ~1.4 concurrent misses each - a real but customer-invisible signal, per
// review feedback on the first build.
const HOT_PRODUCT_IDS = [1];
const ALL_PRODUCT_IDS = Array.from({ length: 20 }, (_, i) => i + 1);
const HOT_TRAFFIC_SHARE = 0.7;

function pickProductId(): number {
  const pool = Math.random() < HOT_TRAFFIC_SHARE ? HOT_PRODUCT_IDS : ALL_PRODUCT_IDS;
  return pool[Math.floor(Math.random() * pool.length)];
}

app.use(express.json());

app.post("/admin/rate", (req: Request, res: Response) => {
  if (typeof req.body?.rps === "number" && req.body.rps >= 0) {
    rps = req.body.rps;
    logger.info({ rps }, "loadgen rate updated");
  }
  res.json({ rps });
});

app.get("/admin/rate", (_req: Request, res: Response) => {
  res.json({ rps });
});

async function loop(): Promise<void> {
  while (true) {
    const start = Date.now();

    if (rps > 0) {
      fetch(ORDERS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: "loadgen", productId: pickProductId() }),
      }).catch((error: unknown) => logger.warn({ err: error }, "loadgen request failed"));
    }

    const intervalMs = rps > 0 ? 1000 / rps : 1000;
    const elapsed = Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, intervalMs - elapsed)));
  }
}

app.listen(PORT, () => logger.info(`loadgen on ${PORT}, starting at ${rps} rps`));
loop();
