import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactGetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const adapterPath = path.join(projectRoot, "runtime/conversation-store.ts");
const tableName = "conversations-aurora-dev";
const owner = { sub: "teacher-123", botId: "bot-aurora" };
const otherOwner = { sub: "teacher-456", botId: "bot-aurora" };
const conversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const queryId = "a4bfbc9f-3699-4e93-b120-a03c0204bc67";
const profileSnapshot = {
  sub: owner.sub,
  botId: owner.botId,
  fields: { educationLevels: [{ id: "secundario", label: "Secundario" }] },
  responsePreferenceIds: ["ready-material"],
  promptTexts: ["Incluí materiales completos y listos para usar."],
  configurationRevision: "profile-r7",
};

let createConversationStoreAdapter;

function makeStore(
  send = vi.fn(async () => ({})),
  now = () => Date.parse("2026-10-22T02:30:00.000Z"),
) {
  const documentClient = { send };
  const store =
    typeof createConversationStoreAdapter === "function"
      ? createConversationStoreAdapter({ documentClient, tableName, now })
      : null;
  return { documentClient, store };
}

function requireMethod(store, methodName) {
  const method = store?.[methodName];
  expect(
    typeof method,
    "producto ausente: expected runtime/conversation-store.ts#createConversationStoreAdapter#" +
      methodName,
  ).toBe("function");
  return method.bind(store);
}

function keyId(key) {
  return String(key?.pk) + "\u0000" + String(key?.sk);
}

function quotaKeys(sub = owner.sub, botId = owner.botId) {
  return {
    policy: { pk: "BOT#" + botId, sk: "QUOTA#POLICY" },
    usage: { pk: "USER#" + sub + "#BOT#" + botId },
  };
}

function quotaRecords({
  sub = owner.sub,
  botId = owner.botId,
  day = "2026-10-21",
  month = "2026-10",
  dailyUsed = 0,
  monthlyUsed = 0,
  dailyLimit = 20,
  monthlyLimit = 200,
  revision = "policy-r7",
} = {}) {
  const keys = quotaKeys(sub, botId);
  return new Map([
    [
      keyId(keys.policy),
      {
        ...keys.policy,
        dailyLimit,
        monthlyLimit,
        revision,
      },
    ],
    [
      keyId({ ...keys.usage, sk: "USAGE#DAY#" + day }),
      { ...keys.usage, sk: "USAGE#DAY#" + day, used: dailyUsed },
    ],
    [
      keyId({ ...keys.usage, sk: "USAGE#MONTH#" + month }),
      { ...keys.usage, sk: "USAGE#MONTH#" + month, used: monthlyUsed },
    ],
  ]);
}

function quotaFor(now, overrides = {}) {
  const serverNow = typeof now === "number" ? now : Date.parse(now);
  return {
    daily: {
      used: 4,
      limit: 20,
      resetAt: Date.parse("2026-10-22T03:00:00.000Z"),
      period: "2026-10-21",
      ...overrides.daily,
    },
    monthly: {
      used: 37,
      limit: 200,
      resetAt: Date.parse("2026-11-01T03:00:00.000Z"),
      period: "2026-10",
      ...overrides.monthly,
    },
    serverNow,
    blockedUntil: null,
    policyRevision: "policy-r7",
    ...overrides,
  };
}

function admissionInput(overrides = {}) {
  const now = Date.parse("2026-10-22T02:30:00.000Z");
  return {
    ...owner,
    conversationId,
    queryId,
    operation: "start",
    baseOrdinal: 0,
    now,
    ownerAttemptId: "attempt-admitted",
    resultDeadlineAt: now + 60 * 60 * 1000,
    text: "Armá una actividad de porcentajes.",
    profileSnapshot,
    contextSnapshot: { version: 1, recentReferences: [] },
    documentContext: {
      knowledgeBaseId: "kb-aurora-dev",
      query: "porcentajes para secundaria",
      revision: "documents-r7",
      retrievedAt: now,
      status: "empty",
      results: [],
    },
    invocation: {
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "profile-r7",
    },
    quota: quotaFor(now),
    requestFingerprint: "sha256:stable-request-fingerprint",
    ...overrides,
  };
}

function commandWrites(command) {
  if (command instanceof TransactWriteCommand) return [];
  return [command].filter(
    (candidate) =>
      candidate instanceof PutCommand ||
      candidate instanceof UpdateCommand ||
      candidate instanceof DeleteCommand,
  );
}

function mutationCommands(documentClient) {
  return documentClient.send.mock.calls
    .map(([command]) => command)
    .filter(
      (command) =>
        command instanceof TransactWriteCommand ||
        command instanceof PutCommand ||
        command instanceof UpdateCommand ||
        command instanceof DeleteCommand,
    );
}

function transactionCommands(documentClient) {
  return documentClient.send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof TransactWriteCommand);
}

function transactionActions(command) {
  return command.input.TransactItems;
}

function actionPayload(action) {
  return action.Put ?? action.Update ?? action.Delete ?? action.ConditionCheck ?? null;
}

function transactionItems(command) {
  return transactionActions(command).flatMap((action) =>
    action.Put?.Item ? [action.Put.Item] : [],
  );
}

function expressionText(payload) {
  return [payload?.ConditionExpression, payload?.UpdateExpression, payload?.FilterExpression]
    .filter(Boolean)
    .join(" ");
}

function expressionNames(payload) {
  return Object.values(payload?.ExpressionAttributeNames ?? {});
}

function conditionBoundValues(payload) {
  const expression = payload?.ConditionExpression ?? "";
  const tokens = expression.match(/:[A-Za-z0-9_]+/g) ?? [];
  return [...new Set(tokens.map((token) => payload.ExpressionAttributeValues?.[token]))];
}

function conditionNameText(payload) {
  return [payload?.ConditionExpression ?? "", ...expressionNames(payload)].join(" ");
}

function conditionIncludesInstant(payload, instant) {
  return conditionBoundValues(payload).some(
    (value) =>
      value === instant ||
      (typeof value === "string" &&
        Number.isFinite(Date.parse(value)) &&
        Date.parse(value) === instant),
  );
}

function hasValue(value, expected) {
  if (Object.is(value, expected)) return true;
  if (Array.isArray(value)) return value.some((entry) => hasValue(entry, expected));
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => hasValue(entry, expected));
  }
  return false;
}

function recordForRead(command, records) {
  if (command instanceof GetCommand) {
    return { Item: records.get(keyId(command.input.Key)) };
  }
  if (command instanceof TransactGetCommand) {
    return {
      Responses: command.input.TransactItems.map(({ Get }) => ({
        Item: records.get(keyId(Get.Key)),
      })),
    };
  }
  if (command instanceof BatchGetCommand) {
    const request = command.input.RequestItems[tableName];
    return {
      Responses: {
        [tableName]: request.Keys.map((Key) => records.get(keyId(Key))).filter(Boolean),
      },
    };
  }
  if (command instanceof QueryCommand) {
    const names = command.input.ExpressionAttributeNames ?? {};
    const values = command.input.ExpressionAttributeValues ?? {};
    const expression = command.input.KeyConditionExpression ?? "";
    const partitionMatch = expression.match(/([#A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)/);
    const prefixMatch = expression.match(
      /begins_with\(\s*([#A-Za-z0-9_]+)\s*,\s*(:[A-Za-z0-9_]+)\s*\)/i,
    );
    const partitionAttribute = names[partitionMatch?.[1]] ?? partitionMatch?.[1];
    const sortAttribute = names[prefixMatch?.[1]] ?? prefixMatch?.[1];
    const partition = values[partitionMatch?.[2]];
    const prefix = values[prefixMatch?.[2]];
    const items = [...records.values()].filter((item) => {
      if (partitionAttribute && item[partitionAttribute] !== partition) return false;
      return !sortAttribute || String(item[sortAttribute] ?? "").startsWith(prefix ?? "");
    });
    return { Items: items };
  }
  return {};
}

function strongReadKeys(documentClient) {
  return documentClient.send.mock.calls.flatMap(([command]) => {
    if (command instanceof GetCommand) {
      return command.input.ConsistentRead === true ? [command.input.Key] : [];
    }
    if (command instanceof TransactGetCommand) {
      return command.input.TransactItems.map(({ Get }) => Get.Key);
    }
    if (command instanceof BatchGetCommand) {
      const request = command.input.RequestItems[tableName];
      return request?.ConsistentRead === true ? request.Keys : [];
    }
    if (command instanceof QueryCommand && command.input.ConsistentRead === true) {
      return [command.input.KeyConditionExpression];
    }
    return [];
  });
}

function mapReadRecords(records) {
  return vi.fn(async (command) => recordForRead(command, records));
}

function conditionalFailure() {
  return Object.assign(new Error("conditional write failed"), {
    name: "ConditionalCheckFailedException",
  });
}

function turnRecord(overrides = {}) {
  return {
    ...owner,
    pk: "CONV#" + conversationId,
    sk: "TURN#00000002",
    conversationId,
    queryId,
    ordinal: 2,
    status: "in_progress",
    phase: "admitted",
    ownerAttemptId: "attempt-a",
    resultDeadlineAt: Date.parse("2026-10-22T03:00:00.000Z"),
    cursor: 0,
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: 0, complete: false },
    contextManifest: { count: 0, complete: true },
    contextSnapshot: { version: 1, recentReferences: [] },
    documentContextManifest: { count: 1, complete: true },
    profileSnapshot,
    invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "profile-r7" },
    operation: "message",
    baseOrdinal: 1,
    requestFingerprint: "sha256:stable-request-fingerprint",
    ...overrides,
  };
}

function metaRecord(overrides = {}) {
  return {
    pk: "CONV#" + conversationId,
    sk: "META",
    conversationId,
    ...owner,
    lastOrdinal: 2,
    activeQueryId: queryId,
    activeOwnerAttemptId: "attempt-a",
    ...overrides,
  };
}

function submissionRecord(overrides = {}) {
  return {
    pk: "USER#" + owner.sub + "#BOT#" + owner.botId,
    sk: "SEND#" + queryId,
    ...owner,
    queryId,
    requestFingerprint: "sha256:stable-request-fingerprint",
    operation: "message",
    baseOrdinal: 1,
    conversationId,
    ordinal: 2,
    admittedAt: Date.parse("2026-10-22T02:30:00.000Z"),
    resultDeadlineAt: Date.parse("2026-10-22T03:30:00.000Z"),
    ...overrides,
  };
}

function submissionChunk(ordinal, requestId, role, index, text) {
  return {
    pk: "CONV#" + conversationId,
    sk:
      "TURN#" +
      String(ordinal).padStart(8, "0") +
      "#" +
      requestId +
      "#" +
      role.toUpperCase() +
      "#" +
      String(index).padStart(8, "0"),
    conversationId,
    queryId: requestId,
    ordinal,
    role,
    index,
    text,
  };
}

function lifecycleRecords(turnOverrides = {}, metaOverrides = {}) {
  const submission = submissionRecord({
    resultDeadlineAt: turnOverrides.resultDeadlineAt ?? submissionRecord().resultDeadlineAt,
  });
  const turn = turnRecord({
    conversationId: submission.conversationId,
    queryId: submission.queryId,
    ordinal: submission.ordinal,
    resultDeadlineAt: submission.resultDeadlineAt,
    ...turnOverrides,
  });
  const meta = metaRecord(metaOverrides);
  const question = submissionChunk(turn.ordinal, turn.queryId, "user", 0, "Pregunta fixture.");
  const document = documentChunk(turn.ordinal, turn.queryId);
  return new Map([
    [keyId({ pk: submission.pk, sk: submission.sk }), submission],
    [keyId({ pk: turn.pk, sk: turn.sk }), turn],
    [keyId({ pk: meta.pk, sk: meta.sk }), meta],
    [keyId({ pk: question.pk, sk: question.sk }), question],
    [keyId({ pk: document.pk, sk: document.sk }), document],
  ]);
}

function documentChunk(ordinal, requestId) {
  return {
    ...submissionChunk(ordinal, requestId, "document", 0, ""),
    sk: "TURN#" + String(ordinal).padStart(8, "0") + "#DOCUMENT#00000000",
    text: JSON.stringify(admissionInput().documentContext),
  };
}

describe("the DynamoDB usage and submission store adapter", () => {
  beforeAll(async () => {
    if (!existsSync(adapterPath)) return;
    const module = await import(pathToFileURL(adapterPath).href);
    createConversationStoreAdapter = module.createConversationStoreAdapter;
  });

  beforeEach(() => {
    expect(
      typeof createConversationStoreAdapter,
      "producto ausente: expected runtime/conversation-store.ts#createConversationStoreAdapter",
    ).toBe("function");
  });

  it("reads the configured 20/200 limits and both scoped usage records strongly", async () => {
    const records = quotaRecords({ dailyUsed: 7, monthlyUsed: 61 });
    const send = mapReadRecords(records);
    const { documentClient, store } = makeStore(send);
    const readQuota = requireMethod(store, "readQuota");
    const now = Date.parse("2026-10-22T02:30:00.000Z");

    await expect(readQuota({ ...owner, now })).resolves.toMatchObject({
      daily: { used: 7, limit: 20, period: "2026-10-21" },
      monthly: { used: 61, limit: 200, period: "2026-10" },
      serverNow: now,
      blockedUntil: null,
      policyRevision: "policy-r7",
    });

    const reads = strongReadKeys(documentClient);
    expect(reads).toEqual(
      expect.arrayContaining([
        { pk: "BOT#" + owner.botId, sk: "QUOTA#POLICY" },
        {
          pk: "USER#" + owner.sub + "#BOT#" + owner.botId,
          sk: "USAGE#DAY#2026-10-21",
        },
        {
          pk: "USER#" + owner.sub + "#BOT#" + owner.botId,
          sk: "USAGE#MONTH#2026-10",
        },
      ]),
    );
    expect(reads).toHaveLength(3);
  });

  it.each([
    ["missing policy", (records) => records.delete(keyId(quotaKeys().policy))],
    [
      "invalid policy",
      (records) =>
        records.set(keyId(quotaKeys().policy), {
          ...quotaKeys().policy,
          dailyLimit: -1,
          monthlyLimit: 200,
          revision: "policy-invalid",
        }),
    ],
  ])("fails closed for %s", async (_label, changePolicy) => {
    const records = quotaRecords();
    changePolicy(records);
    const { documentClient, store } = makeStore(mapReadRecords(records));
    const readQuota = requireMethod(store, "readQuota");

    await expect(
      readQuota({ ...owner, now: Date.parse("2026-10-22T02:30:00.000Z") }),
    ).rejects.toBeInstanceOf(Error);

    expect(mutationCommands(documentClient)).toEqual([]);
  });

  it("changes the daily period at Córdoba midnight, not UTC midnight", async () => {
    const records = quotaRecords({
      day: "2026-10-21",
      month: "2026-10",
      dailyUsed: 11,
      monthlyUsed: 18,
    });
    records.set(
      keyId({
        pk: "USER#" + owner.sub + "#BOT#" + owner.botId,
        sk: "USAGE#DAY#2026-10-22",
      }),
      {
        pk: "USER#" + owner.sub + "#BOT#" + owner.botId,
        sk: "USAGE#DAY#2026-10-22",
        used: 2,
      },
    );
    const { store } = makeStore(mapReadRecords(records));
    const readQuota = requireMethod(store, "readQuota");

    const beforeMidnight = await readQuota({
      ...owner,
      now: Date.parse("2026-10-22T02:59:59.000Z"),
    });
    const atMidnight = await readQuota({
      ...owner,
      now: Date.parse("2026-10-22T03:00:00.000Z"),
    });

    expect(beforeMidnight.daily).toMatchObject({
      period: "2026-10-21",
      used: 11,
      resetAt: Date.parse("2026-10-22T03:00:00.000Z"),
    });
    expect(atMidnight.daily).toMatchObject({
      period: "2026-10-22",
      used: 2,
      resetAt: Date.parse("2026-10-23T03:00:00.000Z"),
    });
  });

  it("uses the Córdoba month boundary and leap day calendar date", async () => {
    const records = quotaRecords({
      day: "2024-02-29",
      month: "2024-02",
      dailyUsed: 20,
      monthlyUsed: 200,
    });
    const marchRecords = quotaRecords({
      day: "2024-03-01",
      month: "2024-03",
      dailyUsed: 0,
      monthlyUsed: 0,
    });
    for (const [key, value] of marchRecords) records.set(key, value);
    const { store } = makeStore(mapReadRecords(records));
    const readQuota = requireMethod(store, "readQuota");

    const beforeBoundary = await readQuota({
      ...owner,
      now: Date.parse("2024-03-01T02:59:59.000Z"),
    });
    const afterBoundary = await readQuota({
      ...owner,
      now: Date.parse("2024-03-01T03:00:00.000Z"),
    });

    expect(beforeBoundary.daily).toMatchObject({
      period: "2024-02-29",
      resetAt: Date.parse("2024-03-01T03:00:00.000Z"),
    });
    expect(beforeBoundary.monthly).toMatchObject({
      period: "2024-02",
      resetAt: Date.parse("2024-03-01T03:00:00.000Z"),
    });
    expect(afterBoundary.daily.period).toBe("2024-03-01");
    expect(afterBoundary.monthly).toMatchObject({
      period: "2024-03",
      resetAt: Date.parse("2024-04-01T03:00:00.000Z"),
    });
  });

  it("blocks until the later reset when both daily and monthly quotas are exhausted", async () => {
    const records = quotaRecords({
      dailyUsed: 20,
      monthlyUsed: 200,
      day: "2026-10-21",
      month: "2026-10",
    });
    const { store } = makeStore(mapReadRecords(records));
    const readQuota = requireMethod(store, "readQuota");
    const now = Date.parse("2026-10-22T02:30:00.000Z");

    await expect(readQuota({ ...owner, now })).resolves.toMatchObject({
      daily: { used: 20, limit: 20, resetAt: Date.parse("2026-10-22T03:00:00.000Z") },
      monthly: { used: 200, limit: 200, resetAt: Date.parse("2026-11-01T03:00:00.000Z") },
      blockedUntil: Date.parse("2026-11-01T03:00:00.000Z"),
    });
  });

  it("keeps usage isolated by person and chatbot", async () => {
    const otherBot = { sub: owner.sub, botId: "bot-brisa" };
    const records = new Map([
      ...quotaRecords({ dailyUsed: 3, monthlyUsed: 30 }),
      ...quotaRecords({ ...otherOwner, dailyUsed: 8, monthlyUsed: 80 }),
      ...quotaRecords({ ...otherBot, dailyUsed: 14, monthlyUsed: 140 }),
    ]);
    const { documentClient, store } = makeStore(mapReadRecords(records));
    const readQuota = requireMethod(store, "readQuota");
    const now = Date.parse("2026-10-22T02:30:00.000Z");

    const first = await readQuota({ ...owner, now });
    const second = await readQuota({ ...otherOwner, now });
    const third = await readQuota({ ...otherBot, now });

    expect([first.daily.used, second.daily.used, third.daily.used]).toEqual([3, 8, 14]);
    expect([first.monthly.used, second.monthly.used, third.monthly.used]).toEqual([30, 80, 140]);
    const reads = strongReadKeys(documentClient);
    expect(reads).toContainEqual({
      pk: "USER#" + otherOwner.sub + "#BOT#" + otherOwner.botId,
      sk: "USAGE#DAY#2026-10-21",
    });
    expect(reads).toContainEqual({
      pk: "USER#" + otherBot.sub + "#BOT#" + otherBot.botId,
      sk: "USAGE#MONTH#2026-10",
    });
  });

  it("applies changed limits to existing usage without resetting consumption", async () => {
    const records = quotaRecords({
      dailyUsed: 15,
      monthlyUsed: 51,
      dailyLimit: 20,
      monthlyLimit: 200,
      revision: "policy-r7",
    });
    const { store } = makeStore(mapReadRecords(records));
    const readQuota = requireMethod(store, "readQuota");
    const now = Date.parse("2026-10-22T02:30:00.000Z");

    const initial = await readQuota({ ...owner, now });
    records.set(keyId(quotaKeys().policy), {
      ...quotaKeys().policy,
      dailyLimit: 10,
      monthlyLimit: 40,
      revision: "policy-r8",
    });
    const reduced = await readQuota({ ...owner, now });
    records.set(keyId(quotaKeys().policy), {
      ...quotaKeys().policy,
      dailyLimit: 25,
      monthlyLimit: 100,
      revision: "policy-r9",
    });
    const increased = await readQuota({ ...owner, now });

    expect(initial).toMatchObject({
      daily: { used: 15, limit: 20 },
      monthly: { used: 51, limit: 200 },
    });
    expect(reduced).toMatchObject({
      daily: { used: 15, limit: 10 },
      monthly: { used: 51, limit: 40 },
      policyRevision: "policy-r8",
      blockedUntil: Date.parse("2026-11-01T03:00:00.000Z"),
    });
    expect(increased).toMatchObject({
      daily: { used: 15, limit: 25 },
      monthly: { used: 51, limit: 100 },
      policyRevision: "policy-r9",
      blockedUntil: null,
    });
  });

  it("stores a stable start submission and quota snapshot in the admission transaction", async () => {
    const { documentClient, store } = makeStore();
    const startTurn = requireMethod(store, "startTurn");
    const input = admissionInput();

    await startTurn(input);

    const transactions = transactionCommands(documentClient);
    expect(transactions).toHaveLength(1);
    const transaction = transactions[0];
    const items = transactionItems(transaction);
    const marker = items.find((item) => item.sk === "SEND#" + queryId);
    expect(marker).toBeTruthy();
    expect(marker).toMatchObject({
      sub: owner.sub,
      botId: owner.botId,
      queryId,
      requestFingerprint: input.requestFingerprint,
    });
    expect(JSON.stringify(transaction.input)).toContain(input.quota.policyRevision);
    expect(commandWrites(documentClient.send.mock.calls.at(-1)[0])).toHaveLength(0);
  });

  it("commits a multi-chunk question, references, profile, marker and both counters in one transaction", async () => {
    const largeQuestion = "á".repeat(220_000);
    const references = [
      { ordinal: 1, queryId: "11dd5a71-b6db-4ad9-a2c3-934cb56fe749" },
      { ordinal: 2, queryId: "22dd5a71-b6db-4ad9-a2c3-934cb56fe749" },
    ];
    const input = admissionInput({
      queryId: "fcdd5a71-b6db-4ad9-a2c3-934cb56fe749",
      text: largeQuestion,
      contextReferences: references,
      contextSnapshot: { version: 1, recentReferences: references },
      operation: "message",
      baseOrdinal: 4,
    });
    const { documentClient, store } = makeStore();
    const continueTurn = requireMethod(store, "continueTurn");

    await continueTurn(input);

    const transactions = transactionCommands(documentClient);
    expect(transactions).toHaveLength(1);
    const transaction = transactions[0];
    const items = transactionItems(transaction);
    expect(transactionActions(transaction).length).toBeLessThanOrEqual(100);
    expect(
      Buffer.byteLength(JSON.stringify(transaction.input.TransactItems), "utf8"),
    ).toBeLessThanOrEqual(4 * 1024 * 1024);
    const serializedItemBytes = items.map((item) =>
      Buffer.byteLength(JSON.stringify(item), "utf8"),
    );
    expect(serializedItemBytes.every((size) => size < 400 * 1024)).toBe(true);
    expect(serializedItemBytes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
    const questionChunks = items.filter(
      (item) => item.queryId === input.queryId && item.role === "user",
    );
    expect(questionChunks.length).toBeGreaterThan(1);
    expect(questionChunks.map((item) => item.text).join("")).toBe(largeQuestion);
    const turn = items.find((item) => item.queryId === input.queryId && item.profileSnapshot);
    expect(turn).toBeTruthy();
    expect(turn.profileSnapshot).toEqual(profileSnapshot);
    expect(turn.questionManifest).toMatchObject({
      count: questionChunks.length,
      complete: true,
    });
    const marker = items.find(
      (item) =>
        item.pk === "USER#" + owner.sub + "#BOT#" + owner.botId &&
        item.sk === "SEND#" + input.queryId,
    );
    expect(marker).toMatchObject({
      queryId: input.queryId,
      requestFingerprint: input.requestFingerprint,
    });
    for (const reference of references) {
      expect(JSON.stringify(items)).toContain(reference.queryId);
    }
    expect(items.some((item) => item.queryId === input.queryId && item.requestFingerprint)).toBe(
      true,
    );
    expect(JSON.stringify(transaction.input)).toContain(input.quota.policyRevision);

    const updates = transactionActions(transaction).flatMap((action) =>
      action.Update ? [action.Update] : [],
    );
    expect(updates.some(({ Key }) => String(Key?.sk).includes("USAGE#DAY#"))).toBe(true);
    expect(updates.some(({ Key }) => String(Key?.sk).includes("USAGE#MONTH#"))).toBe(true);
    const meta = transactionActions(transaction).find((action) =>
      [action.Put?.Item?.sk, action.Update?.Key?.sk].includes("META"),
    );
    expect(meta).toBeTruthy();
    expect(expressionText(actionPayload(meta))).toBeTruthy();
    expect(expressionText(actionPayload(meta))).toMatch(/ordinal/i);
    expect(documentClient.send.mock.calls.flatMap(([command]) => commandWrites(command))).toEqual(
      [],
    );
  });

  it("rejects an admission whose profile snapshot exceeds one DynamoDB item before charging", async () => {
    const { documentClient, store } = makeStore();
    const startTurn = requireMethod(store, "startTurn");
    const oversizedProfile = {
      ...profileSnapshot,
      promptTexts: ["x".repeat(410 * 1024)],
    };

    await expect(
      startTurn(admissionInput({ profileSnapshot: oversizedProfile })),
    ).rejects.toBeInstanceOf(Error);

    expect(mutationCommands(documentClient)).toEqual([]);
  });

  it("rejects an admission whose complete transaction exceeds 4 MiB before charging", async () => {
    const { documentClient, store } = makeStore();
    const startTurn = requireMethod(store, "startTurn");
    const transactionTooLargeQuestion = "x".repeat(4 * 1024 * 1024 + 64 * 1024);

    await expect(
      startTurn(admissionInput({ text: transactionTooLargeQuestion })),
    ).rejects.toBeInstanceOf(Error);

    expect(mutationCommands(documentClient)).toEqual([]);
  });

  it("conditions both counter increments on their own limits and the policy revision", async () => {
    const { documentClient, store } = makeStore();
    const startTurn = requireMethod(store, "startTurn");
    const input = admissionInput();

    await startTurn(input);

    const transaction = transactionCommands(documentClient)[0];
    expect(transaction).toBeTruthy();
    for (const [period, limit] of [
      ["DAY", input.quota.daily.limit],
      ["MONTH", input.quota.monthly.limit],
    ]) {
      const action = transactionActions(transaction).find(({ Update }) =>
        String(Update?.Key?.sk).includes("USAGE#" + period + "#"),
      );
      expect(action?.Update).toBeTruthy();
      expect(action.Update.ConditionExpression).toBeTruthy();
      expect(action.Update.ConditionExpression).toMatch(/</);
      expect(hasValue(action.Update.ExpressionAttributeValues, limit)).toBe(true);
      expect(/\bADD\b|\+/.test(action.Update.UpdateExpression ?? "")).toBe(true);
      expect(hasValue(action.Update.ExpressionAttributeValues, 1)).toBe(true);
    }

    const policyGuard = transactionActions(transaction).find((action) => {
      const payload = action.ConditionCheck ?? action.Update ?? action.Put;
      const key = payload?.Key ?? payload?.Item;
      return key?.sk === "QUOTA#POLICY" && Boolean(payload.ConditionExpression);
    });
    expect(policyGuard).toBeTruthy();
    expect(
      hasValue(actionPayload(policyGuard).ExpressionAttributeValues, input.quota.policyRevision),
    ).toBe(true);
  });

  it("guards the stable query marker and active conversation ordinal in the same admission", async () => {
    const { documentClient, store } = makeStore();
    const continueTurn = requireMethod(store, "continueTurn");
    const input = admissionInput({
      operation: "message",
      baseOrdinal: 4,
      contextReferences: [],
    });

    await continueTurn(input);

    const transaction = transactionCommands(documentClient)[0];
    expect(transaction).toBeTruthy();
    const marker = transactionActions(transaction).find(
      (action) => action.Put?.Item?.sk === "SEND#" + queryId,
    )?.Put;
    expect(marker).toBeTruthy();
    expect(marker.Item.requestFingerprint).toBe(input.requestFingerprint);
    expect(marker.ConditionExpression).toMatch(/attribute_not_exists/i);

    const meta = transactionActions(transaction).find(
      (action) => action.Update?.Key?.sk === "META",
    )?.Update;
    expect(meta).toBeTruthy();
    expect(meta.ConditionExpression).toBeTruthy();
    expect(meta.ConditionExpression).toMatch(/ordinal/i);
    expect(conditionNameText(meta)).toMatch(/active|reserv/i);
    expect(hasValue(meta.ExpressionAttributeValues, input.baseOrdinal)).toBe(true);
    expect(documentClient.send.mock.calls.flatMap(([command]) => commandWrites(command))).toEqual(
      [],
    );
  });

  it("reads one submission consistently by person, chatbot and stable query ID", async () => {
    const record = submissionRecord({ ordinal: 2 });
    const turn = turnRecord({
      status: "completed",
      phase: "complete",
      resultDeadlineAt: record.resultDeadlineAt,
      questionManifest: { count: 1, complete: true },
      answerManifest: { count: 2, complete: true },
      cursor: 2,
    });
    const question = submissionChunk(2, queryId, "user", 0, "Pregunta original.");
    const firstAnswer = submissionChunk(2, queryId, "assistant", 0, "Primera ");
    const secondAnswer = submissionChunk(2, queryId, "assistant", 1, "respuesta.");
    const records = new Map(
      [
        record,
        turn,
        metaRecord({
          lastOrdinal: 2,
          activeQueryId: undefined,
          activeOwnerAttemptId: undefined,
        }),
        question,
        firstAnswer,
        secondAnswer,
        documentChunk(2, queryId),
      ].map((item) => [keyId({ pk: item.pk, sk: item.sk }), item]),
    );
    const { documentClient, store } = makeStore(mapReadRecords(records));
    const getSubmission = requireMethod(store, "getSubmission");

    const snapshot = await getSubmission({ ...owner, queryId });
    expect(snapshot).toMatchObject({
      sub: owner.sub,
      botId: owner.botId,
      queryId,
      requestFingerprint: record.requestFingerprint,
      conversationId,
      ordinal: 2,
      status: "completed",
      question: "Pregunta original.",
      answer: "Primera respuesta.",
      cursor: 2,
      questionManifest: { count: 1, complete: true },
      answerManifest: { count: 2, complete: true },
    });
    expect(record.status).toBeUndefined();

    expect(strongReadKeys(documentClient)).toContainEqual({
      pk: "USER#" + owner.sub + "#BOT#" + owner.botId,
      sk: "SEND#" + queryId,
    });
    const reads = documentClient.send.mock.calls.map(([command]) => command);
    expect(
      reads
        .filter((command) => command instanceof GetCommand)
        .every((command) => command.input.ConsistentRead === true),
    ).toBe(true);
    expect(
      reads
        .filter((command) => command instanceof QueryCommand)
        .every((command) => command.input.ConsistentRead === true),
    ).toBe(true);
    expect(
      reads
        .filter((command) => command instanceof BatchGetCommand)
        .every((command) => command.input.RequestItems[tableName].ConsistentRead === true),
    ).toBe(true);
  });

  it("rejects a terminal submission with assistant text beyond its cursor", async () => {
    const record = submissionRecord({ ordinal: 2 });
    const turn = turnRecord({
      status: "completed",
      phase: "complete",
      resultDeadlineAt: record.resultDeadlineAt,
      questionManifest: { count: 1, complete: true },
      answerManifest: { count: 2, complete: true },
      cursor: 2,
    });
    const question = submissionChunk(2, queryId, "user", 0, "Pregunta original.");
    const firstAnswer = submissionChunk(2, queryId, "assistant", 0, "Primera ");
    const secondAnswer = submissionChunk(2, queryId, "assistant", 1, "respuesta.");
    const beyondCursor = submissionChunk(2, queryId, "assistant", 2, "respuesta zombi");
    const records = new Map(
      [
        record,
        turn,
        metaRecord({
          lastOrdinal: 2,
          activeQueryId: undefined,
          activeOwnerAttemptId: undefined,
        }),
        question,
        firstAnswer,
        secondAnswer,
        beyondCursor,
        documentChunk(2, queryId),
      ].map((item) => [keyId({ pk: item.pk, sk: item.sk }), item]),
    );
    const { store } = makeStore(mapReadRecords(records));
    const getSubmission = requireMethod(store, "getSubmission");

    await expect(getSubmission({ ...owner, queryId })).rejects.toThrow(
      /assistant chunk beyond the terminal cursor/,
    );
  });

  it("returns a boolean from the conditional single-invocation claim", async () => {
    // Script one success and one conditional failure; this verifies result mapping, not races.
    let claims = 0;
    const send = vi.fn(async (command) => {
      const writes =
        command instanceof TransactWriteCommand
          ? command.input.TransactItems
          : [command instanceof UpdateCommand ? { Update: command.input } : {}];
      if (!writes.some((action) => action.Update)) return {};
      claims += 1;
      if (claims === 2) throw conditionalFailure();
      return {};
    });
    const { documentClient, store } = makeStore(send);
    const claimInvocation = requireMethod(store, "claimInvocation");
    const claim = {
      conversationId,
      ordinal: 2,
      queryId,
      ownerAttemptId: "attempt-a",
      now: Date.parse("2026-10-22T02:31:00.000Z"),
    };

    await expect(claimInvocation(claim)).resolves.toBe(true);
    await expect(claimInvocation({ ...claim, ownerAttemptId: "attempt-b" })).resolves.toBe(false);

    const mutationInputs = documentClient.send.mock.calls.flatMap(([command]) => {
      if (command instanceof TransactWriteCommand) return transactionActions(command);
      return command instanceof UpdateCommand ? [{ Update: command.input }] : [];
    });
    expect(mutationInputs).toHaveLength(2);
    expect(mutationInputs.every(({ Update }) => Update.ConditionExpression)).toBe(true);
    expect(mutationInputs.every(({ Update }) => conditionIncludesInstant(Update, claim.now))).toBe(
      true,
    );
    expect(
      mutationInputs.every(({ Update }) => conditionBoundValues(Update).includes("admitted")),
    ).toBe(true);
    expect(mutationInputs.every(({ Update }) => /deadline/i.test(conditionNameText(Update)))).toBe(
      true,
    );
    expect(
      mutationInputs.every(({ Update }) => hasValue(Update.ExpressionAttributeValues, "admitted")),
    ).toBe(true);
    expect(
      mutationInputs.some(({ Update }) => hasValue(Update.ExpressionAttributeValues, "attempt-a")),
    ).toBe(true);
    expect(
      mutationInputs.some(({ Update }) => hasValue(Update.ExpressionAttributeValues, "attempt-b")),
    ).toBe(true);
  });

  it("writes each chunk and advances its cursor atomically under the invocation owner", async () => {
    const { documentClient, store } = makeStore();
    const appendChunk = requireMethod(store, "appendChunk");
    const now = Date.parse("2026-10-22T02:31:00.000Z");

    await appendChunk({
      conversationId,
      ordinal: 2,
      queryId,
      role: "assistant",
      index: 0,
      text: "Respuesta durable.",
      ownerAttemptId: "attempt-a",
      now,
    });

    const transactions = transactionCommands(documentClient);
    expect(transactions).toHaveLength(1);
    const actions = transactionActions(transactions[0]);
    const chunk = actions.find(({ Put }) => Put?.Item?.role === "assistant")?.Put;
    const cursor = actions.find(({ Update }) => Update?.Key?.sk?.startsWith("TURN#"))?.Update;
    expect(chunk?.Item).toMatchObject({
      queryId,
      role: "assistant",
      index: 0,
      text: "Respuesta durable.",
    });
    expect(chunk.ConditionExpression).toMatch(/attribute_not_exists/i);
    expect(cursor).toBeTruthy();
    expect(cursor.ConditionExpression).toBeTruthy();
    expect(expressionNames(cursor).some((name) => /cursor/i.test(name))).toBe(true);
    expect(conditionBoundValues(cursor)).toContain("attempt-a");
    expect(conditionBoundValues(cursor)).toContain(0);
    expect(conditionNameText(cursor)).toMatch(/cursor/i);
    expect(conditionNameText(cursor)).toMatch(/ownerAttemptId/i);
    expect(conditionNameText(cursor)).toMatch(/status|stage|phase/i);
    expect(documentClient.send.mock.calls.flatMap(([command]) => commandWrites(command))).toEqual(
      [],
    );
  });

  it("completes a turn and releases its conversation reservation in one transaction", async () => {
    const { documentClient, store } = makeStore();
    const completeTurn = requireMethod(store, "completeTurn");

    await completeTurn({
      conversationId,
      ordinal: 2,
      queryId,
      ownerAttemptId: "attempt-a",
      now: Date.parse("2026-10-22T02:50:00.000Z"),
      answerManifest: { count: 2, complete: true },
    });

    const transactions = transactionCommands(documentClient);
    expect(transactions).toHaveLength(1);
    const actions = transactionActions(transactions[0]);
    const turn = actions.find(({ Update }) => Update?.Key?.sk?.startsWith("TURN#"))?.Update;
    const meta = actions.find(({ Update }) => Update?.Key?.sk === "META")?.Update;
    expect(turn).toBeTruthy();
    expect(turn.ConditionExpression).toBeTruthy();
    expect(conditionBoundValues(turn)).toContain("attempt-a");
    expect(conditionBoundValues(turn)).toContain("invocation_claimed");
    expect(conditionIncludesInstant(turn, Date.parse("2026-10-22T02:50:00.000Z"))).toBe(true);
    expect(conditionNameText(turn)).toMatch(/ownerAttemptId/i);
    expect(conditionNameText(turn)).toMatch(/status/i);
    expect(conditionNameText(turn)).toMatch(/deadline/i);
    expect(hasValue(turn.ExpressionAttributeValues, "completed")).toBe(true);
    expect(meta).toBeTruthy();
    expect(meta.ConditionExpression).toBeTruthy();
    expect(conditionBoundValues(meta)).toContain(queryId);
    expect(conditionNameText(meta)).toMatch(/activeQueryId/i);
    expect(
      /REMOVE/i.test(meta.UpdateExpression ?? "") || hasValue(meta.ExpressionAttributeValues, null),
    ).toBe(true);
    expect(documentClient.send.mock.calls.flatMap(([command]) => commandWrites(command))).toEqual(
      [],
    );
  });

  it("reconciles an expired admitted turn as failed and releases the reservation atomically", async () => {
    const admittedAt = submissionRecord().admittedAt;
    const now = admittedAt + 60 * 60 * 1000;
    expect(now).toBe(Date.parse("2026-10-22T03:30:00.000Z"));
    const records = lifecycleRecords(
      { phase: "admitted", status: "in_progress", resultDeadlineAt: now },
      { activeQueryId: queryId },
    );
    const { documentClient, store } = makeStore(mapReadRecords(records));
    const reconcileTurn = requireMethod(store, "reconcileTurn");

    await reconcileTurn({ ...owner, conversationId, queryId, now });

    const transactions = transactionCommands(documentClient);
    expect(transactions).toHaveLength(1);
    const actions = transactionActions(transactions[0]);
    const turn = actions.find(({ Update }) => Update?.Key?.sk?.startsWith("TURN#"))?.Update;
    const meta = actions.find(({ Update }) => Update?.Key?.sk === "META")?.Update;
    expect(turn).toBeTruthy();
    expect(turn.ConditionExpression).toBeTruthy();
    expect(conditionIncludesInstant(turn, now)).toBe(true);
    expect(conditionBoundValues(turn)).toContain("admitted");
    expect(conditionNameText(turn)).toMatch(/status|stage|phase/i);
    expect(conditionNameText(turn)).toMatch(/deadline/i);
    expect(hasValue(turn.ExpressionAttributeValues, "failed")).toBe(true);
    expect(meta).toBeTruthy();
    expect(meta.ConditionExpression).toBeTruthy();
    expect(conditionBoundValues(meta)).toContain(queryId);
    expect(conditionNameText(meta)).toMatch(/activeQueryId/i);
    expect(
      /REMOVE/i.test(meta.UpdateExpression ?? "") || hasValue(meta.ExpressionAttributeValues, null),
    ).toBe(true);
    expect(documentClient.send.mock.calls.flatMap(([command]) => commandWrites(command))).toEqual(
      [],
    );
  });

  it("retires a conversation when an invocation claim expires without confirmed provider finish", async () => {
    const admittedAt = submissionRecord().admittedAt;
    const now = admittedAt + 60 * 60 * 1000;
    expect(now).toBe(Date.parse("2026-10-22T03:30:00.000Z"));
    const records = lifecycleRecords(
      {
        phase: "invocation_claimed",
        status: "in_progress",
        ownerAttemptId: "attempt-a",
        resultDeadlineAt: now,
      },
      { activeQueryId: queryId },
    );
    const { documentClient, store } = makeStore(mapReadRecords(records));
    const reconcileTurn = requireMethod(store, "reconcileTurn");

    await reconcileTurn({ ...owner, conversationId, queryId, now });

    const transaction = transactionCommands(documentClient)[0];
    expect(transaction).toBeTruthy();
    const actions = transactionActions(transaction);
    const turn = actions.find(({ Update }) => Update?.Key?.sk?.startsWith("TURN#"))?.Update;
    const meta = actions.find(({ Update }) => Update?.Key?.sk === "META")?.Update;
    expect(turn).toBeTruthy();
    expect(turn.ConditionExpression).toBeTruthy();
    expect(conditionBoundValues(turn)).toContain("attempt-a");
    expect(conditionBoundValues(turn)).toContain("invocation_claimed");
    expect(conditionIncludesInstant(turn, now)).toBe(true);
    expect(conditionNameText(turn)).toMatch(/ownerAttemptId/i);
    expect(conditionNameText(turn)).toMatch(/status|stage|phase/i);
    expect(conditionNameText(turn)).toMatch(/deadline/i);
    expect(hasValue(turn.ExpressionAttributeValues, "failed")).toBe(true);
    expect(meta).toBeTruthy();
    expect(meta.ConditionExpression).toBeTruthy();
    expect(conditionBoundValues(meta)).toContain(queryId);
    expect(conditionNameText(meta)).toMatch(/activeQueryId/i);
    expect(/closed|retired/i.test(JSON.stringify(meta))).toBe(true);
    expect(documentClient.send.mock.calls.flatMap(([command]) => commandWrites(command))).toEqual(
      [],
    );
  });

  it("does not let a stale invocation owner append after terminal reconciliation", async () => {
    const { documentClient, store } = makeStore(
      vi.fn(async (command) => {
        if (command instanceof TransactWriteCommand) throw conditionalFailure();
        return {};
      }),
    );
    const appendChunk = requireMethod(store, "appendChunk");

    await expect(
      appendChunk({
        conversationId,
        ordinal: 2,
        queryId,
        role: "assistant",
        index: 99,
        text: "zombie output",
        ownerAttemptId: "old-attempt",
        now: Date.parse("2026-10-22T03:30:01.000Z"),
      }),
    ).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });

    const transaction = transactionCommands(documentClient)[0];
    expect(transaction).toBeTruthy();
    const cursorUpdate = transactionActions(transaction).find(({ Update }) => Update)?.Update;
    expect(cursorUpdate).toBeTruthy();
    expect(cursorUpdate.ConditionExpression).toBeTruthy();
    expect(conditionBoundValues(cursorUpdate)).toContain("old-attempt");
    expect(conditionNameText(cursorUpdate)).toMatch(/ownerAttemptId/i);
    expect(conditionNameText(cursorUpdate)).toMatch(/status|stage|phase/i);
    expect(documentClient.send.mock.calls.flatMap(([command]) => commandWrites(command))).toEqual(
      [],
    );
  });
});
