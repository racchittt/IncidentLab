"""Tempo search per service in the window: every error trace, every trace
over 1s, plus a random sample of 100 normal ones - fetched in full and
flattened to simplified spans.
"""

import os
import random
import time

import httpx

from evals.recorder import http_utils

TEMPO_URL = os.environ.get("TEMPO_URL", "http://localhost:3200")
NORMAL_SAMPLE_SIZE = 100
SEARCH_LIMIT = 1000
# "Every error trace, every trace over 1s" is the spec, but a deliberately
# dramatic incident (a retry storm's giveups all take several retries, so
# their traces run long) can put that in the thousands - capped so one
# incident's own worst case can't blow the ~50MB bundle budget or turn a
# recording run into an hours-long one. Sampled, not just truncated, so a
# capped set is still representative rather than just "whatever sorted
# first."
MAX_INTERESTING_TRACES = 300


def _search(query: str, start: int, end: int, limit: int) -> list[str]:
    resp = http_utils.get(
        f"{TEMPO_URL}/api/search",
        params={"q": query, "start": start, "end": end, "limit": limit},
    )
    resp.raise_for_status()
    return [t["traceID"] for t in resp.json().get("traces", [])]


def _fetch_trace(trace_id: str) -> dict | None:
    resp = http_utils.get(f"{TEMPO_URL}/api/traces/{trace_id}")
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def _service_name(batch: dict) -> str | None:
    for attr in batch.get("resource", {}).get("attributes", []):
        if attr["key"] == "service.name":
            return attr["value"].get("stringValue")
    return None


def _simplify(trace_json: dict) -> list[dict]:
    spans = []
    for batch in trace_json.get("batches", []):
        service = _service_name(batch)
        for scope_span in batch.get("scopeSpans", []):
            for span in scope_span.get("spans", []):
                start_ns = int(span["startTimeUnixNano"])
                end_ns = int(span["endTimeUnixNano"])
                status_code = span.get("status", {}).get("code", 0)  # 0 UNSET, 1 OK, 2 ERROR
                spans.append(
                    {
                        "trace_id": span["traceId"],
                        "span_id": span["spanId"],
                        "parent_span_id": span.get("parentSpanId"),
                        "name": span["name"],
                        "service": service,
                        "start": start_ns,
                        "duration_ns": end_ns - start_ns,
                        "status": "error" if status_code == 2 else "ok",
                    }
                )
    return spans


def record_traces(start: int, end: int, known_services: set[str]) -> list[dict]:
    interesting_ids: set[str] = set()
    all_ids: set[str] = set()

    for service in known_services:
        base = f'resource.service.name="{service}"'
        interesting_ids.update(_search(f"{{{base} && status=error}}", start, end, SEARCH_LIMIT))
        interesting_ids.update(_search(f"{{{base} && duration>1s}}", start, end, SEARCH_LIMIT))
        all_ids.update(_search(f"{{{base}}}", start, end, SEARCH_LIMIT))

    interesting_list = list(interesting_ids)
    if len(interesting_list) > MAX_INTERESTING_TRACES:
        print(f"[recorder]   {len(interesting_list)} error/slow traces found, sampling down to {MAX_INTERESTING_TRACES}")
        random.shuffle(interesting_list)
        interesting_list = interesting_list[:MAX_INTERESTING_TRACES]
    interesting_ids = set(interesting_list)

    normal_pool = list(all_ids - interesting_ids)
    random.shuffle(normal_pool)
    trace_ids = interesting_ids | set(normal_pool[:NORMAL_SAMPLE_SIZE])

    print(f"[recorder]   fetching {len(trace_ids)} full traces")
    spans: list[dict] = []
    skipped = 0
    for i, trace_id in enumerate(trace_ids, 1):
        try:
            trace_json = _fetch_trace(trace_id)
        except httpx.HTTPError as error:
            # This single-container Tempo instance has been under
            # continuous load for hours this session and occasionally
            # drops an individual trace fetch outright under sustained
            # sequential requests - losing one trace out of hundreds isn't
            # worth failing an otherwise-successful recording run over.
            print(f"[recorder]   trace {trace_id} failed, skipping: {error}")
            skipped += 1
            trace_json = None
        if trace_json:
            spans.extend(_simplify(trace_json))
        if i % 50 == 0:
            print(f"[recorder]   {i}/{len(trace_ids)} traces fetched ({skipped} skipped)")
        time.sleep(0.02)
    if skipped:
        print(f"[recorder]   {skipped}/{len(trace_ids)} traces skipped after retries")
    return spans
