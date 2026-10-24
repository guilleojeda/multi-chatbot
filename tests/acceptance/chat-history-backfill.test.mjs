import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptPath = path.join(projectRoot, "scripts/backfill-chat-history.mjs");
const tableName = "conversations-aurora-dev";
const botId = "bot-aurora";
const sub = "teacher-123";
const firstId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const legacyId = "fcdd5a71-b6db-4ad9-a2c3-934cb56fe749";
const brokenId = "d16d6a34-aa77-4c99-8985-712fdc7646c5";
const firstQuestion = "Armá una actividad inicial de porcentajes.";
const legacyQuestion = "Prepará una secuencia de geometría.";

let backfillChatHistory;

function availableBackfill() {
  if (typeof backfillChatHistory === "function") return backfillChatHistory;
  expect(
    typeof backfillChatHistory,
    "producto ausente: expected scripts/backfill-chat-history.mjs#backfillChatHistory",
  ).toBe("function");
  return null;
}

function meta(conversationId, overrides = {}) {
  return {
    pk: `CONV#${conversationId}`,
    sk: "META",
    conversationId,
    sub,
    botId,
    lastOrdinal: 1,
    ...overrides,
  };
}

function firstQuestionChunk(conversationId, queryId, text) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#00000001#${queryId}#USER#00000000`,
    conversationId,
    queryId,
    ordinal: 1,
    index: 0,
    role: "user",
    text,
  };
}

function firstTurnRecord(conversationId, queryId, overrides = {}) {
  return {
    pk: `CONV#${conversationId}`,
    sk: "TURN#00000001",
    conversationId,
    sub,
    botId,
    queryId,
    operation: "start",
    baseOrdinal: 0,
    ordinal: 1,
    status: "completed",
    phase: "complete",
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: 1, complete: true },
    cursor: 1,
    ...overrides,
  };
}

function firstAnswerChunk(conversationId, queryId) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#00000001#${queryId}#ASSISTANT#00000000`,
    conversationId,
    queryId,
    ordinal: 1,
    index: 0,
    role: "assistant",
    text: "Respuesta original guardada.",
  };
}

function firstTurnData(conversationId, queryId, text, overrides = {}) {
  return {
    1: {
      record: firstTurnRecord(conversationId, queryId, overrides),
      chunks: [
        firstQuestionChunk(conversationId, queryId, text),
        firstAnswerChunk(conversationId, queryId),
      ],
    },
  };
}

function queryText(command) {
  const values = command.input.ExpressionAttributeValues || {};
  return (
    Object.values(values).find((value) => typeof value === "string" && /^TURN#\d{8}/.test(value)) ||
    ""
  );
}

function metaKey(command) {
  return command.input.Key?.sk === "META";
}

function mockDocumentClient({ scans, chunks = new Map(), onUpdate, onGet } = {}) {
  const pages = [...(scans || [])];
  const send = vi.fn(async (command) => {
    if (command instanceof ScanCommand) {
      const page = pages.shift();
      if (page instanceof Error) throw page;
      if (!page) throw new Error("unexpected extra Scan page");
      return page;
    }
    if (command instanceof QueryCommand) {
      const prefix = queryText(command);
      const ordinal = Number(prefix.match(/^TURN#(\d+)/)?.[1] || 1);
      const pk = command.input.ExpressionAttributeValues?.[":pk"];
      const conversationId = String(pk || "").replace(/^CONV#/, "");
      const turn = chunks.get(conversationId)?.[ordinal];
      return {
        Items: [...(turn?.record ? [turn.record] : []), ...(turn?.chunks || [])],
      };
    }
    if (command instanceof GetCommand) {
      if (onGet) {
        const result = await onGet(command);
        if (result !== undefined) return result;
      }
      const key = command.input.Key || {};
      const conversationId = String(key.pk || "").replace(/^CONV#/, "");
      const ordinal = Number(String(key.sk || "").match(/^TURN#(\d+)$/)?.[1] || 0);
      if (ordinal > 0) {
        const record = chunks.get(conversationId)?.[ordinal]?.record;
        if (record) return { Item: record };
      }
      return {};
    }
    if (command instanceof UpdateCommand) {
      if (onUpdate) return onUpdate(command);
      return {};
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
  return { documentClient: { send }, send };
}

function sendCalls(send, type) {
  return send.mock.calls.map(([command]) => command).filter((command) => command instanceof type);
}

function attributeAssignment(update, attribute) {
  const names = update.ExpressionAttributeNames || {};
  const values = update.ExpressionAttributeValues || {};
  const token = Object.entries(names).find(([, value]) => value === attribute)?.[0];
  if (!token) return undefined;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = (update.UpdateExpression || "").match(
    new RegExp(`${escaped}\\s*=\\s*(:[A-Za-z0-9_]+)`),
  );
  return match ? values[match[1]] : undefined;
}

function expectOnlyHistoryUpdate(update, expected) {
  expect(update.input.Key).toEqual({ pk: `CONV#${expected.conversationId}`, sk: "META" });
  const expression = update.input.UpdateExpression || "";
  const names = update.input.ExpressionAttributeNames || {};
  const attributes = Object.entries(names)
    .filter(([token]) => expression.includes(token))
    .map(([, attribute]) => attribute);
  expect(attributes).toEqual(
    expect.arrayContaining(["historyOwner", "historyOrder", "historyLabel"]),
  );
  for (const forbidden of [
    "sub",
    "botId",
    "lastOrdinal",
    "updatedAt",
    "createdAt",
    "closed",
    "status",
    "lastQueryId",
    "activeQueryId",
    "profileSnapshot",
    "quotaSnapshot",
    "requestFingerprint",
  ]) {
    expect(attributes).not.toContain(forbidden);
    expect(expression).not.toMatch(new RegExp(`(?:^|[^A-Za-z])${forbidden}(?:[^A-Za-z]|$)`, "i"));
  }
  expect(attributeAssignment(update.input, "historyOwner")).toBe(`USER#${sub}#BOT#${botId}`);
  expect(attributeAssignment(update.input, "historyOrder")).toBe(expected.historyOrder);
  expect(attributeAssignment(update.input, "historyLabel")).toContain(expected.historyLabel);
  const conditionNames = Object.values(update.input.ExpressionAttributeNames || {});
  expect(conditionNames).toEqual(expect.arrayContaining(["sub", "botId", "lastOrdinal"]));
  expect(
    conditionNames.some((name) => ["updatedAt", "createdAt", "lastQueryId"].includes(name)),
  ).toBe(true);
}

describe("chat history backfill acceptance", () => {
  beforeAll(async () => {
    if (!existsSync(scriptPath)) return;
    const module = await import(pathToFileURL(scriptPath).href);
    backfillChatHistory = module.backfillChatHistory;
  });

  beforeEach(() => {
    expect(
      typeof backfillChatHistory,
      "producto ausente: expected scripts/backfill-chat-history.mjs#backfillChatHistory",
    ).toBe("function");
  });

  it("is safe to import without starting the CLI or creating AWS clients", () => {
    expect(existsSync(scriptPath), "the backfill module must exist").toBe(true);
    if (!existsSync(scriptPath)) return;
    const importOnly = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(scriptPath).href)})`,
      ],
      { encoding: "utf8", env: { ...process.env, AWS_EC2_METADATA_DISABLED: "true" } },
    );
    expect(importOnly.status, importOnly.stderr).toBe(0);
    expect(importOnly.stdout).toBe("");
  });

  it("pages through META only, labels from first questions, and adds only the three history attributes", async () => {
    const runBackfill = availableBackfill();
    if (!runBackfill) return;
    const firstMeta = meta(firstId, {
      lastOrdinal: 3,
      lastQueryId: "33333333-3333-4333-8333-333333333333",
      updatedAt: "2026-10-20T10:15:00.000Z",
      createdAt: "2026-10-19T16:00:00.000Z",
      closed: true,
      profileSnapshot: { private: "must remain untouched" },
    });
    const legacyMeta = meta(legacyId, {
      lastOrdinal: 1,
      lastQueryId: "22222222-2222-4222-8222-222222222222",
    });
    const brokenMeta = meta(brokenId, {
      sub: undefined,
      lastOrdinal: 4,
      updatedAt: "2026-10-22T10:00:00.000Z",
    });
    const pageOne = {
      Items: [firstMeta],
      LastEvaluatedKey: { pk: `CONV#${legacyId}`, sk: "META" },
    };
    const pageTwo = { Items: [legacyMeta, brokenMeta] };
    const chunks = new Map([
      [firstId, firstTurnData(firstId, "11111111-1111-4111-8111-111111111111", firstQuestion)],
      [legacyId, firstTurnData(legacyId, "22222222-2222-4222-8222-222222222222", legacyQuestion)],
    ]);
    const { documentClient, send } = mockDocumentClient({ scans: [pageOne, pageTwo], chunks });
    const result = await runBackfill({ documentClient, tableName, botId, pageSize: 2 });

    expect(result).toMatchObject({ scanned: 3, updated: 2, skipped: 0, incompatible: 1, pages: 2 });
    expect(result.nextKey).toBeUndefined();
    const scans = sendCalls(send, ScanCommand);
    expect(scans).toHaveLength(2);
    expect(scans.map(({ input }) => input.TableName)).toEqual([tableName, tableName]);
    expect(scans.map(({ input }) => input.Limit)).toEqual([2, 2]);
    expect(scans[0].input.ExclusiveStartKey).toBeUndefined();
    expect(scans[1].input.ExclusiveStartKey).toEqual(pageOne.LastEvaluatedKey);
    for (const scan of scans) {
      expect(JSON.stringify(scan.input)).toMatch(/META/);
      expect(JSON.stringify(scan.input.ExpressionAttributeValues)).not.toMatch(/SEND/);
    }

    const updates = sendCalls(send, UpdateCommand);
    expect(updates).toHaveLength(2);
    expectOnlyHistoryUpdate(updates[0], {
      conversationId: firstId,
      historyOrder: `2026-10-20T10:15:00.000Z#${firstId}`,
      historyLabel: firstQuestion,
    });
    expectOnlyHistoryUpdate(updates[1], {
      conversationId: legacyId,
      historyOrder: `0000#${legacyId}`,
      historyLabel: legacyQuestion,
    });
    const queries = sendCalls(send, QueryCommand);
    expect(queries).toHaveLength(2);
    expect(queries.every(({ input }) => input.TableName === tableName)).toBe(true);
    expect(
      queries.every(({ input }) =>
        Object.values(input.ExpressionAttributeValues || {}).some(
          (value) => typeof value === "string" && /^TURN#00000001#?$/.test(value),
        ),
      ),
      "the label must come from the first admitted question in each conversation",
    ).toBe(true);
    expect(
      sendCalls(send, GetCommand).some(({ input }) => input.Key?.sk?.startsWith("SEND#")),
    ).toBe(false);
    expect(
      updates.every(({ input }) => input.Key?.sk === "META"),
      "the backfill may update META records only",
    ).toBe(true);
    expect(
      updates.some(({ input }) => input.Key?.pk === brokenMeta.pk),
      "incompatible legacy records must be reported without repair",
    ).toBe(false);
  });

  it("does not invent a migration date when META and the first turn have no verifiable date", async () => {
    const runBackfill = availableBackfill();
    if (!runBackfill) return;
    const unknownDateMeta = meta(legacyId, {
      lastOrdinal: 1,
      lastQueryId: "22222222-2222-4222-8222-222222222222",
    });
    const chunks = new Map([
      [legacyId, firstTurnData(legacyId, "22222222-2222-4222-8222-222222222222", legacyQuestion)],
    ]);
    const { documentClient, send } = mockDocumentClient({
      scans: [{ Items: [unknownDateMeta] }],
      chunks,
    });
    const result = await runBackfill({ documentClient, tableName, botId });

    expect(result.updated).toBe(1);
    const update = sendCalls(send, UpdateCommand)[0];
    expect(attributeAssignment(update.input, "historyOrder")).toBe(`0000#${legacyId}`);
    expect(attributeAssignment(update.input, "historyOrder")).not.toMatch(/^\d{4}-\d\d-/);
  });

  it("skips a fully indexed conversation on a second backfill pass", async () => {
    const runBackfill = availableBackfill();
    if (!runBackfill) return;
    const indexedMeta = meta(firstId, {
      lastOrdinal: 1,
      lastQueryId: "11111111-1111-4111-8111-111111111111",
      updatedAt: "2026-10-20T10:15:00.000Z",
      historyOwner: `USER#${sub}#BOT#${botId}`,
      historyOrder: `2026-10-20T10:15:00.000Z#${firstId}`,
      historyLabel: firstQuestion,
    });
    const { documentClient, send } = mockDocumentClient({
      scans: [{ Items: [indexedMeta] }],
      chunks: new Map([
        [firstId, firstTurnData(firstId, "11111111-1111-4111-8111-111111111111", firstQuestion)],
      ]),
    });

    const result = await runBackfill({ documentClient, tableName, botId });

    expect(result).toMatchObject({ scanned: 1, updated: 0, skipped: 1, incompatible: 0 });
    expect(sendCalls(send, UpdateCommand)).toHaveLength(0);
  });

  it("returns a resumable nextKey when maxPages stops before the scan is complete", async () => {
    const runBackfill = availableBackfill();
    if (!runBackfill) return;
    const startKey = { pk: "CONV#older", sk: "META" };
    const nextKey = { pk: `CONV#${legacyId}`, sk: "META" };
    const { documentClient, send } = mockDocumentClient({
      scans: [
        {
          Items: [
            meta(firstId, {
              lastQueryId: "11111111-1111-4111-8111-111111111111",
              updatedAt: "2026-10-20T10:15:00.000Z",
            }),
          ],
          LastEvaluatedKey: nextKey,
        },
        {
          Items: [meta(legacyId, { lastQueryId: "22222222-2222-4222-8222-222222222222" })],
          LastEvaluatedKey: { pk: "CONV#later", sk: "META" },
        },
      ],
      chunks: new Map([
        [firstId, firstTurnData(firstId, "11111111-1111-4111-8111-111111111111", firstQuestion)],
        [legacyId, firstTurnData(legacyId, "22222222-2222-4222-8222-222222222222", legacyQuestion)],
      ]),
    });
    const firstRun = await runBackfill({
      documentClient,
      tableName,
      botId,
      startKey,
      pageSize: 1,
      maxPages: 1,
    });

    expect(firstRun.pages).toBe(1);
    expect(firstRun.nextKey).toEqual(nextKey);
    expect(sendCalls(send, ScanCommand)[0].input.ExclusiveStartKey).toEqual(startKey);

    const resumedRun = await runBackfill({
      documentClient,
      tableName,
      botId,
      startKey: firstRun.nextKey,
      pageSize: 1,
      maxPages: 1,
    });
    expect(resumedRun.pages).toBe(1);
    expect(resumedRun.nextKey).toEqual({ pk: "CONV#later", sk: "META" });
    expect(sendCalls(send, ScanCommand)[1].input.ExclusiveStartKey).toEqual(nextKey);
  });

  it("re-reads META after a conditional race and treats a concurrent identical projection as complete", async () => {
    const runBackfill = availableBackfill();
    if (!runBackfill) return;
    const scannedMeta = meta(firstId, { updatedAt: "2026-10-20T10:15:00.000Z" });
    const concurrentlyIndexed = {
      ...scannedMeta,
      historyOwner: `USER#${sub}#BOT#${botId}`,
      historyOrder: `2026-10-20T10:15:00.000Z#${firstId}`,
      historyLabel: firstQuestion,
    };
    const conditionalError = new Error("conditional check failed");
    conditionalError.name = "ConditionalCheckFailedException";
    const { documentClient, send } = mockDocumentClient({
      scans: [{ Items: [scannedMeta] }],
      chunks: new Map([
        [firstId, firstTurnData(firstId, "11111111-1111-4111-8111-111111111111", firstQuestion)],
      ]),
      onUpdate: async () => {
        throw conditionalError;
      },
      onGet: async (command) => (metaKey(command) ? { Item: concurrentlyIndexed } : undefined),
    });
    const result = await runBackfill({ documentClient, tableName, botId });

    expect(result).toMatchObject({ updated: 0, skipped: 1, incompatible: 0 });
    expect(sendCalls(send, UpdateCommand)).toHaveLength(1);
    expect(sendCalls(send, GetCommand)).toHaveLength(1);
    expect(sendCalls(send, GetCommand)[0].input.Key).toEqual({ pk: `CONV#${firstId}`, sk: "META" });
  });

  it("preserves the last completed scan checkpoint when a later page fails", async () => {
    const runBackfill = availableBackfill();
    if (!runBackfill) return;
    const checkpoint = { pk: `CONV#${legacyId}`, sk: "META" };
    const failure = new Error("DynamoDB scan unavailable");
    const { documentClient } = mockDocumentClient({
      scans: [{ Items: [], LastEvaluatedKey: checkpoint }, failure],
    });

    await expect(
      runBackfill({ documentClient, tableName, botId, pageSize: 1 }),
    ).rejects.toMatchObject({
      message: "DynamoDB scan unavailable",
      checkpoint,
    });
  });
});
