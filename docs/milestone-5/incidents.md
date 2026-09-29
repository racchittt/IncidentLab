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
| **Mechanism** | Provider error rate (0.15) is fixed from t=0 — only one thing changes during the incident. At t=240s, a deploy removes retry backoff (`retry.baseMs: 0`). The provider is a **token bucket rate limiter** (`RATE_LIMIT_PER_SEC=15` steady refill, `BUCKET_CAPACITY=8` burst allowance, separate from each other) that returns 429 once exceeded — genuinely how real payment APIs behave. Removing backoff bunches a fixed number of retries close together in time instead of spreading them out, which is what actually depletes a *burst* allowance; the steady average call rate barely changes either way. |
| **Evidence** | A real 10-minute run: baseline (backoff intact) — 0 giveups, ~248 429s (all absorbed by retries, none cascading into a failure). Fault window (backoff removed) — 2496 giveups, 2185 429s. Success rate collapsed from ~9.4/s to ~4.3/s. Zero deploys for payment-service outside the one causal step. |
| **Control run** | `--no-deploy`: same fixed error rate, retry.baseMs never changes. Giveups and 429s stay in the same noise floor as baseline. |
| **Gotcha** | An earlier version of this incident modeled overload as same-`Idempotency-Key` retries landing within 15ms of each other ("rapid retries") - functionally correct at the time, but rejected on review as unrealistic: *"no real provider behaves that way."* The realistic replacement (a plain rate limiter) turned out to need its own real tuning: a single-parameter bucket (capacity == refill rate, i.e. a full 1-second burst window) was maddeningly hard to land - 25/s gave zero signal either way, 15/s broke the *baseline* (429s even with backoff intact, since real demand runs closer to the ceiling than expected), 20/s gave zero signal again. What actually worked was separating **burst capacity** from **steady refill rate** - a small burst allowance (8) is what's sensitive to bunched-vs-spread timing; a full-second allowance just measures the average rate, which backoff barely changes. And before any of that: a raw concurrency counter (`inFlight`) never showed *any* difference between backoff and no-backoff at this traffic scale (~10rps), because concurrent in-flight calls almost never exceed 1-2 regardless of backoff - concurrency was never the right axis to model this on. |

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
| **Mechanism** | A genuinely inert deploy (`log.level: debug`, same never-read key as INC-00) at t=235s, immediately followed by a real cause: payment-service's Postgres connection (routed through a new Toxiproxy `postgres` proxy) is toggled off at t=240s for 40s, together with a `reset_peer` toxic (`timeout: 0`) on the same proxy so already-open connections are killed immediately rather than left to linger. The decoy is deliberately *not* marked causal, so it happens in both the real run and the counterfactual — the point is proving it's a red herring even when a control comparison is available. |
| **Evidence** | 503s from payment-service: 0 in the 235-240s gap between decoy and outage, ~110 in the outage window, back to 0 well after the proxy is restored. payment-service's own log shows the specific mechanism: `"Connection terminated unexpectedly"` (the `reset_peer` effect on an already-open connection) about 5s after onset, followed by `ECONNREFUSED` on new connection attempts. The decoy's diff (`log.level`) confirmed in the registry. |
| **Control run** | `--no-deploy` skips only the outage — the decoy deploy still happens. Errors stay near-zero throughout, proving the decoy alone never causes anything, with or without a comparison run. |
| **Gotcha** | Originally just `proxy.toggle` alone, which only blocks *new* connections - payment-service's `pg` pool kept serving queries off already-open idle connections for a while after the proxy went down, and real error timestamps showed anywhere from ~2s to ~15s of delay before failures started, varying between runs. Fixed by adding a `reset_peer` toxic alongside the toggle, which kills existing connections outright - onset dropped to a consistent ~5s. The pool-detection-lag finding is still worth knowing (a real postmortem trusting "the outage started when errors first appeared" could be off by that much), it's just no longer this incident's actual behavior. Separately: Prometheus's `increase()` returned an *empty* result (not zero) for a query window starting too close to a particular counter update, for reasons not fully tracked down - a window starting ~15s after onset reads reliably, one starting at onset+7 sometimes didn't. Worth knowing before assuming a tight verify-test window will behave the way the underlying event's real timing suggests it should. |

## What's honestly not verified

- **`ilab verify-all`'s "baseline restored" check is a light heuristic** (5xx error rate near zero, sampled over a 5s window starting 10s after reset), not a full config-equality check against each service's seeded defaults. A reset that silently left one config key wrong would still show "yes" here.
- **Timing gotchas (INC-05's toxic-vs-timeout, INC-12's pool-detection lag) were found and fixed for the specific values used here** (1200ms, 40s). Pushing `--seed` to change other randomized params, or running against a differently-loaded environment, could plausibly re-surface variants of the same class of issue.
- **No Tempo/trace-level assertions** in any of these tests, despite the original Milestone 4 plan mentioning span-level evidence for INC-05 — every incident here is verified through Prometheus metrics and Loki logs only.
