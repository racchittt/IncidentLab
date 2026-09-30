# Incident dataset card — Milestone 5

Nine incidents, each with a real timeline (`infra/faults/*.yaml`), a live 5-13 minute
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

## INC-03 — cache stampede

| | |
|---|---|
| **Mechanism** | order-service does cache-aside product price lookups: Redis first, on a miss a deliberately expensive Postgres query (`pg_sleep(0.4)`, simulating a heavy join) then a `SET` with TTL. Loadgen sends 80% of traffic to 3 "hot" products out of 20. At t=240s, a causal deploy drops `cache.ttlSeconds` from 300 to 5 - once a hot key's entry (cached under the old long TTL) finally expires, it starts cycling through short-lived misses every ~5s instead of every 5 minutes. |
| **Evidence** | A real 6-minute run: baseline hit ratio ~0.995 (240s) vs. ~0.92 in the back half of the fault window (entries cached under the old 300s TTL don't feel the new one until they naturally expire, so the first ~60s of the fault window still looks like baseline). `order_db_pool_in_use` average rises from 0 to ~0.15 over that same back half. |
| **Control run** | `--no-deploy` keeps the TTL at 300 throughout: hit ratio stays ~0.98. |
| **Gotcha** | Three real findings. (1) order-service had never touched Postgres before this incident, and its `docker-compose.yml` block had zero `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`REDIS_URL` env vars - `pg.Pool` defaulted to `127.0.0.1:5432` and every lookup failed with `ECONNREFUSED` until those were added. (2) The original plan's 30rps baseline unintentionally tripped order-service's *own* pre-existing DynamoDB write-capacity limiter (20/s, INC-02's baseline) before requests ever reached the price lookup at all - had to drop to 15rps and compensate with a smaller pool (5→2) and a costlier simulated miss (0.2s→0.4s) to keep a measurable signal at the lower, DynamoDB-safe traffic level. (3) Real request queueing (`order_db_pool_waiting > 0`) was never achieved at any traffic level tried - concurrent misses per hot product (~1.5-2, computed from `rps × hot-share ÷ hot-product-count × miss-duration`) stayed under even a pool of 2's exact capacity, since three independently-expiring keys stagger their misses instead of synchronizing into one burst the way a naive "total rps × miss duration" estimate assumes. The verified evidence ended up being elevated miss rate and briefly-elevated pool utilization, not literal queueing - a real, honest signal, just a more modest one than first planned. Also needed a new helper (`promAvgOverTime`, using `avg_over_time` on raw samples) since the existing `promAvg`'s coarser query-range step was stepping right over this signal, averaging it away to exactly 0. |

## INC-05 — provider slowdown ("it wasn't us")

| | |
|---|---|
| **Mechanism** | Zero deploy. A Toxiproxy latency toxic (1200ms) is added to the existing `provider` proxy at t=60s — the third-party payment provider just got slow on its own. |
| **Evidence** | p95 end-to-end provider call duration: ~4.75ms baseline vs. ~2425ms in the fault window. Zero deploys for payment-service. |
| **Control run** | `--no-deploy`: toxic never added, p95 stays flat. |
| **Gotcha** | First attempt used 2500ms latency, which exceeds payment-service's own 2000ms request timeout. Every call timed out, tripped the circuit breaker (5 consecutive failures → open for 10s), and once open the breaker fails *instantly* without calling the provider at all — which erased the very latency signal the incident is supposed to produce (measured p95 stayed near baseline). Fixed by keeping the toxic under the timeout (1200ms), so calls succeed slowly instead of failing fast. |

## INC-08 — silent fulfilment failure

| | |
|---|---|
| **Mechanism** | worker-service polls `queue.name` from config every 5s, the same hot-reload pattern order-service uses for its own config. At t=120s, a causal deploy points it at `orders-placed-v2` - a name nobody's ever enqueued to. SQS's own idempotent `CreateQueueCommand` just hands back a fresh, permanently-empty queue: no restart, no error, no log line that looks like a failure - just silence. order-service never notices anything; it keeps enqueueing to the real `orders-placed` queue exactly as always. |
| **Evidence** | A real run: `orders_created_total` +598 during the 120s fault window, `orders_fulfilled_total` +0 - exactly zero. `sqs_queue_depth` on `orders-placed` climbs from 0 to 510 over that same window. Zero error-level log lines for either service throughout. **Zero errors anywhere is the defining property of this incident**, not an assertion of convenience - if this incident ever produces a real error, something about it is wrong. |
| **Control run** | `--no-deploy` keeps `queue.name` at `orders-placed` throughout: creation and fulfilment stay in lockstep (+598.9 created vs. +598.9 fulfilled over the same window). |
| **Gotcha** | worker-service had no existing registry row when this was built (unlike order-service/payment-service, which already had rows from earlier incidents). The first deploy's diff would have shown `queue.name` going `from: null` instead of `from: "orders-placed"` - which would have broken reset's rollback-to-baseline behavior, since `pollWorkerServiceConfig`'s `typeof body.config?.queue?.name === "string"` check treats a `null` value as "no override, keep whatever's in memory" rather than "explicitly reset." Had to manually seed the baseline value via a real deploy first - the same pattern already needed for order-service/nginx-gateway/postgres earlier this session, whenever a brand-new config key gets added to an already-running service. |

## INC-09 — connection leak (slow burn)

| | |
|---|---|
| **Mechanism** | payment-service gets a `ledger.auditWrites` feature flag (default `false`). When on, every successful charge also writes a compliance audit row using a manually checked-out pg client (`pool.connect()`) rather than the pool's own query helper. For ~0.5% of orders (a simulated constraint violation, `hash(orderId) % 200 === 0`), that code path returns early without ever calling `client.release()` - a genuine connection leak, not a spike. Everything else releases normally through a `finally` block. At t=120s a causal deploy turns the flag on, reason "enable audit trail for compliance." |
| **Evidence** | A real run: `payment_db_pool_in_use` climbs in an actual staircase, not a spike - 0 baseline, ~5.35 early in the fault window, ~16.83 late in the fault window, closing in on the pool's own `max: 20`. 19 "audit write failed" log lines over the 480s fault window (the deliberately-leaking 0.5% branch). Once the pool got close to exhausted near the end of the window, real `"timeout exceeded when trying to connect"` pg errors appeared, cascading into charge failures for orders that had nothing to do with the leaking branch - `pool.connect()` itself now times out before the code ever reaches the hash check, turning a rare 0.5% failure mode into something closer to 100% past the tipping point. The registry deploy diff carries `ledger.auditWrites`. |
| **Control run** | `--no-deploy` keeps `ledger.auditWrites` at `false` throughout: `payment_db_pool_in_use` stays flat (~0.5 baseline vs. ~0.17 late in the window - noise, not a leak). |
| **Gotcha** | This is the one incident in the set whose lesson is about the *reset* mechanism itself, not just the fault. Rolling back the config alone does **not** return leaked connections - confirmed live: after 5 leaks accumulated during a manual smoke test, rolling back the flag without restarting left `payment_db_pool_in_use` at 6, not 0. A `pg.Pool` only frees a connection when something calls `release()` on it; a config rollback doesn't know anything leaked, so it can't do that on the pool's behalf. Only an actual process restart clears it - `pool` is itself reconstructed from scratch. Added a new `restart` action to `ilab` (`docker compose restart <service>`) specifically for this, and INC-09's reset block does rollback *then* restart for exactly this reason. Also hit the by-now-familiar SEED_DEFAULTS-first-creation-only issue (payment-service already had a registry row from earlier incidents, so `db.poolMax` and `ledger.auditWrites` needed an explicit manual deploy to seed a real baseline before testing), and the previously-documented restart-required-for-pool-size constraint (a deploy bumping `db.poolMax` alone doesn't resize the already-constructed `Pool` - the service needs a restart to pick it up). |

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

## Verification results

A full `npx tsx infra/faults/ilab.ts verify-all` run against every incident (real run,
counterfactual where one applies, vitest, reset) on 2026-09-30:

| ID | VERIFY | BASELINE RESTORED | CONFIG DRIFT |
|---|---|---|---|
| INC-00 | PASS | yes | none |
| INC-01 | PASS | yes | none |
| INC-02 | PASS | yes | none |
| INC-03 | FAIL → fixed | yes | none |
| INC-05 | PASS | yes | none |
| INC-08 | PASS | yes | none |
| INC-09 | PASS | yes | none |
| INC-10 | PASS | yes | none |
| INC-12 | PASS | yes | none |

INC-03 failed this run on a real flake, not a broken incident: its `db_pool_in_use`
check compared baseline against only the back half of the fault window (copied from
the hit-ratio check next to it, which needs that restriction so the short TTL has time
to cycle - pool contention doesn't). With a signal this sparse, restricting to the back
half meant a handful of 5s-interval Prometheus scrapes catching a brief blip could land
on either side of `avg_over_time`'s exclusive left boundary more or less at random;
this run caught 4 of its 6 nonzero samples before the midpoint. Fixed by comparing
against the full fault window instead, then verified against both the failing run's own
data (now passes) and a brand new real+counterfactual run (passes cleanly) - not
curve-fit to the one data point that failed.

## What's honestly not verified

- **Timing gotchas (INC-05's toxic-vs-timeout, INC-12's pool-detection lag) were found and fixed for the specific values used here** (1200ms, 40s). Pushing `--seed` to change other randomized params, or running against a differently-loaded environment, could plausibly re-surface variants of the same class of issue.
- **INC-03's `db_pool_in_use` signal is inherently sparse** (baseline avg ~0.04, fault avg ~0.15-0.2, both real measured numbers) even after the verify-all-driven fix above - real queueing was never achieved at this traffic/pool-size scale, only a brief, honest, comparably-small elevation. A future seed or load change could still land close enough to the noise floor to flake again.
