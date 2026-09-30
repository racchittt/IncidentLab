"""The six tools' query/formatting logic, shared between ReplayBackend and
LiveBackend. Both populate the same attributes (self._metrics_df,
self._logs, self._spans, self.deploys, self.topology, self.cutoff) - one
by reading a frozen bundle, the other by querying Prometheus/Loki/Tempo/
the registry live - and get identical query behavior from here. What can
still differ between them is the raw data each one fetches, which is
exactly what the parity test checks.
"""

from datetime import datetime, timezone

from agent.tools._analysis import detect_onset, log_template, template_hash
from evals.schema import EvidenceItem

TOP_N = 10
EXAMPLES_PER_TEMPLATE = 2


def _format_metric_summary(view: str, stats: dict) -> str:
    baseline, recent, pct, onset_ts = stats["baseline_mean"], stats["recent_mean"], stats["pct_change"], stats["onset_ts"]
    baseline_s = f"{baseline:.3g}" if baseline is not None else "n/a"
    recent_s = f"{recent:.3g}" if recent is not None else "n/a"
    if pct is None:
        pct_s = "n/a"
    elif pct == float("inf"):
        pct_s = "+inf%"
    else:
        pct_s = f"{pct:+.0f}%"
    onset_s = (
        datetime.fromtimestamp(onset_ts, tz=timezone.utc).strftime("%H:%M:%S")
        if onset_ts
        else "no clear onset detected"
    )
    return f"[{view}] baseline mean {baseline_s}, last 5 min mean {recent_s} ({pct_s}), change began ~{onset_s}"


def _p95(durations_ms: list[float]) -> float:
    durations_ms = sorted(durations_ms)
    idx = min(len(durations_ms) - 1, int(len(durations_ms) * 0.95))
    return durations_ms[idx]


class BundleQueryMixin:
    def list_services(self) -> list[EvidenceItem]:
        services = sorted(self.topology.get("services", []))
        return [EvidenceItem(key="topology:services", summary=", ".join(services))]

    def get_service_graph(self) -> list[EvidenceItem]:
        edges = self.topology.get("edges", [])
        summary = "; ".join(f"{e['from']} -> {e['to']}" for e in edges)
        return [EvidenceItem(key="topology:graph", summary=summary)]

    def query_metrics(self, service: str, metric: str | None = None) -> list[EvidenceItem]:
        df = self._metrics_df[self._metrics_df.service == service]
        if df.empty:
            return []

        if metric is None:
            items = []
            for name in sorted(df.metric.unique()):
                views = sorted(df[df.metric == name].view.unique())
                items.append(
                    EvidenceItem(key=f"metric:{service}:{name}", summary=f"available views: {', '.join(views)}")
                )
            return items

        sub = df[df.metric == metric]
        if sub.empty:
            return []

        items = []
        for view in sorted(sub.view.unique()):
            points = list(sub[sub.view == view][["ts", "value"]].itertuples(index=False, name=None))
            stats = detect_onset(points)
            items.append(
                EvidenceItem(key=f"metric:{service}:{metric}", summary=_format_metric_summary(view, stats))
            )
        return items

    def query_logs(self, service: str, level: str | None = None, contains: str | None = None) -> list[EvidenceItem]:
        lines = [line for line in self._logs if line["service"] == service]
        if level:
            lines = [line for line in lines if (line.get("level") or "").lower() == level.lower()]
        if contains:
            lines = [line for line in lines if contains.lower() in line["message"].lower()]

        groups: dict[str, list[dict]] = {}
        for line in lines:
            groups.setdefault(log_template(line["message"]), []).append(line)

        ranked = sorted(groups.items(), key=lambda kv: len(kv[1]), reverse=True)[:TOP_N]

        items = []
        for template, group in ranked:
            examples = [g["message"] for g in group[:EXAMPLES_PER_TEMPLATE]]
            summary = f'{len(group)} occurrences of "{template}". Examples: ' + "; ".join(repr(e) for e in examples)
            items.append(EvidenceItem(key=f"log:{service}:{template_hash(template)}", summary=summary))
        return items

    def query_traces(
        self, service: str, min_duration_ms: float | None = None, errors_only: bool = False
    ) -> list[EvidenceItem]:
        spans = [s for s in self._spans if s["service"] == service]
        if min_duration_ms is not None:
            spans = [s for s in spans if s["duration_ns"] / 1e6 >= min_duration_ms]
        if errors_only:
            spans = [s for s in spans if s["status"] == "error"]

        groups: dict[str, list[dict]] = {}
        for s in spans:
            groups.setdefault(s["name"], []).append(s)

        ranked = []
        for name, group in groups.items():
            durations_ms = [s["duration_ns"] / 1e6 for s in group]
            ranked.append((name, len(group), _p95(durations_ms)))
        ranked.sort(key=lambda t: t[2], reverse=True)

        return [
            EvidenceItem(key=f"trace:{service}:{name}", summary=f"{count} spans, p95 duration {p95_ms:.1f}ms")
            for name, count, p95_ms in ranked[:TOP_N]
        ]

    def list_deployments(self, service: str | None = None) -> list[EvidenceItem]:
        deploys = self.deploys
        if service:
            deploys = [d for d in deploys if d["service"] == service]

        items = []
        for d in sorted(deploys, key=lambda d: d["ts"]):
            keys = ", ".join(sorted(d["diff"].keys()))
            summary = f"{d['service']} at {d['ts']}, changed: {keys}"
            items.append(EvidenceItem(key=f"deploy:{d['change_id']}", summary=summary))
        return items

    def get_change_diff(self, change_id: str) -> list[EvidenceItem]:
        for d in self.deploys:
            if d["change_id"] == change_id:
                diff_str = "; ".join(f"{k}: {v['from']} -> {v['to']}" for k, v in d["diff"].items())
                summary = f"{d['service']} at {d['ts']}: {diff_str}. Reason: {d.get('reason') or 'none given'}"
                return [EvidenceItem(key=f"deploy:{change_id}", summary=summary)]
        return []
