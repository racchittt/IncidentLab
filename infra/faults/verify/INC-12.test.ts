import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promIncrease, getDeploys } from "./lib";

const REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://localhost:3004";
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

const ERROR_QUERY =
  'http_server_request_duration_seconds_count{service_name="payment-service",http_response_status_code="503"}';

const real = latestManifest("INC-12", false);
// The decoy deploy is always the FIRST recorded change (t=235s, before the
// causal proxy.toggle at t=240s - which doesn't record a change_id at all).
const decoyChangeId = real.changeIds[0];
if (!real.phases?.fault_onset || !real.phases?.fault_window) {
  throw new Error("INC-12's run manifest has no phases.");
}
const faultOnset = toSec(real.phases.fault_onset);
const [, faultEnd] = real.phases.fault_window.map(toSec);

describe("INC-12 verification", () => {
  it("the registry has the decoy deploy for payment-service with log.level in its diff", async () => {
    const res = await fetch(`${REGISTRY_URL}/deploys/${decoyChangeId}`);
    expect(res.ok).toBe(true);

    const deploy = await res.json();
    expect(deploy.service).toBe("payment-service");
    expect(deploy.diff).toHaveProperty("log.level");
  });

  it("errors line up with the proxy outage, not with the decoy deploy 5s earlier", async () => {
    // Between the decoy deploy (t=235s) and the outage (t=240s) - the decoy
    // alone should do nothing.
    const preOutageErrors = await promIncrease(ERROR_QUERY, faultOnset - 5, faultOnset);
    // payment-service's pg pool keeps serving queries off already-open idle
    // connections for a while after the proxy goes down - errors don't
    // start immediately, they start once the pool's own idle-connection
    // churn forces a fresh connection attempt (empirically ~15s in). Check
    // the back half of the 40s outage window, well clear of that lag.
    const outageErrors = await promIncrease(ERROR_QUERY, faultOnset + 20, faultOnset + 40);

    expect(outageErrors).toBeGreaterThan(preOutageErrors + 2);
  });

  it("errors recover once the proxy comes back", async () => {
    const outageErrors = await promIncrease(ERROR_QUERY, faultOnset + 20, faultOnset + 40);
    // Buffer for in-flight reconnects to settle after the proxy is back at t=280s (onset+40).
    const recoveredErrors = await promIncrease(ERROR_QUERY, faultOnset + 55, faultEnd);

    expect(recoveredErrors).toBeLessThan(outageErrors);
  });

  it("the counterfactual run (proxy outage skipped) never sees the error spike, even with the decoy deploy present", async () => {
    const control = latestManifest("INC-12", true);
    if (!control.phases?.fault_onset || !control.phases?.fault_window) {
      throw new Error("Counterfactual run's manifest has no phases.");
    }
    // The decoy deploy still happens in the control run (it isn't the causal
    // step) - this is the point: it alone never causes errors.
    expect(control.changeIds.length).toBeGreaterThan(0);

    const cFaultOnset = toSec(control.phases.fault_onset);
    const [, cFaultEnd] = control.phases.fault_window.map(toSec);
    const cErrors = await promIncrease(ERROR_QUERY, cFaultOnset - 5, cFaultEnd);
    expect(cErrors).toBeLessThan(5);
  });
});
