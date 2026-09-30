import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promAvg, promAvgOverTime, promIncrease, getDeploys } from "./lib";

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

const HIT_QUERY = 'order_cache_requests_total{result="hit"}';
const MISS_QUERY = 'order_cache_requests_total{result="miss"}';
const POOL_IN_USE_QUERY = "order_db_pool_in_use";
const POOL_WAITING_QUERY = "order_db_pool_waiting";
// Customer-visible symptom, not just an internal signal: if a client is
// actually queuing for a connection, POST /orders itself gets slower.
const P95_ORDERS_QUERY =
  'histogram_quantile(0.95, sum(rate(http_server_request_duration_seconds_bucket{service_name="order-service",http_route="/orders"}[30s])) by (le))';

async function hitRatio(startSec: number, endSec: number): Promise<number> {
  const hits = await promIncrease(HIT_QUERY, startSec, endSec);
  const misses = await promIncrease(MISS_QUERY, startSec, endSec);
  const total = hits + misses;
  return total === 0 ? 1 : hits / total;
}

async function ordersP95(startSec: number, endSec: number): Promise<number> {
  return promAvg(P95_ORDERS_QUERY, startSec, endSec);
}

const real = latestManifest("INC-03", false);
const deployChangeId = real.changeIds[0];
if (!real.phases?.baseline || !real.phases?.fault_window) {
  throw new Error("INC-03's run manifest has no phases.");
}
const [baselineStart, baselineEnd] = real.phases.baseline.map(toSec);
const [faultStart, faultEnd] = real.phases.fault_window.map(toSec);

describe("INC-03 verification", () => {
  it("the registry has a deploy for order-service with cache.ttlSeconds in its diff", async () => {
    const deploys = await getDeploys("order-service", faultStart - 10, faultStart + 10);
    const deploy = deploys.find((d: { change_id: string }) => d.change_id === deployChangeId);
    expect(deploy).toBeTruthy();
    expect(deploy.diff).toHaveProperty("cache.ttlSeconds");
  });

  it("hit ratio drops once the TTL shortens, and DB pool usage rises with it", async () => {
    const baselineHitRatio = await hitRatio(baselineStart, baselineEnd);
    // Entries cached under the old (long) TTL don't feel the new one until
    // they naturally expire - look at the back half of the fault window,
    // once the short TTL has actually had time to cycle a few times.
    const lateFaultStart = faultStart + Math.floor((faultEnd - faultStart) / 2);
    const afterHitRatio = await hitRatio(lateFaultStart, faultEnd);

    expect(baselineHitRatio).toBeGreaterThan(0.9);
    expect(afterHitRatio).toBeLessThan(baselineHitRatio);

    // db_pool_in_use moves, but only briefly - promAvgOverTime (avg_over_time
    // on raw samples), not promAvg (which averages a query_range call's own
    // discretized points and can step right over a signal this brief).
    // Unlike the hit ratio above, this isn't restricted to the back half of
    // the fault window: pool contention doesn't need the TTL to cycle first,
    // it just needs concurrent misses, which start as soon as the short TTL
    // takes effect. Narrowing to the back half made this genuinely flaky - a
    // sparse signal (a handful of 5s-interval scrapes catching a brief blip)
    // can land on either side of an avg_over_time query's exclusive left
    // boundary more or less at random, and a real run caught 4 of its 6
    // nonzero samples before the midpoint.
    const baselinePoolInUse = await promAvgOverTime(POOL_IN_USE_QUERY, baselineStart, baselineEnd);
    const afterPoolInUse = await promAvgOverTime(POOL_IN_USE_QUERY, faultStart, faultEnd);
    expect(afterPoolInUse).toBeGreaterThan(baselinePoolInUse);
  });

  // Review feedback on the first build: hit ratio dropping and pool_in_use
  // nudging up (baseline ~0.04, fault ~0.15-0.2 at the time) were both real,
  // but neither is something a customer or an on-call engineer would ever
  // notice - an agent investigating this incident had no actual symptom to
  // find. The traffic shape was the problem: 3 hot products spread the same
  // share of misses thin enough (~1.4 concurrent per key) to never exceed a
  // pool of 2. Concentrating onto 1 hot product at 70% of traffic
  // (loadgen's HOT_PRODUCT_IDS/HOT_TRAFFIC_SHARE) fixes the math: 15rps *
  // 0.7 * 0.4s pg_sleep =~ 4 concurrent misses on the same key, comfortably
  // over the pool - real queueing, and a latency spike anyone would notice.
  it("POST /orders gets slower and the pool actually queues - a real customer-visible symptom", async () => {
    // First real run measured baseline p95 at a flat, spurious 10s (the
    // histogram_quantile bucket ceiling) for the first ~75s: the 30s rate()
    // lookback window overlapped loadgen's own rps ramp (5->15, fired at the
    // same t=0 as this window's start), so there wasn't enough real traffic
    // yet for a stable quantile estimate. +90s buffer clears it with margin
    // - baseline settles to ~0.09-0.10s once real steady-state traffic is
    // flowing, confirmed against the same run's raw data points.
    const baselineP95 = await ordersP95(baselineStart + 90, baselineEnd);
    const afterP95 = await ordersP95(faultStart, faultEnd);
    expect(afterP95).toBeGreaterThan(baselineP95);

    const baselinePoolWaiting = await promAvgOverTime(POOL_WAITING_QUERY, baselineStart, baselineEnd);
    const afterPoolWaiting = await promAvgOverTime(POOL_WAITING_QUERY, faultStart, faultEnd);
    expect(baselinePoolWaiting).toBe(0);
    expect(afterPoolWaiting).toBeGreaterThan(0);
  });

  it("the control run (no deploy) keeps a hit ratio above 95%", async () => {
    const control = latestManifest("INC-03", true);
    if (!control.phases?.fault_window) throw new Error("Control run's manifest has no phases.");
    const [cFaultStart, cFaultEnd] = control.phases.fault_window.map(toSec);

    const controlHitRatio = await hitRatio(cFaultStart, cFaultEnd);
    expect(controlHitRatio).toBeGreaterThan(0.95);
  });
});
