import { metrics } from "@opentelemetry/api";
import type { Pool } from "pg";

const meter = metrics.getMeter("order-service");

export const cacheRequests = meter.createCounter("order.cache.requests", {
  description: "Product price cache-aside lookups, labelled by result (hit|miss)",
});

// Paired with worker-service's orders.fulfilled - INC-08's whole signal is
// the gap between the two, since nothing else about this incident produces
// an error anywhere.
export const ordersCreated = meter.createCounter("orders.created", {
  description: "Orders successfully written to DynamoDB and enqueued",
});

export function registerDbPoolGauges(pool: Pool): void {
  const inUse = meter.createObservableGauge("order.db.pool.in_use");
  inUse.addCallback((result) => {
    result.observe(pool.totalCount - pool.idleCount);
  });

  const waiting = meter.createObservableGauge("order.db.pool.waiting");
  waiting.addCallback((result) => {
    result.observe(pool.waitingCount);
  });
}
