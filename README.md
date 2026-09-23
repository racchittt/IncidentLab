# IncidentLab

**An evaluation-driven AI incident-investigation platform.** IncidentLab runs a synthetic production environment, injects real failure modes into it, and measures how different agent architectures; a plain LLM, a fast typed decision model (Jev/Laya), and a hybrid of the two, perform at finding the actual root cause.

The question this project answers isn't "can an LLM investigate an incident." It's **which architectural choices actually move the needle on accuracy, cost, and latency, with numbers to back it up.**

## Why this exists

Most AI incident-response demos are a chatbot wrapped around some logs. IncidentLab is built differently:

- **A real synthetic production stack**, not canned data. Services run behind an nginx gateway, backed by AWS primitives (DynamoDB, SQS, Lambda, ElastiCache, RDS) emulated locally via [floci](https://floci.io/). Failures are injected into a running system, not scripted into a transcript.
- **A System One / System Two architecture.** [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) or [Laya](https://huggingface.co/convaiinnovations/laya) handles fast, typed, calibrated decisions (tool routing, escalation, verification). An LLM is only called in for open-ended reasoning: hypothesis generation and root-cause synthesis. This split is measured, not assumed.
- **Ground-truth incidents with an automated eval harness.** Every agent variant runs against the same incident set. Root-cause accuracy, evidence recall/precision, tool efficiency, latency, cost, and calibration are scored and compared, not eyeballed.

## Architecture

```
Incident Simulator (floci + nginx)
        │
        ▼
Investigation State (structured, typed)
        │
        ▼
   SystemOne Controller ── simple decision ──▶ Tool Layer (logs / metrics / traces / git)
        │
   ambiguous case
        │
        ▼
   LLM Reasoner ──▶ Hypothesis + RCA synthesis
        │
        ▼
Evaluation Harness ──▶ RCA accuracy, cost, latency, calibration
```

Services: Auth, Order, Payment, and Worker, each behind a single nginx gateway, each backed by real AWS-equivalent primitives running locally on floci. A retry storm, a DynamoDB throttle, a cache stampede, a connection leak, and a dozen other failure modes are seeded as deterministic, on-demand fixtures.

## Tech stack

| Layer | Stack |
|---|---|
| Services | Node.js + TypeScript |
| Agent (state, tools, controller, reasoner, RAG) | Python (FastAPI) |
| Dashboard | Node / React |
| Cloud emulation | [floci](https://floci.io/) (AWS-compatible, local) |
| Decision controller | [Jev / TypeSafe](https://typesafe.ai/) or [Laya](https://huggingface.co/convaiinnovations/laya)
| Gateway | nginx |

## Project status

IncidentLab is in active development. Progress is tracked phase by phase, each with its own ground-truth deliverable rather than open-ended work.

- [x] **Phase 0 — Spike**: floci, nginx, and Jev all proven working end to end
- [ ] **Phase 1 — Simulator + Tools**: synthetic services, failure injection fixtures, investigation tool layer
- [ ] **Phase 2 — Baseline Agent**: plain LLM + tools, the control group
- [ ] **Phase 3 — Jev/Laya Controller**: System One / System Two hybrid, head-to-head comparison
- [ ] **Phase 4 — RAG Layer**: retrieval over runbooks and postmortems
- [ ] **Phase 5 — Session Memory + Dashboard**: multi-turn investigation, natural-language query UI
- [ ] **Phase 6 — Eval Harness + Polish**: full incident set, automated scoring, hosted demo

## Repo structure

```
incidentlab/
├── services/       # Node.js/TypeScript — auth, order, payment, worker
├── agent/          # Python — state, tools, Jev/Laya controller, LLM reasoner, RAG
├── dashboard/       # Node/React — investigation trace + NLP query UI
├── infra/          # docker-compose, nginx config, floci bootstrap, failure fixtures
├── evals/          # ground-truth incidents, eval harness, reports
└── docs/
```

## Getting started

```bash
git clone <repo-url>
cd incidentlab

# bring up the simulated environment
docker compose up -d --build

# install and run each service
cd services/order-service && npm install && npm run dev
# repeat for auth-service, payment-service, worker-service

# set up the agent
cd agent
python -m venv venv
source venv/bin/activate   # or venv\Scripts\activate on Windows
pip install -r requirements.txt
uvicorn main:app --reload
```

Full setup, environment variables, and how to trigger a failure fixture manually are documented in `docs/`.

## Why this architecture

Jev/Laya evaluates all questions in a decision in parallel and returns typed, calibrated answers instead of generated text, which makes routing and verification both faster and cheaper than a general LLM call. TypeSafe's own benchmarks report Jev/Laya running up to two orders of magnitude faster and cheaper than LLMs on comparable workflow decisions. IncidentLab tests whether that advantage holds inside a real agentic investigation loop, and where the LLM reasoner is still worth the cost. The eval harness in `evals/` produces the comparison numbers once Phase 3 lands.

