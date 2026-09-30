import "@incidentlab/runtime/src/telemetry";
import { propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  Message,
} from "@aws-sdk/client-sqs";
import { logger } from "@incidentlab/runtime/src/logger";
import { waitFor } from "@incidentlab/runtime/src/waitFor";
import { ordersFulfilled } from "./metrics";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
const tracer = trace.getTracer("worker-service");

const ORDERS_TABLE = "orders";
const ORDERS_PLACED_QUEUE = "orders-placed";
const ORDERS_PLACED_DLQ = "orders-placed-dlq";
const MAX_RECEIVE_COUNT = 3;
// SQS caps a single ReceiveMessage at 10; concurrency beyond that needs more
// frequent receives, not a bigger batch.
const WORKER_CONCURRENCY = Math.min(Number(process.env.WORKER_CONCURRENCY ?? "5"), 10);

const PAYMENT_SERVICE_URL = "http://payment-service:3003/charges";
const DEPLOY_REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://deploy-registry:3004";

// INC-08's whole mechanism: this is read fresh from config, so a deploy can
// point the worker at a different (freshly-created, always-empty) queue
// without ever restarting it or logging anything that looks like a failure.
let queueName = ORDERS_PLACED_QUEUE;

async function pollWorkerServiceConfig(): Promise<void> {
  try {
    const res = await fetch(`${DEPLOY_REGISTRY_URL}/config/worker-service`);
    if (res.ok) {
      const body = await res.json();
      if (typeof body.config?.queue?.name === "string") {
        queueName = body.config.queue.name;
      }
    }
  } catch {
    // Registry unreachable: keep the last known queue name rather than throw.
  }
}

async function chargeOrder(orderId: string, amountCents: number): Promise<void> {
  const response = await fetch(PAYMENT_SERVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, amountCents }),
  });

  if (!response.ok) {
    throw new Error(`payment-service responded ${response.status} for order ${orderId}`);
  }
}

async function fulfillOrder(orderId: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: ORDERS_TABLE,
        Key: { orderId: { S: orderId } },
        UpdateExpression: "SET #status = :fulfilled",
        ConditionExpression: "#status = :created",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":fulfilled": { S: "fulfilled" },
          ":created": { S: "created" },
        },
      })
    );
    ordersFulfilled.add(1);
    logger.info({ orderId }, "order fulfilled");
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      logger.info({ orderId }, "order already fulfilled, skipping");
      return;
    }
    throw error;
  }
}

async function processMessage(message: Message): Promise<void> {
  const attributes = message.MessageAttributes ?? {};
  logger.info({ attributes }, "received message");

  const carrier = { traceparent: attributes.traceparent?.StringValue };
  const extractedContext = propagation.extract(ROOT_CONTEXT, carrier);

  await tracer.startActiveSpan("process-order", {}, extractedContext, async (span) => {
    try {
      const { orderId, amountCents } = JSON.parse(message.Body ?? "{}");
      await chargeOrder(orderId, amountCents);
      await fulfillOrder(orderId);
    } finally {
      span.end();
    }
  });
}

async function handleMessage(queueUrl: string, message: Message): Promise<void> {
  try {
    await processMessage(message);
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  } catch (error: unknown) {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    logger.error(
      { err: error, messageId: message.MessageId, receiveCount },
      "failed to process message, leaving for redelivery"
    );
    // Don't delete: a transient failure gets retried when the message becomes
    // visible again, and a genuine poison message gets moved to
    // orders-placed-dlq automatically once it hits MAX_RECEIVE_COUNT (SQS's own
    // RedrivePolicy, set up in ensureDlqRedrivePolicy - no manual counting needed).
  }
}

async function ensureDlqRedrivePolicy(sourceQueueUrl: string): Promise<void> {
  const { QueueUrl: dlqUrl } = await waitFor(
    () => sqs.send(new CreateQueueCommand({ QueueName: ORDERS_PLACED_DLQ })),
    { label: "CreateQueue(orders-placed-dlq)" }
  );
  if (!dlqUrl) {
    throw new Error("Failed to retrieve QueueUrl for orders-placed-dlq queue.");
  }

  const { Attributes } = await waitFor(
    () => sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] })),
    { label: "GetQueueAttributes(orders-placed-dlq)" }
  );
  const dlqArn = Attributes?.QueueArn;
  if (!dlqArn) {
    throw new Error("Failed to retrieve QueueArn for orders-placed-dlq queue.");
  }

  await waitFor(
    () =>
      sqs.send(
        new SetQueueAttributesCommand({
          QueueUrl: sourceQueueUrl,
          Attributes: {
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: dlqArn,
              maxReceiveCount: String(MAX_RECEIVE_COUNT),
            }),
          },
        })
      ),
    { label: "SetQueueAttributes(orders-placed, RedrivePolicy)" }
  );
}

let resolvedQueueName: string | null = null;
let resolvedQueueUrl: string;

/** Re-resolves the queue URL only when queueName actually changes - CreateQueueCommand
 * is idempotent (returns the existing queue if one exists, creates a fresh empty one
 * if it doesn't), which is exactly INC-08's mechanism: pointing this at a name nobody's
 * ever enqueued to just gets you a real, valid, permanently-empty queue. */
async function resolveQueueUrl(): Promise<string> {
  if (queueName === resolvedQueueName) {
    return resolvedQueueUrl;
  }
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
  if (!QueueUrl) {
    throw new Error(`Failed to retrieve QueueUrl for ${queueName} queue.`);
  }
  logger.info({ queueName, QueueUrl }, "worker now polling queue");
  resolvedQueueName = queueName;
  resolvedQueueUrl = QueueUrl;
  return QueueUrl;
}

async function main(): Promise<void> {
  const ordersPlacedQueueUrl = await waitFor(async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: ORDERS_PLACED_QUEUE }));
    if (!QueueUrl) {
      throw new Error("Failed to retrieve QueueUrl for orders-placed queue.");
    }
    return QueueUrl;
  }, { label: "CreateQueue(orders-placed)" });

  // floci honors SQS's RedrivePolicy natively (confirmed in infra/floci/spike-dlq.ts,
  // see evals/reports/p0-spikes.md) - after MAX_RECEIVE_COUNT failed receives, SQS
  // itself moves the message to orders-placed-dlq. We just have to not delete a
  // message we failed to process, and let redelivery run its course. This is always
  // set up against the real orders-placed queue, independent of which queue the
  // receive loop below is currently pointed at.
  await ensureDlqRedrivePolicy(ordersPlacedQueueUrl);

  await pollWorkerServiceConfig();
  setInterval(pollWorkerServiceConfig, 5000);

  logger.info({ concurrency: WORKER_CONCURRENCY, queueName }, "worker-service started");

  while (true) {
    const QueueUrl = await resolveQueueUrl();
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        WaitTimeSeconds: 10,
        MaxNumberOfMessages: WORKER_CONCURRENCY,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      })
    );

    await Promise.allSettled((Messages ?? []).map((message) => handleMessage(QueueUrl, message)));
  }
}

main().catch((error: unknown) => {
  logger.error(error, "worker-service crashed");
  process.exit(1);
});
