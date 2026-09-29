import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promAvg, getDeploys } from "./lib";

const RUNS_DIR = join(__dirname, "..", "..", "..", "runs");

interface RunManifest {
  phases?: { baseline?: [string, string]; fault_window?: [string, string] };
}

function latestManifest(incidentId: string, counterfactual: boolean): RunManifest {
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.startsWith(`${incidentId}-seed`) && f.endsWith(".json"))
    .filter((f) => (counterfactual ? f.includes("-nodeploy-") : !f.includes("-nodeploy-")))
    .sort();
  if (files.length === 0) {
    throw new Error(`No ${counterfactual ? "control (--no-deploy)" : "real"} run manifest for ${incidentId}.`);
  }
  return JSON.parse(readFileSync(join(RUNS_DIR, files[files.length - 1]), "utf-8"));
}

const toSec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

// p95 end-to-end provider call duration - the provider itself is slow (a
// toxic on the "provider" toxiproxy proxy), not payment-service's own code,
// so this is what should move, not the error rate.
const P95_QUERY = "histogram_quantile(0.95, sum(rate(payment_provider_duration_milliseconds_bucket[30s])) by (le))";

async function p95(startSec: number, endSec: number): Promise<number> {
  return promAvg(P95_QUERY, startSec, endSec);
}

const real = latestManifest("INC-05", false);
if (!real.phases?.baseline || !real.phases?.fault_window) {
  throw new Error("INC-05's run manifest has no phases.");
}
const [baselineStart, baselineEnd] = real.phases.baseline.map(toSec);
const [faultStart, faultEnd] = real.phases.fault_window.map(toSec);

describe("INC-05 verification", () => {
  it("p95 provider latency climbs once the toxic is added, with zero payment-service deploys", async () => {
    const baselineP95 = await p95(baselineStart, baselineEnd);
    // 10s buffer for the toxic to actually apply to new connections.
    const afterP95 = await p95(faultStart + 10, faultEnd);

    expect(afterP95).toBeGreaterThan(baselineP95 + 800);

    // Nobody deployed anything - the provider just got slow on its own.
    const deploys = await getDeploys("payment-service", baselineStart, faultEnd);
    expect(deploys.length).toBe(0);
  });

  it("the counterfactual run (no toxic) never sees the latency spike", async () => {
    const control = latestManifest("INC-05", true);
    if (!control.phases?.baseline || !control.phases?.fault_window) {
      throw new Error("Counterfactual run's manifest has no phases.");
    }
    const [cBaselineStart, cBaselineEnd] = control.phases.baseline.map(toSec);
    const [cFaultStart, cFaultEnd] = control.phases.fault_window.map(toSec);

    const cBaselineP95 = await p95(cBaselineStart, cBaselineEnd);
    const cAfterP95 = await p95(cFaultStart + 10, cFaultEnd);

    expect(cAfterP95).toBeLessThan(cBaselineP95 + 800);
  });
});
