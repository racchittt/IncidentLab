import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promAvg, promIncrease, lokiCount, getDeploys } from "./lib";

const REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://localhost:3004";
const RUNS_DIR = join(__dirname, "..", "..", "..", "runs");

interface RunManifest {
  incidentId: string;
  seed: number;
  counterfactual: boolean;
  changeIds: string[];
  phases?: {
    baseline?: [string, string];
    fault_onset?: string;
    fault_window?: [string, string];
  };
}

function latestManifest(incidentId: string, counterfactual: boolean): RunManifest {
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.startsWith(`${incidentId}-seed`) && f.endsWith(".json"))
    .filter((f) => (counterfactual ? f.includes("-nodeploy-") : !f.includes("-nodeploy-")))
    .sort();
  if (files.length === 0) {
    const kind = counterfactual ? "counterfactual (--no-deploy)" : "real";
    throw new Error(`No ${kind} run manifest for ${incidentId} - run ilab apply first.`);
  }
  return JSON.parse(readFileSync(join(RUNS_DIR, files[files.length - 1]), "utf-8"));
}

const toSec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

// Average provider calls needed per charge, over a window - a coarse
// amplification signature. At this traffic scale it stays close to
// 1/(1-errorRate) whether or not backoff is in place, since retries add the
// same total number of calls either way - it's the TIMING of those calls
// that backoff controls, not the count. Kept as a weak sanity check; the
// real signature is the provider's own 429 rate and orders exhausting all
// retry attempts (see below), which only move once removing backoff lets
// retries burst past the provider's rate limit (see mock-payment-provider).
const AMPLIFICATION_QUERY =
  "increase(payment_provider_calls_per_charge_sum[30s]) / increase(payment_provider_calls_per_charge_count[30s])";

async function amplification(startSec: number, endSec: number): Promise<number> {
  return promAvg(AMPLIFICATION_QUERY, startSec, endSec);
}

const GIVEUP_QUERY = 'payment_retry_attempts_total{outcome="giveup"}';
const RATE_LIMITED_QUERY =
  'http_server_request_duration_seconds_count{service_name="mock-payment-provider",http_response_status_code="429"}';

const real = latestManifest("INC-01", false);
const deployChangeId = real.changeIds[0];
if (!real.phases?.baseline || !real.phases?.fault_window) {
  throw new Error("INC-01's run manifest has no phases - re-run ilab apply after the phases fix.");
}
const [baselineStart, baselineEnd] = real.phases.baseline.map(toSec);
const [faultStart, faultEnd] = real.phases.fault_window.map(toSec);

describe("INC-01 verification", () => {
  it("the registry has a deploy for payment-service with retry.baseMs in its diff", async () => {
    const res = await fetch(`${REGISTRY_URL}/deploys/${deployChangeId}`);
    expect(res.ok).toBe(true);

    const deploy = await res.json();
    expect(deploy.service).toBe("payment-service");
    expect(deploy.diff).toHaveProperty("retry.baseMs");
  });

  it("the provider's rate limiter starts rejecting once the deploy removes backoff", async () => {
    // Backoff doesn't eliminate the occasional 429 - a burst still happens
    // by chance sometimes - it just spaces retries out enough that a 429
    // essentially never cascades into a giveup (see the next test, where
    // that distinction is stark: 0 giveups vs thousands). So this baseline
    // isn't tiny, just clearly smaller than the fault window.
    const baseline429s = await promIncrease(RATE_LIMITED_QUERY, baselineStart, baselineEnd);
    // 20s buffer after the deploy for the config poll to take effect.
    const after429s = await promIncrease(RATE_LIMITED_QUERY, faultStart + 20, faultEnd);

    expect(after429s).toBeGreaterThan(Math.max(baseline429s, 1) * 3);
  });

  it("orders start exhausting all retry attempts once the deploy removes backoff", async () => {
    // Backoff+jitter occasionally lands a burst past the rate limit by pure
    // chance, so baseline giveups aren't exactly zero - just rare.
    const baselineGiveups = await promIncrease(GIVEUP_QUERY, baselineStart, baselineEnd);
    // 20s buffer after the deploy for the config poll to take effect.
    const afterGiveups = await promIncrease(GIVEUP_QUERY, faultStart + 20, faultEnd);

    expect(afterGiveups).toBeGreaterThan(Math.max(baselineGiveups, 1) * 10);
  });

  it("retry amplification doesn't drop once backoff is removed", async () => {
    const baselineAmp = await amplification(baselineStart, baselineEnd);
    const afterAmp = await amplification(faultStart + 20, faultEnd);

    expect(afterAmp).toBeGreaterThanOrEqual(baselineAmp * 0.9);
  });

  it("Loki contains a config applied log carrying this deploy's change_id", async () => {
    // pino's fields (change_id, version, ...) land as Loki structured metadata,
    // not text in the line - the line body is literally just "config applied".
    const count = await lokiCount(
      `{service_name="payment-service"} | change_id="${deployChangeId}"`,
      baselineStart - 60,
      faultEnd + 60
    );
    expect(count).toBeGreaterThan(0);
  });

  it("the counterfactual run (--no-deploy) never crosses the storm threshold", async () => {
    const control = latestManifest("INC-01", true);
    if (!control.phases?.baseline || !control.phases?.fault_window) {
      throw new Error("Counterfactual run's manifest has no phases.");
    }
    const [cFaultStart, cFaultEnd] = control.phases.fault_window.map(toSec);

    // Same errorRate the whole time, no deploy ever happened - retry+backoff
    // keeps calls under the provider's rate limit. Occasional bursts happen
    // by chance, so this stays low rather than exactly zero - the real run's
    // fault window is orders of magnitude higher.
    const cGiveups = await promIncrease(GIVEUP_QUERY, cFaultStart + 20, cFaultEnd);
    expect(cGiveups).toBeLessThan(50);

    // And the registry should show zero deploys for the counterfactual run.
    const deploysDuringControl = await getDeploys("payment-service", cFaultStart, cFaultEnd);
    expect(deploysDuringControl.length).toBe(0);
  });
});
