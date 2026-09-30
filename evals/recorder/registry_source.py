"""Registry deploys from 30 minutes before the window start to its end -
the extra 30 minutes so the agent also sees normal, older deploys, not just
the incident's own.

Every deploy this session has ever created carries author="ilab" and, for a
rollback, a reason like "rollback chg-0141 (ilab reset)" - straight
simulation-internal leakage into what's meant to look like a real
production registry. author is dropped outright (not meaningful info
either way); reason gets scrubbed for every banned token the leakage-scrub
test checks for, so the same fix that's needed here also covers anything
this module's own author didn't anticipate.
"""

import os
import re
from datetime import datetime, timedelta

from evals.recorder import http_utils

REGISTRY_URL = os.environ.get("DEPLOY_REGISTRY_URL", "http://localhost:3004")
LOOKBACK_SECONDS = 30 * 60

# Word-boundary, not substring - "ilab" is also a substring of e.g.
# "available", "seed" of "exceed", "fault" of "default"/"faulty".
_BANNED_TOKENS = ["INC-", "ilab", "toxic", "fault", "counterfactual", "seed"]
_BANNED_PATTERN = re.compile(r"\b(?:" + "|".join(re.escape(t) for t in _BANNED_TOKENS) + r")\b", re.IGNORECASE)


def _redact(text: str | None) -> str | None:
    if text is None:
        return None
    return _BANNED_PATTERN.sub("[redacted]", text)


def fetch_deploys(window_start_iso: str, window_end_iso: str) -> list[dict]:
    start_dt = datetime.fromisoformat(window_start_iso.replace("Z", "+00:00")) - timedelta(seconds=LOOKBACK_SECONDS)
    resp = http_utils.get(
        f"{REGISTRY_URL}/deploys",
        params={"since": start_dt.isoformat(), "until": window_end_iso},
    )
    resp.raise_for_status()

    return [
        {
            "change_id": d["change_id"],
            "service": d["service"],
            "version": d["version"],
            "diff": d["diff"],
            "reason": _redact(d.get("reason")),
            "ts": d["ts"],
        }
        for d in resp.json()
    ]
