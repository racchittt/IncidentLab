"""ReplayBackend(bundle_dir): the six investigation tools, served entirely
from a frozen evals/bundles/<id>/ directory - no Prometheus/Loki/Tempo/
registry required. Every method (agent/tools/_bundle_query.py) filters to
bundle.json's investigation_starts_at: the agent can't see the recovery
after reset, only what's real up to that point.
"""

import gzip
import json
from datetime import datetime
from pathlib import Path

import pandas as pd

from agent.tools._bundle_query import BundleQueryMixin


def _to_epoch_seconds(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


class ReplayBackend(BundleQueryMixin):
    def __init__(self, bundle_dir: Path | str):
        self.bundle_dir = Path(bundle_dir)
        self.bundle = json.loads((self.bundle_dir / "bundle.json").read_text())
        self.cutoff = _to_epoch_seconds(self.bundle["investigation_starts_at"])
        self.cutoff_ns = self.cutoff * 1_000_000_000

        self.topology = json.loads((self.bundle_dir / "topology.json").read_text())

        all_deploys = json.loads((self.bundle_dir / "deploys.json").read_text())
        self.deploys = [d for d in all_deploys if _to_epoch_seconds(d["ts"]) <= self.cutoff]

        metrics_df = pd.read_parquet(self.bundle_dir / "metrics.parquet")
        self._metrics_df = metrics_df[metrics_df.ts <= self.cutoff]

        self._logs = []
        with gzip.open(self.bundle_dir / "logs.jsonl.gz", "rt") as f:
            for line in f:
                entry = json.loads(line)
                if entry["ts"] <= self.cutoff_ns:
                    self._logs.append(entry)

        self._spans = []
        with gzip.open(self.bundle_dir / "spans.jsonl.gz", "rt") as f:
            for line in f:
                entry = json.loads(line)
                if entry["start"] <= self.cutoff_ns:
                    self._spans.append(entry)
