# P0 Spikes

## Spike A: Does floci behave like real AWS where it matters?

**Q1: Does DynamoDB throttle on floci?**
- Answer: No.
- Evidence: Table `throttle-test` created with `PROVISIONED` billing, 1 RCU / 1 WCU. Fired 200 concurrent `PutItemCommand`s via `Promise.allSettled`. Result: 200 succeeded, 0 throttled, 0 other failures. floci does not enforce provisioned throughput limits.
- Because of this: `order-service`'s fault-injection layer (`services/order-service/faults/`) must simulate `ProvisionedThroughputExceededException` itself for INC-02 — floci won't produce it for free. Fault triggers need to raise this error directly rather than relying on real capacity pressure.

**Q2: Does SQS preserve message attributes on floci?**
- Answer: Yes.
- Evidence: Sent a message with `MessageAttributes.traceparent = "00-abc123-def456-01"`, received with `MessageAttributeNames: ["All"]`. Value came back byte-for-byte identical.
- Because of this: trace-context propagation across the queue (order-service → worker-service) can rely on real SQS message attributes. No workaround needed for distributed tracing through the queue.

Script: `infra/floci/spike-fidelity.ts`. Run with `npx tsx spike-fidelity.ts` (floci must be up).

## Spike B: Can a small local model be your cheap router?

Same 20 hand-labeled `next_tool` scenarios (`evals/spikes/scenarios.json`) run through three backends: a local `qwen2.5:3b` via Ollama with a JSON schema forced through `format=`, and Jev/Laya via the existing controller layer (`agent/controller/`).

| Backend | Accuracy | Valid JSON | Avg latency |
|---|---|---|---|
| qwen2.5:3b (local) | 17/20 (85%) | 20/20 (100%) | 2.87s (skewed by a 51s cold model-load on call 1; steady-state ~0.3s) |
| Jev | 20/20 (100%) | 20/20 (100%, typed SDK) | 0.36s |
| Laya | 14/20 (70%) | 20/20 (100%, typed SDK) | 0.27s |

- Answer: a local 3B model is viable as a JSON-valid router (never broke schema) but not yet accurate enough — its 3 misses were all "no metrics yet" scenarios misread as needing logs, or vice versa, suggesting the criteria text needs sharper contrast for a model this small.
- Jev was both the most accurate and had zero confusion between `query_metrics`/`query_logs`. Laya's failures clustered in the same boundary the local model struggled with, plus 2 "just started" cases it read as `finish`.
- Because of this: qwen2.5:3b is a candidate for a cheap first-pass filter (e.g. only escalate to Jev on low local-model confidence) but not a drop-in replacement yet. Worth revisiting with a larger local model or a fine-tuned prompt once Phase 3 starts for real. Jev remains the default (`CONTROLLER_BACKEND=jev`) baseline for accuracy.

Scripts: `evals/spikes/scenarios.json`, `evals/spikes/router_local_model.py` (`python -m evals.spikes.router_local_model`), `evals/spikes/router_controller.py` (`python -m evals.spikes.router_controller <jev|laya>`). Raw results in `evals/spikes/results-*.json`.
