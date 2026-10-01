import gzip
import re
from pathlib import Path

import pandas as pd
import pytest

BANNED_TOKENS = ["INC-", "ilab", "toxic", "fault", "counterfactual", "seed"]
# Word-boundary, not substring - "ilab" is also a substring of "available",
# "seed" of "exceed", "fault" of "default"/"faulty"/"faults". \b around a
# token ending in "-" (INC-) still matches correctly: a hyphen is a
# non-word character, so the digits right after it (INC-01) still form a
# real \w/\W boundary.
_BANNED_PATTERN = re.compile(r"\b(?:" + "|".join(re.escape(t) for t in BANNED_TOKENS) + r")\b", re.IGNORECASE)


def _iter_bundle_text(bundle_dir: Path):
    """Yields (file_label, text) for every human-readable file in a
    recorded bundle."""
    for name in ("bundle.json", "deploys.json", "topology.json"):
        path = bundle_dir / name
        if path.exists():
            yield name, path.read_text()

    for name in ("logs.jsonl.gz", "spans.jsonl.gz"):
        path = bundle_dir / name
        if path.exists():
            with gzip.open(path, "rt") as f:
                yield name, f.read()


def _iter_bundle_metric_values(bundle_dir: Path):
    """metrics.parquet is binary and compressed - a byte-grep over the raw
    file can't reliably find a substring, so its string columns get
    checked by value instead."""
    path = bundle_dir / "metrics.parquet"
    if not path.exists():
        return
    df = pd.read_parquet(path)
    for column in ("service", "metric", "view"):
        if column in df.columns:
            for value in df[column].dropna().unique():
                yield f"metrics.parquet:{column}", str(value)


def assert_bundle_is_clean(bundle_dir: Path) -> None:
    # assert's message is only evaluated on failure, so match.group() here
    # is safe even though match is None on the passing path.
    for label, text in _iter_bundle_text(bundle_dir):
        match = _BANNED_PATTERN.search(text)
        assert match is None, f"{label} contains banned token {match.group()!r}"

    for label, value in _iter_bundle_metric_values(bundle_dir):
        match = _BANNED_PATTERN.search(value)
        assert match is None, f"{label} value {value!r} contains banned token {match.group()!r}"


def _latest_bundle_dir() -> Path | None:
    bundles_dir = Path(__file__).parent.parent / "bundles"
    if not bundles_dir.exists():
        return None
    bundle_dirs = [p for p in bundles_dir.iterdir() if p.is_dir()]
    if not bundle_dirs:
        return None
    return max(bundle_dirs, key=lambda p: p.stat().st_mtime)


def test_latest_bundle_has_no_leakage():
    latest = _latest_bundle_dir()
    if latest is None:
        pytest.skip("no recorded bundles to scrub - run the recorder first")
    assert_bundle_is_clean(latest)


def _all_bundle_dirs() -> list[Path]:
    bundles_dir = Path(__file__).parent.parent / "bundles"
    if not bundles_dir.exists():
        return []
    return sorted(p for p in bundles_dir.iterdir() if p.is_dir())


@pytest.mark.parametrize("bundle_dir", _all_bundle_dirs(), ids=lambda p: p.name[:8])
def test_every_bundle_has_no_leakage(bundle_dir: Path):
    # A dataset of real size (dozens of bundles, not just the newest one) is
    # exactly when a one-off leak in some other incident's bundle - recorded
    # hours ago, never re-checked since - would otherwise go unnoticed.
    assert_bundle_is_clean(bundle_dir)
