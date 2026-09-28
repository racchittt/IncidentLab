# Trace across SQS (Task 5)

Auto-instrumentation for `@aws-sdk/client-sqs` already injects `traceparent` into
`MessageAttributes` on `SendMessage` and exposes it on `ReceiveMessage` — no manual
inject needed on the send side.

**Broke #1:** floci's `CreateQueueCommand` returns a `QueueUrl` hostnamed `localhost`,
but the AWS SDK v3 SQS client defaults to trusting that URL's host as the endpoint for
later calls. Fine on the host, but a container named `worker-service` can't reach
`localhost:4566` — that's floci's own loopback, not the shared network. Fix:
`new SQSClient({ useQueueUrlAsEndpoint: false })` so it always uses `AWS_ENDPOINT_URL`.

**Broke #2:** extracting the parent context with `propagation.extract` and running
`context.with(extractedContext, ...)` is not the same as making a *new* span active.
`tracer.startSpan()` just creates a span object — nested code (and pino's log
injection) still sees whatever was active before. Needed `tracer.startActiveSpan(name,
{}, extractedContext, callback)` so `process-order` itself becomes the active span for
everything inside it.

**Broke #3 (found on review):** a poison message — bad JSON, or valid JSON missing
`orderId` — threw inside the per-message loop, which was only caught by `main()`'s
top-level `catch`. That call `process.exit(1)`s without deleting the message, so SQS
redelivers the same poison message to the next (restarted) process, which crashes
again — an infinite crash-loop. Fixed by moving the try/catch inside the loop, reading
`ApproximateReceiveCount` from the message's system attributes, and only giving up
(deleting without processing) once a message has failed 3 times — transient failures
still get retried, poison messages stop crash-looping.

**Broke #4 (found on review):** `depends_on: [floci]` only waits for floci's
*container* to start, not for floci itself to be ready to accept connections. If
`order-service`/`worker-service` hit `CreateTable`/`CreateQueue` before floci is
actually listening, they crash before ever calling `app.listen`. Fixed two ways: (a)
compose now uses `depends_on: { floci: { condition: service_healthy } }`, which waits
for floci's own healthcheck; (b) added `services/runtime/src/retry.ts` (linear
backoff) around every startup call to floci, as defense-in-depth for the case where
the healthcheck passes but the service still isn't fully ready, or the app runs
outside compose entirely.

**Verified:** one Tempo trace contains `POST /orders` → `DynamoDB.PutItem` →
`orders-placed send` (order-service) and `process-order` → `DynamoDB.UpdateItem`
(worker-service) — screenshot in `docs/milestone-1/tempo-trace-cross-service.jpg`.
`GET /orders/:id` flips from `created` to `fulfilled`. Reapplying the same conditional
`UpdateItem` a second time correctly throws `ConditionalCheckFailedException` instead
of double-processing. A message with no `orderId` is retried 3 times then dropped,
without the worker container ever restarting.
