import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const adapterPath = path.join(projectRoot, "runtime/conversation-store.ts");
const tableName = "conversations-aurora-dev";
const conversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const queryId = "a4bfbc9f-3699-4e93-b120-a03c0204bc67";
const owner = { sub: "teacher-123", botId: "bot-aurora" };
const profileSnapshot = {
  sub: owner.sub,
  botId: owner.botId,
  fields: {
    educationLevels: [{ id: "secundario", label: "Secundario" }],
    subjects: ["Matemática"],
  },
  responsePreferenceIds: ["ready-material"],
  promptTexts: ["Incluí materiales completos y listos para usar."],
  updatedAt: "2026-10-18T12:00:00.000Z",
  configurationRevision: "reviewed-revision-123",
};

let createConversationStoreAdapter;

function makeStore(send = vi.fn(async () => ({}))) {
  const documentClient = { send };
  const store =
    typeof createConversationStoreAdapter === "function"
      ? createConversationStoreAdapter({ documentClient, tableName })
      : null;
  return { documentClient, store };
}

function startInput(overrides = {}) {
  return {
    ...owner,
    conversationId,
    queryId,
    now: Date.parse("2026-10-19T16:00:00.000Z"),
    text: "Armá una actividad de porcentajes.",
    profileSnapshot,
    invocation: {
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "reviewed-revision-123",
    },
    ...overrides,
  };
}

function putItems(command) {
  if (command instanceof TransactWriteCommand) {
    return command.input.TransactItems.flatMap((action) => (action.Put ? [action.Put.Item] : []));
  }
  if (command instanceof PutCommand) return [command.input.Item];
  return [];
}

function allPutItems(documentClient) {
  return documentClient.send.mock.calls.flatMap(([command]) => putItems(command));
}

function conditionalExpression(command) {
  if (command instanceof PutCommand || command instanceof UpdateCommand) {
    return command.input.ConditionExpression ?? "";
  }
  return "";
}

function hasCompleteManifest(value) {
  if (!value || typeof value !== "object") return false;
  if (value.complete === true) return true;
  return Object.values(value).some(hasCompleteManifest);
}

function conditionRequiresStatus(command, expectedStatus) {
  const expression = command.input.ConditionExpression ?? "";
  const names = command.input.ExpressionAttributeNames ?? {};
  const statusAttribute =
    Object.entries(names).find(([, attribute]) => attribute === "status")?.[0] ?? "status";
  const escapedAttribute = statusAttribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = expression.match(new RegExp(`${escapedAttribute}\\s*=\\s*(:[A-Za-z0-9_]+)`));
  if (!match) return false;
  return command.input.ExpressionAttributeValues?.[match[1]] === expectedStatus;
}

function expectScopedKey(item) {
  expect(item.pk).toBe(`CONV#${conversationId}`);
  expect(typeof item.sk).toBe("string");
}

describe("the DynamoDB conversation store adapter", () => {
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

  it("reads META consistently from the conversation partition and returns its owner", async () => {
    const meta = {
      pk: `CONV#${conversationId}`,
      sk: "META",
      conversationId,
      ...owner,
      lastOrdinal: 4,
    };
    const { documentClient, store } = makeStore(vi.fn().mockResolvedValue({ Item: meta }));

    await expect(store.getMeta({ conversationId })).resolves.toMatchObject({
      conversationId,
      ...owner,
    });

    expect(documentClient.send).toHaveBeenCalledTimes(1);
    const command = documentClient.send.mock.calls[0][0];
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toEqual({
      TableName: tableName,
      Key: { pk: `CONV#${conversationId}`, sk: "META" },
      ConsistentRead: true,
    });
  });

  it("creates META and the first in-progress turn atomically with conditional puts", async () => {
    const { documentClient, store } = makeStore();

    const result = await store.startTurn(startInput());

    const transaction = documentClient.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof TransactWriteCommand);
    expect(transaction).toBeTruthy();
    expect(transaction.input.TransactItems).toHaveLength(2);
    const puts = transaction.input.TransactItems.map((action) => action.Put);
    expect(puts.every(Boolean)).toBe(true);
    expect(puts.every(({ TableName }) => TableName === tableName)).toBe(true);
    expect(
      puts.every(({ ConditionExpression = "" }) =>
        /attribute_not_exists/.test(ConditionExpression),
      ),
    ).toBe(true);

    const [metaPut, turnPut] = puts;
    expect(metaPut.Item).toMatchObject({
      pk: `CONV#${conversationId}`,
      sk: "META",
      conversationId,
      ...owner,
    });
    expect(turnPut.Item).toMatchObject({
      pk: `CONV#${conversationId}`,
      queryId,
      status: "in_progress",
      profileSnapshot,
    });
    expect(turnPut.Item.sk).toMatch(/^TURN#/);
    expect(result).toMatchObject({ queryId, ordinal: 1 });
    expect(documentClient.send.mock.calls.some(([command]) => command instanceof PutCommand)).toBe(
      true,
    );
  });

  it("does not treat a start collision as permission to replace another conversation", async () => {
    const collision = Object.assign(new Error("conditional write failed"), {
      name: "ConditionalCheckFailedException",
    });
    const send = vi.fn().mockRejectedValueOnce(collision);
    const { documentClient, store } = makeStore(send);

    await expect(store.startTurn(startInput())).rejects.toBe(collision);

    expect(documentClient.send).toHaveBeenCalledTimes(1);
    const command = documentClient.send.mock.calls[0][0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toHaveLength(2);
    expect(
      command.input.TransactItems.every(({ Put }) =>
        /attribute_not_exists/.test(Put.ConditionExpression),
      ),
    ).toBe(true);
  });

  it("writes question text and the server snapshot before startTurn returns", async () => {
    const { documentClient, store } = makeStore();

    await store.startTurn(startInput());

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const items = allPutItems(documentClient);
    const turn = items.find(
      ({ sk, status }) => typeof sk === "string" && sk.startsWith("TURN#") && status,
    );
    const content = items.filter(({ role }) => role === "user");
    expect(turn).toBeTruthy();
    expect(turn).toMatchObject({
      status: "in_progress",
      profileSnapshot,
    });
    expect(hasCompleteManifest(turn)).toBe(false);
    expect(content.map(({ text }) => text).join("")).toBe("Armá una actividad de porcentajes.");
    expect(content.every((item) => item.pk === `CONV#${conversationId}`)).toBe(true);
    expect(commands[0]).toBeInstanceOf(TransactWriteCommand);
    expect(commands.at(-1)).toBeInstanceOf(UpdateCommand);
    expect(commands.slice(1, -1).every((command) => command instanceof PutCommand)).toBe(true);
    expect(hasCompleteManifest(commands.at(-1).input.ExpressionAttributeValues)).toBe(true);
  });

  it("uses distinct conditional chunk keys scoped to the requested turn and role", async () => {
    const { documentClient, store } = makeStore();

    await store.appendChunk({ conversationId, queryId, role: "user", index: 0, text: "pregunta" });
    await store.appendChunk({
      conversationId,
      queryId,
      role: "assistant",
      index: 0,
      text: "respuesta",
    });
    await store.appendChunk({
      conversationId,
      queryId,
      role: "assistant",
      index: 1,
      text: " continuación",
    });
    await store.appendChunk({
      conversationId,
      queryId: "another-server-query-id",
      role: "assistant",
      index: 0,
      text: "otro turno",
    });

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    expect(commands.every((command) => command instanceof PutCommand)).toBe(true);
    const items = commands.map(({ input }) => input.Item);
    expect(items).toHaveLength(4);
    items.forEach(expectScopedKey);
    expect(new Set(items.map(({ sk }) => sk)).size).toBe(4);
    expect(items.map(({ role, index, text }) => ({ role, index, text }))).toEqual([
      { role: "user", index: 0, text: "pregunta" },
      { role: "assistant", index: 0, text: "respuesta" },
      { role: "assistant", index: 1, text: " continuación" },
      { role: "assistant", index: 0, text: "otro turno" },
    ]);
    expect(
      commands.every((command) => /attribute_not_exists/.test(conditionalExpression(command))),
    ).toBe(true);
  });

  it("splits a large UTF-8 question below the DynamoDB item ceiling without losing text", async () => {
    const largeQuestion = "¿Porcentajes? 🧮 á ".repeat(35_000);
    const { documentClient, store } = makeStore();

    await store.startTurn(startInput({ text: largeQuestion }));

    const items = allPutItems(documentClient).filter(({ role }) => role === "user");
    const questionItems = items.filter(({ role }) => role === "user");
    expect(questionItems.length).toBeGreaterThan(1);
    for (const item of items) {
      expect(Buffer.byteLength(JSON.stringify(item), "utf8")).toBeLessThan(400 * 1024);
      expect(() => Buffer.from(item.text, "utf8").toString("utf8")).not.toThrow();
    }
    expect(questionItems.map(({ text }) => text).join("")).toBe(largeQuestion);
  });

  it("commits completed or failed only from in_progress and never downgrades a completed turn", async () => {
    const unrelatedCondition = new UpdateCommand({
      ConditionExpression: "attribute_exists(#status) AND #stage = :from",
      ExpressionAttributeNames: { "#status": "status", "#stage": "stage" },
      ExpressionAttributeValues: { ":from": "in_progress" },
    });
    expect(conditionRequiresStatus(unrelatedCondition, "in_progress")).toBe(false);

    const turn = { status: "in_progress" };
    const send = vi.fn(async (command) => {
      if (!(command instanceof UpdateCommand)) return {};
      const values = Object.values(command.input.ExpressionAttributeValues ?? {});
      const nextStatus = values.find((value) => value === "completed" || value === "failed");
      const onlyFromInProgress = conditionRequiresStatus(command, "in_progress");
      if (!onlyFromInProgress || turn.status !== "in_progress") {
        throw Object.assign(new Error("conditional update failed"), {
          name: "ConditionalCheckFailedException",
        });
      }
      turn.status = nextStatus;
      return {};
    });
    const { documentClient, store } = makeStore(send);

    await store.completeTurn({
      conversationId,
      queryId,
      answerManifest: { count: 1, complete: true },
      invocation: { modelId: "global.anthropic.claude-sonnet-4-6" },
    });
    expect(turn.status).toBe("completed");
    await expect(
      store.failTurn({ conversationId, queryId, code: "provider_error" }),
    ).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
    expect(turn.status).toBe("completed");

    const updates = documentClient.send.mock.calls.map(([command]) => command);
    expect(updates).toHaveLength(2);
    expect(updates.every((command) => command instanceof UpdateCommand)).toBe(true);
    expect(updates.every((command) => conditionRequiresStatus(command, "in_progress"))).toBe(true);
    expect(
      updates.every(
        (command) => !JSON.stringify(command.input).includes(JSON.stringify(profileSnapshot)),
      ),
    ).toBe(true);
    expect(
      updates.map(({ input }) =>
        Object.values(input.ExpressionAttributeValues).find(
          (value) => value === "completed" || value === "failed",
        ),
      ),
    ).toEqual(["completed", "failed"]);
  });
});
