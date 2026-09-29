import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lokiCount, getDeploys } from "./lib";

const RUNS_DIR = join(__dirname, "..", "..", "..", "runs");

interface RunManifest {
  changeIds: string[];
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

const real = latestManifest("INC-10", false);
const deployChangeId = real.changeIds[0];
if (!real.phases?.baseline || !real.phases?.fault_window) {
  throw new Error("INC-10's run manifest has no phases.");
}
const [baselineStart, baselineEnd] = real.phases.baseline.map(toSec);
const [faultStart, faultEnd] = real.phases.fault_window.map(toSec);

describe("INC-10 verification", () => {
  it("the registry has a deploy for nginx-gateway with ratelimit.rate in its diff", async () => {
    const deploys = await getDeploys("nginx-gateway", faultStart - 10, faultStart + 10);
    const deploy = deploys.find((d: { change_id: string }) => d.change_id === deployChangeId);
    expect(deploy).toBeTruthy();
    expect(deploy.diff).toHaveProperty("ratelimit.rate");
  });

  it("429s spike after the deploy while total request volume stays roughly flat", async () => {
    const baseline429 = await lokiCount(
      '{service_name="nginx-gateway"} | json | status="429"',
      baselineStart,
      baselineEnd
    );
    const after429 = await lokiCount(
      '{service_name="nginx-gateway"} | json | status="429"',
      faultStart + 5,
      faultEnd
    );
    expect(after429).toBeGreaterThan(baseline429 + 5);

    const baselineTotal = await lokiCount('{service_name="nginx-gateway"}', baselineStart, baselineEnd);
    const afterTotal = await lokiCount('{service_name="nginx-gateway"}', faultStart + 5, faultEnd);
    // loadgen's rate never changes for this incident - request volume shouldn't
    // move much even though the outcome (200 vs 429) does.
    expect(afterTotal).toBeGreaterThan(baselineTotal * 0.5);
    expect(afterTotal).toBeLessThan(baselineTotal * 2);
  });

  it("the control run (--no-deploy) never sees a 429 spike", async () => {
    const control = latestManifest("INC-10", true);
    if (!control.phases?.fault_window) throw new Error("Control run's manifest has no phases.");
    const [cFaultStart, cFaultEnd] = control.phases.fault_window.map(toSec);

    const controlAfter429 = await lokiCount(
      '{service_name="nginx-gateway"} | json | status="429"',
      cFaultStart + 5,
      cFaultEnd
    );
    expect(controlAfter429).toBe(0);
  });
});
