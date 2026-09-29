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
import { Pool } from "pg";
import { createClient, RedisClientType } from "redis";
import { logger } from "@incidentlab/runtime/src/logger";
import { waitFor } from "@incidentlab/runtime/src/waitFor";
import { cacheRequests, registerDbPoolGauges } from "./metrics";

const app: Application = express();
const PORT: number = 3001;

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
const ORDERS_TABLE = "orders";
const ORDERS_PLACED_QUEUE = "orders-placed";
const DEPLOY_REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://deploy-registry:3004";

// order-service's own pool, separate from any other service's - deliberately
// small (INC-03's whole mechanism depends on it being easy to exhaust) and
// fixed, not registry-configurable like payment-service's dbPoolMax. The
// causal thing that changes during INC-03 is the cache TTL, not this.
//
// Measured live at 30rps/80% hot-traffic-share/3-hot-products: a hot key's
// expiry produced ~1.6-2 concurrent misses (8rps per hot product * 0.2s
// pg_sleep), not the ~6 a naive "total rps * miss duration" estimate
// suggests - that estimate assumes all traffic synchronizes into one burst,
// but three independently-expiring keys stagger it instead. A pool of 5
// comfortably absorbed that with zero queueing. Dropped to max:2 and the
// miss cost to 0.4s (see lookupProductPrice) to actually get real waiting
// at traffic this size - also had to drop INC-03's loadgen rps to stay
// under order-service's own DynamoDB write cap (20/s, INC-02's baseline),
// since 30rps was tripping THAT limiter before requests ever reached here.
const productsPool = new Pool({ max: 2 });
registerDbPoolGauges(productsPool);

const redis: RedisClientType = createClient({ url: process.env.REDIS_URL ?? "redis://redis:6379" });
redis.on("error", (err) => logger.warn({ err }, "redis error"));

let ordersPlacedQueueUrl: string;

// ddb.writeCapacity is a baseline config value - seeded once in deploy-registry
// and never deployed during INC-02, on purpose. The incident's only trigger is
// load; nothing about this service's own config changes.
let ddbWriteCapacity = 20;
let tokens = ddbWriteCapacity;
let lastRefill = Date.now();

// INC-03's causal value: dropping this from 300 to 5 makes every hot product's
// cache entry expire almost as fast as it's repopulated, turning a handful of
// popular items into a steady stream of simultaneous cache misses.
let cacheTtlSeconds = 300;

async function pollOrderServiceConfig(): Promise<void> {
  try {
    const res = await fetch(`${DEPLOY_REGISTRY_URL}/config/order-service`);
    if (res.ok) {
      const body = await res.json();
      if (typeof body.config?.ddb?.writeCapacity === "number") {
        ddbWriteCapacity = body.config.ddb.writeCapacity;
      }
      if (typeof body.config?.cache?.ttlSeconds === "number") {
        cacheTtlSeconds = body.config.cache.ttlSeconds;
      }
    }
  } catch {
    // Registry unreachable: keep the last known config rather than throw.
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

/**
 * Cache-aside product price lookup. A Postgres miss is made deliberately
 * expensive (pg_sleep(0.4), simulating a heavy join a real catalog query
 * might need) so a wave of simultaneous misses - the whole point of INC-03 -
 * actually costs something instead of being free query noise. (0.2s was the
 * first attempt; measured live it left concurrent misses under the pool's
 * capacity even after lowering the pool size - see productsPool's comment.)
 */
async function lookupProductPrice(productId: number): Promise<number> {
  const cacheKey = `product:${productId}:price`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      cacheRequests.add(1, { result: "hit" });
      return Number(cached);
    }
  } catch (error) {
    logger.warn({ err: error, productId }, "redis GET failed, falling through to Postgres");
  }

  cacheRequests.add(1, { result: "miss" });
  const { rows } = await productsPool.query<{ price_cents: number }>(
    "SELECT price_cents, pg_sleep(0.4) FROM products WHERE id = $1",
    [productId]
  );
  if (rows.length === 0) {
    throw new Error(`unknown productId ${productId}`);
  }
  const priceCents = rows[0].price_cents;

  try {
    await redis.set(cacheKey, String(priceCents), { EX: cacheTtlSeconds });
  } catch (error) {
    logger.warn({ err: error, productId }, "redis SET failed - next request will miss again too");
  }

  return priceCents;
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
  const productId = typeof req.body?.productId === "number" ? req.body.productId : undefined;

  let amountCents: number;
  if (productId !== undefined) {
    try {
      amountCents = await lookupProductPrice(productId);
    } catch (error) {
      logger.error({ err: error, productId, requestId }, "product price lookup failed");
      res.sendStatus(503);
      return;
    }
  } else {
    amountCents =
      typeof req.body?.amountCents === "number" ? req.body.amountCents : 500 + Math.floor(Math.random() * 4500);
  }

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

Promise.all([ensureOrdersTable(), ensureOrdersPlacedQueue(), pollOrderServiceConfig(), redis.connect()]).then(() => {
  setInterval(pollOrderServiceConfig, 5000);
  app.listen(PORT, () => logger.info({ ddbWriteCapacity, cacheTtlSeconds }, `order-service on ${PORT}`));
});
