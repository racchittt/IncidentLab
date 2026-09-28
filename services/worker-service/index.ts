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

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
const tracer = trace.getTracer("worker-service");

const ORDERS_TABLE = "orders";
const ORDERS_PLACED_QUEUE = "orders-placed";
const ORDERS_PLACED_DLQ = "orders-placed-dlq";
const MAX_RECEIVE_COUNT = 3;

const PAYMENT_SERVICE_URL = "http://payment-service:3003/charges";

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

async function main(): Promise<void> {
  const QueueUrl = await waitFor(async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: ORDERS_PLACED_QUEUE }));
    if (!QueueUrl) {
      throw new Error("Failed to retrieve QueueUrl for orders-placed queue.");
    }
    return QueueUrl;
  }, { label: "CreateQueue(orders-placed)" });

  // floci honors SQS's RedrivePolicy natively (confirmed in infra/floci/spike-dlq.ts,
  // see evals/reports/p0-spikes.md) - after MAX_RECEIVE_COUNT failed receives, SQS
  // itself moves the message to orders-placed-dlq. We just have to not delete a
  // message we failed to process, and let redelivery run its course.
  await ensureDlqRedrivePolicy(QueueUrl);

  logger.info("worker-service started");

  while (true) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        WaitTimeSeconds: 10,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      })
    );

    for (const message of Messages ?? []) {
      try {
        await processMessage(message);
        await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
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
  }
}

main().catch((error: unknown) => {
  logger.error(error, "worker-service crashed");
  process.exit(1);
});
