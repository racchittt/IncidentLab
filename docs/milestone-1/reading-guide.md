# Reading guide: IncidentLab as of Milestone 1

This is the "catch up on your own project" document. It covers everything done from
Phase 0's spikes through Milestone 1 (Tasks 1-5) and the bugs found reviewing that
work, and gives you an order to read the actual repo files in so the pieces click
into place instead of arriving as a wall of code.

## TL;DR — what exists right now

A synthetic e-commerce backend with real distributed-tracing plumbing:

```
POST /orders ──▶ nginx ──▶ order-service ──▶ DynamoDB (PutItem)
                                │
                                └──▶ SQS "orders-placed" queue
                                              │
                                              ▼
                                     worker-service ──▶ DynamoDB (UpdateItem, fulfilled)
```

Every hop is traced with OpenTelemetry, exported to a Grafana LGTM stack (Loki +
Grafana + Tempo + Prometheus, all bundled in one container). floci stands in for
real AWS (DynamoDB, SQS) so none of this touches an AWS bill. Alongside that, Phase 0
ran two throwaway experiments (a "spike") to answer questions the rest of the plan
depends on, and left behind a pluggable Jev/Laya decision-routing layer that isn't
wired into anything yet but will matter starting Phase 3.

## The story so far, in order

### Phase 0 — two spikes, before any real service existed

**Spike A** asked: does floci (the local AWS emulator) behave like real AWS where it
matters? Two sub-questions, both answered with a throwaway script
(`infra/floci/spike-fidelity.ts`):
- Does DynamoDB actually throttle when you set a low provisioned capacity? **No** —
  floci accepted 200 concurrent writes against a 1 RCU/1 WCU table with zero
  throttling errors. This matters later: a fault template that's supposed to simulate
  a DynamoDB throttle (INC-02, in the original plan) can't rely on floci's own limits
  — it'll need to fake the error at the application level.
- Does SQS preserve custom message attributes (which is how trace context crosses a
  queue)? **Yes**, confirmed byte-for-byte. This is *why* Milestone 1 Task 5 could
  assume trace propagation across SQS would work.

**Spike B** asked: can a small local model (via Ollama) act as a cheap decision
router, compared against Jev and Laya? 20 hand-labeled scenarios were run through
`qwen2.5:3b`, Jev, and Laya (scripts in `evals/spikes/`). Result: Jev 100% accurate,
Laya 70%, qwen2.5:3b 85% but with the local model's own decision layer
(`agent/controller/`) getting pulled into the repo just to run this comparison —
it wasn't otherwise part of Milestone 1's scope. Full writeup:
`evals/reports/p0-spikes.md`.

### Milestone 1 — five tasks, building the first real service pair

1. **Tooling baseline** — `.env.example`, a pinned `agent/requirements.txt`
   (`pip freeze`), and a root `package.json` turning `services/*` into an npm
   workspace (so `services/runtime` can be imported by name from other services).
2. **Grafana + compose profiles** — added the `otel-lgtm` container (Grafana, Loki,
   Tempo, Prometheus in one image) and split `docker-compose.yml` into profiles.
3. **The shared runtime package** (`services/runtime/`) — every Node service's
   telemetry bootstrap and logger live here once, instead of copy-pasted per service.
4. **order-service, for real** — replaced a stub that echoed a fake response with
   actual `PutItem`/`GetItem` calls against DynamoDB, wired through the runtime
   package's telemetry.
5. **worker-service, and a trace that survives a queue hop** — a new service that
   consumes the queue order-service publishes to, marks orders fulfilled, and proves
   (via a live Tempo query) that one trace really does span both services.

### The review pass — four real bugs, found by re-reading the diff

After Milestone 1 "worked" (curl requests succeeded, traces showed up), a review of
the actual changes caught four problems that only show up under failure conditions
the happy-path testing didn't exercise. All four are written up with symptoms and
fixes in `docs/notes/trace-across-sqs.md`:

1. A `BatchLogRecordProcessor` called with the wrong argument shape, which crashed
   silently on every log emission — logs never reached Loki despite traces and
   metrics working fine.
2. `useQueueUrlAsEndpoint` defaulting to `true` on the SQS client, which broke the
   moment `worker-service` (a different container from floci) tried to use the queue
   URL floci handed back.
3. A poison message (bad JSON, or valid JSON missing `orderId`) crash-looping
   `worker-service` forever, because the only error handling was `main()`'s top-level
   `catch`, which exits the process without deleting the message — so SQS redelivers
   it to the next restart, forever.
4. A startup race: `depends_on: [floci]` only waits for the *container* to start, not
   for floci to actually be ready to accept connections, so `order-service` could
   crash on its first `CreateTable` call if it won the race.

Each of these has a real fix in the current code (not a workaround) — see the
mechanisms section below for what the fixes actually do.

## How to read this repository, in order

Read these in sequence; each one assumes you've absorbed the one before it.

1. **`README.md`** (repo root) — the project's actual thesis and the target
   architecture diagram. Everything else is building toward this.
2. **`docker-compose.yml`** — the fastest way to see what services exist, how they
   talk to each other (`AWS_ENDPOINT_URL=http://floci:4566`,
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318`), and in what order they're
   allowed to start (`depends_on` + `profiles`).
3. **`infra/nginx/nginx.conf`** — the one gateway everything comes through. Small
   enough to read in 10 seconds; explains why `/orders` (not `/orders/`) matters.
4. **`services/runtime/`** — read this before any service that uses it:
   - `package.json` — note it lives at the package root, not inside `src/`; that
     placement is *load-bearing* for npm workspaces to find it at all.
   - `src/telemetry.ts` — the OpenTelemetry bootstrap. This is imported as the
     literal first line of every service's entrypoint, before anything else, so
     auto-instrumentation can patch modules (`express`, `pino`, the AWS SDK) before
     your code requires them.
   - `src/logger.ts` — a two-line pino wrapper. Looks trivial; the interesting part
     (trace-ID correlation) happens automatically via instrumentation set up in
     `telemetry.ts`, not in this file.
   - `src/retry.ts` — linear-backoff retry helper, added during the review pass to
     fix the startup race.
5. **`services/order-service/`** — the producer side:
   - `Dockerfile` — note the build context is the *repo root*, not this folder; that's
     what lets it `COPY services/runtime` in alongside itself.
   - `index.ts` — read top to bottom: telemetry import, DynamoDB + SQS client setup,
     `ensureOrdersTable`/`ensureOrdersPlacedQueue` (both wrapped in `retry`), the
     `POST /orders` handler (PutItem, then SendMessage), `GET /orders/:id`
     (GetItem, 404 if missing).
   - `faults/latency.ts` — a fault-injection middleware left over from the Phase 1
     scaffolding, predating Milestone 1; still wired in but not part of this
     milestone's work.
6. **`services/worker-service/index.ts`** — the consumer side. This is the file with
   the most going on per line: `fulfillOrder` (the idempotent conditional update),
   `processMessage` (trace extraction + the `process-order` span), and `main`'s
   receive loop (long polling, per-message try/catch, the poison-message give-up
   logic).
7. **`infra/floci/`** — `smoke-test.ts` was the original "does floci even boot"
   check; `spike-fidelity.ts` is Spike A's actual experiment. Both are throwaway
   scripts, not part of any service.
8. **`evals/`** — `evals/reports/p0-spikes.md` is the readable summary; `evals/spikes/`
   holds the actual comparison scripts and raw JSON results behind it.
9. **`agent/controller/`** — the Jev/Laya pluggable decision layer. Not used by
   anything yet outside the Spike B comparison script; it exists now because Spike B
   needed it, and it's the seed of Phase 3's System One/System Two split.
10. **`docs/`** — `docs/notes/trace-across-sqs.md` (the four bugs, written up) and
    `docs/milestone-1/` (this file, plus the three screenshots proving the trace
    actually crosses services in a live Tempo/Loki/Prometheus query).

## Key mechanisms, explained

**npm workspaces, and why the Dockerfiles look the way they do.** The root
`package.json` declares `"workspaces": ["services/*"]`. That makes `services/runtime`
resolvable by name (`@incidentlab/runtime`) from any other package under `services/`,
via a symlink npm creates in the root `node_modules`. Each service's Dockerfile
copies the root `package.json`, `services/runtime`, and itself, then runs `npm
install` once at `/app` — that single install is what makes the workspace symlink
exist *inside the image*. Building from inside a service's own folder (the old
Dockerfile, before Milestone 1) can't do this, because it never sees the workspace
root at all.

**How a trace gets from your code to Grafana.** `telemetry.ts` calls
`getNodeAutoInstrumentations()`, which patches `http`, `express`, `pino`, and the AWS
SDK via Node's module-require hooks — meaning it has to run *before* your code
`require`s any of those, which is why the telemetry import is always the first line
of an entrypoint. Once patched, every HTTP request, DynamoDB/SQS call, and log line
automatically gets wrapped in a span or tagged with the active trace/span ID, and
gets batched and shipped over OTLP/HTTP to `otel-lgtm`, which fans it out into Tempo
(traces), Loki (logs), and Prometheus (metrics) — three different databases behind
one Grafana UI.

**Why SQS needed manual code but nothing else did.** Auto-instrumentation already
injects `traceparent` into `MessageAttributes` on every `SendMessage`, and widens
`ReceiveMessage`'s requested attributes automatically — so order-service needed zero
tracing code for the send side. But *receiving* a message isn't itself a traced
operation the way an HTTP request is; nothing decides what span the processing of
that message belongs to. That's what `worker-service`'s `processMessage` does by
hand: `propagation.extract` turns the `traceparent` string back into a context, and
`tracer.startActiveSpan(name, {}, thatContext, callback)` creates a new span as its
child *and* makes it the active span for everything inside the callback — the
4-argument form matters; the simpler `tracer.startSpan()` creates a span but never
activates it, which was one of the review-pass bugs.

**Idempotency and poison messages, together.** SQS is at-least-once delivery, so
`worker-service` has to assume any message might arrive twice. The `UpdateItem` call
uses `ConditionExpression: "#status = :created"` — it only flips the status if it's
still `created`; a redelivered message's second attempt gets
`ConditionalCheckFailedException`, which is caught and logged as a no-op rather than
treated as an error. Separately, a message that's simply malformed (no `orderId`, bad
JSON) will keep throwing no matter how many times it's redelivered — the fix there is
different: track `ApproximateReceiveCount` (an SQS system attribute), retry up to 3
times in case the failure is transient, then delete the message unprocessed and move
on, so one bad message can't take the whole worker down forever.

**Startup ordering, defense in depth.** Two layers, deliberately redundant:
compose-level (`depends_on: { floci: { condition: service_healthy } }`, which waits
for floci's own healthcheck rather than just its container starting) and app-level
(`retry.ts`'s backoff, wrapping every startup call to floci). The compose layer
handles the common case; the app-level layer handles everything the compose layer
can't guarantee — a health check that flips healthy/unhealthy right at the boundary,
or running the service outside compose entirely.

## Where state actually lives

- **Committed to git**: everything under `services/`, `infra/`, `docs/`,
  `docker-compose.yml`, and the root config files. This is the source of truth for
  what's built.
- **Local only, gitignored**: `dcs/IncidentLab_Build_Plan_v1.xlsx` (the task-by-task
  backlog with Status/Notes columns — this is where "what's done" is tracked at a
  finer grain than git history alone shows) and `evals/spikes/results-*.json` (raw
  spike output; the readable summary is `evals/reports/p0-spikes.md`, which *is*
  committed).
- **Branches**: this work happened on `p1-infra-otel-lgtm`, off `main`. Earlier phase
  work (the Jev/Laya controller layer) lived on `p3-controller-jev-laya` and was
  copied in — not merged — specifically to support Spike B's comparison; it'll get a
  real merge when Phase 3 starts.

## What's honestly not done yet

Worth knowing so you don't assume more exists than does:

- `order-service`'s Redis cache-aside for a catalog, and removing the
  `latency.ts` fault middleware — both still on the original Task 4 spec, neither
  done.
- No configurable concurrency on `worker-service`'s poll loop — it's a single
  sequential `while (true)`, not the "SQS consumer with concurrency config" the
  backlog describes.
- `T0.04`'s full scope (`uv`, `ruff`, `pyright`, `pytest`, a Taskfile) — only the
  ".env.example + pinned requirements" quick part happened.
- The trace verified in Milestone 1 doesn't include nginx as its own span (nginx
  isn't instrumented) or payment-service (doesn't exist yet) — so "nginx → order →
  SQS → worker → payment" as one trace, as the original task described it, isn't
  literally true yet; what's proven is order-service → SQS → worker-service.
