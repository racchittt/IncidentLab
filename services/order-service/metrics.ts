import { metrics } from "@opentelemetry/api";
import type { Pool } from "pg";

const meter = metrics.getMeter("order-service");

export const cacheRequests = meter.createCounter("order.cache.requests", {
  description: "Product price cache-aside lookups, labelled by result (hit|miss)",
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
