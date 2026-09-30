"""Discovers every metric Prometheus has for our own services and records
derived views (rate for counters, raw value for gauges, p50/p95/p99 for
histograms) at a fixed step - never raw PromQL, so replay mode (no
Prometheus running) has something to serve.
"""

import os

from evals.recorder import http_utils

PROMETHEUS_URL = os.environ.get("PROMETHEUS_URL", "http://localhost:9090")
STEP_SECONDS = 15
RATE_WINDOW_SECONDS = 60  # ~6 scrapes at this stack's 10s OTel export interval

KNOWN_SERVICES = {
    "nginx-gateway",
    "order-service",
    "worker-service",
    "payment-service",
    "mock-payment-provider",
    "deploy-registry",
    "loadgen",
    "sqs-exporter",
}

# The one label worth splitting a metric into separate derived series for.
# Every other label (and the standard HTTP/db instrumentation carries many
# high-cardinality ones - url.full, network.peer.port, ...) gets summed
# away; these three are the only splits any incident's ground truth needs.
SPLIT_LABEL = {
    "payment_retry_attempts_total": "outcome",
    "order_cache_requests_total": "result",
    "http_server_request_duration_seconds_count": "http_response_status_code",
}


def _get(path: str, **params) -> dict:
    resp = http_utils.get(f"{PROMETHEUS_URL}{path}", params=params)
    resp.raise_for_status()
    return resp.json()


def _all_metric_names() -> set[str]:
    return set(_get("/api/v1/label/__name__/values")["data"])


def classify_metrics(names: set[str]) -> dict[str, str]:
    """{base_name: "histogram" | "counter" | "gauge"}. A _bucket/_count/_sum
    trio collapses to one histogram entry under its base name (quantile
    views); _count additionally stays classified as its own counter (rate
    view, or split views for anything in SPLIT_LABEL) since request/call
    count over time is useful independent of the bucket structure - only
    _bucket and _sum are fully absorbed into the histogram entry."""
    histogram_bases = set()
    for name in names:
        if name.endswith("_bucket"):
            base = name[: -len("_bucket")]
            if f"{base}_count" in names and f"{base}_sum" in names:
                histogram_bases.add(base)

    consumed = set()
    histogram_count_names = set()
    for base in histogram_bases:
        consumed |= {f"{base}_bucket", f"{base}_sum"}
        histogram_count_names.add(f"{base}_count")

    kinds = {base: "histogram" for base in histogram_bases}
    for name in names:
        if name in consumed:
            continue
        if name.endswith("_total") or name in histogram_count_names:
            kinds[name] = "counter"
        else:
            kinds[name] = "gauge"
    return kinds


def _services_for(metric: str, start: int, end: int) -> set[str]:
    body = _get(
        "/api/v1/query",
        query=f"group by (service_name) ({metric})",
        time=end,
    )
    found = {r["metric"].get("service_name") for r in body["data"]["result"]}
    return found & KNOWN_SERVICES


def _label_values(metric: str, label: str, service: str, end: int) -> list[str]:
    body = _get(
        "/api/v1/query",
        query=f'group by ({label}) ({metric}{{service_name="{service}"}})',
        time=end,
    )
    return [r["metric"].get(label) for r in body["data"]["result"] if r["metric"].get(label)]


def _range(query: str, start: int, end: int) -> list[tuple[int, float]]:
    body = _get("/api/v1/query_range", query=query, start=start, end=end, step=STEP_SECONDS)
    points: list[tuple[int, float]] = []
    for series in body["data"]["result"]:
        for ts, v in series["values"]:
            try:
                points.append((int(ts), float(v)))
            except ValueError:
                continue  # NaN, e.g. a quantile with no samples in that step
    return points


def record_metrics(start: int, end: int) -> list[dict]:
    """Returns rows with columns service, metric, view, ts, value - ready
    for a pandas DataFrame / metrics.parquet."""
    names = _all_metric_names()
    kinds = classify_metrics(names)
    rows: list[dict] = []

    for metric, kind in kinds.items():
        services = _services_for(f"{metric}_bucket" if kind == "histogram" else metric, start, end)
        for service in services:
            selector = f'{metric}{{service_name="{service}"}}'

            if kind == "gauge":
                for ts, value in _range(f"sum by () ({selector})", start, end):
                    rows.append({"service": service, "metric": metric, "view": "raw", "ts": ts, "value": value})

            elif kind == "counter":
                split = SPLIT_LABEL.get(metric)
                if split:
                    for label_value in _label_values(metric, split, service, end):
                        q = f'sum(rate({metric}{{service_name="{service}",{split}="{label_value}"}}[{RATE_WINDOW_SECONDS}s]))'
                        view = f"rate:{split}={label_value}"
                        for ts, value in _range(q, start, end):
                            rows.append({"service": service, "metric": metric, "view": view, "ts": ts, "value": value})
                else:
                    q = f"sum(rate({selector}[{RATE_WINDOW_SECONDS}s]))"
                    for ts, value in _range(q, start, end):
                        rows.append({"service": service, "metric": metric, "view": "rate", "ts": ts, "value": value})

            else:  # histogram
                bucket_selector = f'{metric}_bucket{{service_name="{service}"}}'
                for quantile, view in ((0.5, "p50"), (0.95, "p95"), (0.99, "p99")):
                    q = f"histogram_quantile({quantile}, sum(rate({bucket_selector}[{RATE_WINDOW_SECONDS}s])) by (le))"
                    for ts, value in _range(q, start, end):
                        rows.append({"service": service, "metric": metric, "view": view, "ts": ts, "value": value})

    return rows
