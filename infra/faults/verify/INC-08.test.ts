import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promAvgOverTime, promIncrease, lokiCount, getDeploys } from "./lib";

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

const CREATED_QUERY = "orders_created_total";
const FULFILLED_QUERY = "orders_fulfilled_total";
const QUEUE_DEPTH_QUERY = 'sqs_queue_depth{queue="orders-placed"}';

const real = latestManifest("INC-08", false);
const deployChangeId = real.changeIds[0];
if (!real.phases?.baseline || !real.phases?.fault_window) {
  throw new Error("INC-08's run manifest has no phases.");
}
const [baselineStart, baselineEnd] = real.phases.baseline.map(toSec);
const [faultStart, faultEnd] = real.phases.fault_window.map(toSec);

describe("INC-08 verification", () => {
  it("the registry has a deploy for worker-service with queue.name in its diff", async () => {
    const deploys = await getDeploys("worker-service", faultStart - 10, faultStart + 10);
    const deploy = deploys.find((d: { change_id: string }) => d.change_id === deployChangeId);
    expect(deploy).toBeTruthy();
    expect(deploy.diff).toHaveProperty("queue.name");
  });

  it("orders keep getting created while fulfilment flatlines, and the queue backs up", async () => {
    // order-service never notices anything - it enqueues to orders-placed
    // exactly as always, regardless of which queue the worker is polling.
    const createdInFault = await promIncrease(CREATED_QUERY, faultStart, faultEnd);
    const fulfilledInFault = await promIncrease(FULFILLED_QUERY, faultStart, faultEnd);
    expect(createdInFault).toBeGreaterThan(10);
    expect(fulfilledInFault).toBeLessThan(createdInFault * 0.1);

    // Nobody's draining orders-placed, so its depth should be meaningfully
    // higher at the end of the fault window than it was going in.
    const depthAtOnset = await promAvgOverTime(QUEUE_DEPTH_QUERY, faultStart, faultStart + 10);
    const depthAtEnd = await promAvgOverTime(QUEUE_DEPTH_QUERY, faultEnd - 10, faultEnd);
    expect(depthAtEnd).toBeGreaterThan(depthAtOnset);
  });

  it("this incident produces zero errors anywhere - that's the defining property", async () => {
    const workerErrors = await lokiCount('{service_name="worker-service"} |= "error"', faultStart, faultEnd);
    const orderErrors = await lokiCount('{service_name="order-service"} |= "error"', faultStart, faultEnd);
    expect(workerErrors).toBe(0);
    expect(orderErrors).toBe(0);
  });

  it("the control run (no deploy) keeps fulfilment in step with creation", async () => {
    const control = latestManifest("INC-08", true);
    if (!control.phases?.fault_window) throw new Error("Control run's manifest has no phases.");
    const [cFaultStart, cFaultEnd] = control.phases.fault_window.map(toSec);

    const createdInFault = await promIncrease(CREATED_QUERY, cFaultStart, cFaultEnd);
    const fulfilledInFault = await promIncrease(FULFILLED_QUERY, cFaultStart, cFaultEnd);
    expect(createdInFault).toBeGreaterThan(10);
    expect(fulfilledInFault).toBeGreaterThan(createdInFault * 0.8);
  });
});
