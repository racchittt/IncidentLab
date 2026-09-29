import "@incidentlab/runtime/src/telemetry";
import express, { Request, Response, Application } from "express";
import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  CreateTableCommand,
  PutItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SQSClient, CreateQueueCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { logger } from "@incidentlab/runtime/src/logger";
import { waitFor } from "@incidentlab/runtime/src/waitFor";

const app: Application = express();
const PORT: number = 3001;

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
const ORDERS_TABLE = "orders";
const ORDERS_PLACED_QUEUE = "orders-placed";
const DEPLOY_REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://deploy-registry:3004";

let ordersPlacedQueueUrl: string;

// ddb.writeCapacity is a baseline config value - seeded once in deploy-registry
// and never deployed during INC-02, on purpose. The incident's only trigger is
// load; nothing about this service's own config changes.
let ddbWriteCapacity = 20;
let tokens = ddbWriteCapacity;
let lastRefill = Date.now();

async function pollOrderServiceConfig(): Promise<void> {
  try {
    const res = await fetch(`${DEPLOY_REGISTRY_URL}/config/order-service`);
    if (res.ok) {
      const body = await res.json();
      if (typeof body.config?.ddb?.writeCapacity === "number") {
        ddbWriteCapacity = body.config.ddb.writeCapacity;
      }
    }
  } catch {
    // Registry unreachable: keep the last known capacity rather than throw.
  }
}

/** Token bucket gating DynamoDB writes at ddbWriteCapacity per second. */
function tryConsumeWriteToken(): boolean {
  const now = Date.now();
  tokens = Math.min(ddbWriteCapacity, tokens + ((now - lastRefill) / 1000) * ddbWriteCapacity);
  lastRefill = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

async function ensureOrdersPlacedQueue(): Promise<void> {
  await waitFor(async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: ORDERS_PLACED_QUEUE }));
    if (!QueueUrl) {
      throw new Error("Failed to retrieve QueueUrl for orders-placed queue.");
    }
    ordersPlacedQueueUrl = QueueUrl;
  }, { label: "CreateQueue(orders-placed)" });
}

interface OrderParams {
  id: string;
}

interface OrderResponse {
  orderId: string;
  status: string;
}

async function ensureOrdersTable(): Promise<void> {
  await waitFor(async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: ORDERS_TABLE,
          KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
          AttributeDefinitions: [{ AttributeName: "orderId", AttributeType: "S" }],
          BillingMode: "PAY_PER_REQUEST",
        })
      );
    } catch (error: unknown) {
      if ((error as { name?: string })?.name !== "ResourceInUseException") {
        throw error;
      }
    }
  }, { label: "CreateTable(orders)" });
}

app.use(express.json());

app.post("/orders", async (req: Request, res: Response<OrderResponse>) => {
  const requestId = req.header("X-Request-Id");

  if (!tryConsumeWriteToken()) {
    const error = new Error("write capacity exceeded");
    error.name = "ProvisionedThroughputExceededException";
    logger.warn({ requestId, ddbWriteCapacity }, error.name);
    res.sendStatus(503);
    return;
  }

  const orderId = randomUUID();
  const amountCents =
    typeof req.body?.amountCents === "number" ? req.body.amountCents : 500 + Math.floor(Math.random() * 4500);

  await ddb.send(
    new PutItemCommand({
      TableName: ORDERS_TABLE,
      Item: {
        orderId: { S: orderId },
        status: { S: "created" },
        item: { S: String(req.body?.item ?? "") },
        amountCents: { N: String(amountCents) },
      },
    })
  );

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: ordersPlacedQueueUrl,
      MessageBody: JSON.stringify({ eventType: "OrderPlaced", orderId, amountCents }),
    })
  );

  logger.info({ orderId, requestId }, "order created");
  res.status(201).json({ orderId, status: "created" });
});

app.get(
  "/orders/:id",
  async (req: Request<OrderParams>, res: Response<OrderResponse>) => {
    const { id } = req.params;

    const { Item } = await ddb.send(
      new GetItemCommand({
        TableName: ORDERS_TABLE,
        Key: { orderId: { S: id } },
      })
    );

    if (!Item) {
      res.sendStatus(404);
      return;
    }

    res.json({ orderId: id, status: Item.status?.S ?? "unknown" });
  }
);

Promise.all([ensureOrdersTable(), ensureOrdersPlacedQueue(), pollOrderServiceConfig()]).then(() => {
  setInterval(pollOrderServiceConfig, 5000);
  app.listen(PORT, () => logger.info({ ddbWriteCapacity }, `order-service on ${PORT}`));
});
