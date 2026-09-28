# Milestone 1 screenshots

Three screenshots of the same request (`POST /orders`, trace ID
`9b1d9119b4cb541a800cb15f1af6945c`), each from a different Grafana LGTM data source:

- `tempo-trace-cross-service.jpg` — Tempo trace showing `order-service`'s
  `POST /orders` → `DynamoDB.PutItem` → `orders-placed send`, and `worker-service`'s
  `process-order` → `DynamoDB.UpdateItem`, all under one trace.
- `loki-log-trace-id.jpg` — the `order created` log line in Loki, expanded to show
  its `trace_id` field linking straight to the trace above.
- `prometheus-metric.jpg` — `http_server_request_duration_seconds_count` for
  order-service, showing both the `GET /orders/:id` and `POST /orders` routes.
