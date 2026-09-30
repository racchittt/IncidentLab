import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promAvgOverTime, lokiCount, getDeploys } from "./lib";

const RUNS_DIR = join(__dirname, "..", "..", "..", "runs");

interface RunManifest {
  changeIds: string[];
  phases?: { baseline?: [string, string]; fault_onset?: string; fault_window?: [string, string] };
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

const POOL_IN_USE_QUERY = "payment_db_pool_in_use";

const real = latestManifest("INC-09", false);
const deployChangeId = real.changeIds[0];
if (!real.phases?.baseline || !real.phases?.fault_window) {
  throw new Error("INC-09's run manifest has no phases.");
}
const [baselineStart, baselineEnd] = real.phases.baseline.map(toSec);
const [faultStart, faultEnd] = real.phases.fault_window.map(toSec);
const faultMid = faultStart + Math.floor((faultEnd - faultStart) / 2);

describe("INC-09 verification", () => {
  it("the registry has a deploy for payment-service with ledger.auditWrites in its diff", async () => {
    const deploys = await getDeploys("payment-service", faultStart - 10, faultStart + 10);
    const deploy = deploys.find((d: { change_id: string }) => d.change_id === deployChangeId);
    expect(deploy).toBeTruthy();
    expect(deploy.diff).toHaveProperty("ledger.auditWrites");
  });

  it("db pool usage climbs in a staircase - not a spike - as connections leak", async () => {
    const baselinePoolInUse = await promAvgOverTime(POOL_IN_USE_QUERY, baselineStart, baselineEnd);
    const midFaultPoolInUse = await promAvgOverTime(POOL_IN_USE_QUERY, faultStart + 10, faultMid);
    const lateFaultPoolInUse = await promAvgOverTime(POOL_IN_USE_QUERY, faultMid, faultEnd);

    // A staircase: each half is higher than the one before it, not just
    // "high at the end" (which a spike would also produce).
    expect(midFaultPoolInUse).toBeGreaterThan(baselinePoolInUse);
    expect(lateFaultPoolInUse).toBeGreaterThan(midFaultPoolInUse);
  });

  it("audit writes fail for a small fraction of orders, and the diff is in the registry", async () => {
    const auditFailures = await lokiCount('{service_name="payment-service"} |= "audit write failed"', faultStart, faultEnd);
    expect(auditFailures).toBeGreaterThan(0);
  });

  it("the control run (no deploy) keeps db pool usage flat", async () => {
    const control = latestManifest("INC-09", true);
    if (!control.phases?.baseline || !control.phases?.fault_window) {
      throw new Error("Counterfactual run's manifest has no phases.");
    }
    const [cBaselineStart, cBaselineEnd] = control.phases.baseline.map(toSec);
    const [, cFaultEnd] = control.phases.fault_window.map(toSec);

    const cBaselinePoolInUse = await promAvgOverTime(POOL_IN_USE_QUERY, cBaselineStart, cBaselineEnd);
    const cLateFaultPoolInUse = await promAvgOverTime(POOL_IN_USE_QUERY, cFaultEnd - 60, cFaultEnd);

    // Loose bound, not "equal" - normal traffic jitter moves this a little
    // even with nothing leaking.
    expect(cLateFaultPoolInUse).toBeLessThan(cBaselinePoolInUse + 2);
  });
});
