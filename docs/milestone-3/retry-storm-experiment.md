# Retry storm experiment (Task 5), corrected after review

**Baseline:** k6 holds a steady 5 req/s through `POST /orders`; payment-service's
dashboard shows ~5 req/s success, circuit closed (0), single-digit-ms p95.

## What "Request rate" actually measures

The panel's query is `sum(rate(http_server_request_duration_seconds_count{service_name
="payment-service"}[1m]))` — OTel's auto-instrumented HTTP **server** metric. It counts
*incoming* calls to payment-service's own `/charges` endpoint. It does **not** count
payment-service's outbound calls to the provider — those happen inside the handling of
one incoming request and are invisible to this metric. The only place a provider retry
shows up is `payment.retry.attempts{outcome="retry"}`, on the "Retry rate by outcome"
panel. This distinction matters below.

## b. Inject latency (3s toxic, 2s timeout)

Confirmed with real Prometheus numbers, not just the screenshot: in the window the
breaker was flapping open/half-open, `sum(rate(payment_retry_attempts_total[20s])) by
(outcome)` peaked at **`giveup`=31/s, `retry`=0.4/s**. Since `giveup` and `success`
together equal the incoming request count, a `giveup` rate of 31/s on its own proves
the elevated "Request rate" (screenshot `b-latency-toxic-breaker-opens.jpg`) is driven
by **extra incoming calls to payment-service**, not by provider-side retries. The only
way payment-service gets called more than 5×/s is `worker-service` calling it again for
messages that failed and were left for SQS redelivery — confirmed.

## The 10-minute-to-open mystery, solved

Reviewer's hypothesis was right: the worker has **zero concurrency**.
`ReceiveMessageCommand` never sets `MaxNumberOfMessages` (SQS defaults to 1), and the
`for` loop `await`s each message fully before looping back for the next receive — one
message in flight, always. Confirmed in Tempo: pulling one order's full trace (which
Tempo merges across all redelivery attempts, since they share the original
`traceparent`) shows three `process-order` spans at t=0.005s, t=30.005s, t=60.094s —
**almost exactly 30 seconds apart** (SQS's default `VisibilityTimeout`), while each
individual attempt itself only takes 1–9ms. A slow/failing provider call doesn't slow
one order down; it stalls the *entire* single-threaded consumer, so the queue backs up
far faster than a serial worker can drain it, and every backed-up message then pays a
fixed ~30s tax per redelivery regardless of how fast the failure itself was. That's a
real finding (a slow dependency + a serial consumer = a backlog that outlives the root
cause) — basically INC-06, found by accident. Fix: `WORKER_CONCURRENCY` (default 5),
processing up to N messages in parallel via `Promise.allSettled`, with
`MaxNumberOfMessages` on `ReceiveMessage` raised to match.

**Verified the fix, not just the theory:** re-ran the same 3s latency toxic against the
concurrency-5 worker. Toxic added at `t=0`; `circuit breaker state changed
{"from":"closed","to":"open"}` logged at **t=23s** — down from ~10 minutes to 23
seconds. That's the expected order of magnitude: 5 concurrent calls can now stack up
`failureThreshold`(5) failures within roughly one timeout cycle, instead of one call
at a time taking a fixed ~30s-per-redelivery tax to get there serially.

## c. The storm — corrected

**This section was wrong in the first draft.** The "Request rate jumps 5→17" claim was
a misread: the `c-retry-storm.jpg` screenshot's 15-minute trailing window still
contained phase b's tail end, and I attributed that leftover spike to phase c's change.
Querying Prometheus for the actual phase-c window (after removing the toxic, restoring
the breaker, then setting `PAYMENT_RETRY_BASE_MS=0` + `JITTER=none` with the provider's
`ERROR_RATE=0.3`) shows something different and more precise:

- `success` stays flat at ~5/s the whole time — matching k6's order rate exactly.
- `retry` rises from 0 to **~2.2–2.5/s** — a real, sustained increase.
- `giveup` stays at 0 — at a 30% per-attempt error rate with 5 max attempts, the chance
  all 5 fail is only 0.3⁵ ≈ 0.24%, so almost everything still succeeds eventually.

So "Request rate" (incoming calls to payment-service) genuinely does **not** move in
phase c — retries never create new incoming requests, they're internal to handling one.
The real signal is entirely on "Retry rate by outcome"'s `retry` line: roughly +45%
extra calls landing on the provider, and — confirmed in logs — arriving in bursts
**4ms apart** instead of spread out, because `baseMs=0` removes all delay between
attempts. At `ERROR_RATE=0.3` this is a burstiness problem (all-or-nothing timing) more
than a sheer-volume storm; a higher error rate or lower `maxAttempts` would be needed to
also move `giveup`/request rate. Restoring backoff+jitter and resetting the error rate
brings `retry` back to ~0 within a couple of minutes (`c-recovered.jpg`).

## The one panel to point at

"Retry rate by outcome" is the panel that actually tells the truth in both b and c:
in b, `giveup` climbing (not `retry`) proves it's SQS redeliveries, not provider
retries; in c, `retry` climbing (with `giveup` flat) proves the opposite — real
provider-side amplification that never shows up as extra incoming traffic. Reading
"Request rate" alone would have given the wrong story both times.
