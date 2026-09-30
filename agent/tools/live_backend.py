"""LiveBackend(window_start_iso, cutoff_iso): the same six tools, queried
directly from Prometheus/Loki/Tempo/the registry - no bundle required.
Reuses the recorder's own source modules (evals/recorder/*_source.py) for
fetching, so a parity check against ReplayBackend is testing "does
re-querying live match what got frozen into the bundle", not two
independently-written fetchers that happen to agree by luck.
"""

import json
from datetime import datetime
from pathlib import Path

import pandas as pd

from agent.tools._bundle_query import BundleQueryMixin
from evals.recorder import loki_source, prometheus_source, registry_source, tempo_source

TOPOLOGY_PATH = Path(__file__).parent.parent.parent / "infra" / "topology.json"


def _to_epoch_seconds(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


class LiveBackend(BundleQueryMixin):
    def __init__(self, window_start_iso: str, cutoff_iso: str):
        window_start = _to_epoch_seconds(window_start_iso)
        self.cutoff = _to_epoch_seconds(cutoff_iso)

        self.topology = json.loads(TOPOLOGY_PATH.read_text())

        print(f"[live] metrics for [{window_start_iso}, {cutoff_iso}]...")
        metric_rows = prometheus_source.record_metrics(window_start, self.cutoff)
        self._metrics_df = pd.DataFrame(metric_rows, columns=["service", "metric", "view", "ts", "value"])
        print(f"[live]   {len(metric_rows)} rows")

        start_ns = window_start * 1_000_000_000
        cutoff_ns = self.cutoff * 1_000_000_000
        self._logs = []
        print("[live] logs...")
        for service in sorted(prometheus_source.KNOWN_SERVICES):
            service_lines = loki_source.fetch_logs(service, start_ns, cutoff_ns)
            print(f"[live]   {service}: {len(service_lines)} lines")
            self._logs.extend(service_lines)

        print("[live] traces...")
        self._spans = tempo_source.record_traces(window_start, self.cutoff, prometheus_source.KNOWN_SERVICES)
        print(f"[live]   {len(self._spans)} spans")

        # Already bounded to [window_start - 30min lookback, cutoff_iso] -
        # registry_source queries "until" directly, no post-filter needed
        # the way ReplayBackend needs one against a wider frozen bundle.
        print("[live] deploys...")
        self.deploys = registry_source.fetch_deploys(window_start_iso, cutoff_iso)
        print(f"[live]   {len(self.deploys)} deploys")
