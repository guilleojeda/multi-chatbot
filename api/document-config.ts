export type DocumentBotResources = {
  botId: string;
  documentTableName: string;
  uploadBucketName: string;
  documentBucketName: string;
  incomingPrefix: string;
  preparedPrefix: string;
  knowledgeBaseId: string;
  dataSourceId: string;
};

export type DocumentAdminBotResources = DocumentBotResources & {
  stateMachineArn: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.trim() === value;
}

function validPrefix(value: unknown, expected: "incoming/" | "prepared/"): value is string {
  return (
    requiredString(value) &&
    value.startsWith(expected) &&
    value.endsWith("/") &&
    !value.split("/").some((segment) => segment === "." || segment === "..") &&
    !/[\\\u0000-\u001f\u007f]/.test(value)
  );
}

function parseCatalog(value: unknown, requireExecution: boolean): DocumentBotResources[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("BOT_CATALOG must contain at least one chatbot.");
  }

  const botIds = new Set<string>();
  const documentTables = new Set<string>();
  const uploadBuckets = new Set<string>();
  const documentBuckets = new Set<string>();
  const resources: DocumentBotResources[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.botId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.botId) ||
      !requiredString(entry.documentTableName) ||
      !requiredString(entry.uploadBucketName) ||
      !requiredString(entry.documentBucketName) ||
      !validPrefix(entry.incomingPrefix, "incoming/") ||
      !validPrefix(entry.preparedPrefix, "prepared/") ||
      !requiredString(entry.knowledgeBaseId) ||
      !requiredString(entry.dataSourceId) ||
      (requireExecution &&
        (typeof entry.stateMachineArn !== "string" ||
          !/^arn:[^:]+:states:[^:]+:[0-9]{12}:stateMachine:[A-Za-z0-9_-]+$/.test(
            entry.stateMachineArn,
          )))
    ) {
      throw new Error("BOT_CATALOG contains invalid document resources.");
    }
    if (
      botIds.has(entry.botId) ||
      documentTables.has(entry.documentTableName) ||
      uploadBuckets.has(entry.uploadBucketName) ||
      documentBuckets.has(entry.documentBucketName)
    ) {
      throw new Error("BOT_CATALOG document resource IDs and names must be unique.");
    }
    botIds.add(entry.botId);
    documentTables.add(entry.documentTableName);
    uploadBuckets.add(entry.uploadBucketName);
    documentBuckets.add(entry.documentBucketName);
    resources.push({
      botId: entry.botId,
      documentTableName: entry.documentTableName,
      uploadBucketName: entry.uploadBucketName,
      documentBucketName: entry.documentBucketName,
      incomingPrefix: entry.incomingPrefix,
      preparedPrefix: entry.preparedPrefix,
      knowledgeBaseId: entry.knowledgeBaseId,
      dataSourceId: entry.dataSourceId,
      ...(requireExecution ? { stateMachineArn: entry.stateMachineArn as string } : {}),
    });
  }
  return resources;
}

export function parseDocumentResources(value: unknown): DocumentBotResources[] {
  return parseCatalog(value, false);
}

export function parseDocumentAdminResources(value: unknown): DocumentAdminBotResources[] {
  return parseCatalog(value, true) as DocumentAdminBotResources[];
}
