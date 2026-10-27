import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GetCommand,
  DeleteCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const historyStorePath = path.join(projectRoot, "runtime/history-store.ts");
const conversationStorePath = path.join(projectRoot, "runtime/conversation-store.ts");
const tableName = "conversations-aurora-dev";
const owner = { sub: "teacher-123", botId: "bot-aurora" };
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const queryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";
const now = Date.parse("2026-10-24T12:00:00.000Z");
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let createHistoryStore;
let createConversationStoreAdapter;

function makeHistoryStore(send = vi.fn(async () => ({})), storeNow = () => now) {
  const documentClient = { send };
  const store =
    typeof createHistoryStore === "function"
      ? createHistoryStore({
          documentClient,
          tableName,
          botId: owner.botId,
          historyIndexName: "ConversationHistory",
          now: storeNow,
        })
      : null;
  return { documentClient, store };
}

function requireMethod(store, methodName) {
  const method = store?.[methodName];
  expect(typeof method, `producto ausente: expected public store method ${methodName}`).toBe(
    "function",
  );
  return method.bind(store);
}

function meta(id = conversationId, overrides = {}) {
  return {
    pk: `CONV#${id}`,
    sk: "META",
    conversationId: id,
    ...owner,
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-24T11:00:00.000Z",
    lastOrdinal: 3,
    closed: false,
    historyOwner: `USER#${owner.sub}#BOT#${owner.botId}`,
    historyOrder: `2026-10-24T11:00:00.000Z#${id}`,
    historyLabel: "Actividad de porcentajes",
    ...overrides,
  };
}

function historyDescriptor(id, order = `2026-10-24T11:00:00.000Z#${id}`) {
  return {
    pk: `CONV#${id}`,
    sk: "META",
    historyOwner: `USER#${owner.sub}#BOT#${owner.botId}`,
    historyOrder: order,
  };
}

function conditionError() {
  return Object.assign(new Error("condition failed"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
}

function admissionInput(overrides = {}) {
  return {
    ...owner,
    conversationId,
    queryId,
    operation: "message",
    baseOrdinal: 3,
    expectedLastOrdinal: 3,
    now: Date.parse("2026-10-24T12:00:00.000Z"),
    ownerAttemptId: "attempt-admitted",
    resultDeadlineAt: Date.parse("2026-10-24T13:00:00.000Z"),
    text: "Armá una actividad de porcentajes.",
    profileSnapshot: { sub: owner.sub, botId: owner.botId, fields: {} },
    invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "runtime-r1" },
    quota: {
      daily: {
        used: 4,
        limit: 20,
        resetAt: Date.parse("2026-10-25T03:00:00.000Z"),
        period: "2026-10-24",
      },
      monthly: {
        used: 37,
        limit: 200,
        resetAt: Date.parse("2026-11-01T03:00:00.000Z"),
        period: "2026-10",
      },
      serverNow: Date.parse("2026-10-24T12:00:00.000Z"),
      blockedUntil: null,
      policyRevision: "policy-r1",
    },
    requestFingerprint: "sha256:stable-request-fingerprint",
    contextReferences: [],
    contextSnapshot: { version: 1, recentReferences: [] },
    documentContext: {
      knowledgeBaseId: "kb-aurora-dev",
      query: "porcentajes para secundaria",
      revision: "documents-r1",
      retrievedAt: Date.parse("2026-10-24T12:00:00.000Z"),
      status: "empty",
      results: [],
    },
    ...overrides,
  };
}

describe("the public history store removal contract", () => {
  beforeAll(async () => {
    const [history, conversation] = await Promise.all([
      import(pathToFileURL(historyStorePath).href),
      import(pathToFileURL(conversationStorePath).href),
    ]);
    createHistoryStore = history.createHistoryStore;
    createConversationStoreAdapter = conversation.createConversationStoreAdapter;
  });

  beforeEach(() => {
    expect(typeof createHistoryStore, "expected createHistoryStore").toBe("function");
    expect(typeof createConversationStoreAdapter, "expected createConversationStoreAdapter").toBe(
      "function",
    );
  });

  it("hides one owned META record with the server time and only a partial Update", async () => {
    const persisted = meta(conversationId, {
      questionOriginal: "PRIVATE_QUESTION_SENTINEL",
      answerOriginal: "PRIVATE_ANSWER_SENTINEL",
      profileSnapshot: { secret: "PRIVATE_PROFILE_SENTINEL" },
      dailyUsage: 4,
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand && command.input.Key.sk === "META") {
        return { Item: structuredClone(persisted) };
      }
      if (!(command instanceof UpdateCommand)) throw new Error("Unexpected store command");
      const input = command.input;
      const names = input.ExpressionAttributeNames ?? {};
      const values = input.ExpressionAttributeValues ?? {};
      const valueInCondition = (value) =>
        Object.entries(values).find(
          ([token, candidate]) => candidate === value && input.ConditionExpression?.includes(token),
        )?.[1];
      if (
        input.Key.pk !== persisted.pk ||
        input.Key.sk !== "META" ||
        persisted.sub !== valueInCondition(owner.sub) ||
        persisted.botId !== valueInCondition(owner.botId)
      ) {
        throw Object.assign(new Error("conditional write failed"), {
          name: "ConditionalCheckFailedException",
        });
      }
      const hiddenName = Object.entries(names).find(([, value]) => value === "hiddenAt")?.[0];
      if (hiddenName && persisted["hiddenAt"] === undefined) {
        const timestamp = Object.entries(values).find(
          ([token, value]) =>
            input.UpdateExpression.includes(token) &&
            typeof value === "string" &&
            Number.isFinite(Date.parse(value)),
        )?.[1];
        persisted.hiddenAt = timestamp;
      }
      const historyOwnerName = Object.entries(names).find(
        ([, value]) => value === "historyOwner",
      )?.[0];
      if (historyOwnerName && input.UpdateExpression.includes(`REMOVE ${historyOwnerName}`)) {
        delete persisted.historyOwner;
      }
      return { Attributes: structuredClone(persisted) };
    });
    const { documentClient, store } = makeHistoryStore(send);
    const hideConversation = requireMethod(store, "hideConversation");

    const result = await hideConversation({
      ...owner,
      conversationId,
      now: Date.parse("2001-01-01T00:00:00.000Z"),
    });

    expect(result).toEqual({
      version: 1,
      conversationId,
      hiddenAt: "2026-10-24T12:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|historyOwner|historyOrder|historyLabel/);
    expect(persisted).toMatchObject({
      questionOriginal: "PRIVATE_QUESTION_SENTINEL",
      answerOriginal: "PRIVATE_ANSWER_SENTINEL",
      profileSnapshot: { secret: "PRIVATE_PROFILE_SENTINEL" },
      dailyUsage: 4,
      hiddenAt: "2026-10-24T12:00:00.000Z",
      historyOrder: `2026-10-24T11:00:00.000Z#${conversationId}`,
      historyLabel: "Actividad de porcentajes",
    });
    expect(persisted.historyOwner).toBeUndefined();

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const reads = commands.filter(
      (command) => command instanceof GetCommand || command instanceof QueryCommand,
    );
    const writes = commands.filter(
      (command) =>
        command instanceof UpdateCommand ||
        command instanceof PutCommand ||
        command instanceof DeleteCommand ||
        command instanceof TransactWriteCommand,
    );
    expect(
      reads
        .filter((command) => command instanceof GetCommand)
        .every(({ input }) => input.Key.sk === "META"),
    ).toBe(true);
    expect(
      reads
        .filter((command) => command instanceof QueryCommand)
        .every(({ input }) => !/TURN#|SEND#|DOCUMENT#|CONTEXT#/.test(JSON.stringify(input))),
    ).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBeInstanceOf(UpdateCommand);
    const update = writes[0].input;
    expect(update.TableName).toBe(tableName);
    expect(update.Key).toEqual({ pk: `CONV#${conversationId}`, sk: "META" });
    expect(update.ConditionExpression).toBeTruthy();
    expect(Object.values(update.ExpressionAttributeNames)).toEqual(
      expect.arrayContaining(["sub", "botId", "hiddenAt", "historyOwner"]),
    );
    expect(Object.values(update.ExpressionAttributeValues)).toContain(owner.sub);
    expect(Object.values(update.ExpressionAttributeValues)).toContain(owner.botId);
    const conditionNames = update.ExpressionAttributeNames;
    const conditionValues = update.ExpressionAttributeValues;
    const subjectName = Object.entries(conditionNames).find(([, value]) => value === "sub")?.[0];
    const botName = Object.entries(conditionNames).find(([, value]) => value === "botId")?.[0];
    const subjectValue = Object.entries(conditionValues).find(
      ([, value]) => value === owner.sub,
    )?.[0];
    const botValue = Object.entries(conditionValues).find(
      ([, value]) => value === owner.botId,
    )?.[0];
    expect(update.ConditionExpression).toMatch(
      new RegExp(`${escapeRegex(subjectName)}\\s*=\\s*${escapeRegex(subjectValue)}`),
    );
    expect(update.ConditionExpression).toMatch(
      new RegExp(`${escapeRegex(botName)}\\s*=\\s*${escapeRegex(botValue)}`),
    );
    const partitionKeyName =
      Object.entries(conditionNames).find(([, value]) => value === "pk")?.[0] ?? "pk";
    expect(update.ConditionExpression).toMatch(
      new RegExp(`attribute_exists\\s*\\(\\s*${escapeRegex(partitionKeyName)}\\s*\\)`, "i"),
    );
    expect(update.UpdateExpression).toMatch(/SET .*if_not_exists/i);
    const names = update.ExpressionAttributeNames;
    const hiddenAtName = Object.entries(names).find(([, value]) => value === "hiddenAt")?.[0];
    const historyOwnerName = Object.entries(names).find(
      ([, value]) => value === "historyOwner",
    )?.[0];
    expect(update.UpdateExpression).toContain(hiddenAtName);
    expect(update.UpdateExpression).toContain(`REMOVE ${historyOwnerName}`);
    expect(update.UpdateExpression).not.toMatch(/REMOVE.*(historyOrder|historyLabel)/i);
  });

  it.each([
    ["missing META", undefined, owner],
    ["another subject", meta(conversationId, { sub: "someone-else" }), owner],
    ["another bot", meta(conversationId, { botId: "bot-other" }), owner],
  ])("does not create or hide a conversation when %s", async (_caseName, savedMeta, scope) => {
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand && command.input.Key.sk === "META") {
        return { Item: savedMeta ? structuredClone(savedMeta) : undefined };
      }
      if (!(command instanceof UpdateCommand)) throw new Error("Unexpected store command");
      const input = command.input;
      const values = Object.values(input.ExpressionAttributeValues ?? {});
      if (
        !savedMeta ||
        input.Key.pk !== `CONV#${conversationId}` ||
        input.Key.sk !== "META" ||
        savedMeta.sub !== scope.sub ||
        savedMeta.botId !== scope.botId ||
        !values.includes(scope.sub) ||
        !values.includes(scope.botId)
      ) {
        throw Object.assign(new Error("conditional write failed"), {
          name: "ConditionalCheckFailedException",
        });
      }
      return { Attributes: structuredClone(savedMeta) };
    });
    const { store } = makeHistoryStore(send);
    const hideConversation = requireMethod(store, "hideConversation");

    await expect(hideConversation({ ...scope, conversationId })).rejects.toBeDefined();

    const commands = send.mock.calls.map(([command]) => command);
    expect(
      commands
        .filter((command) => command instanceof GetCommand)
        .every((command) => command.input.Key.sk === "META"),
    ).toBe(true);
    const writes = commands.filter(
      (command) =>
        command instanceof UpdateCommand ||
        command instanceof PutCommand ||
        command instanceof DeleteCommand ||
        command instanceof TransactWriteCommand,
    );
    expect(writes.every((command) => command instanceof UpdateCommand)).toBe(true);
    expect(writes.length).toBeLessThanOrEqual(1);
    expect(
      writes.every(
        (command) =>
          command.input.Key.pk === `CONV#${conversationId}` && command.input.Key.sk === "META",
      ),
    ).toBe(true);
    expect(savedMeta?.hiddenAt).toBeUndefined();
  });

  it("keeps the first server timestamp across duplicate calls and a lost ACK retry", async () => {
    const persisted = meta();
    let first = true;
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand && command.input.Key.sk === "META") {
        return { Item: structuredClone(persisted) };
      }
      if (!(command instanceof UpdateCommand)) throw new Error("Unexpected store command");
      const input = command.input;
      const values = input.ExpressionAttributeValues ?? {};
      const serverTimestamp = Object.entries(values).find(
        ([token, value]) =>
          input.UpdateExpression.includes(token) &&
          typeof value === "string" &&
          Number.isFinite(Date.parse(value)),
      )?.[1];
      if (!persisted.hiddenAt) persisted.hiddenAt = serverTimestamp;
      delete persisted.historyOwner;
      if (first) {
        first = false;
        throw new Error("simulated lost Update acknowledgement");
      }
      return { Attributes: structuredClone(persisted) };
    });
    const { store } = makeHistoryStore(send);
    const hideConversation = requireMethod(store, "hideConversation");

    await expect(hideConversation({ ...owner, conversationId })).rejects.toThrow(
      "simulated lost Update acknowledgement",
    );
    await expect(hideConversation({ ...owner, conversationId, now: 1 })).resolves.toEqual({
      version: 1,
      conversationId,
      hiddenAt: "2026-10-24T12:00:00.000Z",
    });
    const updates = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof UpdateCommand);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.length).toBeLessThanOrEqual(2);
    expect(
      send.mock.calls
        .filter(([command]) => command instanceof GetCommand)
        .every(([command]) => command.input.Key.sk === "META"),
    ).toBe(true);
    expect(persisted.hiddenAt).toBe("2026-10-24T12:00:00.000Z");
  });

  it("returns brief visible metadata from one consistent META read", async () => {
    const savedMeta = meta(conversationId, {
      activeQueryId: queryId,
      questionOriginal: "PRIVATE_QUESTION_SENTINEL",
      answerOriginal: "PRIVATE_ANSWER_SENTINEL",
      contextSnapshot: { summary: "PRIVATE_CONTEXT_SENTINEL" },
      requestFingerprint: "PRIVATE_FINGERPRINT_SENTINEL",
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand && command.input.Key.sk === "META") {
        return { Item: savedMeta };
      }
      throw new Error(`Unexpected document command ${command.constructor.name}`);
    });
    const { documentClient, store } = makeHistoryStore(send);
    const readConversationMeta = requireMethod(store, "readConversationMeta");

    const summary = await readConversationMeta({ ...owner, conversationId });

    expect(summary).toEqual({
      version: 1,
      conversationId,
      label: "Actividad de porcentajes",
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-24T11:00:00.000Z",
      lastOrdinal: 3,
      closed: false,
      activeQueryId: queryId,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /PRIVATE_|historyOwner|historyOrder|profileSnapshot/,
    );
    expect(documentClient.send).toHaveBeenCalledTimes(1);
    expect(documentClient.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(documentClient.send.mock.calls[0][0].input).toMatchObject({
      TableName: tableName,
      Key: { pk: `CONV#${conversationId}`, sk: "META" },
      ConsistentRead: true,
    });
  });

  it("drops a stale GSI row when the consistent META read has any hiddenAt marker", async () => {
    const hiddenId = conversationId;
    const visibleId = "550e8400-e29b-41d4-a716-446655440001";
    const hiddenMeta = meta(hiddenId, { hiddenAt: "malformed-but-present" });
    delete hiddenMeta.historyOwner;
    delete hiddenMeta.historyLabel;
    const visibleMeta = meta(visibleId, { lastOrdinal: 1, historyLabel: "Otra conversación" });
    const send = vi.fn(async (command) => {
      if (command instanceof QueryCommand) {
        return { Items: [historyDescriptor(hiddenId), historyDescriptor(visibleId)] };
      }
      if (command instanceof GetCommand && command.input.Key.sk === "META") {
        const id = command.input.Key.pk.slice("CONV#".length);
        return { Item: id === hiddenId ? hiddenMeta : visibleMeta };
      }
      throw new Error(`Unexpected document command ${command.constructor.name}`);
    });
    const { documentClient, store } = makeHistoryStore(send);

    const result = await store.listConversations({ ...owner, limit: 2 });

    expect(result.conversations.map(({ conversationId: id }) => id)).toEqual([visibleId]);
    const metaReads = documentClient.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof GetCommand);
    expect(metaReads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: expect.objectContaining({
            Key: { pk: `CONV#${hiddenId}`, sk: "META" },
            ConsistentRead: true,
          }),
        }),
        expect.objectContaining({
          input: expect.objectContaining({
            Key: { pk: `CONV#${visibleId}`, sk: "META" },
            ConsistentRead: true,
          }),
        }),
      ]),
    );
    expect(metaReads.every(({ input }) => input.ConsistentRead === true)).toBe(true);
  });

  it("rejects old turn and text cursors after a conversation is hidden", async () => {
    const question = "Pregunta preservada.";
    const laterTurnQueryId = "c166b6c3-5c0d-4b45-a9da-77b675bed25b";
    const firstTurn = {
      pk: `CONV#${conversationId}`,
      sk: "TURN#00000001",
      conversationId,
      sub: owner.sub,
      botId: owner.botId,
      queryId,
      ordinal: 1,
      status: "completed",
      phase: "complete",
      operation: "start",
      baseOrdinal: 0,
      requestFingerprint: "current-start-fingerprint",
      ownerAttemptId: "attempt-first",
      resultDeadlineAt: now + 60 * 60 * 1000,
      questionManifest: { count: 17, complete: true },
      answerManifest: { count: 1, complete: true },
      cursor: 1,
      contextManifest: { count: 0, complete: true },
      contextSnapshot: { version: 1, recentReferences: [] },
      documentContextManifest: { count: 1, complete: true },
    };
    const laterTurn = {
      ...firstTurn,
      sk: "TURN#00000002",
      queryId: laterTurnQueryId,
      ordinal: 2,
      operation: "message",
      baseOrdinal: 1,
      questionManifest: { count: 1, complete: true },
    };
    const questionChunk = {
      pk: `CONV#${conversationId}`,
      sk: `TURN#00000001#${queryId}#USER#00000000`,
      conversationId,
      queryId,
      ordinal: 1,
      role: "user",
      index: 0,
      text: question,
    };
    const textChunks = Array.from({ length: 17 }, (_, index) => ({
      ...questionChunk,
      sk: `TURN#00000001#${queryId}#USER#${String(index).padStart(8, "0")}`,
      index,
      text: `question-${index}`,
    }));
    let hidden = false;
    const savedMeta = () => meta(conversationId, hidden ? { hiddenAt: null } : { lastOrdinal: 2 });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        if (command.input.Key.sk === "META") return { Item: savedMeta() };
        if (command.input.Key.sk === "TURN#00000001") return { Item: firstTurn };
        if (command.input.Key.sk === "TURN#00000002") return { Item: laterTurn };
      }
      if (command instanceof QueryCommand) {
        const items = command.input.ExpressionAttributeValues?.[":prefix"]?.includes("USER")
          ? textChunks
          : [questionChunk];
        const limit = command.input.Limit;
        return {
          Items: items.slice(0, limit),
          ...(items.length > limit
            ? { LastEvaluatedKey: { pk: items[limit - 1].pk, sk: items[limit - 1].sk } }
            : {}),
        };
      }
      throw new Error(`Unexpected document command ${command.constructor.name}`);
    });
    const { documentClient, store } = makeHistoryStore(send);

    const firstTurns = await store.readTurns({ ...owner, conversationId, limit: 1 });
    const firstText = await store.readText({
      ...owner,
      conversationId,
      ordinal: 1,
      queryId,
      role: "user",
    });
    expect(firstTurns.nextCursor).toBeTypeOf("string");
    expect(firstText.nextCursor).toBeTypeOf("string");

    hidden = true;
    const countBeforeHiddenReads = documentClient.send.mock.calls.length;
    await expect(
      store.readTurns({ ...owner, conversationId, limit: 1, cursor: firstTurns.nextCursor }),
    ).rejects.toBeDefined();
    await expect(
      store.readText({
        ...owner,
        conversationId,
        ordinal: 1,
        queryId,
        role: "user",
        cursor: firstText.nextCursor,
      }),
    ).rejects.toBeDefined();
    const hiddenCommands = documentClient.send.mock.calls
      .slice(countBeforeHiddenReads)
      .map(([command]) => command);
    expect(hiddenCommands.some((command) => command instanceof GetCommand)).toBe(true);
    expect(
      hiddenCommands.every(
        (command) => command instanceof GetCommand && command.input.Key.sk === "META",
      ),
    ).toBe(true);
  });
});

describe("conversation admission and terminal META updates", () => {
  beforeAll(async () => {
    if (typeof createConversationStoreAdapter !== "function") {
      const module = await import(pathToFileURL(conversationStorePath).href);
      createConversationStoreAdapter = module.createConversationStoreAdapter;
    }
  });

  it("conditions continuation admission on visible META in the same transaction as quota writes", async () => {
    const currentMeta = meta(conversationId, { lastOrdinal: 3 });
    const policy = {
      pk: `BOT#${owner.botId}`,
      sk: "QUOTA#POLICY",
      dailyLimit: 20,
      monthlyLimit: 200,
      revision: "policy-r1",
    };
    let attemptedTransaction;
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        if (command.input.Key.sk === "META") return { Item: structuredClone(currentMeta) };
        if (command.input.Key.sk === "QUOTA#POLICY") return { Item: policy };
        if (command.input.Key.sk.startsWith("USAGE#")) {
          return { Item: { ...command.input.Key, used: 4 } };
        }
        return {};
      }
      if (command instanceof TransactWriteCommand) {
        attemptedTransaction = command.input.TransactItems;
        currentMeta.hiddenAt = "2026-10-24T12:00:00.000Z";
        delete currentMeta.historyOwner;
        throw conditionError();
      }
      throw new Error(`Unexpected document command ${command.constructor.name}`);
    });
    const store = createConversationStoreAdapter({
      documentClient: { send },
      tableName,
      now: () => Date.parse("2026-10-24T12:00:00.000Z"),
    });

    await expect(store.continueTurn(admissionInput())).rejects.toBeDefined();

    expect(attemptedTransaction).toBeDefined();
    const metaUpdate = attemptedTransaction.find(
      ({ Update }) => Update?.Key?.sk === "META",
    )?.Update;
    expect(metaUpdate).toBeTruthy();
    const expressionNames = metaUpdate.ExpressionAttributeNames ?? {};
    const hiddenAtName = Object.entries(expressionNames).find(
      ([, value]) => value === "hiddenAt",
    )?.[0];
    expect(hiddenAtName).toBeTruthy();
    expect(metaUpdate.ConditionExpression).toContain("attribute_not_exists");
    expect(metaUpdate.ConditionExpression).toContain(hiddenAtName);
    for (const expected of [owner.sub, owner.botId, conversationId]) {
      const token = Object.entries(metaUpdate.ExpressionAttributeValues ?? {}).find(
        ([valueToken, value]) =>
          value === expected && metaUpdate.ConditionExpression.includes(valueToken),
      )?.[0];
      expect(token).toBeTruthy();
    }
    expect(
      attemptedTransaction.some(({ Update }) => Update?.Key?.sk?.startsWith("USAGE#DAY#")),
    ).toBe(true);
    expect(
      attemptedTransaction.some(({ Update }) => Update?.Key?.sk?.startsWith("USAGE#MONTH#")),
    ).toBe(true);
    expect(currentMeta).toMatchObject({ hiddenAt: "2026-10-24T12:00:00.000Z", lastOrdinal: 3 });
    expect(
      send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(1);
  });

  it.each([
    ["visible META read before hide", "complete", false],
    ["visible META read before hide", "fail", false],
    ["already hidden META", "complete", true],
    ["already hidden META", "fail", true],
  ])(
    "keeps ownership removed through %s and a %s terminal update",
    async (_timing, outcome, alreadyHidden) => {
      const hiddenAt = "2026-10-24T12:00:00.000Z";
      const turn = {
        pk: `CONV#${conversationId}`,
        sk: "TURN#00000004",
        conversationId,
        ...owner,
        queryId,
        ordinal: 4,
        operation: "message",
        baseOrdinal: 3,
        requestFingerprint: "current-followup-fingerprint",
        status: "in_progress",
        phase: "invocation_claimed",
        ownerAttemptId: "attempt-admitted",
        resultDeadlineAt: now + 60 * 60 * 1000,
        cursor: 0,
        questionManifest: { count: 1, complete: true },
        answerManifest: { count: 0, complete: false },
        contextManifest: { count: 0, complete: true },
        contextSnapshot: { version: 1, recentReferences: [] },
        documentContextManifest: { count: 1, complete: true },
        invocation: { modelId: "global.anthropic.claude-sonnet-4-6" },
      };
      const documentChunk = {
        pk: turn.pk,
        sk: "TURN#00000004#DOCUMENT#00000000",
        conversationId,
        queryId,
        ordinal: 4,
        index: 0,
        text: JSON.stringify({
          knowledgeBaseId: "kb-aurora-dev",
          query: "porcentajes para secundaria",
          revision: "documents-r1",
          retrievedAt: now,
          status: "empty",
          results: [],
        }),
      };
      const currentMeta = meta(conversationId, {
        lastOrdinal: 4,
        activeQueryId: queryId,
        activeOwnerAttemptId: "attempt-admitted",
        ...(alreadyHidden ? { hiddenAt } : {}),
      });
      if (alreadyHidden) delete currentMeta.historyOwner;
      let terminalTransaction;
      const send = vi.fn(async (command) => {
        if (command instanceof GetCommand) {
          if (command.input.Key.sk === "META") return { Item: structuredClone(currentMeta) };
          if (command.input.Key.sk === "TURN#00000004") return { Item: structuredClone(turn) };
          if (command.input.Key.sk === documentChunk.sk) {
            return { Item: structuredClone(documentChunk) };
          }
        }
        if (command instanceof TransactWriteCommand) {
          terminalTransaction = command.input.TransactItems;
          if (!alreadyHidden) {
            // The hide Update wins after the terminal read and before its transaction.
            currentMeta.hiddenAt = hiddenAt;
            delete currentMeta.historyOwner;
          }
          return {};
        }
        throw new Error(`Unexpected document command ${command.constructor.name}`);
      });
      const store = createConversationStoreAdapter({
        documentClient: { send },
        tableName,
        now: () => now,
      });

      if (outcome === "complete") {
        await store.completeTurn({
          conversationId,
          ordinal: 4,
          queryId,
          ownerAttemptId: "attempt-admitted",
          now,
          answerManifest: { count: 0, complete: true },
        });
      } else {
        await store.failTurn({
          conversationId,
          ordinal: 4,
          queryId,
          ownerAttemptId: "attempt-admitted",
          now,
          code: "provider_error",
          invocationClaimed: true,
          providerFinished: true,
          answerManifest: { count: 0, complete: false },
        });
      }

      const metaUpdate = terminalTransaction.find(
        ({ Update }) => Update?.Key?.sk === "META",
      )?.Update;
      expect(metaUpdate).toBeTruthy();
      const names = Object.values(metaUpdate.ExpressionAttributeNames ?? {});
      expect(names).not.toContain("historyOwner");
      expect(names).not.toContain("historyLabel");
      expect(names).not.toContain("hiddenAt");
      expect(metaUpdate.UpdateExpression).not.toMatch(/historyOwner|historyLabel|hiddenAt/i);
      expect(metaUpdate.UpdateExpression).toMatch(/REMOVE/i);
      expect(currentMeta.hiddenAt).toBe(hiddenAt);
      expect(currentMeta.historyOwner).toBeUndefined();
      expect(currentMeta.historyLabel).toBe("Actividad de porcentajes");
      expect(terminalTransaction.some(({ Update }) => Update?.Key?.sk.startsWith("TURN#"))).toBe(
        true,
      );
    },
  );
});
