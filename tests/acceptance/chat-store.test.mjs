import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

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

function equalityConditionValue(command, attribute) {
  const expression = command.input.ConditionExpression ?? "";
  const names = command.input.ExpressionAttributeNames ?? {};
  const values = command.input.ExpressionAttributeValues ?? {};
  const attributeToken =
    Object.entries(names).find(([, value]) => value === attribute)?.[0] ?? attribute;
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = expression.match(
    new RegExp(`(?:^|\\W)${escape(attributeToken)}\\s*=\\s*(:[A-Za-z0-9_]+)(?:\\W|$)`),
  );
  return match ? values[match[1]] : undefined;
}

function conditionRequiresEquality(command, attribute, expectedValue) {
  return equalityConditionValue(command, attribute) === expectedValue;
}

function expectScopedKey(item) {
  expect(item.pk).toBe(`CONV#${conversationId}`);
  expect(typeof item.sk).toBe("string");
}

function turnRecord(ordinal, requestId, overrides = {}) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}`,
    conversationId,
    queryId: requestId,
    ordinal,
    status: "completed",
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: 1, complete: true },
    ...overrides,
  };
}

function textChunk(ordinal, requestId, role, index, text) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}#${requestId}#${role.toUpperCase()}#${String(index).padStart(8, "0")}`,
    conversationId,
    queryId: requestId,
    role,
    index,
    text,
  };
}

function message(role, text) {
  return { role, content: [{ text }] };
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

  it("reconstructs every completed exchange in order across all consistent query pages", async () => {
    const firstId = "c0a9cf23-5413-4f97-8f88-b976c9c4d6c1";
    const secondId = "fcdd5a71-b6db-4ad9-a2c3-934cb56fe749";
    const thirdId = "d16d6a34-aa77-4c99-8985-712fdc7646c5";
    const fourthId = "eef19065-a8fb-410d-a034-0efc17762037";
    const firstPageEnd = textChunk(1, firstId, "assistant", 0, "Empezamos con una compra.");
    const secondPageEnd = textChunk(2, secondId, "assistant", 0, "Segunda respuesta");
    const pages = [
      {
        Items: [
          { pk: `CONV#${conversationId}`, sk: "META", ...owner, lastOrdinal: 4 },
          turnRecord(1, firstId, {
            questionManifest: { count: 2, complete: true },
            answerManifest: { count: 2, complete: true },
          }),
          firstPageEnd,
        ],
        LastEvaluatedKey: { pk: firstPageEnd.pk, sk: firstPageEnd.sk },
      },
      {
        Items: [
          textChunk(1, firstId, "assistant", 1, " con descuentos."),
          textChunk(1, firstId, "user", 0, "Armá una actividad"),
          textChunk(1, firstId, "user", 1, " de porcentajes."),
          turnRecord(2, secondId),
          secondPageEnd,
        ],
        LastEvaluatedKey: { pk: secondPageEnd.pk, sk: secondPageEnd.sk },
      },
      {
        Items: [
          textChunk(2, secondId, "user", 0, "¿Cómo lo comprueban?"),
          turnRecord(3, thirdId, {
            status: "in_progress",
            questionManifest: { count: 1, complete: true },
            answerManifest: { count: 1, complete: false },
          }),
          textChunk(3, thirdId, "assistant", 0, "Prefijo incompleto"),
          textChunk(3, thirdId, "user", 0, "Consulta todavía en curso"),
          turnRecord(4, fourthId, { status: "failed" }),
          textChunk(4, fourthId, "assistant", 0, "Respuesta parcial"),
          textChunk(4, fourthId, "user", 0, "Consulta fallida"),
        ],
      },
    ];
    const { documentClient, store } = makeStore(
      vi.fn(async (command) => {
        if (!(command instanceof QueryCommand)) throw new Error("expected a paginated Query");
        const page = pages.shift();
        if (!page) throw new Error("unexpected extra Query page");
        return page;
      }),
    );

    const context = await store.readContext({ conversationId });
    expect(context.messages).toEqual([
      message("user", "Armá una actividad de porcentajes."),
      message("assistant", "Empezamos con una compra. con descuentos."),
      message("user", "¿Cómo lo comprueban?"),
      message("assistant", "Segunda respuesta"),
    ]);

    const queries = documentClient.send.mock.calls.map(([command]) => command);
    expect(queries).toHaveLength(3);
    expect(queries.every((command) => command instanceof QueryCommand)).toBe(true);
    expect(queries.every(({ input }) => input.TableName === tableName)).toBe(true);
    expect(queries.every(({ input }) => input.ConsistentRead === true)).toBe(true);
    expect(queries.map(({ input }) => input.ExclusiveStartKey)).toEqual([
      undefined,
      { pk: firstPageEnd.pk, sk: firstPageEnd.sk },
      { pk: secondPageEnd.pk, sk: secondPageEnd.sk },
    ]);
    for (const { input } of queries) {
      expect(
        equalityConditionValue(
          { input: { ...input, ConditionExpression: input.KeyConditionExpression } },
          "pk",
        ),
      ).toBe(`CONV#${conversationId}`);
    }
  });

  it("returns an empty context when the conversation has no completed exchange", async () => {
    const pendingId = "c0a9cf23-5413-4f97-8f88-b976c9c4d6c1";
    const failedId = "fcdd5a71-b6db-4ad9-a2c3-934cb56fe749";
    const { store } = makeStore(
      vi.fn(async (command) => {
        if (!(command instanceof QueryCommand)) throw new Error("expected a paginated Query");
        return {
          Items: [
            turnRecord(1, pendingId, {
              status: "in_progress",
              answerManifest: { count: 1, complete: false },
            }),
            textChunk(1, pendingId, "user", 0, "Consulta pendiente"),
            turnRecord(2, failedId, { status: "failed" }),
            textChunk(2, failedId, "assistant", 0, "Prefijo fallido"),
          ],
        };
      }),
    );

    const context = await store.readContext({ conversationId });
    expect(context.messages).toEqual([]);
  });

  it.each([
    [
      "an incomplete question manifest",
      turnRecord(1, queryId, { questionManifest: { count: 1, complete: false } }),
      [
        textChunk(1, queryId, "user", 0, "Pregunta"),
        textChunk(1, queryId, "assistant", 0, "Respuesta"),
      ],
    ],
    [
      "a missing completed answer chunk",
      turnRecord(1, queryId, {
        questionManifest: { count: 1, complete: true },
        answerManifest: { count: 2, complete: true },
      }),
      [
        textChunk(1, queryId, "user", 0, "Pregunta"),
        textChunk(1, queryId, "assistant", 0, "Respuesta"),
      ],
    ],
    [
      "a completed chunk index gap",
      turnRecord(1, queryId, {
        questionManifest: { count: 2, complete: true },
        answerManifest: { count: 1, complete: true },
      }),
      [
        textChunk(1, queryId, "user", 0, "Parte uno"),
        textChunk(1, queryId, "user", 2, "Parte tres"),
        textChunk(1, queryId, "assistant", 0, "Respuesta"),
      ],
    ],
    [
      "a completed chunk for a different query",
      turnRecord(1, queryId),
      [
        textChunk(1, "c0a9cf23-5413-4f97-8f88-b976c9c4d6c1", "user", 0, "Pregunta"),
        textChunk(1, queryId, "assistant", 0, "Respuesta"),
      ],
    ],
    [
      "a completed answer chunk with the wrong role",
      turnRecord(1, queryId),
      [textChunk(1, queryId, "user", 0, "Pregunta"), textChunk(1, queryId, "user", 1, "Respuesta")],
    ],
    [
      "a duplicate completed chunk index",
      turnRecord(1, queryId),
      [
        textChunk(1, queryId, "user", 0, "Pregunta"),
        {
          ...textChunk(1, queryId, "user", 0, "Otra pregunta"),
          sk: textChunk(1, queryId, "user", 0, "Otra pregunta").sk + "#duplicate",
        },
        textChunk(1, queryId, "assistant", 0, "Respuesta"),
      ],
    ],
  ])(
    "fails the context read for %s instead of returning a truncated pair",
    async (_label, turn, chunks) => {
      const { store } = makeStore(
        vi.fn(async (command) => {
          if (!(command instanceof QueryCommand)) throw new Error("expected a paginated Query");
          return { Items: [turn, ...chunks] };
        }),
      );

      await expect(store.readContext({ conversationId })).rejects.toBeInstanceOf(Error);
    },
  );

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

  it("writes and publishes a continuation question under its allocated ordinal before returning", async () => {
    const { documentClient, store } = makeStore();

    const result = await store.continueTurn({
      ...startInput({ text: "Ahora adaptala para trabajar sin decimales." }),
      expectedLastOrdinal: 1,
      contextReferences: [],
    });

    expect(result).toMatchObject({ queryId, ordinal: 2 });
    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const allocationIndex = commands.findIndex(
      (command) => command instanceof TransactWriteCommand,
    );
    const publicationIndex = commands.findLastIndex(
      (command) =>
        command instanceof UpdateCommand &&
        Object.values(command.input.ExpressionAttributeNames ?? {}).includes("questionManifest"),
    );
    const questionIndexes = commands.flatMap((command, index) =>
      command instanceof PutCommand && command.input.Item.role === "user" ? [index] : [],
    );
    expect(allocationIndex).toBeGreaterThanOrEqual(0);
    expect(questionIndexes.length).toBeGreaterThan(0);
    expect(publicationIndex).toBeGreaterThan(allocationIndex);
    expect(
      questionIndexes.every((index) => index > allocationIndex && index < publicationIndex),
    ).toBe(true);

    const allocation = commands[allocationIndex];
    const turnPut = allocation.input.TransactItems.find(({ Put }) => Put)?.Put;
    expect(turnPut.Item).toMatchObject({
      ordinal: 2,
      queryId,
      status: "in_progress",
      profileSnapshot,
    });
    expect(turnPut.Item.questionManifest.complete).toBe(false);
    const questionChunks = questionIndexes.map((index) => commands[index].input.Item);
    expect(questionChunks.map(({ text }) => text).join("")).toBe(
      "Ahora adaptala para trabajar sin decimales.",
    );
    expect(
      questionChunks.every(
        ({ pk, sk, queryId: itemQueryId, role }) =>
          pk === `CONV#${conversationId}` &&
          sk.startsWith("TURN#00000002#") &&
          itemQueryId === queryId &&
          role === "user",
      ),
    ).toBe(true);
    expect(hasCompleteManifest(commands[publicationIndex].input.ExpressionAttributeValues)).toBe(
      true,
    );
    expect(conditionRequiresStatus(commands[publicationIndex], "in_progress")).toBe(true);
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

  it("allocates distinct continuation ordinals with a conditional META update and turn put", async () => {
    const expectedLastOrdinal = 4;
    const competing = { lastOrdinal: expectedLastOrdinal, committedOrdinals: [] };
    const send = vi.fn(async (command) => {
      if (!(command instanceof TransactWriteCommand)) return {};
      const update = command.input.TransactItems.find(({ Update }) => Update)?.Update;
      const put = command.input.TransactItems.find(({ Put }) => Put)?.Put;
      if (!update || !put) throw new Error("continuation allocation must be atomic");

      const expectedOrdinal = equalityConditionValue({ input: update }, "lastOrdinal");
      if (
        !conditionRequiresEquality({ input: update }, "lastOrdinal", competing.lastOrdinal) ||
        !Number.isSafeInteger(expectedOrdinal) ||
        put.Item.ordinal !== expectedOrdinal + 1
      ) {
        throw Object.assign(new Error("conditional allocation failed"), {
          name: "ConditionalCheckFailedException",
        });
      }
      competing.lastOrdinal = put.Item.ordinal;
      competing.committedOrdinals.push(put.Item.ordinal);
      return {};
    });
    const { documentClient, store } = makeStore(send);
    const nextTurn = (requestId) =>
      store.continueTurn({
        ...startInput({ queryId: requestId }),
        expectedLastOrdinal,
        contextReferences: [],
      });

    const outcomes = await Promise.allSettled([
      nextTurn("c0a9cf23-5413-4f97-8f88-b976c9c4d6c1"),
      nextTurn("fcdd5a71-b6db-4ad9-a2c3-934cb56fe749"),
    ]);

    const fulfilled = outcomes.filter(({ status }) => status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThan(0);
    expect(competing.committedOrdinals).toHaveLength(fulfilled.length);
    expect(new Set(competing.committedOrdinals).size).toBe(competing.committedOrdinals.length);

    const transactions = documentClient.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof TransactWriteCommand);
    expect(transactions.length).toBeGreaterThanOrEqual(2);
    const candidateItems = transactions.map((command) => {
      const update = command.input.TransactItems.find(({ Update }) => Update)?.Update;
      const put = command.input.TransactItems.find(({ Put }) => Put)?.Put;
      expect(update).toBeTruthy();
      expect(put).toBeTruthy();
      expect(update.TableName).toBe(tableName);
      expect(update.Key).toEqual({ pk: `CONV#${conversationId}`, sk: "META" });
      expect(put.TableName).toBe(tableName);
      expect(put.Item.profileSnapshot).toEqual(profileSnapshot);
      expect(/attribute_not_exists/.test(put.ConditionExpression)).toBe(true);
      const previousOrdinal = equalityConditionValue({ input: update }, "lastOrdinal");
      expect(Number.isSafeInteger(previousOrdinal)).toBe(true);
      expect(put.Item.ordinal).toBe(previousOrdinal + 1);
      return put.Item;
    });
    expect(
      candidateItems.every(({ ordinal, sk }) =>
        sk.startsWith(`TURN#${String(ordinal).padStart(8, "0")}`),
      ),
    ).toBe(true);
    expect(new Set(candidateItems.map(({ queryId: requestId }) => requestId)).size).toBe(2);
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
