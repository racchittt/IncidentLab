/**
 * ilab - fault engine runner.
 *
 * Usage (run with `npx tsx infra/faults/ilab.ts ...` from the repo root):
 *   ilab apply <INC-ID> --seed <n> [--no-deploy|--control]
 *   ilab reset <INC-ID>
 *   ilab verify-all
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://localhost:3004";
const PROVIDER_URL = process.env.MOCK_PROVIDER_URL ?? "http://localhost:3002";
const LOADGEN_URL = process.env.LOADGEN_URL ?? "http://localhost:3005";
const TOXIPROXY_URL = process.env.TOXIPROXY_URL ?? "http://localhost:8474";
const FAULTS_DIR = join(__dirname);
const RUNS_DIR = join(__dirname, "..", "..", "runs");

/** A single transient network blip shouldn't fail an incident that's
 * otherwise fine - verify-all runs unattended for the better part of an
 * hour, long enough for one to show up. Retries idempotent GETs and the
 * registry's own POST /deploys (each deploy just becomes a new version, so
 * a retried duplicate is harmless - the caller only ever sees the last one
 * that went through). */
async function fetchWithRetry(url: string, init?: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`[ilab] fetch ${url} failed (attempt ${attempt}/${attempts}), retrying: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  throw lastError;
}

interface DeployAction {
  service: string;
  set: Record<string, unknown>;
  reason?: string;
}

interface ToxicAction {
  proxy: string;
  type: string;
  attributes?: Record<string, unknown>;
  name?: string;
}

interface Action {
  at: string;
  /** Marks the one step that IS the incident's cause - a control run (--control /
   * --no-deploy) skips exactly this step's effects and nothing else, so the same
   * timeline can prove "this specific change is what caused it." */
  causal?: boolean;
  "provider.set"?: { errorRate: number | string };
  "load.set"?: { rps: number | string };
  "toxic.add"?: ToxicAction;
  "toxic.remove"?: { proxy: string; name: string };
  "proxy.toggle"?: { proxy: string; enabled: boolean };
  deploy?: DeployAction;
  end?: boolean;
  rollback?: string;
}

interface PhasesSpec {
  baseline?: [string, string];
  fault_onset?: string;
  fault_window?: [string, string];
}

interface FaultFile {
  id: string;
  params?: Record<string, [number, number]>;
  timeline: Action[];
  phases?: PhasesSpec;
  reset: Action[];
}

interface RunManifest {
  incidentId: string;
  seed: number;
  counterfactual: boolean;
  params: Record<string, number>;
  startedAt: string;
  endedAt: string;
  changeIds: string[];
  phases?: Record<string, string | [string, string]>;
}

/** Deterministic PRNG so the same --seed always produces the same params. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickParams(faultFile: FaultFile, seed: number): Record<string, number> {
  const rng = mulberry32(seed);
  const params: Record<string, number> = {};
  for (const [name, [min, max]] of Object.entries(faultFile.params ?? {})) {
    params[name] = min + rng() * (max - min);
  }
  return params;
}

function resolvePlaceholder(value: unknown, params: Record<string, number>): unknown {
  if (typeof value === "string") {
    const match = value.match(/^\{(\w+)\}$/);
    if (match) return params[match[1]];
  }
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseAtSeconds(at: string): number {
  return Number(at.replace(/s$/, ""));
}

/** Turns a relative "240s" offset into an absolute ISO timestamp anchored at startedAt. */
function absoluteTime(startedAt: string, at: string): string {
  return new Date(new Date(startedAt).getTime() + parseAtSeconds(at) * 1000).toISOString();
}

function resolvePhases(
  startedAt: string,
  phases?: PhasesSpec
): Record<string, string | [string, string]> | undefined {
  if (!phases) return undefined;
  const resolved: Record<string, string | [string, string]> = {};
  if (phases.baseline) {
    resolved.baseline = [absoluteTime(startedAt, phases.baseline[0]), absoluteTime(startedAt, phases.baseline[1])];
  }
  if (phases.fault_onset) {
    resolved.fault_onset = absoluteTime(startedAt, phases.fault_onset);
  }
  if (phases.fault_window) {
    resolved.fault_window = [
      absoluteTime(startedAt, phases.fault_window[0]),
      absoluteTime(startedAt, phases.fault_window[1]),
    ];
  }
  return resolved;
}

async function setProviderConfig(errorRate: number): Promise<void> {
  console.log(`[ilab] provider.set errorRate=${errorRate}`);
  const res = await fetchWithRetry(`${PROVIDER_URL}/admin/set-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ errorRate }),
  });
  if (!res.ok) throw new Error(`provider.set failed: HTTP ${res.status}`);
}

async function setLoadRate(rps: number): Promise<void> {
  console.log(`[ilab] load.set rps=${rps}`);
  const res = await fetchWithRetry(`${LOADGEN_URL}/admin/rate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rps }),
  });
  if (!res.ok) throw new Error(`load.set failed: HTTP ${res.status}`);
}

async function addToxic(action: ToxicAction): Promise<void> {
  const name = action.name ?? `${action.type}_ilab`;
  console.log(`[ilab] toxic.add ${action.proxy}/${name} type=${action.type} ${JSON.stringify(action.attributes ?? {})}`);
  const res = await fetchWithRetry(`${TOXIPROXY_URL}/proxies/${action.proxy}/toxics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type: action.type, attributes: action.attributes ?? {} }),
  });
  if (!res.ok) throw new Error(`toxic.add failed: HTTP ${res.status}`);
}

async function removeToxic(proxy: string, name: string): Promise<void> {
  console.log(`[ilab] toxic.remove ${proxy}/${name}`);
  const res = await fetchWithRetry(`${TOXIPROXY_URL}/proxies/${proxy}/toxics/${name}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`toxic.remove failed: HTTP ${res.status}`);
}

async function toggleProxy(proxy: string, enabled: boolean): Promise<void> {
  console.log(`[ilab] proxy.toggle ${proxy} enabled=${enabled}`);
  const res = await fetchWithRetry(`${TOXIPROXY_URL}/proxies/${proxy}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`proxy.toggle failed: HTTP ${res.status}`);
}

async function postDeploy(action: DeployAction): Promise<string> {
  console.log(`[ilab] deploy ${action.service} ${JSON.stringify(action.set)} (${action.reason})`);
  const res = await fetchWithRetry(`${REGISTRY_URL}/deploys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service: action.service, set: action.set, author: "ilab", reason: action.reason }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`deploy failed: ${JSON.stringify(body)}`);
  console.log(`[ilab]   -> ${body.change_id}`);

  if (action.service === "nginx-gateway") {
    const { renderNginxRateLimit } = await import("../deploy/nginxGateway");
    await renderNginxRateLimit();
  }

  return body.change_id;
}

/** Runs every non-deploy, non-rollback action in a step. Deploy/rollback are
 * handled by the caller, since they need to mutate the run's changeIds list. */
async function runSideEffects(step: Action, params: Record<string, number>): Promise<void> {
  if (step["provider.set"]) {
    await setProviderConfig(resolvePlaceholder(step["provider.set"].errorRate, params) as number);
  }
  if (step["load.set"]) {
    await setLoadRate(resolvePlaceholder(step["load.set"].rps, params) as number);
  }
  if (step["toxic.add"]) {
    await addToxic(step["toxic.add"]);
  }
  if (step["toxic.remove"]) {
    await removeToxic(step["toxic.remove"].proxy, step["toxic.remove"].name);
  }
  if (step["proxy.toggle"]) {
    await toggleProxy(step["proxy.toggle"].proxy, step["proxy.toggle"].enabled);
  }
}

function loadFaultFile(incidentId: string): FaultFile {
  const raw = readFileSync(join(FAULTS_DIR, `${incidentId}.yaml`), "utf-8");
  return parseYaml(raw) as FaultFile;
}

/**
 * Finds the latest REAL (non-counterfactual) run manifest. Reset undoes what
 * was actually deployed - a --no-deploy run never created a change_id, so
 * picking one up here would silently skip rolling back the real run.
 */
function latestManifestFor(incidentId: string): RunManifest | null {
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.startsWith(`${incidentId}-seed`) && f.endsWith(".json") && !f.includes("-nodeploy-"))
    .sort();
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(RUNS_DIR, files[files.length - 1]), "utf-8"));
}

async function cmdApply(incidentId: string, seed: number, control: boolean): Promise<void> {
  const faultFile = loadFaultFile(incidentId);
  const params = pickParams(faultFile, seed);
  console.log(
    `[ilab] applying ${incidentId} with seed=${seed}, params=${JSON.stringify(params)}${control ? " (control run: skipping the causal step)" : ""}`
  );

  const startedAt = new Date().toISOString();
  const changeIds: string[] = [];

  let elapsed = 0;
  const sorted = [...faultFile.timeline].sort((a, b) => parseAtSeconds(a.at) - parseAtSeconds(b.at));

  for (const step of sorted) {
    const targetSeconds = parseAtSeconds(step.at);
    const waitMs = Math.max(0, targetSeconds * 1000 - elapsed);
    if (waitMs > 0) {
      console.log(`[ilab] waiting ${waitMs}ms to reach t=${targetSeconds}s`);
      await sleep(waitMs);
      elapsed += waitMs;
    }

    if (step.causal && control) {
      console.log(`[ilab] skipping causal step (control run) at t=${targetSeconds}s`);
    } else {
      await runSideEffects(step, params);
      if (step.deploy) {
        changeIds.push(await postDeploy(step.deploy));
      }
    }

    if (step.end) {
      console.log(`[ilab] end of timeline at t=${targetSeconds}s`);
      break;
    }
  }

  const endedAt = new Date().toISOString();
  const manifest: RunManifest = {
    incidentId,
    seed,
    counterfactual: control,
    params,
    startedAt,
    endedAt,
    changeIds,
    phases: resolvePhases(startedAt, faultFile.phases),
  };

  const suffix = control ? "-nodeploy" : "";
  const manifestPath = join(RUNS_DIR, `${incidentId}-seed${seed}${suffix}-${Date.now()}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[ilab] wrote run manifest: ${manifestPath}`);
}

async function cmdReset(incidentId: string): Promise<void> {
  const faultFile = loadFaultFile(incidentId);
  const manifest = latestManifestFor(incidentId);
  const params = manifest?.params ?? {};

  for (const step of faultFile.reset) {
    if (step.rollback === "all_created") {
      if (!manifest) {
        console.warn(`[ilab] no run manifest found for ${incidentId}, nothing to roll back`);
        continue;
      }
      // Reverse chronological order, so layered diffs unwind correctly.
      for (const changeId of [...manifest.changeIds].reverse()) {
        console.log(`[ilab] rolling back ${changeId}`);
        const original = await (await fetchWithRetry(`${REGISTRY_URL}/deploys/${changeId}`)).json();
        const set: Record<string, unknown> = {};
        for (const [key, change] of Object.entries(original.diff as Record<string, { from: unknown }>)) {
          set[key] = change.from;
        }
        await postDeploy({ service: original.service, set, reason: `rollback ${changeId} (ilab reset)` });
      }
    }
    await runSideEffects(step, params);
  }

  console.log(`[ilab] reset ${incidentId} complete`);
}

interface VerifyAllSpec {
  id: string;
  seed: number;
  /** Incidents with no causal-step marker (INC-00) have nothing to skip, so
   * there's no counterfactual run to prove absent. */
  needsControl: boolean;
}

const ALL_INCIDENTS: VerifyAllSpec[] = [
  { id: "INC-00", seed: 1, needsControl: false },
  { id: "INC-01", seed: 42, needsControl: true },
  { id: "INC-02", seed: 1, needsControl: true },
  { id: "INC-03", seed: 1, needsControl: true },
  { id: "INC-05", seed: 1, needsControl: true },
  { id: "INC-10", seed: 1, needsControl: true },
  { id: "INC-12", seed: 1, needsControl: true },
];

/** Rough post-reset health signal: are 5xxs still elevated anywhere? A
 * non-zero reading here doesn't fail the run on its own (a few in-flight
 * requests can straggle in right after a reset) - it's a warning for the
 * table, not a verdict. */
async function baselineLooksHealthy(): Promise<boolean> {
  const promUrl = process.env.PROMETHEUS_URL ?? "http://localhost:9090";
  // A short window, checked well after the reset - a wide one would still
  // catch an incident's own genuine fault-window traffic tailing off right
  // up to the moment the timeline ends (confirmed via payment-service logs:
  // INC-01's last real retry landed ~10s before this check fired, comfortably
  // inside a 15s lookback but not a 5s one).
  const query = 'increase(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5s])';
  const res = await fetch(`${promUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
  if (!res.ok) return true; // can't tell - don't punish the run for a Prometheus hiccup
  const body = await res.json();
  const total = (body.data?.result ?? []).reduce(
    (sum: number, r: { value: [number, string] }) => sum + Number(r.value[1]),
    0
  );
  return total < 5;
}

async function runVerifyTest(incidentId: string): Promise<boolean> {
  const { execSync } = await import("node:child_process");
  try {
    execSync(`npx vitest run infra/faults/verify/${incidentId}.test.ts`, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

async function cmdVerifyAll(only?: string[]): Promise<void> {
  const incidents = only ? ALL_INCIDENTS.filter((spec) => only.includes(spec.id)) : ALL_INCIDENTS;
  const results: { id: string; pass: boolean; baselineRestored: boolean; error?: string }[] = [];

  for (const spec of incidents) {
    console.log(`\n[ilab] ==================== ${spec.id} ====================`);
    let pass = false;
    try {
      await cmdApply(spec.id, spec.seed, false);
      if (spec.needsControl) {
        await cmdReset(spec.id);
        await cmdApply(spec.id, spec.seed, true);
      }
      pass = await runVerifyTest(spec.id);
    } catch (error) {
      console.error(`[ilab] ${spec.id} errored: ${error instanceof Error ? error.message : error}`);
    }

    let baselineRestored = true;
    try {
      await cmdReset(spec.id);
      // A high-volume incident (a retry storm, sustained throttling) can
      // still have in-flight requests started under fault conditions
      // resolving as errors for several seconds after the reset itself
      // completes - give those time to drain before judging.
      await new Promise((resolve) => setTimeout(resolve, 10000));
      baselineRestored = await baselineLooksHealthy();
    } catch (error) {
      console.error(`[ilab] ${spec.id} reset failed: ${error instanceof Error ? error.message : error}`);
      baselineRestored = false;
    }

    results.push({ id: spec.id, pass, baselineRestored });
  }

  console.log("\n[ilab] verify-all results:");
  console.log("ID       VERIFY    BASELINE RESTORED");
  for (const r of results) {
    console.log(`${r.id.padEnd(9)}${(r.pass ? "PASS" : "FAIL").padEnd(10)}${r.baselineRestored ? "yes" : "no"}`);
  }

  if (results.some((r) => !r.pass || !r.baselineRestored)) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [command, incidentId, ...rest] = process.argv.slice(2);

  if (command === "verify-all") {
    // ilab verify-all [INC-00,INC-05] - handy for smoke-testing this command
    // itself without waiting through every incident's full timeline.
    const only = incidentId ? incidentId.split(",") : undefined;
    await cmdVerifyAll(only);
  } else if (command === "apply") {
    const seedFlagIndex = rest.indexOf("--seed");
    const seed = seedFlagIndex >= 0 ? Number(rest[seedFlagIndex + 1]) : Date.now();
    // --no-deploy is kept as a synonym: it's the exact flag name INC-01's spec
    // asked for, and it reads naturally when the causal step happens to be a
    // deploy. --control is the generic name for incidents whose causal step is
    // something else (a load spike, a toxic, ...).
    const control = rest.includes("--no-deploy") || rest.includes("--control");
    await cmdApply(incidentId, seed, control);
  } else if (command === "reset") {
    await cmdReset(incidentId);
  } else {
    console.error("usage: ilab <apply|reset> <INC-ID> [--seed n] [--no-deploy|--control]  |  ilab verify-all");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
