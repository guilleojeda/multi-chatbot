import { expect, it, vi } from "vitest";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createConversationStoreAdapter } from "../../runtime/conversation-store.ts";
import { dynamoItemSize } from "../../runtime/context-storage.ts";

const now = Date.parse("2026-10-24T15:00:00.000Z");
const count = 6_935;
const conversationId = "b2000000-0000-4000-8000-000000000001";
const queryIdFor = (ordinal) => `b3000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const owner = { sub: "snapshot-teacher", botId: "bot-snapshot" };

function keyId(key) {
  return `${key.pk}\u0000${key.sk}`;
}

function transactionActions(command) {
  return command.input.TransactItems;
}

function transactionItems(command) {
  return transactionActions(command).flatMap((action) =>
    action.Put?.Item ? [action.Put.Item] : [],
  );
}

function makeHarness(records) {
  const send = vi.fn(async (command) => {
    if (command instanceof GetCommand) {
      return { Item: records.get(keyId(command.input.Key)) };
    }
    if (command instanceof QueryCommand) return { Items: [] };
    return {};
  });
  const store = createConversationStoreAdapter({
    documentClient: { send },
    tableName: "conversations",
    now: () => now,
  });
  return { send, store };
}

it("externalizes a near-limit snapshot before claim, append, completion, failure, and expiry", async () => {
  const previousMeta = {
    pk: `CONV#${conversationId}`,
    sk: "META",
    conversationId,
    ...owner,
    lastOrdinal: count,
    lastQueryId: queryIdFor(count),
    historyOwner: "USER#snapshot-teacher#BOT#bot-snapshot",
    historyOrder: `2026-10-24T14:00:00.000Z#${conversationId}`,
    historyLabel: "small",
  };
  const references = Array.from({ length: count }, (_, index) => ({
    ordinal: index + 1,
    queryId: queryIdFor(index + 1),
  }));
  const input = {
    ...owner,
    conversationId,
    queryId: queryIdFor(count + 1),
    now,
    ownerAttemptId: "attempt",
    resultDeadlineAt: now + 3_600_000,
    operation: "message",
    text: "new question",
    documentContext: {
      knowledgeBaseId: "kb-snapshot-dev",
      query: "new question",
      revision: "documents-snapshot-r1",
      retrievedAt: now,
      status: "empty",
      results: [],
    },
    profileSnapshot: { fields: {} },
    invocation: { modelId: "model", revision: "r" },
    quota: {
      daily: { used: 2, limit: 20, resetAt: now + 1_000_000, period: "2026-10-24" },
      monthly: { used: 8, limit: 200, resetAt: now + 10_000_000, period: "2026-10" },
      serverNow: now,
      blockedUntil: null,
      policyRevision: "p",
    },
    requestFingerprint: "f",
    baseOrdinal: count,
    contextReferences: references,
    contextSnapshot: { version: 1, recentReferences: references },
  };
  const metaKey = { pk: previousMeta.pk, sk: previousMeta.sk };
  const turnKey = {
    pk: previousMeta.pk,
    sk: `TURN#${String(count + 1).padStart(8, "0")}`,
  };
  const records = new Map([[keyId(metaKey), previousMeta]]);
  const { send, store } = makeHarness(records);

  await store.continueTurn(input);

  const admission = send.mock.calls
    .map(([command]) => command)
    .find((command) => command instanceof TransactWriteCommand);
  expect(admission).toBeTruthy();
  expect(
    transactionItems(admission).some(
      (item) => item.sk === `SEND#${input.queryId}` && item.queryId === input.queryId,
    ),
  ).toBe(true);
  expect(
    transactionActions(admission).filter((action) =>
      String(action.Update?.Key?.sk ?? "").startsWith("USAGE#"),
    ),
  ).toHaveLength(2);
  const admittedTurn = transactionItems(admission).find((item) => item.sk === turnKey.sk);
  expect(admittedTurn).toBeTruthy();
  const inlineTurn = {
    ...admittedTurn,
    contextManifest: { count: 0, complete: true },
    contextSnapshot: { version: 1, recentReferences: references },
  };
  expect(dynamoItemSize(inlineTurn)).toBeGreaterThan(400 * 1024 - 32);
  expect(dynamoItemSize(inlineTurn)).toBeLessThanOrEqual(400 * 1024);
  expect(admittedTurn.contextSnapshot).toEqual({
    version: 1,
    recentReferencesStorage: "context_chunks",
  });
  const contextItems = transactionItems(admission).filter((item) =>
    item.sk.startsWith(`${turnKey.sk}#CONTEXT#`),
  );
  expect(contextItems.map((item) => item.text).join("")).toBe(JSON.stringify(references));
  expect(admittedTurn.contextManifest).toEqual({ count: contextItems.length, complete: true });

  const activeMeta = {
    ...previousMeta,
    lastOrdinal: count + 1,
    lastQueryId: input.queryId,
    activeQueryId: input.queryId,
    activeOwnerAttemptId: input.ownerAttemptId,
  };
  const identity = {
    conversationId,
    ordinal: count + 1,
    queryId: input.queryId,
    ownerAttemptId: input.ownerAttemptId,
  };
  const maximumCursor = Number.MAX_SAFE_INTEGER;
  const maximumMetrics = {
    inputTokens: Number.MAX_VALUE,
    outputTokens: Number.MAX_VALUE,
    totalTokens: Number.MAX_VALUE,
    cacheReadInputTokens: Number.MAX_VALUE,
    cacheWriteInputTokens: Number.MAX_VALUE,
    latencyMs: Number.MAX_VALUE,
    timeToFirstByteMs: Number.MAX_VALUE,
  };
  const maximumRequestId = "漢".repeat(256);
  const resetRecords = () => {
    records.set(keyId(turnKey), admittedTurn);
    records.set(keyId(metaKey), activeMeta);
  };

  resetRecords();
  await expect(store.claimInvocation({ ...identity, now: now + 1 })).resolves.toBe(true);
  expect(send.mock.calls.some(([command]) => command instanceof UpdateCommand)).toBe(true);

  const claimedAt = new Date(now + 1).toISOString();
  const claimedTurn = {
    ...admittedTurn,
    phase: "invocation_claimed",
    invocationClaimedAt: claimedAt,
    cursor: maximumCursor,
    answerManifest: { count: maximumCursor, complete: false },
  };
  resetRecords();
  records.set(keyId(turnKey), claimedTurn);
  await expect(
    store.appendChunk({
      ...identity,
      role: "assistant",
      index: maximumCursor,
      text: "x",
      now: now + 2,
    }),
  ).resolves.toBeUndefined();

  const claimedAtMaximumCursor = {
    ...claimedTurn,
    cursor: maximumCursor,
    answerManifest: { count: maximumCursor, complete: false },
  };
  resetRecords();
  records.set(keyId(turnKey), claimedAtMaximumCursor);
  await expect(
    store.completeTurn({
      ...identity,
      now: now + 3,
      answerManifest: { count: maximumCursor, complete: true },
      invocation: input.invocation,
      stopReason: "x".repeat(64),
      requestId: maximumRequestId,
      metrics: maximumMetrics,
    }),
  ).resolves.toBeUndefined();

  const claimedAfterFinalAppend = {
    ...claimedTurn,
    cursor: maximumCursor + 1,
    answerManifest: { count: maximumCursor + 1, complete: false },
  };
  resetRecords();
  records.set(keyId(turnKey), claimedAfterFinalAppend);
  await expect(
    store.failTurn({
      ...identity,
      now: now + 4,
      code: "temporarily_unavailable",
      invocationClaimed: true,
      providerFinished: false,
      answerManifest: { count: maximumCursor + 1, complete: false },
      stopReason: "x".repeat(64),
      requestId: maximumRequestId,
      metrics: maximumMetrics,
      providerError: {
        providerCode: "x".repeat(64),
        requestId: maximumRequestId,
        httpStatusCode: 599,
        attempts: Number.MAX_VALUE,
      },
    }),
  ).resolves.toBeUndefined();

  resetRecords();
  await expect(
    store.failTurn({
      ...identity,
      now: now + 2,
      code: "temporarily_unavailable",
      invocationClaimed: false,
      providerFinished: true,
      stopReason: "x".repeat(64),
      requestId: maximumRequestId,
      metrics: maximumMetrics,
      providerError: {
        providerCode: "x".repeat(64),
        requestId: maximumRequestId,
        httpStatusCode: 599,
        attempts: Number.MAX_VALUE,
      },
    }),
  ).resolves.toBeUndefined();
  const failureWrite = send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof TransactWriteCommand)
    .at(-1);
  const failureUpdate = transactionActions(failureWrite).find(
    (action) => action.Update?.Key?.sk === turnKey.sk,
  ).Update;
  expect(failureUpdate.UpdateExpression).toContain("providerError");
  expect(failureUpdate.ExpressionAttributeValues[":requestId"]).toBe(maximumRequestId);
  expect(failureUpdate.ExpressionAttributeValues[":providerError"]).toEqual({
    providerCode: "x".repeat(64),
    requestId: maximumRequestId,
    httpStatusCode: 599,
    attempts: Number.MAX_VALUE,
  });
  expect(failureUpdate.ExpressionAttributeValues[":metrics"]).toEqual(maximumMetrics);

  resetRecords();
  await expect(
    store.reconcileHistoryTurn({
      ...owner,
      ...identity,
      now: now + 3_600_001,
    }),
  ).resolves.toMatchObject({
    turn: { status: "in_progress" },
    confirmable: true,
  });
  const reconciliationWrite = send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof TransactWriteCommand)
    .at(-1);
  expect(
    transactionActions(reconciliationWrite).some((action) => action.Update?.Key?.sk === turnKey.sk),
  ).toBe(true);

  resetRecords();
  records.set(keyId(turnKey), {
    ...claimedAtMaximumCursor,
    cursor: maximumCursor,
    answerManifest: { count: maximumCursor, complete: false },
  });
  await expect(
    store.reconcileHistoryTurn({
      ...owner,
      ...identity,
      now: now + 3_600_001,
    }),
  ).resolves.toMatchObject({ confirmable: true });
  const claimedReconciliationWrite = send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof TransactWriteCommand)
    .at(-1);
  expect(
    transactionActions(claimedReconciliationWrite).some(
      (action) => action.Update?.Key?.sk === turnKey.sk,
    ),
  ).toBe(true);
});

it("rejects a near-capacity turn with no references before sending its quota transaction", async () => {
  const previousMeta = {
    pk: `CONV#${conversationId}`,
    sk: "META",
    conversationId,
    ...owner,
    lastOrdinal: count,
    lastQueryId: queryIdFor(count),
    historyOwner: "USER#snapshot-teacher#BOT#bot-snapshot",
    historyOrder: `2026-10-24T14:00:00.000Z#${conversationId}`,
    historyLabel: "small",
  };
  const baseInput = {
    ...owner,
    conversationId,
    queryId: queryIdFor(count + 1),
    now,
    ownerAttemptId: "attempt",
    resultDeadlineAt: now + 3_600_000,
    operation: "message",
    text: "new question",
    documentContext: {
      knowledgeBaseId: "kb-snapshot-dev",
      query: "new question",
      revision: "documents-snapshot-r1",
      retrievedAt: now,
      status: "empty",
      results: [],
    },
    profileSnapshot: { fields: { payload: "x" } },
    invocation: { modelId: "model", revision: "r" },
    quota: {
      daily: { used: 2, limit: 20, resetAt: now + 1_000_000, period: "2026-10-24" },
      monthly: { used: 8, limit: 200, resetAt: now + 10_000_000, period: "2026-10" },
      serverNow: now,
      blockedUntil: null,
      policyRevision: "p",
    },
    requestFingerprint: "f",
    baseOrdinal: count,
    contextReferences: [],
    contextSnapshot: { version: 1, recentReferences: [] },
  };
  const metaKey = { pk: previousMeta.pk, sk: previousMeta.sk };
  const baselineRecords = new Map([[keyId(metaKey), previousMeta]]);
  const baselineHarness = makeHarness(baselineRecords);

  await baselineHarness.store.continueTurn(baseInput);

  const baselineAdmission = baselineHarness.send.mock.calls
    .map(([command]) => command)
    .find((command) => command instanceof TransactWriteCommand);
  const baselineTurn = transactionItems(baselineAdmission).find(
    (item) => item.sk === `TURN#${String(count + 1).padStart(8, "0")}`,
  );
  expect(baselineTurn).toBeTruthy();

  const targetSize = 400 * 1024 - 64;
  const additionalBytes = targetSize - dynamoItemSize(baselineTurn);
  expect(additionalBytes).toBeGreaterThan(0);
  const nearLimitProfile = { fields: { payload: "x".repeat(1 + additionalBytes) } };
  expect(dynamoItemSize({ ...baselineTurn, profileSnapshot: nearLimitProfile })).toBe(targetSize);

  const rejectionRecords = new Map([[keyId(metaKey), previousMeta]]);
  const rejectionHarness = makeHarness(rejectionRecords);
  await expect(
    rejectionHarness.store.continueTurn({
      ...baseInput,
      queryId: queryIdFor(count + 2),
      profileSnapshot: nearLimitProfile,
    }),
  ).rejects.toMatchObject({ code: "storage_capacity_exceeded" });
  expect(
    rejectionHarness.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand),
  ).toBe(false);
});
