# Incident dataset card — Milestone 5

Six incidents, each with a real timeline (`infra/faults/*.yaml`), a live 5-13 minute
`ilab apply` run against the actual stack, and a vitest suite
(`infra/faults/verify/*.test.ts`) that asserts against real Prometheus/Loki/
deploy-registry data afterward — not a canned fixture. Every incident except INC-00
also has a `--no-deploy`/`--control` counterfactual run: the same timeline, minus the
one causal step, proving the effect doesn't happen when the cause is absent.

Run any of them with `npx tsx infra/faults/ilab.ts apply <ID> --seed <n>`, verify with
`npx vitest run infra/faults/verify/<ID>.test.ts`, undo with
`npx tsx infra/faults/ilab.ts reset <ID>`. Or run the whole set with
`npx tsx infra/faults/ilab.ts verify-all`.

## INC-00 — negative control

| | |
|---|---|
| **Mechanism** | One harmless deploy (`log.level: debug` — a key payment-service never reads) at t=100s. No load change, no toxic, no causal step at all. |
| **Evidence** | Error rate and p95 provider latency measured flat across the deploy (baseline vs. after: 0 vs. 0 errors, ~4.75ms vs. ~4.75ms p95). |
| **Control run** | None — there's nothing to prove absent when nothing is supposed to happen. |
| **Gotcha** | None found. This one worked first try — useful confirmation that "nothing happened" is itself a real, checkable signal, not just the absence of a test. |

## INC-01 — retry storm

| | |
|---|---|
| **Mechanism** | Provider error rate (0.3) is fixed from t=0 — only one thing changes during the incident. At t=240s, a deploy removes retry backoff (`retry.baseMs: 0`). The provider's overload model is keyed on retry *timing*, not raw concurrency: it tracks same-`Idempotency-Key` re-attempts landing within 15ms of the previous attempt ("rapid retries"); a burst of those degrades the provider for everyone, briefly. |
| **Evidence** | Orders exhausting all 5 retry attempts (`giveup` outcome): ~4 in baseline (240s) vs. ~1023 in the fault window (~340s) — a ~245x jump. Zero deploys for payment-service outside the one causal step. |
| **Control run** | `--no-deploy`: same fixed error rate, retry.baseMs never changes. Giveups stay in the same tiny-noise ballpark as baseline. |
| **Gotcha** | This took the most tuning by far. At this traffic scale (~10rps), concurrent in-flight calls to the provider almost never exceed 1-2 regardless of backoff — a concurrency-based capacity model (`inFlight` counter) never showed *any* difference between backoff and no-backoff, across five different `CAPACITY`/`LATENCY_MS`/`errorRate`/loadgen-rps combinations. The real signal only appears when overload is modeled on retry *timing* per request, not aggregate load. |

## INC-02 — DynamoDB write throttling

| | |
|---|---|
| **Mechanism** | Pure load, zero deploy. order-service's DynamoDB writes are already behind a token bucket (`ddb.writeCapacity: 20`/s baseline, never touched). At t=60s, `load.set: {rps: 40}` doubles traffic past that capacity. |
| **Evidence** | `ProvisionedThroughputExceededException` in order-service's logs: ~0 in baseline (60s) vs. ~1194 in the fault window (120s). Zero deploys for order-service throughout. |
| **Control run** | `--no-deploy` (rate stays at 5): throttling stays at 0. |
| **Gotcha** | None — passed clean on the first real run. The mechanism (an existing, already-wired rate limiter) made this the simplest incident to build. |

## INC-05 — provider slowdown ("it wasn't us")

| | |
|---|---|
| **Mechanism** | Zero deploy. A Toxiproxy latency toxic (1200ms) is added to the existing `provider` proxy at t=60s — the third-party payment provider just got slow on its own. |
| **Evidence** | p95 end-to-end provider call duration: ~4.75ms baseline vs. ~2425ms in the fault window. Zero deploys for payment-service. |
| **Control run** | `--no-deploy`: toxic never added, p95 stays flat. |
| **Gotcha** | First attempt used 2500ms latency, which exceeds payment-service's own 2000ms request timeout. Every call timed out, tripped the circuit breaker (5 consecutive failures → open for 10s), and once open the breaker fails *instantly* without calling the provider at all — which erased the very latency signal the incident is supposed to produce (measured p95 stayed near baseline). Fixed by keeping the toxic under the timeout (1200ms), so calls succeed slowly instead of failing fast. |

## INC-10 — nginx rate-limit misconfiguration

| | |
|---|---|
| **Mechanism** | A deploy to `nginx-gateway` at t=60s tightens `ratelimit.rate` from the 30r/s baseline to 2r/s, below the steady ~5rps of traffic already flowing through it. |
| **Evidence** | 429s from nginx: 0 in baseline (60s) vs. 336 in the fault window (120s), with total request volume staying flat (loadgen's own rate never changes — only the outcome, 200 vs. 429, does). |
| **Control run** | `--no-deploy`: rate limit never drops, 429s stay at 0. |
| **Gotcha** | Two real bugs, not just tuning. (1) nginx's `limit_req` returns 503 on rejection by default — indistinguishable in the access log from a genuine upstream failure. Fixed with `limit_req_status 429`. (2) The verify helper's Loki query counted raw fetched log lines, which Loki caps at 100 per query by default — silently undercounting anything busier than that (a real 429 spike showed up as "0" until this was caught). Fixed by rewriting the helper to use a `count_over_time()` metric query (aggregated server-side) instead. |

## INC-12 — decoy deploy + real outage

| | |
|---|---|
| **Mechanism** | A genuinely inert deploy (`log.level: debug`, same never-read key as INC-00) at t=235s, immediately followed by a real cause: payment-service's Postgres connection (routed through a new Toxiproxy `postgres` proxy) is toggled off at t=240s for 40s. The decoy is deliberately *not* marked causal, so it happens in both the real run and the counterfactual — the point is proving it's a red herring even when a control comparison is available. |
| **Evidence** | 503s from payment-service: 0 in the 235-240s gap between decoy and outage, 116 in the back half of the outage window, back to 0 well after the proxy is restored. The decoy's diff (`log.level`) confirmed in the registry. |
| **Control run** | `--no-deploy` skips only the outage — the decoy deploy still happens. Errors stay near-zero throughout, proving the decoy alone never causes anything, with or without a comparison run. |
| **Gotcha** | The outage had to be extended from 20s to 40s. payment-service's `pg` connection pool keeps serving queries off already-open idle connections for a while after the proxy goes down — real error timestamps showed anywhere from ~2s to ~15s of delay before failures started, varying between runs. A short outage window can end before the pool ever notices. This is a genuine characteristic of connection pooling, not a test flake — worth knowing before trusting "the outage started at time X" in a real postmortem. |

## What's honestly not verified

- **`ilab verify-all`'s "baseline restored" check is a light heuristic** (5xx error rate near zero 3s after reset), not a full config-equality check against each service's seeded defaults. A reset that silently left one config key wrong would still show "yes" here.
- **Timing gotchas (INC-05's toxic-vs-timeout, INC-12's pool-detection lag) were found and fixed for the specific values used here** (1200ms, 40s). Pushing `--seed` to change other randomized params, or running against a differently-loaded environment, could plausibly re-surface variants of the same class of issue.
- **No Tempo/trace-level assertions** in any of these tests, despite the original Milestone 4 plan mentioning span-level evidence for INC-05 — every incident here is verified through Prometheus metrics and Loki logs only.
