import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://localhost:3004";
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://localhost:9090";
const LOKI_URL = process.env.LOKI_URL ?? "http://localhost:3100";
const RUNS_DIR = join(__dirname, "..", "..", "..", "runs");

interface RunManifest {
  incidentId: string;
  seed: number;
  params: Record<string, number>;
  startedAt: string;
  endedAt: string;
  changeIds: string[];
}

function latestManifest(incidentId: string): RunManifest {
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.startsWith(`${incidentId}-seed`) && f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No run manifest for ${incidentId} - run "ilab apply ${incidentId} --seed <n>" first.`);
  }
  return JSON.parse(readFileSync(join(RUNS_DIR, files[files.length - 1]), "utf-8"));
}

async function avgRetryRate(startSec: number, endSec: number): Promise<number> {
  const params = new URLSearchParams({
    query: 'sum(rate(payment_retry_attempts_total{outcome="retry"}[30s]))',
    start: String(startSec),
    end: String(endSec),
    step: "15",
  });
  const res = await fetch(`${PROMETHEUS_URL}/api/v1/query_range?${params}`);
  const body = await res.json();
  const values = body.data.result.flatMap((r: { values: [string, string][] }) =>
    r.values.map(([, v]) => Number(v))
  );
  if (values.length === 0) return 0;
  return values.reduce((a: number, b: number) => a + b, 0) / values.length;
}

const manifest = latestManifest("INC-01");
const deployChangeId = manifest.changeIds[0];
const startedAtSec = Math.floor(new Date(manifest.startedAt).getTime() / 1000);

describe("INC-01 verification", () => {
  it("the registry has a deploy for payment-service with retry.baseMs in its diff", async () => {
    const res = await fetch(`${REGISTRY_URL}/deploys/${deployChangeId}`);
    expect(res.ok).toBe(true);

    const deploy = await res.json();
    expect(deploy.service).toBe("payment-service");
    expect(deploy.diff).toHaveProperty("retry.baseMs");
  });

  it("Prometheus shows retry rate after the deploy at least 3x the baseline window", async () => {
    // Timeline: deploy at t=240s, provider error rate jumps at t=250s. Baseline is
    // the quiet window before either; "after" gives both a moment to actually bite.
    const baselineRate = await avgRetryRate(startedAtSec, startedAtSec + 230);
    const afterRate = await avgRetryRate(startedAtSec + 270, startedAtSec + 590);

    expect(afterRate).toBeGreaterThanOrEqual(baselineRate * 3);
  });

  it("Loki contains a config applied log carrying this deploy's change_id", async () => {
    // pino's fields (change_id, version, ...) land as Loki structured metadata, not
    // as text in the log line - the line body is just "config applied". Filter on
    // the metadata field directly rather than substring-matching the line.
    const params = new URLSearchParams({
      query: `{service_name="payment-service"} | change_id="${deployChangeId}"`,
      start: `${(startedAtSec - 60) * 1_000_000_000}`,
      end: `${(startedAtSec + 620) * 1_000_000_000}`,
    });
    const res = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${params}`);
    const body = await res.json();
    const matches = body.data.result.flatMap((r: { values: unknown[] }) => r.values);

    expect(matches.length).toBeGreaterThan(0);
  });
});
