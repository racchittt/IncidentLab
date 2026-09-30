"""Every log line per service in the window, paged past Loki's default
100-line cap by advancing the query's start time to just past the last
line seen each round.
"""

import os

from evals.recorder import http_utils

LOKI_URL = os.environ.get("LOKI_URL", "http://localhost:3100")
PAGE_LIMIT = 1000

_IGNORED_LABEL_KEYS = {"service_name", "severity_text", "detected_level"}


def fetch_logs(service: str, start_ns: int, end_ns: int) -> list[dict]:
    lines: list[dict] = []
    cursor = start_ns

    while cursor <= end_ns:
        resp = http_utils.get(
            f"{LOKI_URL}/loki/api/v1/query_range",
            params={
                "query": f'{{service_name="{service}"}}',
                "start": str(cursor),
                "end": str(end_ns),
                "limit": str(PAGE_LIMIT),
                "direction": "forward",
            },
        )
        resp.raise_for_status()
        streams = resp.json()["data"]["result"]

        page: list[tuple[int, str, dict]] = []
        for stream in streams:
            labels = stream["stream"]
            for ts_str, text in stream["values"]:
                page.append((int(ts_str), text, labels))
        if not page:
            break
        page.sort(key=lambda row: row[0])

        for ts_ns, text, labels in page:
            lines.append(
                {
                    "ts": ts_ns,
                    "service": service,
                    "level": labels.get("severity_text") or labels.get("detected_level"),
                    "message": text,
                    "metadata": {k: v for k, v in labels.items() if k not in _IGNORED_LABEL_KEYS},
                }
            )

        if len(page) < PAGE_LIMIT:
            break
        # Advancing 1ns past the last line risks dropping a same-ns sibling
        # line on the rare tie, but Loki's own timestamps carry nanosecond
        # precision so a real collision is vanishingly unlikely at this
        # stack's traffic scale.
        cursor = page[-1][0] + 1

    return lines
