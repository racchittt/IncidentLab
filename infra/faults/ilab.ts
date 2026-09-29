/**
 * ilab - fault engine runner.
 *
 * Usage (run with `npx tsx infra/faults/ilab.ts ...` from the repo root):
 *   ilab apply <INC-ID> --seed <n>
 *   ilab reset <INC-ID>
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://localhost:3004";
const PROVIDER_URL = process.env.MOCK_PROVIDER_URL ?? "http://localhost:3002";
const FAULTS_DIR = join(__dirname);
const RUNS_DIR = join(__dirname, "..", "..", "runs");

interface DeployAction {
  service: string;
  set: Record<string, unknown>;
  reason?: string;
}

interface TimelineStep {
  at: string;
  "provider.set"?: { errorRate: number | string };
  deploy?: DeployAction;
  end?: boolean;
}

interface FaultFile {
  id: string;
  params: Record<string, [number, number]>;
  timeline: TimelineStep[];
  reset: Array<{ rollback?: string; "provider.set"?: { errorRate: number | string } }>;
}

interface RunManifest {
  incidentId: string;
  seed: number;
  params: Record<string, number>;
  startedAt: string;
  endedAt: string;
  changeIds: string[];
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

async function setProviderConfig(errorRate: number): Promise<void> {
  console.log(`[ilab] provider.set errorRate=${errorRate}`);
  const res = await fetch(`${PROVIDER_URL}/admin/set-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ errorRate }),
  });
  if (!res.ok) throw new Error(`provider.set failed: HTTP ${res.status}`);
}

async function postDeploy(action: DeployAction): Promise<string> {
  console.log(`[ilab] deploy ${action.service} ${JSON.stringify(action.set)} (${action.reason})`);
  const res = await fetch(`${REGISTRY_URL}/deploys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service: action.service, set: action.set, author: "ilab", reason: action.reason }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`deploy failed: ${JSON.stringify(body)}`);
  console.log(`[ilab]   -> ${body.change_id}`);
  return body.change_id;
}

function loadFaultFile(incidentId: string): FaultFile {
  const raw = readFileSync(join(FAULTS_DIR, `${incidentId}.yaml`), "utf-8");
  return parseYaml(raw) as FaultFile;
}

function latestManifestFor(incidentId: string): RunManifest | null {
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.startsWith(`${incidentId}-seed`) && f.endsWith(".json"))
    .sort();
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(RUNS_DIR, files[files.length - 1]), "utf-8"));
}

async function cmdApply(incidentId: string, seed: number): Promise<void> {
  const faultFile = loadFaultFile(incidentId);
  const params = pickParams(faultFile, seed);
  console.log(`[ilab] applying ${incidentId} with seed=${seed}, params=${JSON.stringify(params)}`);

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

    if (step["provider.set"]) {
      const errorRate = resolvePlaceholder(step["provider.set"].errorRate, params) as number;
      await setProviderConfig(errorRate);
    }
    if (step.deploy) {
      const changeId = await postDeploy(step.deploy);
      changeIds.push(changeId);
    }
    if (step.end) {
      console.log(`[ilab] end of timeline at t=${targetSeconds}s`);
      break;
    }
  }

  const endedAt = new Date().toISOString();
  const manifest: RunManifest = { incidentId, seed, params, startedAt, endedAt, changeIds };

  const manifestPath = join(RUNS_DIR, `${incidentId}-seed${seed}-${Date.now()}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[ilab] wrote run manifest: ${manifestPath}`);
}

async function cmdReset(incidentId: string): Promise<void> {
  const faultFile = loadFaultFile(incidentId);
  const manifest = latestManifestFor(incidentId);

  for (const step of faultFile.reset) {
    if (step.rollback === "all_created") {
      if (!manifest) {
        console.warn(`[ilab] no run manifest found for ${incidentId}, nothing to roll back`);
        continue;
      }
      // Reverse chronological order, so layered diffs unwind correctly.
      for (const changeId of [...manifest.changeIds].reverse()) {
        console.log(`[ilab] rolling back ${changeId}`);
        const original = await (await fetch(`${REGISTRY_URL}/deploys/${changeId}`)).json();
        const set: Record<string, unknown> = {};
        for (const [key, change] of Object.entries(original.diff as Record<string, { from: unknown }>)) {
          set[key] = change.from;
        }
        await postDeploy({ service: original.service, set, reason: `rollback ${changeId} (ilab reset)` });
      }
    }
    if (step["provider.set"]) {
      const errorRate = resolvePlaceholder(step["provider.set"].errorRate, manifest?.params ?? {}) as number;
      await setProviderConfig(errorRate);
    }
  }

  console.log(`[ilab] reset ${incidentId} complete`);
}

async function main(): Promise<void> {
  const [command, incidentId, ...rest] = process.argv.slice(2);

  if (command === "apply") {
    const seedFlagIndex = rest.indexOf("--seed");
    const seed = seedFlagIndex >= 0 ? Number(rest[seedFlagIndex + 1]) : Date.now();
    await cmdApply(incidentId, seed);
  } else if (command === "reset") {
    await cmdReset(incidentId);
  } else {
    console.error("usage: ilab <apply|reset> <INC-ID> [--seed n]");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
