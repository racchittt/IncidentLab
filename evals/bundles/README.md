# IncidentLab-Bench v1 — dataset card

44 investigation-ready bundles across 9 incident templates. Each bundle is a frozen
snapshot of one real `ilab apply` run — Prometheus metrics (derived views: rate for
counters, raw value for gauges, p50/p95/p99 for histograms), every Loki log line,
simplified Tempo spans (every error trace, every trace over 1s, plus a random sample of
normal ones), registry deploys from 30 minutes before the window to its end, the service
topology, and the alert text an on-call would actually see. No Prometheus/Loki/Tempo/
registry is needed to read one — see `agent/tools/replay_backend.py`.

**Ground truth lives separately, never inside a bundle.** `evals/incidents/*.gt.yaml`
holds the root cause, fault category, and required/acceptable evidence per incident
template; `index.jsonl` (below) maps each bundle's random UUID back to which incident and
seed produced it. A bundle's own `bundle_id` gives no hint which incident it is — folder
names are deliberately uninformative, and every bundle passes a leakage-scrub test
(`evals/tests/test_bundle_scrub.py`) checking for simulation-internal tokens (`INC-`,
`ilab`, `toxic`, `fault`, `counterfactual`, `seed`) in every file, including
`metrics.parquet`'s actual string column values, not just its compressed bytes.

Bundles are **gitignored**, not committed to this repo — they're reproducible from
`infra/faults/*.yaml` plus `ilab record-all`, and publish to Hugging Face in Phase 8.
`index.jsonl` (the bundle_id → incident/seed/manifest mapping) is gitignored too, since
it's effectively the answer key.

## Counts per incident

| Incident | Bundles | Mechanism |
|---|---|---|
| INC-00 | 6 | Negative control (no incident) |
| INC-01 | 5 | Retry storm |
| INC-02 | 6 | DynamoDB write throttling |
| INC-03 | 5 | Cache stampede |
| INC-05 | 4 | External provider slowdown |
| INC-08 | 4 | Silent fulfilment failure |
| INC-09 | 4 | Connection leak (slow burn) |
| INC-10 | 6 | nginx rate-limit misconfiguration |
| INC-12 | 4 | Decoy deploy + real outage |
| **Total** | **44** | |

Every incident has at least 4 recorded variants (seed-driven: onset time ±30s, loadgen
rps ±20%, a 50% chance of a random decoy deploy). A few incidents have more than 4 -
harmless duplicates from re-running `record-all` after a background process got
interrupted partway through during recording (see the build history in this repo's
commit log); extra variants aren't a problem for a dataset, just extra variety.

## Size

**62 MB total** across all 44 bundles (~1.4 MB average per bundle).

## Decoy rate

A random harmless decoy deploy (`log.level` on a randomly chosen service - a key only
payment-service's own code ever reads, so it's a genuine no-op everywhere else) lands in
a bundle's own window with intended 50% probability for most incidents:

| Incident | Bundles with a decoy in-window |
|---|---|
| INC-00 | 6/6 (100%) |
| INC-01 | 2/5 (40%) |
| INC-02 | 3/6 (50%) |
| INC-03 | 2/5 (40%) |
| INC-05 | 1/4 (25%) |
| INC-08 | 2/4 (50%) |
| INC-09 | 2/4 (50%) |
| INC-10 | 2/6 (33%) |
| INC-12 | 4/4 (100%) |

INC-00 and INC-12 show 100% because both incidents have their **own built-in** decoy
mechanism (INC-00's single benign deploy *is* the whole incident; INC-12's decoy is
specifically what the incident is testing an agent's resistance to) - independent of the
randomly-injected kind every other incident gets a ~50/50 shot at. The two aren't fully
distinguishable by reason text alone (INC-00's own built-in reason, "increase log
verbosity for debugging," is also one of the three reasons the random injector picks
from), so this table counts "a decoy deploy is present," not "which specific mechanism
put it there" - worth knowing if decoy rate per se becomes a variable of interest later.

## Why decoys matter

Without a decoy, "blame the most recent deploy" is right far too often for an agent's
investigation skill to mean much. Roughly half of this dataset's bundles (more, for
INC-00/INC-12) include at least one deploy that happened during the window but caused
nothing - exactly the trap a shallow heuristic falls into.
