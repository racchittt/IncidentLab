"""Golden-file tests: run each of the 6 tools (7 functions - list_services
and get_service_graph are two entry points onto the same topology data)
against the recorded INC-01 bundle and compare to a saved snapshot. Any
later change to the tools or the analysis helpers that alters their output
shows up here as a diff, not a surprise.

These are pinned to whichever bundle was most recently recorded for
INC-01 (via evals/bundles/index.jsonl) at the time the golden files were
written - re-recording a fresh bundle is a legitimate reason to need new
golden files (new change_ids, new timestamps), not a bug in the tools.
"""

import json
from pathlib import Path

import pytest

from agent.tools.replay_backend import ReplayBackend

REPO_ROOT = Path(__file__).parent.parent.parent
BUNDLES_DIR = REPO_ROOT / "evals" / "bundles"
GOLDEN_DIR = Path(__file__).parent / "golden"

# The retry.baseMs/retry.jitter change that's this bundle's own causal
# deploy (evals/incidents/INC-01.gt.yaml's expected_path) - re-pin this
# whenever the golden files get regenerated against a new "latest" INC-01
# bundle, since change_ids aren't stable across a registry rebuild.
CAUSAL_CHANGE_ID = "chg-0029"

CALLS: list[tuple[str, dict]] = [
    ("list_services", {}),
    ("get_service_graph", {}),
    ("query_metrics", {"service": "payment-service"}),
    ("query_metrics", {"service": "payment-service", "metric": "payment_retry_attempts_total"}),
    ("query_logs", {"service": "payment-service"}),
    ("query_logs", {"service": "mock-payment-provider"}),
    ("query_traces", {"service": "payment-service", "min_duration_ms": 500}),
    ("query_traces", {"service": "mock-payment-provider", "errors_only": True}),
    ("list_deployments", {"service": "payment-service"}),
    ("get_change_diff", {"change_id": CAUSAL_CHANGE_ID}),
]


def _golden_name(method: str, kwargs: dict) -> str:
    if not kwargs:
        return f"{method}.json"
    suffix = "_".join(f"{k}={v}" for k, v in kwargs.items())
    return f"{method}__{suffix}.json"


def _latest_bundle_dir_for(incident_id: str) -> Path:
    index_path = BUNDLES_DIR / "index.jsonl"
    entries = [json.loads(line) for line in index_path.read_text().splitlines() if line.strip()]
    matches = [e for e in entries if e["incident_id"] == incident_id]
    if not matches:
        raise RuntimeError(f"no recorded bundle for {incident_id} in {index_path}")
    return BUNDLES_DIR / matches[-1]["bundle_id"]


@pytest.fixture(scope="module")
def backend() -> ReplayBackend:
    return ReplayBackend(_latest_bundle_dir_for("INC-01"))


@pytest.mark.parametrize("method, kwargs", CALLS, ids=[_golden_name(m, kw) for m, kw in CALLS])
def test_tool_output_matches_golden(backend: ReplayBackend, method: str, kwargs: dict):
    result = [item.model_dump() for item in getattr(backend, method)(**kwargs)]

    golden_path = GOLDEN_DIR / _golden_name(method, kwargs)
    if not golden_path.exists():
        GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
        golden_path.write_text(json.dumps(result, indent=2))
        pytest.skip(f"wrote new golden file {golden_path.name} - re-run to verify it now matches")

    expected = json.loads(golden_path.read_text())
    assert result == expected
