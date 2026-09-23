import { 
  DynamoDBClient, 
  CreateTableCommand, 
  PutItemCommand,
  CreateTableCommandInput,
  PutItemCommandInput
} from "@aws-sdk/client-dynamodb";
import { 
  SQSClient, 
  CreateQueueCommand, 
  SendMessageCommand, 
  ReceiveMessageCommand,
  CreateQueueCommandInput,
  SendMessageCommandInput,
  ReceiveMessageCommandInput,
  ReceiveMessageCommandOutput
} from "@aws-sdk/client-sqs";

const endpoint: string = "http://localhost:4566";
const region: string = "us-east-1";

const ddb = new DynamoDBClient({ endpoint, region });
const sqs = new SQSClient({ endpoint, region });

async function main(): Promise<void> {
  const createTableInput: CreateTableCommandInput = {
    TableName: "orders",
    KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "orderId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  };
  await ddb.send(new CreateTableCommand(createTableInput));

  const putItemInput: PutItemCommandInput = {
    TableName: "orders",
    Item: { 
      orderId: { S: "test-1" }, 
      status: { S: "created" } 
    },
  };
  await ddb.send(new PutItemCommand(putItemInput));
  console.log("DynamoDB OK");

  const createQueueInput: CreateQueueCommandInput = { QueueName: "payment-retry-queue" };
  const { QueueUrl } = await sqs.send(new CreateQueueCommand(createQueueInput));

  if (!QueueUrl) {
    throw new Error("Failed to retrieve QueueUrl from SQS.");
  }

  const sendMessageInput: SendMessageCommandInput = { 
    QueueUrl, 
    MessageBody: "ping" 
  };
  await sqs.send(new SendMessageCommand(sendMessageInput));

  const receiveMessageInput: ReceiveMessageCommandInput = { QueueUrl };
  const msgs: ReceiveMessageCommandOutput = await sqs.send(
    new ReceiveMessageCommand(receiveMessageInput)
  );
  
  console.log("SQS OK:", msgs.Messages?.[0]?.Body);
}

main().catch((error: unknown) => {
  console.error("Execution failed:", error);
});