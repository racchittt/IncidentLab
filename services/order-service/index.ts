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
import { retry } from "@incidentlab/runtime/src/retry";
import { latencyFaultMiddleware, setLatencyFault } from "./faults/latency";

const app: Application = express();
const PORT: number = 3001;

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
const ORDERS_TABLE = "orders";
const ORDERS_PLACED_QUEUE = "orders-placed";

let ordersPlacedQueueUrl: string;

async function ensureOrdersPlacedQueue(): Promise<void> {
  await retry(async () => {
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
  await retry(async () => {
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
app.use(latencyFaultMiddleware);

app.post("/orders", async (req: Request, res: Response<OrderResponse>) => {
  const orderId = randomUUID();

  await ddb.send(
    new PutItemCommand({
      TableName: ORDERS_TABLE,
      Item: {
        orderId: { S: orderId },
        status: { S: "created" },
        item: { S: String(req.body?.item ?? "") },
      },
    })
  );

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: ordersPlacedQueueUrl,
      MessageBody: JSON.stringify({ eventType: "OrderPlaced", orderId }),
    })
  );

  logger.info({ orderId }, "order created");
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

app.post("/admin/inject-fault", (req: Request, res: Response) => {
  const delayMs = req.body?.delayMs;
  if (typeof delayMs !== "number" || delayMs < 0) {
    return res.status(400).json({ error: "delayMs must be a non-negative number" });
  }
  setLatencyFault(delayMs);
  res.sendStatus(200);
});

app.post("/admin/reset-fault", (req: Request, res: Response) => {
  setLatencyFault(null);
  res.sendStatus(200);
});

Promise.all([ensureOrdersTable(), ensureOrdersPlacedQueue()]).then(() => {
  app.listen(PORT, () => logger.info(`order-service on ${PORT}`));
});
