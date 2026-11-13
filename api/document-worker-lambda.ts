import { BedrockAgentClient } from "@aws-sdk/client-bedrock-agent";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { createDocumentIngestion, createDocumentObjects } from "./document-aws-adapters.js";
import { parseDocumentResources } from "./document-config.js";
import { createDocumentStore } from "./document-store.js";
import { createDocumentWorker, type DocumentWorkerStep } from "./document-worker.js";
import { isValidOperationId } from "./access.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required Lambda environment variable ${name}.`);
  return value;
}

function catalogFromEnvironment() {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredEnvironment("BOT_CATALOG"));
  } catch {
    throw new Error("BOT_CATALOG must be valid JSON.");
  }
  return parseDocumentResources(parsed);
}

function validWorkerEvent(value: unknown): value is {
  botId: string;
  operationId: string;
  step: DocumentWorkerStep;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const keys = Object.keys(event);
  return (
    keys.length === 3 &&
    keys.includes("botId") &&
    keys.includes("operationId") &&
    keys.includes("step") &&
    typeof event.botId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(event.botId) &&
    isValidOperationId(event.operationId) &&
    ["validate", "promote", "start-ingestion", "observe-ingestion", "finish"].includes(
      String(event.step),
    )
  );
}

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const resources = catalogFromEnvironment();
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3ReadClient = new S3Client({ region, maxAttempts: 2 });
const s3EffectClient = new S3Client({ region, maxAttempts: 1 });
const bedrockClient = new BedrockAgentClient({ region });
const stores = Object.fromEntries(
  resources.map((bot) => [
    bot.botId,
    createDocumentStore({
      documentClient: dynamoClient,
      tableName: bot.documentTableName,
      botId: bot.botId,
      now: Date.now,
    }),
  ]),
);
const resourcesByBot = Object.fromEntries(resources.map((bot) => [bot.botId, bot]));
const worker = createDocumentWorker({
  stores,
  resourcesByBot,
  objects: createDocumentObjects({ s3Client: s3ReadClient, effectClient: s3EffectClient }),
  ingestion: createDocumentIngestion({ bedrockClient }),
  now: Date.now,
});

export async function handler(event: unknown) {
  if (!validWorkerEvent(event)) throw new TypeError("Document worker input is invalid.");
  if (!resourcesByBot[event.botId])
    throw new TypeError("Document worker chatbot is not configured.");
  try {
    return await worker.run(event);
  } catch {
    throw new Error("Document worker invocation failed.");
  }
}
