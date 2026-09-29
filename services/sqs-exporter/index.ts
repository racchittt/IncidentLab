import "@incidentlab/runtime/src/telemetry";
import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { metrics } from "@opentelemetry/api";
import { logger } from "@incidentlab/runtime/src/logger";

// A separate service on purpose: if this polling lived inside worker-service,
// it would go blind exactly when the worker breaks (INC-08) - the one incident
// where queue depth climbing is itself the evidence.
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
const meter = metrics.getMeter("sqs-exporter");

const QUEUES = ["orders-placed", "orders-placed-dlq"];
const POLL_MS = 10_000;

const depths: Record<string, number> = {};
const ages: Record<string, number> = {};
let ageOfOldestSupported: boolean | null = null;

const depthGauge = meter.createObservableGauge("sqs.queue.depth", {
  description: "ApproximateNumberOfMessages per queue",
});
depthGauge.addCallback((result) => {
  for (const [queue, value] of Object.entries(depths)) {
    result.observe(value, { queue });
  }
});

const ageGauge = meter.createObservableGauge("sqs.queue.age_of_oldest_message", {
  description: "ApproximateAgeOfOldestMessage per queue, seconds (only if floci supports it)",
  unit: "s",
});
ageGauge.addCallback((result) => {
  for (const [queue, value] of Object.entries(ages)) {
    result.observe(value, { queue });
  }
});

async function pollOnce(): Promise<void> {
  for (const queueName of QUEUES) {
    try {
      const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
      if (!QueueUrl) continue;

      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateAgeOfOldestMessage"],
        })
      );

      depths[queueName] = Number(Attributes?.ApproximateNumberOfMessages ?? "0");

      if (Attributes?.ApproximateAgeOfOldestMessage !== undefined) {
        ages[queueName] = Number(Attributes.ApproximateAgeOfOldestMessage);
        if (ageOfOldestSupported === null) {
          ageOfOldestSupported = true;
          logger.info("floci supports ApproximateAgeOfOldestMessage");
        }
      } else if (ageOfOldestSupported === null) {
        ageOfOldestSupported = false;
        logger.warn("floci does not return ApproximateAgeOfOldestMessage - age gauge will stay empty");
      }

      logger.info({ queue: queueName, depth: depths[queueName], age: ages[queueName] }, "queue polled");
    } catch (error: unknown) {
      logger.warn({ err: error, queue: queueName }, "failed to poll queue attributes");
    }
  }
}

setInterval(pollOnce, POLL_MS);
pollOnce();
logger.info({ queues: QUEUES, pollMs: POLL_MS }, "sqs-exporter started");
