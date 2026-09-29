import "@incidentlab/runtime/src/telemetry";
import express, { Request, Response, Application } from "express";
import { Pool } from "pg";
import { metrics } from "@opentelemetry/api";
import { logger } from "@incidentlab/runtime/src/logger";
import { getPath, setPath } from "./paths";

const app: Application = express();
const PORT = 3004;

const pool = new Pool();

const meter = metrics.getMeter("deploy-registry");
const deploysCounter = meter.createCounter("deploys", {
  description: "Deploys recorded, labelled by service",
});

// The mock provider stays out of this on purpose: it stands in for a third party,
// and its own /admin knobs are how INC-05 ("the provider got slow, nothing changed on
// our side") stays possible. Only services that are actually ours get seeded here.
const SEED_DEFAULTS: Record<string, Record<string, unknown>> = {
  "payment-service": {
    retry: { maxAttempts: 5, baseMs: 100, jitter: "full" },
    timeout: { ms: 2000 },
    breaker: { threshold: 5, openMs: 10000 },
    db: { poolMax: 10 },
  },
  // INC-02's whole point: this stays a baseline, never deployed during the
  // incident. The fault is load alone, not a config change.
  "order-service": {
    ddb: { writeCapacity: 20 },
    // INC-03's whole point: this is the baseline, healthy value. The
    // incident's one causal step drops it to 5.
    cache: { ttlSeconds: 300 },
  },
  // INC-08's whole point: this stays "orders-placed" as a baseline. The
  // causal step points it at a name nobody's ever enqueued to.
  "worker-service": {
    queue: { name: "orders-placed" },
  },
  // deployctl special-cases this service: a deploy also renders
  // infra/nginx/ratelimit.conf and reloads nginx (see cmdDeploy).
  "nginx-gateway": {
    ratelimit: { rate: "30r/s", burst: 50 },
  },
};

async function ensureSeeded(): Promise<void> {
  for (const [service, config] of Object.entries(SEED_DEFAULTS)) {
    const { rows } = await pool.query("SELECT 1 FROM configs WHERE service = $1", [service]);
    if (rows.length === 0) {
      await pool.query(
        "INSERT INTO configs (service, version, config) VALUES ($1, 1, $2)",
        [service, config]
      );
      logger.info({ service }, "seeded default config");
    }
  }
}

app.use(express.json());

app.post("/deploys", async (req: Request, res: Response) => {
  const { service, set, author, reason } = req.body ?? {};
  if (typeof service !== "string" || typeof set !== "object" || set === null) {
    res.status(400).json({ error: "service (string) and set (object) are required" });
    return;
  }

  const { rows } = await pool.query("SELECT version, config FROM configs WHERE service = $1", [service]);
  const currentVersion: number = rows[0]?.version ?? 0;
  const config: Record<string, unknown> = rows[0]?.config ?? {};

  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [path, value] of Object.entries(set)) {
    diff[path] = { from: getPath(config, path) ?? null, to: value };
    setPath(config, path, value);
  }

  const newVersion = currentVersion + 1;

  const { rows: seqRows } = await pool.query("SELECT nextval('deploy_seq') AS n");
  const changeId = `chg-${String(seqRows[0].n).padStart(4, "0")}`;

  await pool.query(
    `INSERT INTO configs (service, version, config, last_change_id, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (service) DO UPDATE SET version = $2, config = $3, last_change_id = $4, updated_at = now()`,
    [service, newVersion, config, changeId]
  );

  await pool.query(
    `INSERT INTO deploys (change_id, service, version, diff, author, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [changeId, service, newVersion, diff, author ?? null, reason ?? null]
  );

  deploysCounter.add(1, { service });
  logger.info({ change_id: changeId, service, version: newVersion, diff }, "deploy applied");

  res.status(201).json({ change_id: changeId, service, version: newVersion, diff });
});

app.get("/config/:service", async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    "SELECT version, config, last_change_id FROM configs WHERE service = $1",
    [req.params.service]
  );
  if (rows.length === 0) {
    res.sendStatus(404);
    return;
  }
  res.json({
    service: req.params.service,
    version: rows[0].version,
    config: rows[0].config,
    last_change_id: rows[0].last_change_id,
  });
});

app.get("/deploys", async (req: Request, res: Response) => {
  const { service, since, until } = req.query;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (typeof service === "string") {
    params.push(service);
    conditions.push(`service = $${params.length}`);
  }
  if (typeof since === "string") {
    params.push(since);
    conditions.push(`ts >= $${params.length}`);
  }
  if (typeof until === "string") {
    params.push(until);
    conditions.push(`ts <= $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(`SELECT * FROM deploys ${where} ORDER BY ts`, params);
  res.json(rows);
});

app.get("/deploys/:change_id", async (req: Request, res: Response) => {
  const { rows } = await pool.query("SELECT * FROM deploys WHERE change_id = $1", [req.params.change_id]);
  if (rows.length === 0) {
    res.sendStatus(404);
    return;
  }
  res.json(rows[0]);
});

ensureSeeded().then(() => {
  app.listen(PORT, () => logger.info(`deploy-registry on ${PORT}`));
});
