/** Shared helpers for fault verification tests (infra/faults/verify/*.test.ts). */

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://localhost:9090";
const LOKI_URL = process.env.LOKI_URL ?? "http://localhost:3100";
const REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://localhost:3004";

export async function promQuery(query: string, startSec: number, endSec: number, step = "15"): Promise<any> {
  const params = new URLSearchParams({ query, start: String(startSec), end: String(endSec), step });
  const res = await fetch(`${PROMETHEUS_URL}/api/v1/query_range?${params}`);
  return res.json();
}

/** Average value of a range query over [startSec, endSec]. 0 if there's no data. */
export async function promAvg(query: string, startSec: number, endSec: number): Promise<number> {
  const body = await promQuery(query, startSec, endSec);
  const values = body.data.result.flatMap((r: { values: [string, string][] }) =>
    r.values.map(([, v]) => Number(v))
  );
  if (values.length === 0) return 0;
  return values.reduce((a: number, b: number) => a + b, 0) / values.length;
}

/** Total increase of a counter over [startSec, endSec]. 0 if there's no data. */
export async function promIncrease(query: string, startSec: number, endSec: number): Promise<number> {
  const durationSec = Math.max(1, Math.floor(endSec - startSec));
  const params = new URLSearchParams({ query: `increase(${query}[${durationSec}s])`, time: String(endSec) });
  const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?${params}`);
  const body = await res.json();
  const values = body.data.result.map((r: { value: [number, string] }) => Number(r.value[1]));
  if (values.length === 0) return 0;
  return values.reduce((a: number, b: number) => a + b, 0);
}

/** Number of matching Loki log lines over [startSec, endSec]. */
export async function lokiCount(query: string, startSec: number, endSec: number): Promise<number> {
  const params = new URLSearchParams({
    query,
    start: `${startSec * 1_000_000_000}`,
    end: `${endSec * 1_000_000_000}`,
  });
  const res = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${params}`);
  const body = await res.json();
  return body.data.result.flatMap((r: { values: unknown[] }) => r.values).length;
}

/** Deploys for a service within [startSec, endSec]. */
export async function getDeploys(service: string, startSec: number, endSec: number): Promise<any[]> {
  const params = new URLSearchParams({
    service,
    since: new Date(startSec * 1000).toISOString(),
    until: new Date(endSec * 1000).toISOString(),
  });
  const res = await fetch(`${REGISTRY_URL}/deploys?${params}`);
  return res.json();
}
