import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHistoryLabel, createHistoryOrder } from "../runtime/history-projection.ts";
import { pathToFileURL } from "node:url";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value) {
  return (
    typeof value === "string" && timestampPattern.test(value) && Number.isFinite(Date.parse(value))
  );
}

function normalizedTimestamp(value) {
  return validTimestamp(value) ? new Date(Date.parse(value)).toISOString() : undefined;
}

function latestTimestamp(values) {
  return values
    .map(normalizedTimestamp)
    .filter((value) => value !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1);
}

function validMeta(item, botId) {
  return (
    isRecord(item) &&
    item.sk === "META" &&
    typeof item.pk === "string" &&
    item.pk === "CONV#" + item.conversationId &&
    typeof item.conversationId === "string" &&
    uuidPattern.test(item.conversationId) &&
    typeof item.sub === "string" &&
    item.sub.trim().length > 0 &&
    item.botId === botId &&
    Number.isSafeInteger(item.lastOrdinal) &&
    item.lastOrdinal > 0 &&
    (item.lastQueryId === undefined || typeof item.lastQueryId === "string") &&
    (item.activeQueryId === undefined || typeof item.activeQueryId === "string")
  );
}

function validTurn(item, meta, ordinal = 1) {
  const key = "TURN#" + String(ordinal).padStart(8, "0");
  const legacyGenerating =
    item?.status === "in_progress" &&
    item.phase === "generating" &&
    isRecord(item.questionManifest) &&
    Number.isSafeInteger(item.questionManifest.count) &&
    item.questionManifest.count > 0 &&
    item.questionManifest.complete === true &&
    isRecord(item.answerManifest) &&
    item.answerManifest.count === 0 &&
    item.answerManifest.complete === false &&
    (item.cursor === undefined || item.cursor === 0);
  return (
    isRecord(item) &&
    item.pk === meta.pk &&
    item.sk === key &&
    item.conversationId === meta.conversationId &&
    item.sub === meta.sub &&
    item.botId === meta.botId &&
    item.ordinal === ordinal &&
    typeof item.queryId === "string" &&
    uuidPattern.test(item.queryId) &&
    ["in_progress", "completed", "failed"].includes(String(item.status)) &&
    (item.phase === undefined ||
      (item.status === "in_progress"
        ? ["admitted", "invocation_claimed"].includes(String(item.phase)) || legacyGenerating
        : item.status === "completed"
          ? item.phase === "complete"
          : item.phase === "failed")) &&
    isRecord(item.questionManifest) &&
    Number.isSafeInteger(item.questionManifest.count) &&
    item.questionManifest.count > 0 &&
    item.questionManifest.complete === true &&
    isRecord(item.answerManifest) &&
    Number.isSafeInteger(item.answerManifest.count) &&
    item.answerManifest.count >= 0 &&
    typeof item.answerManifest.complete === "boolean" &&
    (item.cursor === undefined ||
      (Number.isSafeInteger(item.cursor) &&
        item.cursor >= 0 &&
        item.cursor === item.answerManifest.count)) &&
    (item.status !== "completed" || item.answerManifest.count > 0) &&
    (item.status !== "in_progress" || item.answerManifest.complete === false) &&
    (item.status !== "completed" || item.answerManifest.complete === true) &&
    (item.status !== "failed" || item.answerManifest.complete === false)
  );
}

function isConditionalFailure(error) {
  return (
    isRecord(error) &&
    (error.name === "ConditionalCheckFailedException" ||
      (error.name === "TransactionCanceledException" &&
        Array.isArray(error.CancellationReasons) &&
        error.CancellationReasons.some(
          (reason) => isRecord(reason) && reason.Code === "ConditionalCheckFailed",
        )))
  );
}

function validateOptions(input) {
  if (
    !input ||
    typeof input.documentClient?.send !== "function" ||
    typeof input.tableName !== "string" ||
    input.tableName.length === 0 ||
    typeof input.botId !== "string" ||
    input.botId.length === 0
  ) {
    throw new TypeError("History backfill configuration is invalid.");
  }
  const pageSize = input.pageSize ?? 50;
  const maxPages = input.maxPages ?? Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new RangeError("History backfill page size must be between 1 and 1000.");
  }
  if (!(
    maxPages === Number.POSITIVE_INFINITY ||
    (Number.isSafeInteger(maxPages) && maxPages > 0)
  )) {
    throw new RangeError("History backfill maxPages must be a positive integer.");
  }
  if (
    input.startKey !== undefined &&
    (!isRecord(input.startKey) ||
      typeof input.startKey.pk !== "string" ||
      typeof input.startKey.sk !== "string")
  ) {
    throw new TypeError("History backfill checkpoint is invalid.");
  }
  return { pageSize, maxPages };
}

async function readFirstQuestion(documentClient, tableName, meta, pageSize) {
  const turnResult = await documentClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: meta.pk, sk: "TURN#00000001" },
      ConsistentRead: true,
    }),
  );
  const turn = turnResult.Item;
  if (!validTurn(turn, meta)) return null;
  const turnPrefix = "TURN#00000001";
  const prefix = turnPrefix + "#" + turn.queryId + "#USER#";
  const chunks = [];
  let startKey;
  let pages = 0;
  let previousPageKey;
  const maxPages = turn.questionManifest.count + 1;
  do {
    const page = await documentClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":pk": meta.pk, ":prefix": prefix },
        ConsistentRead: true,
        ScanIndexForward: true,
        Limit: pageSize,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    pages += 1;
    if (!Array.isArray(page.Items)) return null;
    for (const item of page.Items) {
      if (!isRecord(item)) return null;
      if (
        item.pk !== meta.pk ||
        item.conversationId !== meta.conversationId ||
        item.queryId !== turn.queryId ||
        (item.ordinal !== undefined && item.ordinal !== 1) ||
        item.role !== "user" ||
        !Number.isSafeInteger(item.index) ||
        item.index < 0 ||
        typeof item.sk !== "string" ||
        item.sk !== prefix + String(item.index).padStart(8, "0") ||
        typeof item.text !== "string"
      ) {
        return null;
      }
      chunks.push(item);
      if (chunks.length > turn.questionManifest.count) return null;
    }
    startKey = page.LastEvaluatedKey;
    if (startKey) {
      if (
        !isRecord(startKey) ||
        startKey.pk !== meta.pk ||
        typeof startKey.sk !== "string" ||
        !startKey.sk.startsWith(prefix) ||
        page.Items.length === 0 ||
        (previousPageKey !== undefined && startKey.sk <= previousPageKey)
      ) {
        return null;
      }
      previousPageKey = startKey.sk;
      if (pages >= maxPages) return null;
    }
  } while (startKey);

  chunks.sort((left, right) => left.index - right.index);
  if (chunks.length !== turn.questionManifest.count) return null;
  for (let index = 0; index < chunks.length; index += 1) {
    if (chunks[index].index !== index) return null;
  }
  const question = chunks.map(({ text }) => text).join("");
  if (!question.trim()) return null;
  return { question, firstTurn: turn };
}

async function readLatestTurn(documentClient, tableName, meta) {
  const response = await documentClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: meta.pk, sk: "TURN#" + String(meta.lastOrdinal).padStart(8, "0") },
      ConsistentRead: true,
    }),
  );
  const turn = response.Item;
  if (!validTurn(turn, meta, meta.lastOrdinal)) return null;
  const admittedAt = turn.createdAt;
  if (turn.status === "completed") {
    return { activityAt: latestTimestamp([admittedAt, turn.completedAt, turn.updatedAt]) };
  }
  if (turn.status === "failed") {
    return { activityAt: latestTimestamp([admittedAt, turn.failedAt, turn.updatedAt]) };
  }
  // An active writer updates TURN while streaming. That is not conversation activity.
  return { activityAt: normalizedTimestamp(admittedAt) };
}

async function projectionFor(documentClient, tableName, botId, meta, pageSize) {
  if (!validMeta(meta, botId)) return null;
  const original = await readFirstQuestion(documentClient, tableName, meta, pageSize);
  if (!original) return null;
  const latestTurn = await readLatestTurn(documentClient, tableName, meta);
  if (!latestTurn) return null;
  const activityAt = latestTimestamp([
    meta.updatedAt,
    latestTurn.activityAt,
    meta.createdAt,
    original.firstTurn.createdAt,
  ]);
  return {
    historyOwner: "USER#" + meta.sub + "#BOT#" + meta.botId,
    historyOrder: createHistoryOrder(activityAt, meta.conversationId),
    historyLabel: createHistoryLabel(original.question),
  };
}

function projectionMatches(meta, projection) {
  return (
    meta.historyOwner === projection.historyOwner &&
    meta.historyOrder === projection.historyOrder &&
    meta.historyLabel === projection.historyLabel
  );
}

function updateExpressionFor(meta, projection, tableName) {
  const names = {
    "#historyOwner": "historyOwner",
    "#historyOrder": "historyOrder",
    "#historyLabel": "historyLabel",
    "#sub": "sub",
    "#botId": "botId",
    "#conversationId": "conversationId",
    "#lastOrdinal": "lastOrdinal",
    "#updatedAt": "updatedAt",
    "#createdAt": "createdAt",
    "#lastQueryId": "lastQueryId",
    "#activeQueryId": "activeQueryId",
  };
  const values = {
    ":historyOwner": projection.historyOwner,
    ":historyOrder": projection.historyOrder,
    ":historyLabel": projection.historyLabel,
    ":sub": meta.sub,
    ":botId": meta.botId,
    ":conversationId": meta.conversationId,
    ":lastOrdinal": meta.lastOrdinal,
  };
  const conditions = [
    "#sub = :sub",
    "#botId = :botId",
    "#conversationId = :conversationId",
    "#lastOrdinal = :lastOrdinal",
  ];
  for (const [attribute, alias] of [
    ["updatedAt", "#updatedAt"],
    ["createdAt", "#createdAt"],
    ["lastQueryId", "#lastQueryId"],
    ["activeQueryId", "#activeQueryId"],
  ]) {
    if (Object.hasOwn(meta, attribute)) {
      conditions.push(alias + " = :" + attribute);
      values[":" + attribute] = meta[attribute];
    } else {
      conditions.push("attribute_not_exists(" + alias + ")");
    }
  }
  return {
    TableName: tableName,
    Key: { pk: meta.pk, sk: "META" },
    UpdateExpression:
      "SET #historyOwner = :historyOwner, #historyOrder = :historyOrder, #historyLabel = :historyLabel",
    ConditionExpression: conditions.join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

async function migrateMeta(input, initialMeta, pageSize) {
  let meta = initialMeta;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!validMeta(meta, input.botId)) return "incompatible";
    const projection = await projectionFor(
      input.documentClient,
      input.tableName,
      input.botId,
      meta,
      pageSize,
    );
    if (!projection) return "incompatible";
    if (projectionMatches(meta, projection)) return "skipped";
    try {
      await input.documentClient.send(
        new UpdateCommand(updateExpressionFor(meta, projection, input.tableName)),
      );
      return "updated";
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const reread = await input.documentClient.send(
        new GetCommand({
          TableName: input.tableName,
          Key: { pk: meta.pk, sk: "META" },
          ConsistentRead: true,
        }),
      );
      if (!reread.Item) return "incompatible";
      if (validMeta(reread.Item, input.botId) && projectionMatches(reread.Item, projection)) {
        return "skipped";
      }
      meta = reread.Item;
    }
  }
  const conflict = new Error("History backfill could not stabilize conversation activity.");
  conflict.name = "ConditionalCheckFailedException";
  throw conflict;
}

export async function backfillChatHistory(input) {
  const { pageSize, maxPages } = validateOptions(input);
  const result = {
    scanned: 0,
    updated: 0,
    skipped: 0,
    incompatible: 0,
    pages: 0,
    nextKey: undefined,
  };
  let startKey = input.startKey;
  let checkpoint = input.startKey;
  while (result.pages < maxPages) {
    let page;
    try {
      page = await input.documentClient.send(
        new ScanCommand({
          TableName: input.tableName,
          FilterExpression: "#sk = :meta",
          ExpressionAttributeNames: { "#sk": "sk" },
          ExpressionAttributeValues: { ":meta": "META" },
          Limit: pageSize,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof Error) error.checkpoint = checkpoint;
      else {
        const wrapped = new Error("History backfill scan failed.");
        wrapped.cause = error;
        wrapped.checkpoint = checkpoint;
        throw wrapped;
      }
      throw error;
    }
    result.pages += 1;
    if (!Array.isArray(page.Items)) {
      const invalid = new Error("History backfill scan returned an invalid page.");
      invalid.checkpoint = checkpoint;
      throw invalid;
    }
    try {
      for (const meta of page.Items) {
        if (!isRecord(meta) || meta.sk !== "META") continue;
        result.scanned += 1;
        if (meta.botId !== input.botId) {
          result.skipped += 1;
          continue;
        }
        const outcome = await migrateMeta(input, meta, pageSize);
        result[outcome] += 1;
      }
    } catch (error) {
      if (error instanceof Error) error.checkpoint = checkpoint;
      throw error;
    }
    checkpoint = page.LastEvaluatedKey;
    startKey = page.LastEvaluatedKey;
    result.nextKey = page.LastEvaluatedKey;
    if (!startKey) break;
  }
  return result;
}

async function runCli() {
  const tableName = process.env.CHAT_HISTORY_TABLE;
  const botId = process.env.CHAT_HISTORY_BOT_ID;
  if (!tableName || !botId) throw new Error("Set CHAT_HISTORY_TABLE and CHAT_HISTORY_BOT_ID.");
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  try {
    const result = await backfillChatHistory({ documentClient, tableName, botId });
    console.log(JSON.stringify(result));
  } finally {
    documentClient.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
