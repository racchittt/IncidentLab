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
        body: JSON.stringify({ item: "loadgen" }),
      }).catch((error: unknown) => logger.warn({ err: error }, "loadgen request failed"));
    }

    const intervalMs = rps > 0 ? 1000 / rps : 1000;
    const elapsed = Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, intervalMs - elapsed)));
  }
}

app.listen(PORT, () => logger.info(`loadgen on ${PORT}, starting at ${rps} rps`));
loop();
