"""python -m evals.recorder.record <manifest.json>

Freezes one ilab run (metrics, logs, traces, deploys, topology, the alert
text) into evals/bundles/<bundle_id>/ - a random UUID, never the incident
ID, so a folder name can't hand the answer to anything that reads a path.
The incident/seed/manifest mapping lives separately, in
evals/bundles/index.jsonl, on the ground-truth side of the fence.
"""

import gzip
import json
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import yaml

from evals.recorder import loki_source, prometheus_source, registry_source, tempo_source

REPO_ROOT = Path(__file__).parent.parent.parent
BUNDLES_DIR = REPO_ROOT / "evals" / "bundles"
INCIDENTS_DIR = REPO_ROOT / "evals" / "incidents"
TOPOLOGY_PATH = REPO_ROOT / "infra" / "topology.json"


def _parse_iso(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _to_epoch_seconds(iso: str) -> int:
    return int(_parse_iso(iso).timestamp())


def _to_epoch_ns(iso: str) -> int:
    return _to_epoch_seconds(iso) * 1_000_000_000


def record(manifest_path: Path) -> str:
    manifest = json.loads(manifest_path.read_text())
    incident_id = manifest["incidentId"]
    seed = manifest["seed"]
    phases = manifest.get("phases") or {}

    baseline = phases.get("baseline")
    fault_window = phases.get("fault_window")
    window_start_iso = baseline[0] if baseline else manifest["startedAt"]
    window_end_iso = fault_window[1] if fault_window else manifest["endedAt"]
    fault_onset_iso = phases.get("fault_onset", window_end_iso)

    window_start = _to_epoch_seconds(window_start_iso)
    window_end = _to_epoch_seconds(window_end_iso)
    investigation_starts_at = _parse_iso(fault_onset_iso) + timedelta(seconds=60)

    gt = yaml.safe_load((INCIDENTS_DIR / f"{incident_id}.gt.yaml").read_text())
    alert = gt["alert"]

    bundle_id = str(uuid.uuid4())
    bundle_dir = BUNDLES_DIR / bundle_id
    bundle_dir.mkdir(parents=True, exist_ok=True)

    print(f"[recorder] recording {incident_id} seed={seed} -> {bundle_id}")

    print("[recorder] metrics...")
    metric_rows = prometheus_source.record_metrics(window_start, window_end)
    pd.DataFrame(metric_rows, columns=["service", "metric", "view", "ts", "value"]).to_parquet(
        bundle_dir / "metrics.parquet"
    )
    print(f"[recorder]   {len(metric_rows)} rows")

    print("[recorder] logs...")
    start_ns, end_ns = _to_epoch_ns(window_start_iso), _to_epoch_ns(window_end_iso)
    log_lines = []
    for service in sorted(prometheus_source.KNOWN_SERVICES):
        service_lines = loki_source.fetch_logs(service, start_ns, end_ns)
        print(f"[recorder]   {service}: {len(service_lines)} lines")
        log_lines.extend(service_lines)
    log_lines.sort(key=lambda line: line["ts"])
    with gzip.open(bundle_dir / "logs.jsonl.gz", "wt") as f:
        for line in log_lines:
            f.write(json.dumps(line) + "\n")
    print(f"[recorder]   {len(log_lines)} lines")

    print("[recorder] traces...")
    spans = tempo_source.record_traces(window_start, window_end, prometheus_source.KNOWN_SERVICES)
    with gzip.open(bundle_dir / "spans.jsonl.gz", "wt") as f:
        for span in spans:
            f.write(json.dumps(span) + "\n")
    print(f"[recorder]   {len(spans)} spans")

    print("[recorder] deploys...")
    deploys = registry_source.fetch_deploys(window_start_iso, window_end_iso)
    (bundle_dir / "deploys.json").write_text(json.dumps(deploys, indent=2))
    print(f"[recorder]   {len(deploys)} deploys")

    (bundle_dir / "topology.json").write_text(TOPOLOGY_PATH.read_text())

    bundle_meta = {
        "window": {"start": window_start_iso, "end": window_end_iso},
        "alert": alert,
        "investigation_starts_at": investigation_starts_at.isoformat().replace("+00:00", "Z"),
    }
    (bundle_dir / "bundle.json").write_text(json.dumps(bundle_meta, indent=2))

    BUNDLES_DIR.mkdir(parents=True, exist_ok=True)
    with (BUNDLES_DIR / "index.jsonl").open("a") as f:
        f.write(
            json.dumps(
                {"bundle_id": bundle_id, "incident_id": incident_id, "seed": seed, "manifest": str(manifest_path)}
            )
            + "\n"
        )

    print(f"[recorder] wrote bundle: {bundle_dir}")
    return bundle_id


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python -m evals.recorder.record <manifest.json>", file=sys.stderr)
        sys.exit(1)
    record(Path(sys.argv[1]))
