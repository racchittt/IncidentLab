import "@incidentlab/runtime/src/telemetry";
import { propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import {
  SQSClient,
  CreateQueueCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  Message,
} from "@aws-sdk/client-sqs";
import { logger } from "@incidentlab/runtime/src/logger";
import { retry } from "@incidentlab/runtime/src/retry";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
const tracer = trace.getTracer("worker-service");

const ORDERS_TABLE = "orders";
const ORDERS_PLACED_QUEUE = "orders-placed";
const MAX_RECEIVE_COUNT = 3;

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
      const { orderId } = JSON.parse(message.Body ?? "{}");
      await fulfillOrder(orderId); //flips to completed, will be extrapolated to other services in the future
    } finally {
      span.end();
    }
  });
}

async function main(): Promise<void> {
  const QueueUrl = await retry(async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: ORDERS_PLACED_QUEUE }));
    if (!QueueUrl) {
      throw new Error("Failed to retrieve QueueUrl for orders-placed queue.");
    }
    return QueueUrl;
  }, { label: "CreateQueue(orders-placed)" });

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
          "failed to process message"
        );

        // A poison message (bad JSON, missing orderId, ...) would otherwise be
        // redelivered and crash this loop forever. Give it a few tries in case the
        // failure is transient, then give up and drop it instead of crash-looping.
        if (receiveCount >= MAX_RECEIVE_COUNT) {
          logger.error({ messageId: message.MessageId }, "giving up on poison message, deleting unprocessed");
          await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
        }
      }
    }
  }
}

main().catch((error: unknown) => {
  logger.error(error, "worker-service crashed");
  process.exit(1);
});
