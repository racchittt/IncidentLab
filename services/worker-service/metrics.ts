import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("worker-service");

// Paired with order-service's orders.created - INC-08's whole signal is the
// gap between the two, since nothing else about this incident produces an
// error anywhere: the worker happily polls an empty queue and logs nothing
// alarming.
export const ordersFulfilled = meter.createCounter("orders.fulfilled", {
  description: "Orders successfully charged and marked fulfilled",
});
