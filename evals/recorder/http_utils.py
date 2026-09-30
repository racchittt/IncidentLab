"""Shared retry wrapper + connection pool for every recorder HTTP call -
this stack's Prometheus/Loki/Tempo occasionally stall under load for
longer than a single request should wait, and Tempo specifically started
resetting connections outright once trace fetches got into the thousands
with a fresh TCP connection per request. Mirrors infra/faults/ilab.ts's
fetchWithRetry (3 attempts, growing backoff) for the retry part; the
pooled client (keep-alive, reused across every call) is what actually
fixed the connection resets.
"""

import time

import httpx

_client = httpx.Client(timeout=60, limits=httpx.Limits(max_keepalive_connections=8, max_connections=8))


def get(url: str, *, params: dict | None = None, timeout: float = 60, attempts: int = 3) -> httpx.Response:
    """Retries on a transport-level failure (timeout, connection reset) only
    - an HTTP status (a real 404, a real 500) is returned as-is and left to
    the caller, exactly like a direct httpx.get() would."""
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return _client.get(url, params=params, timeout=timeout)
        except (httpx.TimeoutException, httpx.TransportError) as error:
            last_error = error
            if attempt < attempts:
                print(f"[recorder] fetch {url} failed (attempt {attempt}/{attempts}), retrying: {error}")
                time.sleep(attempt)
    assert last_error is not None
    raise last_error
