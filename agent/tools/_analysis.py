"""Shared math for the tools: onset detection for query_metrics, log
templating for query_logs. Kept deterministic and cheap on purpose - see
the reading guide's reasoning on why a simple rule beats a clever one
here.
"""

import hashlib
import re
import statistics

_UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE)
_NUM_RE = re.compile(r"\d+")

RECENT_WINDOW_SECONDS = 5 * 60


def log_template(message: str) -> str:
    template = _UUID_RE.sub("<uuid>", message)
    template = _NUM_RE.sub("#", template)
    return template


def template_hash(template: str) -> str:
    return hashlib.sha256(template.encode()).hexdigest()[:8]


def detect_onset(points: list[tuple[int, float]]) -> dict:
    """points: (ts_seconds, value), any order. Onset = the first of 3
    consecutive points exceeding a provisional baseline's mean + 3 stddev,
    where the provisional baseline is the first quarter of the series - a
    fixed, cheap rule, not a statistical model. Once an onset is found, the
    reported baseline is recomputed from everything strictly before it (a
    tighter, truer baseline than the provisional one used to find it).
    "Recent" is literally the last 5 minutes of whatever data the caller is
    allowed to see - there's no oracle knowledge of where a fault window
    boundary "really" is, by design (a live tool wouldn't have one either).
    """
    if not points:
        return {"baseline_mean": None, "recent_mean": None, "pct_change": None, "onset_ts": None}

    points = sorted(points, key=lambda p: p[0])
    values = [v for _, v in points]

    provisional_n = max(3, len(points) // 4)
    provisional = values[:provisional_n]
    prov_mean = statistics.mean(provisional)
    prov_std = statistics.pstdev(provisional) if len(provisional) > 1 else 0.0
    # A metric that's genuinely flat at baseline (giveups, pool_waiting,
    # audit-write failures - many of this project's real incidents are
    # exactly "usually 0, then not") has prov_std == 0, which degenerates
    # "+3 stddev" to "+0" - the very first random nonzero blip then counts
    # as onset. A floor of 10% of the series' own peak keeps the rule just
    # as simple and deterministic while requiring a deviation that's
    # actually a meaningful fraction of the signal, not any blip at all.
    scale_floor = 0.1 * max(abs(v) for v in values)
    threshold = prov_mean + max(3 * prov_std, scale_floor)

    onset_index = None
    consecutive = 0
    for i, v in enumerate(values):
        if v > threshold:
            consecutive += 1
            if consecutive >= 3:
                onset_index = i - 2
                break
        else:
            consecutive = 0

    if onset_index is not None and onset_index > 0:
        baseline_values = values[:onset_index]
        onset_ts = points[onset_index][0]
    elif onset_index == 0:
        # The breach starts at the very first point - no real "before" to
        # measure a baseline from, so fall back to the provisional window.
        baseline_values = provisional
        onset_ts = points[0][0]
    else:
        baseline_values = provisional
        onset_ts = None

    baseline_mean = statistics.mean(baseline_values)

    window_end_ts = points[-1][0]
    recent_values = [v for ts, v in points if ts >= window_end_ts - RECENT_WINDOW_SECONDS]
    recent_mean = statistics.mean(recent_values) if recent_values else values[-1]

    if baseline_mean:
        pct_change = ((recent_mean - baseline_mean) / abs(baseline_mean)) * 100
    elif recent_mean:
        pct_change = float("inf")
    else:
        pct_change = 0.0

    return {
        "baseline_mean": baseline_mean,
        "recent_mean": recent_mean,
        "pct_change": pct_change,
        "onset_ts": onset_ts,
    }
