import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";

const endpoint = "http://localhost:4566";
const region = "us-east-1";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };

const sqs = new SQSClient({ endpoint, region, credentials, useQueueUrlAsEndpoint: false });

const MAX_RECEIVE_COUNT = 2;

async function main(): Promise<void> {
  const { QueueUrl: dlqUrl } = await sqs.send(new CreateQueueCommand({ QueueName: "spike-dlq" }));
  if (!dlqUrl) throw new Error("no dlq url");

  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] })
  );
  const dlqArn = Attributes?.QueueArn;
  if (!dlqArn) throw new Error("no dlq arn");
  console.log("DLQ ARN:", dlqArn);

  const { QueueUrl: sourceUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: "spike-source",
      Attributes: {
        VisibilityTimeout: "1",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(MAX_RECEIVE_COUNT) }),
      },
    })
  );
  if (!sourceUrl) throw new Error("no source url");

  await sqs.send(new SendMessageCommand({ QueueUrl: sourceUrl, MessageBody: "spike-poison" }));
  console.log("Sent 1 message to spike-source with maxReceiveCount =", MAX_RECEIVE_COUNT);

  // Receive it MAX_RECEIVE_COUNT + 1 times *without deleting* (simulating a handler
  // that always fails), waiting out the 1s visibility timeout between each attempt.
  for (let i = 1; i <= MAX_RECEIVE_COUNT + 1; i++) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: sourceUrl,
        WaitTimeSeconds: 3,
        AttributeNames: ["ApproximateReceiveCount"],
      })
    );
    const receiveCount = Messages?.[0]?.Attributes?.ApproximateReceiveCount;
    console.log(`Receive attempt ${i}: got ${Messages?.length ?? 0} message(s), ApproximateReceiveCount=${receiveCount}`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Now check both queues.
  const sourceCheck = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: sourceUrl, WaitTimeSeconds: 2 })
  );
  const dlqCheck = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 2 })
  );

  console.log("\n--- Result ---");
  console.log("Message still on spike-source:", sourceCheck.Messages?.length ?? 0);
  console.log("Message moved to spike-dlq:", dlqCheck.Messages?.length ?? 0);
  console.log(
    dlqCheck.Messages?.length
      ? "floci DOES honor RedrivePolicy."
      : "floci does NOT honor RedrivePolicy (or not within this wait window) -- app must move messages to the DLQ manually."
  );
}

main().catch((error) => {
  console.error("Execution failed:", error);
});
