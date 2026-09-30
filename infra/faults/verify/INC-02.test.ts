import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lokiCount, getDeploys } from "./lib";

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

const real = latestManifest("INC-02", false);
if (!real.phases?.baseline || !real.phases?.fault_window) {
  throw new Error("INC-02's run manifest has no phases.");
}
const [baselineStart, baselineEnd] = real.phases.baseline.map(toSec);
const [faultStart, faultEnd] = real.phases.fault_window.map(toSec);

describe("INC-02 verification", () => {
  it("the registry has zero deploys for order-service during the incident - traffic alone caused it", async () => {
    const deploys = await getDeploys("order-service", baselineStart, faultEnd);
    expect(deploys.length).toBe(0);
  });

  it("ProvisionedThroughputExceededException spikes after the load increase", async () => {
    const baselineThrottles = await lokiCount(
      '{service_name="order-service"} |= "ProvisionedThroughputExceededException"',
      baselineStart,
      baselineEnd
    );
    const afterThrottles = await lokiCount(
      '{service_name="order-service"} |= "ProvisionedThroughputExceededException"',
      faultStart + 5,
      faultEnd
    );
    expect(afterThrottles).toBeGreaterThan(baselineThrottles + 5);
  });

  it("the control run (steady load) never throttles", async () => {
    const control = latestManifest("INC-02", true);
    if (!control.phases?.fault_window) throw new Error("Control run's manifest has no phases.");
    const [cFaultStart, cFaultEnd] = control.phases.fault_window.map(toSec);

    const controlThrottles = await lokiCount(
      '{service_name="order-service"} |= "ProvisionedThroughputExceededException"',
      cFaultStart + 5,
      cFaultEnd
    );
    expect(controlThrottles).toBe(0);
  });
});
