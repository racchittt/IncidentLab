import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promAvg, promIncrease, getDeploys } from "./lib";

const RUNS_DIR = join(__dirname, "..", "..", "..", "runs");

interface RunManifest {
  changeIds: string[];
  phases?: { baseline?: [string, string]; fault_window?: [string, string] };
}

function latestManifest(): RunManifest {
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.startsWith("INC-00-seed") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error("No run manifest for INC-00 - run ilab apply first.");
  }
  return JSON.parse(readFileSync(join(RUNS_DIR, files[files.length - 1]), "utf-8"));
}

const toSec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

const ERROR_QUERY = 'http_server_request_duration_seconds_count{service_name="payment-service",http_response_status_code="503"}';
const P95_QUERY = "histogram_quantile(0.95, sum(rate(payment_provider_duration_milliseconds_bucket[30s])) by (le))";

const manifest = latestManifest();
if (!manifest.phases?.baseline || !manifest.phases?.fault_window) {
  throw new Error("INC-00's run manifest has no phases.");
}
const [baselineStart, baselineEnd] = manifest.phases.baseline.map(toSec);
const [faultStart, faultEnd] = manifest.phases.fault_window.map(toSec);

describe("INC-00 verification (negative control)", () => {
  it("the harmless deploy happened", async () => {
    const deploys = await getDeploys("payment-service", baselineStart, faultEnd);
    expect(deploys.length).toBeGreaterThan(0);
  });

  it("error rate stays flat across the harmless deploy - nothing breaks", async () => {
    const baselineErrors = await promIncrease(ERROR_QUERY, baselineStart, baselineEnd);
    const afterErrors = await promIncrease(ERROR_QUERY, faultStart, faultEnd);

    expect(baselineErrors).toBeLessThan(5);
    expect(afterErrors).toBeLessThan(5);
  });

  it("p95 provider latency stays in the same ballpark across the harmless deploy", async () => {
    const baselineP95 = await promAvg(P95_QUERY, baselineStart, baselineEnd);
    const afterP95 = await promAvg(P95_QUERY, faultStart, faultEnd);

    // Generous band - this is a stability check, not a precision one.
    expect(afterP95).toBeLessThan(baselineP95 + 500);
  });
});
