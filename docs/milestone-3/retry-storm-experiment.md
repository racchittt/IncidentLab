# Retry storm experiment (Task 5)

**Baseline:** k6 holds a steady 5 req/s through `POST /orders`; payment-service's
dashboard shows ~5 req/s success, circuit closed (0), single-digit-ms p95.

**b. Inject latency** (`toxiproxy-cli toxic add -t latency -a latency=3000 provider`,
3s, timeout at 2s): calls to the provider start timing out. `retry` retries the
`TimeoutError` a few times, but concurrent 5 req/s traffic accumulates
`failureThreshold` (5) consecutive failures fast — the breaker opens within
~10 minutes of wall time. Once open, every request fails instantly with
`CircuitOpenError` instead of waiting out the provider — p95 actually *drops* after
opening (screenshot `b-latency-toxic-breaker-opens.jpg`), which is the whole point of
a breaker: fail fast instead of hanging. `worker-service`'s messages, now getting 503s,
stop being deleted and pile up for redelivery — visible as the request-rate panel
climbing past 5 req/s (SQS redelivering the same failed orders on top of new ones).

**c. The storm:** removed the toxic (breaker recovers on the next half-open trial),
then set `PAYMENT_RETRY_BASE_MS=0` + `PAYMENT_RETRY_JITTER=none` (restarted
payment-service) with the provider's `ERROR_RATE` set to 0.3 live via its
`/admin/set-config`. With zero delay between attempts, a failing request's 5 retries
fire back-to-back in single-digit milliseconds instead of spreading out — logs show
two attempts 4ms apart. Request rate to payment-service jumps from 5 to ~17 req/s
(screenshot `c-retry-storm.jpg`) purely from retries re-hitting the provider, and the
burst is dense enough that it *also* trips the circuit breaker a second time, compounding
the outage. Resetting the error rate and restoring backoff+jitter brings request rate,
retries, and circuit state all back to baseline within a couple of minutes
(`c-recovered.jpg`) — the same failure rate, spread out with backoff, never storms.

**The one panel to point at:** "Retry rate by outcome" — `success` flatlines and
`giveup` spikes at the exact moment "Circuit state" jumps from 0 to 2, in both b and c.
That's INC-01 (a retry storm cascading into an outage), reproduced for real instead of
simulated.
