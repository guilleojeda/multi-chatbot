import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { parseRecordsTestPersonIds } from "./records-test-people.js";
import { createRecordsExportWorker, type RecordsExportResources } from "./records-export-worker.js";
import { uploadRecordsCsv } from "./records-export-uploader.js";

type WorkerCatalogEntry = RecordsExportResources & { botId: string };
type WorkerEvent = {
  botId?: unknown;
  actorSub?: unknown;
  exportId?: unknown;
  filters?: unknown;
};
type WorkerContext = { getRemainingTimeInMillis?: () => number };

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() !== value) {
    throw new Error(`Missing or invalid Lambda environment variable ${name}.`);
  }
  return value;
}

function requiredString(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkerCatalog(value: unknown): WorkerCatalogEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("RECORDS_WORKER_CATALOG must contain at least one chatbot.");
  }
  const seenBots = new Set<string>();
  const seenTables = new Set<string>();
  const seenBuckets = new Set<string>();
  const catalog: WorkerCatalogEntry[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !requiredString(entry.botId, 64) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.botId) ||
      !requiredString(entry.conversationTableName) ||
      !requiredString(entry.recordsIndexName) ||
      !requiredString(entry.documentUploadBucketName) ||
      !Array.isArray(entry.testPersonIds) ||
      !entry.testPersonIds.every((sub: unknown) => requiredString(sub, 128))
    ) {
      throw new Error("RECORDS_WORKER_CATALOG contains invalid chatbot resources.");
    }
    if (
      seenBots.has(entry.botId) ||
      seenTables.has(entry.conversationTableName) ||
      seenBuckets.has(entry.documentUploadBucketName) ||
      new Set(entry.testPersonIds).size !== entry.testPersonIds.length
    ) {
      throw new Error("RECORDS_WORKER_CATALOG chatbot resources must be unique.");
    }
    seenBots.add(entry.botId);
    seenTables.add(entry.conversationTableName);
    seenBuckets.add(entry.documentUploadBucketName);
    catalog.push({
      botId: entry.botId,
      conversationTableName: entry.conversationTableName,
      recordsIndexName: entry.recordsIndexName,
      documentUploadBucketName: entry.documentUploadBucketName,
      testPersonIds: [...entry.testPersonIds],
    });
  }
  return catalog;
}

function buildResourcesByBot(
  catalog: WorkerCatalogEntry[],
  configuredTestPeople: ReadonlyMap<string, readonly string[]>,
): Record<string, RecordsExportResources> {
  const catalogBotIds = new Set(catalog.map(({ botId }) => botId));
  if ([...configuredTestPeople.keys()].some((botId) => !catalogBotIds.has(botId))) {
    throw new Error("RECORDS_TEST_PERSON_IDS contains an unknown chatbot.");
  }
  return Object.fromEntries(
    catalog.map(({ botId, ...resources }) => [
      botId,
      {
        ...resources,
        testPersonIds: [
          ...new Set([...(configuredTestPeople.get(botId) ?? []), ...resources.testPersonIds]),
        ],
      },
    ]),
  );
}

const environment = requiredEnvironment("ENVIRONMENT");
let catalogInput: unknown;
try {
  catalogInput = JSON.parse(requiredEnvironment("RECORDS_WORKER_CATALOG"));
} catch {
  throw new Error("RECORDS_WORKER_CATALOG must be valid JSON.");
}
const catalog = parseWorkerCatalog(catalogInput);
const configuredTestPeople = parseRecordsTestPersonIds(process.env.RECORDS_TEST_PERSON_IDS);
const resourcesByBot = buildResourcesByBot(catalog, configuredTestPeople);
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3Client = new S3Client({ region });

const worker = createRecordsExportWorker({
  environment,
  resourcesByBot,
  documentClient,
  publishCsv: async ({ bucket, key, contentType, body }) => {
    return uploadRecordsCsv({
      client: s3Client,
      bucket,
      key,
      contentType,
      body,
    });
  },
});

export const handler = async (event: WorkerEvent, context: WorkerContext) => {
  return worker.run(
    event,
    context.getRemainingTimeInMillis
      ? { remainingTimeMs: () => context.getRemainingTimeInMillis?.() ?? 0 }
      : undefined,
  );
};
