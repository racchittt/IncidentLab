# Reading guide: Milestone 4 (deploys and faults)

This covers everything added on top of Milestone 3's payment-service chain: two bugs
fixed on review, a real deploy-registry, live config polling, a `deployctl` CLI, and a
fault engine that ran an actual 10-minute INC-01 against the live stack instead of
faking one. Same idea as `docs/milestone-1/reading-guide.md` — read this instead of
the raw diff.

## TL;DR — what exists now that didn't before

```
deployctl (CLI, run from host) ──┐
ilab (fault engine, run from host) ──┼──▶ deploy-registry ──▶ Postgres "registry" db
                                  │         (configs + deploys tables)
                                  │              ▲
                                  │      polls every 5s
                                  │              │
                                  └──▶ payment-service (getConfig() is now live)
                                             │
ilab ──────────────────────────────▶ mock-payment-provider (/admin/set-config)
```

A deploy is now a real, queryable event with a diff and a reason, not a line in a
markdown file. payment-service picks up a config change within 5 seconds with zero
restart. And `ilab apply INC-01 --seed 42` reproduces the actual retry-storm incident
end to end — against real Prometheus/Loki/registry data, not a canned fixture.

## The story so far, in order

### Review pass: two things checked before building anything new

The previous milestone's write-up got checked, not just re-read:

1. **Why did the breaker take ~10 minutes to open, when 5 failures at 5 req/s should
   take under a second?** Confirmed via Tempo: one order's merged trace showed three
   `process-order` attempts exactly 30 seconds apart (SQS's `VisibilityTimeout`), each
   only 1-9ms long. `worker-service` had zero concurrency — `ReceiveMessageCommand`
   never set `MaxNumberOfMessages` (defaults to 1), and the receive loop `await`ed one
   message at a time. Fixed with `WORKER_CONCURRENCY` (default 5) and
   `Promise.allSettled`; re-verified live — the same toxic now opens the breaker in
   **23 seconds**.
2. **What does "Request rate" actually measure?** It's payment-service's own incoming
   `/charges` count — it never counts calls *out* to the provider. The original
   write-up's "5→17 req/s in section c" turned out to be stale phase-b data still
   inside the dashboard's 15-minute trailing window, misattributed to the wrong
   phase. The real phase-c signal was entirely on the `retry` line (0→2.3/s), with
   `success` staying flat — corrected in `docs/milestone-3/retry-storm-experiment.md`.

Also exposed `otel-lgtm`'s query ports directly (9090 Prometheus, 3100 Loki, 3200
Tempo) — needed for the verification test later, and for Phase 2's agent tools.

### Task 2 — deploy-registry: a deploy becomes real evidence

New service, new database (`registry`, separate from the `payments` ledger). Two
tables: `configs` (current merged config + version per service) and `deploys` (the
audit trail: `change_id`, diff, author, reason, timestamp). Config keys are dotted
paths (`retry.baseMs`, `db.poolMax`) so `deployctl`'s `--set` flags and the fault
file's `set:` blocks can address a nested value without inventing a new schema per
service.

### Task 3 — live config: no more restart to change behavior

`getConfig()` in `runtime` stopped reading env vars. A background poller now fetches
`GET /config/<OTEL_SERVICE_NAME>` from deploy-registry every 5 seconds; `getConfig()`
just returns whatever it last got. If the registry is down, it keeps the last known
config instead of crashing. Every real version change logs `"config applied"` with the
`change_id` — that log line is the evidence trail an agent will need later.

Not everything can be hot-swapped, though: retry/timeout settings are read fresh per
request already (free), so they're "hot" by construction. The circuit breaker is a
stateful object — it gets *rebuilt in place* on every config version change (losing
whatever open/half-open state it was in, an accepted trade-off). The DB pool size is
genuinely restart-required — `main()` only reads `db.poolMax` once at startup, and
changing it needs Task 4's `--restart` flag.

### Task 4 — deployctl: a CLI for the registry

`infra/deploy/deployctl.ts deploy|history|rollback`. `--set key=value` values are
parsed as JSON when possible (`0` becomes a number) and fall back to a raw string
otherwise (`none` stays `"none"`). `rollback <change_id>` reads that deploy's diff and
posts a *new* deploy setting every key back to its `from` value — never a delete, so
the audit trail stays honest for whoever reads it later, including an agent.

### Task 5 — the fault engine: INC-01, for real

`infra/faults/INC-01.yaml` replaces the old static JSON fixture that just declared a
root cause with no mechanism to actually produce it. The new fault is a real timeline:
background noise from t=0, an innocent-sounding deploy at t=240s (`retry.baseMs: 0`,
reason "reduce checkout latency" — deliberately never mentions retries, since an agent
will read that field), then the provider's error rate jumps at t=250s to a value a
seeded PRNG picks from a range. `ilab apply INC-01 --seed 42` runs this against the
live stack for real — it takes the full 10 minutes the timeline specifies. Every apply
writes a run manifest to `runs/` (start/end time, chosen params, every `change_id`
created); `ilab reset` undoes it by rolling back those change_ids and zeroing the
provider's error rate.

A vitest suite (`infra/faults/verify/INC-01.test.ts`) reads that manifest and asserts
against the *real* APIs afterward: the registry has the deploy with `retry.baseMs` in
its diff, Prometheus shows retry rate at least 3x its pre-deploy baseline, and Loki has
a `"config applied"` log carrying that exact `change_id`. All three passed against a
real run — see "the Loki gotcha" below for a bug this caught.

Cleanup: the old `latency.ts` fault middleware, its `/admin/inject-fault` /
`/admin/reset-fault` routes on order-service (and nginx's `/admin/` location — nothing
left behind it), and the old `trigger.js` are all gone, fully replaced by the
mechanism above.

## How to read the new files, in order

1. **`infra/faults/INC-01.yaml`** — read this first. It's the "what," in plain terms,
   before any code: a timeline of `provider.set` / `deploy` / `end` steps at specific
   offsets, plus a `reset` block. The `params` section is a seeded range, not a fixed
   value — that's what makes `--seed 42` reproducible.
2. **`services/deploy-registry/`**:
   - `paths.ts` — the whole dotted-path trick in ~20 lines: `getPath`/`setPath` walk
     a string like `"retry.baseMs"` into nested object access.
   - `index.ts` — `POST /deploys` is the one to read carefully: it loads the current
     config, computes `{key: {from, to}}` for every key in the request's `set`, merges
     the new values in, bumps the version, and writes both `configs` (current state)
     and `deploys` (the append-only log) in the same handler.
3. **`services/runtime/src/resilience/config.ts`** — completely rewritten from
   Milestone 3's env-var version. `poll()` is the core: fetch, compare `version` to
   what's cached, and only on an actual change does it update `current`, log, and fire
   `onConfigChange` listeners. `startConfigPolling()` awaits one poll before the
   interval starts, on purpose — a freshly restarted service shouldn't have to wait 5s
   to see real config.
4. **`services/payment-service/index.ts`** — see how the poller gets used: `pool` is
   constructed once (restart-required), `breaker` is a `let` that
   `onConfigChange` reassigns (hot-reloadable), and the route handler reads `getConfig()`
   fresh every request the same way it always did.
5. **`infra/deploy/deployctl.ts`** — `cmdRollback` is the one instructive function:
   fetch the original deploy, invert its diff (`to` becomes the new `from`), post it
   as a normal deploy. Nothing rollback-specific happens on the registry side at all.
6. **`infra/faults/ilab.ts`** — `pickParams` (the seeded PRNG) and the main loop in
   `cmdApply` (sort the timeline by `at`, sleep the gap between steps, dispatch each
   action) are the two things worth understanding; everything else is bookkeeping.
7. **`infra/faults/verify/INC-01.test.ts`** — note the Loki query in the third test;
   see "the Loki gotcha" below before assuming `|= "some-value"` will find a
   structured field.
8. **`runs/INC-01-seed42-*.json`** — the actual manifest from the real run. This is
   what Phase 2's recorder will read to know which time window to freeze.

## Key mechanisms, explained

**Dotted-path config, end to end.** A fault file says `set: { retry.baseMs: 0 }`.
`deployctl`/`ilab` send that literally as a JSON key `"retry.baseMs"` (not a nested
object) to `POST /deploys`. `paths.ts`'s `setPath` splits on `.` and walks/creates
nested objects as needed, so the *stored* config is properly nested
(`{retry: {baseMs: 0}}`) even though the *request* uses a flat dotted key. The diff
keeps the dotted key as-is (`{"retry.baseMs": {from, to}}`) because that reads better
in an audit log than a nested diff object would.

**Hot vs. restart-required is a decision about object lifetime, not the config
value.** Nothing marks a key as "hot" in the schema. It's purely about whether the
value is read fresh per use (retry/timeout — cheap, safe to re-read every request) or
baked into a long-lived object's constructor (the breaker, the DB pool). The breaker
gets a cheap escape: `onConfigChange` just makes a new one. The pool doesn't, because
`pg.Pool` doesn't support resizing after construction — that's the actual constraint,
not a design choice.

**The Loki gotcha.** pino's structured log fields (`change_id`, `version`, ...) don't
end up as text in the Loki log line — they land as *structured metadata* attached to
the line, whose body is just the bare message string (`"config applied"`). A filter
like `|= "chg-0012"` searches line *text* and will never match. The fix is a metadata
filter after the stream selector: `{service_name="payment-service"} |
change_id="chg-0012"`. This bit the verify test directly — first draft used `|=` and
failed with "0 results" even though the log was right there; caught by checking Loki's
raw API response and seeing the fields listed as stream labels, not in the line value.

**Why the fault's deploy reason matters.** `reason: "reduce checkout latency"` is
deliberately generic. The point of the exercise (per the spec) is that an
investigating agent reads deploy reasons as evidence — a reason that said "inject
retry storm" would make the incident trivial to solve by reading, not investigating.

**Rollback is a new deploy, never a delete.** Both `deployctl rollback` and `ilab
reset`'s `all_created` step work the same way: read the diff, flip `to`→`from` for
every key, post it as an ordinary deploy. The `deploys` table never loses a row. This
is what keeps `runs/*.json`'s `changeIds` list a complete, honest record of what
actually happened, instead of a log that a rollback could silently invalidate.

## Where state lives

- **Committed to git**: all the new service code, `infra/faults/INC-01.yaml`,
  `infra/deploy/deployctl.ts`, `infra/faults/ilab.ts`, and — deliberately — the real
  run manifest at `runs/INC-01-seed42-*.json`. That manifest is evidence of an actual
  run, not disposable scratch output, so it's checked in like the spike results were
  in Milestone 1.
- **Postgres, `registry` database** (separate from `payments`): `configs` and
  `deploys` tables. Created via `\connect registry` inside `infra/postgres/init.sql`
  for a fresh environment; applied directly to the already-running instance in this
  session.
- **Fully removed**: `services/order-service/faults/latency.ts`, its
  `/admin/inject-fault` and `/admin/reset-fault` routes, nginx's `/admin/` location,
  `infra/fixtures/trigger.js`, and `infra/fixtures/INC-01-retry-storm.json`. If you're
  looking for the old fault-injection admin endpoints, they don't exist anymore — this
  is intentional, not a regression.

## What's honestly not done yet

- **T1.17 is 1 of ~8 fault templates.** Only INC-01 has real mechanics and a passing
  verification test. The others (INC-00/02/03/05/08/09/10/12) mostly need services or
  mechanics that don't exist yet (auth-service, a cache layer, ...).
- **The git-config-repo idea was deliberately cut**, per this batch's own plan — the
  registry's stored diffs are the audit trail; nothing writes config to a git repo of
  files.
- **No bulkhead/pool-limit primitive** in `runtime`'s resilience module — only
  retry/timeout/breaker exist; T1.02's backlog note already flags this.
- **`ilab apply` is a real-time, blocking 10-minute script** for INC-01 specifically —
  there's no scheduler or "run this at 2x speed for testing" mode. Any new fault file
  with a longer timeline will take exactly as long to apply as its `at:` values say.
