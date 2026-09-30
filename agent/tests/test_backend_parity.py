"""Parity check: LiveBackend (queried fresh from Prometheus/Loki/Tempo/the
registry) against ReplayBackend (the same window, frozen into a bundle) -
same evidence keys, same summaries within rounding.

Unlike the golden-file tests, this depends on live infrastructure being
reachable and the bundle's window still being retained in
Prometheus/Loki/Tempo - meant to run right after recording, not as an
always-green standing check. Skips (not fails) when no bundle or no live
stack is available, so it doesn't break an offline test run.
"""

import json
import re
from pathlib import Path

import httpx
import pytest

from agent.tools.live_backend import LiveBackend
from agent.tools.replay_backend import ReplayBackend

REPO_ROOT = Path(__file__).parent.parent.parent
BUNDLES_DIR = REPO_ROOT / "evals" / "bundles"

PARITY_INCIDENTS = ["INC-00", "INC-05", "INC-10"]

_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _numbers(text: str) -> list[float]:
    return [float(n) for n in _NUM_RE.findall(text)]


def _summaries_close(a: str, b: str, rel_tol: float = 0.2) -> bool:
    if a == b:
        return True
    nums_a, nums_b = _numbers(a), _numbers(b)
    if len(nums_a) != len(nums_b):
        return False
    for x, y in zip(nums_a, nums_b):
        if abs(x - y) > rel_tol * max(abs(x), abs(y), 1.0):
            return False
    return True


def _latest_bundle_dir_for(incident_id: str) -> Path | None:
    index_path = BUNDLES_DIR / "index.jsonl"
    if not index_path.exists():
        return None
    entries = [json.loads(line) for line in index_path.read_text().splitlines() if line.strip()]
    matches = [e for e in entries if e["incident_id"] == incident_id]
    if not matches:
        return None
    return BUNDLES_DIR / matches[-1]["bundle_id"]


def _live_stack_reachable() -> bool:
    try:
        httpx.get("http://localhost:9090/-/healthy", timeout=3)
        return True
    except httpx.HTTPError:
        return False


CALLS: list[tuple[str, dict]] = [
    ("list_services", {}),
    ("get_service_graph", {}),
    ("list_deployments", {}),
    ("query_logs", {"service": "payment-service"}),
    ("query_metrics", {"service": "payment-service"}),
]


@pytest.mark.parametrize("incident_id", PARITY_INCIDENTS)
def test_live_matches_replay(incident_id: str):
    bundle_dir = _latest_bundle_dir_for(incident_id)
    if bundle_dir is None:
        pytest.skip(f"no recorded bundle for {incident_id}")
    if not _live_stack_reachable():
        pytest.skip("live stack (Prometheus) not reachable")

    replay = ReplayBackend(bundle_dir)
    live = LiveBackend(replay.bundle["window"]["start"], replay.bundle["investigation_starts_at"])

    for method, kwargs in CALLS:
        replay_items = {item.key: item.summary for item in getattr(replay, method)(**kwargs)}
        live_items = {item.key: item.summary for item in getattr(live, method)(**kwargs)}

        assert set(replay_items) == set(live_items), (
            f"{method}{kwargs}: key mismatch\nreplay={sorted(replay_items)}\nlive={sorted(live_items)}"
        )
        for key in replay_items:
            assert _summaries_close(replay_items[key], live_items[key]), (
                f"{method}{kwargs} key {key!r}:\n  replay={replay_items[key]!r}\n  live={live_items[key]!r}"
            )
