import { metrics } from "@opentelemetry/api";
import type { Pool } from "pg";
import type { CircuitBreaker } from "@incidentlab/runtime/src/resilience/circuitBreaker";

const meter = metrics.getMeter("payment-service");

export const retryAttempts = meter.createCounter("payment.retry.attempts", {
  description: "Outcome of each provider charge attempt, including retries",
});

export const providerDuration = meter.createHistogram("payment.provider.duration", {
  description: "Latency of the full retried provider call (ms)",
  unit: "ms",
});

const STATE_TO_NUMBER = { closed: 0, "half-open": 1, open: 2 } as const;

/**
 * Takes a getter rather than the breaker itself: the breaker gets rebuilt in place
 * when threshold/openMs change (a "hot" config key), and the gauge needs to keep
 * reading whichever instance is current, not the one that existed at registration.
 */
export function registerCircuitStateGauge(getBreaker: () => CircuitBreaker): void {
  const gauge = meter.createObservableGauge("payment.circuit.state", {
    description: "0 = closed, 1 = half-open, 2 = open",
  });
  gauge.addCallback((result) => {
    result.observe(STATE_TO_NUMBER[getBreaker().getState()]);
  });
}

export function registerDbPoolGauges(pool: Pool): void {
  const inUse = meter.createObservableGauge("payment.db.pool.in_use");
  inUse.addCallback((result) => {
    result.observe(pool.totalCount - pool.idleCount);
  });

  const waiting = meter.createObservableGauge("payment.db.pool.waiting");
  waiting.addCallback((result) => {
    result.observe(pool.waitingCount);
  });
}
