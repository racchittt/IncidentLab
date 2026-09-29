# Reading guide: Milestone 5 (the core incident set)

This covers everything added on top of Milestone 4's single INC-01 template: a rebuild
of INC-01 itself (the original didn't actually prove its own root cause), the
plumbing five more incidents needed (a controllable load generator, Toxiproxy actions,
a queue-depth exporter, a second Toxiproxy proxy in front of Postgres), five new
incident templates with real mechanics, and an `ilab verify-all` command that runs the
whole set end to end. Same idea as `docs/milestone-4/reading-guide.md` — read this
instead of the raw diff, which spans six commits and touches most of the stack.

## TL;DR — what exists now that didn't before

```
loadgen (rate: POST /admin/rate) ──▶ nginx-gateway ──▶ order-service ──▶ SQS
                                          │                  │
                                   ratelimit.conf      DynamoDB write
                                   (deployable)        token bucket
                                                              │
sqs-exporter (queue depth, separate from worker) ◀───────────┘
                                                              │
                                                        worker-service ──▶ payment-service
                                                                                │      │
                                              toxiproxy:8666 "provider" ◀───────┘      │
                                                    │                                  │
                                          mock-payment-provider              toxiproxy:5433 "postgres"
                                          (rapid-retry overload model)                 │
                                                                                    Postgres

ilab ──▶ deploy-registry / loadgen / mock-provider / toxiproxy, all through fetchWithRetry
ilab verify-all ──▶ apply → [reset → --control apply] → vitest → reset → health check,
                     for each of INC-00/01/02/05/10/12, prints a PASS/FAIL table
```

Six incidents now have real mechanics, a live multi-minute `ilab apply` run against the
actual stack, and a vitest suite asserting against real Prometheus/Loki/registry data
afterward. Five of them also have a `--no-deploy`/`--control` counterfactual run — the
same timeline minus the one causal step — proving the effect doesn't happen when the
cause is absent, not just correlating with it.

## The story so far, in order

### Task 1 — INC-01 didn't actually prove its own root cause

Review caught this before anything else got built: INC-01's verification test passed
even if you deleted the deploy it was supposed to be testing for, because two things
changed at the same instant (the deploy *and* the provider's error rate), and the mock
provider had no capacity model at all — a 32% error rate produces plenty of retries
regardless of whether backoff is on, so the test couldn't tell "the deploy caused this"
from "the provider got worse" (which is really INC-05's story).

Two fixes, and one dead end before the real one. `provider.set` now fires once at
t=0s and stays fixed for the whole run — only the deploy changes during the incident.
The capacity model took three attempts: a raw concurrency counter (`inFlight`) never
showed any difference between backoff and no-backoff, because this traffic scale
(~10rps) essentially never produces two simultaneous calls to the provider regardless
of backoff. A fixed backlog test proved batches of 5 *do* fire concurrently when a
backlog exists — but tuning `CAPACITY` against that only worked when the backlog was
artificially huge, which isn't the incident's real starting condition. The one that
actually worked: track same-`Idempotency-Key` retries landing within 15ms of the
previous attempt ("rapid retries") in a sliding 3s window, and let a burst of those —
only possible once backoff is removed — degrade the provider for everyone. A real
10-minute run measured ~245x more retry giveups in the fault window than baseline; the
counterfactual (`--no-deploy`) stayed in the same noise floor as baseline.

Two files were staged incompletely in the first pass and had to be caught and added in
a follow-up commit: `services/payment-service/metrics.ts` and `index.ts` carry the
`payment.provider.calls_per_charge` / `payment.retry.delay` instrumentation the verify
test actually queries — without them the test would fail against a fresh checkout even
though it passed against the running (uncommitted-code) stack.

### Task 2 — plumbing five more incidents needed

k6 can't have its rate changed mid-run, and INC-02/INC-10's whole fault *is* a traffic
or rate-limit change — replaced it with `services/loadgen`, an Express service whose
rate is a live `POST /admin/rate` call. `infra/faults/ilab.ts`'s `Action` type grew
`load.set`, `toxic.add`/`toxic.remove`, `proxy.toggle` alongside `provider.set`/`deploy`,
all routed through one `runSideEffects()`. INC-01's `--no-deploy` became a generic
`causal: true` marker on whichever timeline step is the incident's actual cause — a
control run skips exactly that step, whatever it is, and `--no-deploy` stays as a
synonym since that's the literal flag name the spec asked for.

`services/sqs-exporter` polls queue depth every 10s, deliberately separate from
`worker-service` — a future incident (silent fulfilment failure, deferred) needs the
queue-depth signal to keep working even when the thing that's supposed to be draining
the queue has gone blind. Confirmed live that floci doesn't return
`ApproximateAgeOfOldestMessage` at all (documented in `evals/reports/p0-spikes.md`), so
`sqs.queue.depth` is what backlog-based evidence has to use instead.

### Task 3 — INC-10 and INC-02

INC-10 (nginx rate-limit misconfig) needed nginx's access log actually reaching Loki
first: JSON `access_log` format, `X-Request-Id` passed through to order-service, and
Grafana Alloy tailing the log file (nginx:alpine symlinks its default access log to
`/dev/stdout`, which isn't a real file Alloy's tailer can follow — this one bit
Milestone 4 too and got a new, separate log path this time). INC-02 (DynamoDB write
throttling) turned out to be the simplest build in the whole batch: order-service
already had a token-bucket rate limiter in front of its DynamoDB writes from earlier
work, so the incident is just `load.set: {rps: 40}` against the existing 20/s cap, zero
deploy needed.

Both caught real bugs in the shared verify helpers, not just incident-specific tuning.
`lokiCount()` fetched raw log lines and counted them client-side — Loki's default query
API caps that at 100 results, so a real 429/throttle spike silently read back as "0"
until checked against Loki's raw response directly. Rewritten to use a
`count_over_time()` metric query instead (aggregated server-side, no result cap).
nginx's `limit_req` returns 503 on rejection by default — indistinguishable in the
access log from a genuine upstream failure — so `limit_req_status 429` got added
specifically so "the gateway rate-limited this" is legible on its own.

### Task 4 — the "it wasn't us" incidents

INC-05 (provider slowdown) and INC-12 (decoy deploy + real outage) needed a second
Toxiproxy proxy — payment-service's Postgres connection now routes through
`toxiproxy:5433` instead of `postgres:5432` directly, so INC-12 can simulate a real DB
outage via `proxy.toggle` without touching payment-service's own config.

INC-05's first attempt used a 2500ms latency toxic on the provider link and measured
*no* latency increase at all — because 2500ms exceeds payment-service's own 2000ms
request timeout, so every call timed out, tripped the circuit breaker, and the breaker
then fails instantly without calling the provider, erasing the very signal the incident
is supposed to produce. Fixed by keeping the toxic (1200ms) under the timeout, so calls
succeed slowly instead of failing fast — measured ~2425ms fault-window p95 against a
~5ms baseline.

INC-12 layers a genuinely inert decoy (`log.level: debug`, a key payment-service never
reads, deliberately *not* marked causal so it happens in both the real and control run)
right before a real 20s DB outage. The first real run showed almost no visible impact —
payment-service's `pg` connection pool kept serving queries off already-open idle
connections for well over a minute after the proxy went down in one run, and errors
didn't start reliably until well into a 40s window in the next. This is a genuine
characteristic of connection pooling, not a bug: a short outage can end before the pool
ever notices, so the outage window had to be widened and the verify test's timing
assertions loosened from "within 5s" to "somewhere in the back half of the window."

### Task 5 — `ilab verify-all`

Runs every incident's full `apply` → (`reset` → `--control apply` if it has one) →
vitest → `reset` → health-check cycle and prints a PASS/FAIL + baseline-restored table.
Took three iterations to get the orchestration itself right, both on things unrelated
to any single incident's own logic:

1. A one-off `fetch failed` during INC-01's reset step, on a run this long, turned out
   to be exactly the kind of transient network blip a ~50-minute unattended process
   should tolerate — added `fetchWithRetry` (3 attempts, short backoff) around every
   registry/provider/loadgen/toxiproxy call in `ilab.ts`.
2. The post-reset health check then reported "baseline not restored" even though the
   environment was confirmed healthy via a direct Prometheus query. First guess (not
   enough settle time) was wrong — direct log inspection showed the *real* problem was
   the check's 15-second lookback window still overlapping the counterfactual run's own
   genuine fault-window traffic tailing off right up to the timeline's nominal end.
   Longer wait didn't fix a window-width problem; narrowing the window to 5s did.

## How to read the new files, in order

1. **`docs/milestone-5/incidents.md`** — read this first. One section per incident:
   mechanism, evidence, control run, one gotcha. The "what's not verified" section at
   the bottom is the honest list of what this batch didn't nail down.
2. **`services/mock-payment-provider/index.ts`** — the rapid-retry heat mechanism.
   `lastAttemptByKey` + a sliding `rapidRetryTimestamps` window is the whole INC-01 fix
   in about 20 lines; the comment above it explains why raw concurrency doesn't work at
   this traffic scale.
3. **`infra/faults/ilab.ts`** — three things worth understanding: the `Action`
   interface and `runSideEffects()` (every incident's side effects go through the same
   dispatch), the `causal`/`control` skip logic in `cmdApply` (the whole counterfactual
   mechanism is about a dozen lines), and `cmdVerifyAll` at the bottom (the retry
   wrapper and the health-check window are both commented at the point they matter).
4. **`infra/faults/verify/lib.ts`** — `promIncrease` and the rewritten `lokiCount`.
   Compare `lokiCount`'s comment against Milestone 4's "Loki gotcha" — this batch found
   a different Loki footgun (result-count truncation, not structured-metadata
   filtering) in the same helper file.
5. **`infra/faults/INC-12.yaml`** — the clearest example of the `causal: true` pattern
   generalized in Task 2: three timeline steps, only the middle one skipped by a
   control run, and the comments explain why the decoy step deliberately isn't marked.
6. **`services/order-service/index.ts`** — the DynamoDB write token bucket
   (`tryConsumeWriteToken`) that INC-02 turned out to already have available.
7. **`infra/nginx/nginx.conf`** — `limit_req_status 429` and the JSON `access_log`
   directive, both one-line fixes with outsized effect on what INC-10 can actually
   prove.

## Key mechanisms, explained

**Why "retries without backoff cause a storm" needed a redesign, not just tuning.**
Removing backoff doesn't change how many calls a fixed error rate needs on average —
that's a function of the error rate alone. What backoff actually controls is *timing*:
with it, a retry for the same request lands 50ms–1.6s after the previous attempt; with
it removed, it lands within milliseconds. At low traffic (~10rps), concurrent in-flight
calls to any one backend essentially never exceed 1–2 regardless of backoff, so a
capacity model keyed on concurrency can't see the difference — the fix had to be keyed
on retry timing (same idempotency key, sub-15ms gap) instead, which *is* structurally
impossible with backoff+jitter in place and trivial without it.

**Toxiproxy toxics interact with the service's own resilience config, not just the
network.** A latency toxic that exceeds a client's request timeout doesn't produce a
slow success — it produces a timeout, which triggers a retry, which (at 5 consecutive
failures) opens the circuit breaker, which then fails every subsequent call instantly
without ever touching the toxic proxy again. If the incident's whole point is "the
provider got slow," the toxic value has to stay under the timeout or the circuit
breaker erases the signal it's supposed to demonstrate.

**Connection pools mask outages for a while, and that's real, not a test artifact.** A
`pg.Pool` doesn't notice its upstream is gone until it actually needs a connection it
doesn't already have open. INC-12's outage duration is what it is (40s, not the
originally-planned 20s) because that's genuinely how long it took, across repeated real
runs, for the pool's own connection churn to surface the failure — a real postmortem
reading "the outage started at time X" from when errors first appeared would be off by
however long this lag is, which is worth knowing before trusting that kind of evidence.

**A `causal: true` marker, not a `--no-deploy` special case.** Only INC-01's spec used
that literal flag name; every other incident's cause is something else (a load spike, a
toxic, a proxy toggle). Rather than add an incident-specific control flag each time, one
step in the timeline gets marked `causal: true`, and `--control apply` skips exactly
that step's side effects — including its `deploy`, if it has one — while every other
step (including a decoy deploy specifically *not* marked causal) still runs normally.

**verify-all's health check trades sensitivity for honesty about what it's checking.**
It isn't a full config-equality check against each service's seeded defaults — it's a
5-second error-rate sample, taken 10 seconds after reset. That's deliberately weak: a
reset that silently left one config key wrong would still read "yes." What it's
actually good for is catching an incident whose *own* fault-window traffic hasn't
finished tailing off yet, which is a real failure mode this batch hit and fixed by
narrowing the window rather than widening the wait.

## Where state lives

- **Committed to git**, across six commits: all new/changed service code, all six
  `infra/faults/*.yaml` templates, `infra/faults/verify/*.test.ts`, `infra/faults/ilab.ts`'s
  `verify-all` command, `docs/milestone-5/incidents.md`, `docs/notes/inc-01-counterfactual.md`.
  Branch: `p1-infra-fault-templates`, not yet pushed.
- **Not committed, by design**: `runs/*.json` manifests (gitignored as of this batch —
  Milestone 4 had committed its one INC-01 manifest as evidence, but with six incidents
  each producing a fresh manifest per run, per re-run, per counterfactual, committing
  them all stopped making sense; `docs/milestone-5/incidents.md` carries the same
  evidence in prose instead).
- **`dcs/IncidentLab_Build_Plan_v1.xlsx`** (gitignored, tracked outside git): T1.17's
  Status/Notes updated to reflect 6 of 9 templates done.

## What's honestly not done yet

- **3 of the original 9 templates are deferred**: INC-03 (Redis cache stampede — no
  cache layer exists), INC-08 (silent fulfilment failure), INC-09 (Postgres connection
  leak). `sqs-exporter`'s separate-from-worker design (Task 2) was specifically built
  ahead of INC-08's need, but INC-08 itself isn't built.
- **The Incidents tab's original INC-12 spec has drifted from what's actually
  implemented.** It says "order-service, Postgres" and "benign order-service deploy" —
  but order-service uses DynamoDB, not Postgres (that's payment-service); the decoy
  deploy in the real implementation is on payment-service, matching where the Postgres
  connection actually lives. The spec tab wasn't rewritten to match; this reading guide
  and `incidents.md` are the source of truth for what's real.
- **verify-all's baseline-restored check is a heuristic**, not a full check that every
  service's config equals its seeded defaults (see "Key mechanisms" above).
- **No Tempo/trace-level assertions** anywhere in this batch, despite the original
  Milestone 4 plan mentioning span-level evidence for INC-05 specifically. Every
  incident here is verified through Prometheus metrics and Loki logs only.
- **`ilab verify-all` is a real-time, blocking process for the whole set** — same
  caveat Milestone 4 noted for `ilab apply` alone, just six times over. A full run is
  close to an hour.
