/**
 * deployctl - CLI for deploy-registry.
 *
 * Usage (run with `npx tsx infra/deploy/deployctl.ts ...` from the repo root):
 *   deployctl deploy <service> --set key.path=value [--set key.path=value ...] [--reason "..."] [--author name] [--restart]
 *   deployctl history <service> [--since ISO] [--until ISO]
 *   deployctl rollback <change_id>
 */

const REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://localhost:3004";

function parseValue(raw: string): unknown {
  try {
    // Lets --set retry.baseMs=0 become a number and --set retry.jitter=none stay a
    // string (JSON.parse("none") throws, so it falls through to the raw string).
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface ParsedArgs {
  set: Record<string, unknown>;
  reason?: string;
  author?: string;
  since?: string;
  until?: string;
  restart: boolean;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { set: {}, restart: false, positional: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--set") {
      const kv = argv[++i];
      const eq = kv.indexOf("=");
      result.set[kv.slice(0, eq)] = parseValue(kv.slice(eq + 1));
    } else if (arg === "--reason") {
      result.reason = argv[++i];
    } else if (arg === "--author") {
      result.author = argv[++i];
    } else if (arg === "--since") {
      result.since = argv[++i];
    } else if (arg === "--until") {
      result.until = argv[++i];
    } else if (arg === "--restart") {
      result.restart = true;
    } else {
      result.positional.push(arg);
    }
  }

  return result;
}

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${REGISTRY_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await res.json();
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${REGISTRY_URL}${path}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}`);
  }
  return res.json();
}

async function cmdDeploy(argv: string[]): Promise<void> {
  const { set, reason, author, restart, positional } = parseArgs(argv);
  const service = positional[0];
  if (!service || Object.keys(set).length === 0) {
    throw new Error("usage: deployctl deploy <service> --set key=value [...] [--reason r] [--restart]");
  }

  const deploy = await postJson("/deploys", { service, set, author: author ?? "deployctl", reason });
  console.log(`${deploy.change_id}  ${service}  v${deploy.version}`);
  console.log(JSON.stringify(deploy.diff, null, 2));

  if (service === "nginx-gateway") {
    const { renderNginxRateLimit } = await import("./nginxGateway");
    await renderNginxRateLimit();
  }

  if (restart) {
    console.log(`restarting ${service}...`);
    const { execSync } = await import("node:child_process");
    execSync(`docker compose restart ${service}`, { stdio: "inherit" });
  }
}

async function cmdHistory(argv: string[]): Promise<void> {
  const { since, until, positional } = parseArgs(argv);
  const service = positional[0];

  const params = new URLSearchParams();
  if (service) params.set("service", service);
  if (since) params.set("since", since);
  if (until) params.set("until", until);

  const rows = await getJson(`/deploys?${params.toString()}`);
  for (const row of rows ?? []) {
    console.log(`${row.change_id}  ${row.ts}  v${row.version}  ${row.service}  ${row.reason ?? ""}`);
    console.log(`  ${JSON.stringify(row.diff)}`);
  }
}

async function cmdRollback(argv: string[]): Promise<void> {
  const { positional } = parseArgs(argv);
  const changeId = positional[0];
  if (!changeId) {
    throw new Error("usage: deployctl rollback <change_id>");
  }

  const original = await getJson(`/deploys/${changeId}`);
  if (!original) {
    throw new Error(`no such deploy: ${changeId}`);
  }

  // A rollback is a new deploy that reverses the original diff - never a delete,
  // so the audit trail stays honest for whoever (or whatever agent) reads it later.
  const set: Record<string, unknown> = {};
  for (const [key, change] of Object.entries(original.diff as Record<string, { from: unknown; to: unknown }>)) {
    set[key] = change.from;
  }

  const rollback = await postJson("/deploys", {
    service: original.service,
    set,
    author: "deployctl",
    reason: `rollback ${changeId}`,
  });

  console.log(`${rollback.change_id}  ${original.service}  v${rollback.version}  (rollback of ${changeId})`);
  console.log(JSON.stringify(rollback.diff, null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "deploy":
      return cmdDeploy(rest);
    case "history":
      return cmdHistory(rest);
    case "rollback":
      return cmdRollback(rest);
    default:
      console.error("usage: deployctl <deploy|history|rollback> ...");
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
