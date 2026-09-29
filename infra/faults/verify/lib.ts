/** Shared helpers for fault verification tests (infra/faults/verify/*.test.ts). */

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://localhost:9090";
const LOKI_URL = process.env.LOKI_URL ?? "http://localhost:3100";
const REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://localhost:3004";
const TEMPO_URL = process.env.TEMPO_URL ?? "http://localhost:3200";

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

/**
 * Average value of a gauge over [startSec, endSec], via avg_over_time on the
 * raw stored samples - unlike promAvg (which averages the *discretized*
 * points a query_range call happens to return, at whatever step it used),
 * this doesn't miss a real but brief value change that a coarse step could
 * step right over. Matters for a gauge that's mostly 0 with short spikes
 * (e.g. a DB pool's in-use count during a brief contention burst).
 */
export async function promAvgOverTime(query: string, startSec: number, endSec: number): Promise<number> {
  const durationSec = Math.max(1, Math.floor(endSec - startSec));
  const params = new URLSearchParams({ query: `avg_over_time(${query}[${durationSec}s])`, time: String(endSec) });
  const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?${params}`);
  const body = await res.json();
  const values = body.data.result.map((r: { value: [number, string] }) => Number(r.value[1]));
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

/**
 * Number of matching Loki log lines over [startSec, endSec]. Uses
 * count_over_time (a metric query, aggregated server-side) rather than
 * fetching raw log lines and counting them client-side - the raw-line query
 * endpoint caps results at Loki's default limit (100), which silently
 * undercounts anything busier than that.
 */
export async function lokiCount(query: string, startSec: number, endSec: number): Promise<number> {
  const durationSec = Math.max(1, Math.floor(endSec - startSec));
  const params = new URLSearchParams({
    query: `sum(count_over_time(${query}[${durationSec}s]))`,
    time: String(endSec),
  });
  const res = await fetch(`${LOKI_URL}/loki/api/v1/query?${params}`);
  const body = await res.json();
  const values = body.data.result.map((r: { value: [number, string] }) => Number(r.value[1]));
  if (values.length === 0) return 0;
  return values.reduce((a: number, b: number) => a + b, 0);
}

/**
 * Number of distinct traces matching a TraceQL query within [startSec, endSec].
 * Existence, not volume, is what most trace assertions care about ("did a
 * slow provider-call span happen at all in this window"), so this counts
 * traces (Tempo's /api/search already dedupes to one entry per trace) rather
 * than spans.
 */
export async function tempoSearch(traceQlQuery: string, startSec: number, endSec: number, limit = 50): Promise<number> {
  const params = new URLSearchParams({ q: traceQlQuery, start: String(startSec), end: String(endSec), limit: String(limit) });
  const res = await fetch(`${TEMPO_URL}/api/search?${params}`);
  const body = await res.json();
  return (body.traces ?? []).length;
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
