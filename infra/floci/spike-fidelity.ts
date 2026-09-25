import {
  DynamoDBClient,
  CreateTableCommand,
  PutItemCommand,
  CreateTableCommandInput,
  PutItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  CreateQueueCommandInput,
  SendMessageCommandInput,
  ReceiveMessageCommandInput,
  ReceiveMessageCommandOutput,
} from "@aws-sdk/client-sqs";

const endpoint: string = "http://localhost:4566";
const region: string = "us-east-1";

const credentials = { accessKeyId: "test", secretAccessKey: "test" };

const ddb = new DynamoDBClient({ endpoint, region, credentials });
const sqs = new SQSClient({ endpoint, region, credentials });

async function testThrottling(): Promise<void> {
  console.log("\n--- Question 1: Does DynamoDB throttle? ---");

  const createTableInput: CreateTableCommandInput = {
    TableName: "throttle-test",
    KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "orderId", AttributeType: "S" }],
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
  };
  await ddb.send(new CreateTableCommand(createTableInput));

  const writes = Array.from({ length: 200 }, (_, i) => {
    const putItemInput: PutItemCommandInput = {
      TableName: "throttle-test",
      Item: {
        orderId: { S: `throttle-test-${i}` },
        status: { S: "created" },
      },
    };
    return ddb.send(new PutItemCommand(putItemInput));
  });

  const results = await Promise.allSettled(writes);

  const throttled = results.filter(
    (r) => r.status === "rejected" && (r.reason as { name?: string })?.name === "ProvisionedThroughputExceededException"
  );
  const otherFailures = results.filter(
    (r) => r.status === "rejected" && (r.reason as { name?: string })?.name !== "ProvisionedThroughputExceededException"
  );
  const succeeded = results.filter((r) => r.status === "fulfilled");

  console.log(`Sent: 200, Succeeded: ${succeeded.length}, Throttled: ${throttled.length}, Other failures: ${otherFailures.length}`);
  if (otherFailures.length > 0) {
    console.log("Sample other failure:", (otherFailures[0] as PromiseRejectedResult).reason);
  }
}

async function testMessageAttributes(): Promise<void> {
  console.log("\n--- Question 2: Does SQS keep message attributes? ---");

  const createQueueInput: CreateQueueCommandInput = { QueueName: "trace-test-queue" };
  const { QueueUrl } = await sqs.send(new CreateQueueCommand(createQueueInput));

  if (!QueueUrl) {
    throw new Error("Failed to retrieve QueueUrl from SQS.");
  }

  const traceValue = "00-abc123-def456-01";

  const sendMessageInput: SendMessageCommandInput = {
    QueueUrl,
    MessageBody: "ping",
    MessageAttributes: {
      traceparent: { DataType: "String", StringValue: traceValue },
    },
  };
  await sqs.send(new SendMessageCommand(sendMessageInput));

  const receiveMessageInput: ReceiveMessageCommandInput = {
    QueueUrl,
    MessageAttributeNames: ["All"],
  };
  const msgs: ReceiveMessageCommandOutput = await sqs.send(
    new ReceiveMessageCommand(receiveMessageInput)
  );

  const receivedValue = msgs.Messages?.[0]?.MessageAttributes?.traceparent?.StringValue;
  console.log(`Sent traceparent: ${traceValue}`);
  console.log(`Received traceparent: ${receivedValue}`);
  console.log(`Match: ${receivedValue === traceValue}`);
}

async function main(): Promise<void> {
  await testThrottling();
  await testMessageAttributes();
}

main().catch((error: unknown) => {
  console.error("Execution failed:", error);
});
