import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const adapterPath = path.join(projectRoot, "runtime/conversation-store.ts");
const tableName = "conversations-aurora-dev";
const conversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const queryId = "a4bfbc9f-3699-4e93-b120-a03c0204bc67";
const sub = "teacher-123";
const botId = "bot-aurora";
const question = "Armá una actividad de porcentajes.";
const firstActivityAt = Date.parse("2026-10-19T16:00:00.000Z");
const secondActivityAt = Date.parse("2026-10-20T10:15:00.000Z");
const metaKey = { pk: `CONV#${conversationId}`, sk: "META" };

let createConversationStoreAdapter;

function makeMeta(overrides = {}) {
  return {
    ...metaKey,
    conversationId,
    sub,
    botId,
    createdAt: "2026-10-19T16:00:00.000Z",
    updatedAt: "2026-10-19T16:00:00.000Z",
    lastOrdinal: 1,
    lastQueryId: queryId,
    historyOwner: `USER#${sub}#BOT#${botId}`,
    historyOrder: `2026-10-19T16:00:00.000Z#${conversationId}`,
    historyLabel: question,
    ...overrides,
  };
}

function turnRecord(overrides = {}) {
  return {
    pk: `CONV#${conversationId}`,
    sk: "TURN#00000001",
    conversationId,
    sub,
    botId,
    queryId,
    ordinal: 1,
    status: "in_progress",
    phase: "invocation_claimed",
    ownerAttemptId: "attempt-admitted",
    resultDeadlineAt: secondActivityAt + 60 * 60 * 1000,
    cursor: 1,
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: 1, complete: false },
    contextManifest: { count: 0, complete: true },
    profileSnapshot: {},
    invocation: { modelId: "global.anthropic.claude-sonnet-4-6" },
    ...overrides,
  };
}

function makeStore(send, now = () => secondActivityAt) {
  const documentClient = { send };
  return {
    documentClient,
    store:
      typeof createConversationStoreAdapter === "function"
        ? createConversationStoreAdapter({ documentClient, tableName, now })
        : null,
  };
}

function transactionCommand(documentClient) {
  const command = documentClient.send.mock.calls
    .map(([candidate]) => candidate)
    .find((candidate) => candidate instanceof TransactWriteCommand);
  expect(
    command,
    "the index fields must be written with the existing DynamoDB transaction",
  ).toBeDefined();
  return command;
}

function metaWrite(command) {
  const actions = command.input.TransactItems;
  const matches = actions.flatMap((action) => {
    if (action.Put?.Item?.sk === "META") return [{ kind: "Put", payload: action.Put }];
    if (action.Update?.Key?.sk === "META") return [{ kind: "Update", payload: action.Update }];
    return [];
  });
  expect(matches, "one existing META write must carry the history projection").toHaveLength(1);
  return matches[0];
}

function updateAssignments(update) {
  const names = update.ExpressionAttributeNames || {};
  const values = update.ExpressionAttributeValues || {};
  const expression = update.UpdateExpression || "";
  const result = new Map();
  for (const [token, attribute] of Object.entries(names)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = expression.match(new RegExp(`${escaped}\\s*=\\s*(:[A-Za-z0-9_]+)`));
    if (match) result.set(attribute, values[match[1]]);
  }
  return result;
}

function expectOrderWrite(metaWriteResult, at) {
  if (metaWriteResult.kind === "Put") {
    expect(metaWriteResult.payload.Item.historyOwner).toBe(`USER#${sub}#BOT#${botId}`);
    expect(metaWriteResult.payload.Item.historyOrder).toBe(
      `${new Date(at).toISOString()}#${conversationId}`,
    );
    expect(metaWriteResult.payload.Item.historyLabel).toContain(question);
    return;
  }

  const assignments = updateAssignments(metaWriteResult.payload);
  expect(assignments.get("historyOrder")).toBe(`${new Date(at).toISOString()}#${conversationId}`);
  if (assignments.has("historyOwner")) {
    expect(assignments.get("historyOwner")).toBe(`USER#${sub}#BOT#${botId}`);
  }
  if (assignments.has("historyLabel")) {
    expect(assignments.get("historyLabel")).toContain(question);
  }
  expect(metaWriteResult.payload.UpdateExpression).not.toMatch(
    /REMOVE[^\n]*history(?:Owner|Label)/i,
  );
}

function keyFor(command) {
  return command.input.Key || {};
}

describe("conversation history GSI writer acceptance", () => {
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

  it("adds owner, activity order, and a label from the first question to META in first admission", async () => {
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return {};
      if (command instanceof TransactWriteCommand) return {};
      throw new Error(`unexpected command ${command.constructor.name}`);
    });
    const { documentClient, store } = makeStore(send, () => firstActivityAt);
    if (!store) return;

    await store.startTurn({
      sub,
      botId,
      conversationId,
      queryId,
      now: firstActivityAt,
      ownerAttemptId: "attempt-admitted",
      resultDeadlineAt: firstActivityAt + 60 * 60 * 1000,
      text: question,
      profileSnapshot: {},
      invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "rev-1" },
      requestFingerprint: "sha256:request-one",
      quota: {
        daily: { used: 4, limit: 20, resetAt: firstActivityAt + 1, period: "2026-10-19" },
        monthly: { used: 37, limit: 200, resetAt: firstActivityAt + 2, period: "2026-10" },
        serverNow: firstActivityAt,
        blockedUntil: null,
        policyRevision: "policy-r7",
      },
    });

    const transaction = transactionCommand(documentClient);
    const indexedMeta = metaWrite(transaction);
    expect(indexedMeta.kind).toBe("Put");
    expectOrderWrite(indexedMeta, firstActivityAt);
    const items = transaction.input.TransactItems.flatMap((action) =>
      action.Put?.Item ? [action.Put.Item] : [],
    );
    const questionItem = items.find((item) => item.role === "user");
    expect(questionItem?.text).toBe(question);
    expect(questionItem).not.toHaveProperty("historyOwner");
    expect(questionItem).not.toHaveProperty("historyOrder");
    expect(questionItem).not.toHaveProperty("historyLabel");
    const turnItem = items.find((item) => item.sk === "TURN#00000001");
    expect(turnItem).toBeDefined();
    expect(turnItem).not.toHaveProperty("historyOwner");
    expect(turnItem).not.toHaveProperty("historyOrder");
    expect(turnItem).not.toHaveProperty("historyLabel");
    expect(items.filter((item) => item.sk === "META")).toHaveLength(1);
    expect(items.some((item) => String(item.sk).startsWith("HISTORY#"))).toBe(false);

    const actions = transaction.input.TransactItems;
    expect(actions.filter((action) => action.ConditionCheck)).toHaveLength(1);
    expect(actions.filter((action) => action.Update?.Key?.sk?.startsWith("USAGE#"))).toHaveLength(
      2,
    );
  });

  it("moves META activity on a follow-up while keeping the first-question label stable", async () => {
    const originalMeta = makeMeta();
    const followupQueryId = "d66bd564-7560-4dba-b99e-8355f05d72bc";
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        const key = keyFor(command);
        if (key.sk === `SEND#${followupQueryId}`) return {};
        if (key.sk === "META") return { Item: originalMeta };
      }
      if (command instanceof TransactWriteCommand) return {};
      throw new Error(`unexpected command ${command.constructor.name}`);
    });
    const { documentClient, store } = makeStore(send);
    if (!store) return;

    await store.continueTurn({
      sub,
      botId,
      conversationId,
      queryId: followupQueryId,
      baseOrdinal: 1,
      now: secondActivityAt,
      ownerAttemptId: "attempt-followup",
      resultDeadlineAt: secondActivityAt + 60 * 60 * 1000,
      text: "¿Cómo comprueban las respuestas?",
      contextReferences: [],
      profileSnapshot: {},
      invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "rev-1" },
      requestFingerprint: "sha256:request-two",
      quota: {
        daily: { used: 4, limit: 20, resetAt: secondActivityAt + 1, period: "2026-10-20" },
        monthly: { used: 37, limit: 200, resetAt: secondActivityAt + 2, period: "2026-10" },
        serverNow: secondActivityAt,
        blockedUntil: null,
        policyRevision: "policy-r7",
      },
    });

    const transaction = transactionCommand(documentClient);
    const indexedMeta = metaWrite(transaction);
    expect(indexedMeta.kind).toBe("Update");
    expectOrderWrite(indexedMeta, secondActivityAt);
    expect(indexedMeta.payload.UpdateExpression).not.toMatch(/#historyLabel\s*=/);
    expect(indexedMeta.payload.UpdateExpression).not.toMatch(/#historyOwner\s*=/);
    expect(indexedMeta.payload.UpdateExpression).toContain("historyOrder");
    expect(
      transaction.input.TransactItems.filter((action) =>
        action.Update?.Key?.sk?.startsWith("USAGE#"),
      ),
    ).toHaveLength(2);
    expect(
      transaction.input.TransactItems.some((action) =>
        action.Put?.Item?.sk?.startsWith("HISTORY#"),
      ),
    ).toBe(false);
  });

  it.each([
    [
      "completeTurn",
      (store) =>
        store.completeTurn({
          conversationId,
          ordinal: 1,
          queryId,
          ownerAttemptId: "attempt-admitted",
          now: secondActivityAt,
          answerManifest: { count: 1, complete: true },
        }),
    ],
    [
      "failTurn",
      (store) =>
        store.failTurn({
          conversationId,
          ordinal: 1,
          queryId,
          ownerAttemptId: "attempt-admitted",
          now: secondActivityAt,
          code: "provider_error",
          invocationClaimed: true,
          providerFinished: true,
        }),
    ],
  ])(
    "updates META activity in the existing transaction when a turn reaches %s",
    async (_name, run) => {
      const send = vi.fn(async (command) => {
        if (command instanceof GetCommand) {
          const key = keyFor(command);
          if (key.sk === "META")
            return {
              Item: makeMeta({ activeQueryId: queryId, activeOwnerAttemptId: "attempt-admitted" }),
            };
          if (key.sk === "TURN#00000001") return { Item: turnRecord() };
        }
        if (command instanceof TransactWriteCommand) return {};
        throw new Error(`unexpected command ${command.constructor.name}`);
      });
      const { documentClient, store } = makeStore(send);
      if (!store) return;

      await run(store);

      const transaction = transactionCommand(documentClient);
      expectOrderWrite(metaWrite(transaction), secondActivityAt);
      expect(transaction.input.TransactItems).toHaveLength(2);
      expect(transaction.input.TransactItems.every((action) => action.Update)).toBe(true);
      expect(
        transaction.input.TransactItems.some((action) => action.Update.Key.sk.startsWith("USAGE#")),
      ).toBe(false);
    },
  );

  it("updates META activity during shared reconciliation without adding quota writes", async () => {
    const reconciledAt = Date.parse("2026-10-21T13:00:00.000Z");
    const marker = {
      pk: `USER#${sub}#BOT#${botId}`,
      sk: `SEND#${queryId}`,
      sub,
      botId,
      queryId,
      requestFingerprint: "sha256:request-one",
      operation: "start",
      baseOrdinal: 0,
      conversationId,
      ordinal: 1,
      resultDeadlineAt: firstActivityAt,
    };
    let currentTurn = turnRecord({
      status: "in_progress",
      phase: "admitted",
      ownerAttemptId: "attempt-admitted",
      resultDeadlineAt: firstActivityAt,
      cursor: 0,
      answerManifest: { count: 0, complete: false },
      questionManifest: { count: 1, complete: true },
      contextManifest: { count: 0, complete: true },
      requestFingerprint: "sha256:request-one",
    });
    let currentMeta = makeMeta({
      activeQueryId: queryId,
      activeOwnerAttemptId: "attempt-admitted",
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        const key = keyFor(command);
        if (key.sk === `SEND#${queryId}`) return { Item: marker };
        if (key.sk === "META") return { Item: currentMeta };
        if (key.sk === "TURN#00000001") return { Item: currentTurn };
      }
      if (command instanceof QueryCommand) {
        return {
          Items: [
            {
              pk: `CONV#${conversationId}`,
              sk: `TURN#00000001#${queryId}#USER#00000000`,
              conversationId,
              queryId,
              ordinal: 1,
              index: 0,
              role: "user",
              text: question,
            },
          ],
        };
      }
      if (command instanceof TransactWriteCommand) {
        currentTurn = {
          ...currentTurn,
          status: "failed",
          phase: "failed",
          failure: { code: "result_timeout" },
          failedAt: new Date(reconciledAt).toISOString(),
          updatedAt: new Date(reconciledAt).toISOString(),
          answerManifest: { count: 0, complete: false },
        };
        currentMeta = {
          ...currentMeta,
          updatedAt: new Date(reconciledAt).toISOString(),
          historyOrder: `${new Date(reconciledAt).toISOString()}#${conversationId}`,
        };
        delete currentMeta.activeQueryId;
        delete currentMeta.activeOwnerAttemptId;
        return {};
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    });
    const { documentClient, store } = makeStore(send);
    if (!store) return;

    await expect(
      store.reconcileTurn({ sub, botId, conversationId, queryId, now: reconciledAt }),
    ).resolves.toMatchObject({
      status: "failed",
      failure: { code: "result_timeout" },
    });

    const transaction = transactionCommand(documentClient);
    expectOrderWrite(metaWrite(transaction), reconciledAt);
    expect(transaction.input.TransactItems).toHaveLength(2);
    expect(
      transaction.input.TransactItems.some((action) => action.Update.Key.sk.startsWith("USAGE#")),
    ).toBe(false);
  });
});
