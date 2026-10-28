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

function makeStore(
  send = vi.fn(async () => ({})),
  now = () => Date.parse("2026-10-19T16:00:00.000Z"),
) {
  const documentClient = { send };
  const store =
    typeof createConversationStoreAdapter === "function"
      ? createConversationStoreAdapter({ documentClient, tableName, now })
      : null;
  return { documentClient, store };
}

function startInput(overrides = {}) {
  const now = Date.parse("2026-10-19T16:00:00.000Z");
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
      knowledgeBaseId: "kb-docentes-dev",
      query: "Porcentajes para segundo año",
      revision: "documents-r14",
      retrievedAt: now,
      status: "empty",
      results: [],
    },
    invocation: {
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "reviewed-revision-123",
    },
    quota: {
      daily: {
        used: 4,
        limit: 20,
        resetAt: Date.parse("2026-10-20T03:00:00.000Z"),
        period: "2026-10-19",
      },
      monthly: {
        used: 37,
        limit: 200,
        resetAt: Date.parse("2026-11-01T03:00:00.000Z"),
        period: "2026-10",
      },
      serverNow: now,
      blockedUntil: null,
      policyRevision: "policy-r7",
    },
    requestFingerprint: "sha256:stable-request-fingerprint",
    ...overrides,
  };
}

function standaloneWrites(documentClient) {
  return documentClient.send.mock.calls.flatMap(([command]) => {
    if (command instanceof TransactWriteCommand) return [];
    return [command].filter(
      (candidate) => candidate instanceof PutCommand || candidate instanceof UpdateCommand,
    );
  });
}

function transactionActions(command) {
  return command.input.TransactItems;
}

function transactionCommands(documentClient) {
  return documentClient.send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof TransactWriteCommand);
}

function transactionUpdates(command) {
  return transactionActions(command).flatMap((action) => (action.Update ? [action.Update] : []));
}

function transactionItems(command) {
  return transactionActions(command).flatMap((action) =>
    action.Put?.Item ? [action.Put.Item] : [],
  );
}

function expressionValues(payload) {
  return Object.values(payload?.ExpressionAttributeValues ?? {});
}

function conditionBoundValues(payload) {
  const expression = payload?.ConditionExpression ?? "";
  const tokens = expression.match(/:[A-Za-z0-9_]+/g) ?? [];
  return [...new Set(tokens.map((token) => payload.ExpressionAttributeValues?.[token]))];
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

function namedAttributes(payload) {
  return Object.values(payload?.ExpressionAttributeNames ?? {});
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

function expectScopedKey(item) {
  expect(item.pk).toBe(`CONV#${conversationId}`);
  expect(typeof item.sk).toBe("string");
}

function turnRecord(ordinal, requestId, overrides = {}) {
  const status = overrides.status ?? "completed";
  const answerManifest = overrides.answerManifest ?? { count: 1, complete: status === "completed" };
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}`,
    conversationId,
    ...owner,
    queryId: requestId,
    ordinal,
    operation: ordinal === 1 ? "start" : "message",
    baseOrdinal: ordinal - 1,
    requestFingerprint: `fingerprint-${requestId}`,
    status,
    phase:
      status === "completed" ? "complete" : status === "failed" ? "failed" : "invocation_claimed",
    ownerAttemptId: `attempt-${ordinal}`,
    resultDeadlineAt: Date.parse("2026-10-19T17:00:00.000Z"),
    createdAt: "2026-10-19T16:00:00.000Z",
    updatedAt: "2026-10-19T16:00:00.000Z",
    cursor: answerManifest.count,
    questionManifest: { count: 1, complete: true },
    answerManifest,
    contextManifest: { count: 0, complete: true },
    contextSnapshot: { version: 1, recentReferences: [] },
    documentContextManifest: { count: 1, complete: true },
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
    ordinal,
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
      closed: false,
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

  it.each(["getMeta", "readContext"])(
    "rejects current-format META when the required closed field is missing in %s",
    async (method) => {
      const meta = {
        pk: `CONV#${conversationId}`,
        sk: "META",
        conversationId,
        ...owner,
        lastOrdinal: 4,
      };
      const send = vi.fn(async (command) => {
        if (command instanceof GetCommand) return { Item: meta };
        if (command instanceof QueryCommand) return { Items: [] };
        throw new Error(`Unexpected document operation: ${command.constructor.name}`);
      });
      const { store } = makeStore(send);

      await expect(store[method]({ conversationId })).rejects.toBeInstanceOf(Error);
      expect(send.mock.calls.some(([command]) => command instanceof QueryCommand)).toBe(false);
    },
  );

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
          { pk: `CONV#${conversationId}`, sk: "META", ...owner, lastOrdinal: 4, closed: false },
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
            phase: "invocation_claimed",
            ownerAttemptId: "attempt-third",
            resultDeadlineAt: Date.parse("2026-10-19T17:00:00.000Z"),
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
    const meta = {
      pk: `CONV#${conversationId}`,
      sk: "META",
      conversationId,
      ...owner,
      lastOrdinal: 4,
      closed: false,
      activeQueryId: thirdId,
      activeOwnerAttemptId: "attempt-third",
    };
    const { documentClient, store } = makeStore(
      vi.fn(async (command) => {
        if (command instanceof GetCommand) return { Item: meta };
        if (command instanceof QueryCommand) {
          const page = pages.shift();
          if (!page) throw new Error("unexpected extra Query page");
          return page;
        }
        throw new Error("expected a consistent META Get or paginated Query");
      }),
    );

    const context = await store.readContext({ conversationId });
    expect(context.messages).toEqual([
      message("user", "Armá una actividad de porcentajes."),
      message("assistant", "Empezamos con una compra. con descuentos."),
      message("user", "¿Cómo lo comprueban?"),
      message("assistant", "Segunda respuesta"),
    ]);

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const metaReads = commands.filter((command) => command instanceof GetCommand);
    const queries = commands.filter((command) => command instanceof QueryCommand);
    expect(metaReads).toHaveLength(1);
    expect(metaReads[0].input).toMatchObject({
      TableName: tableName,
      Key: { pk: `CONV#${conversationId}`, sk: "META" },
      ConsistentRead: true,
    });
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
        if (command instanceof GetCommand) {
          return {
            Item: {
              pk: `CONV#${conversationId}`,
              sk: "META",
              conversationId,
              ...owner,
              lastOrdinal: 2,
              closed: false,
              activeQueryId: pendingId,
              activeOwnerAttemptId: "attempt-pending",
            },
          };
        }
        if (command instanceof QueryCommand) {
          return {
            Items: [
              turnRecord(1, pendingId, {
                status: "in_progress",
                phase: "invocation_claimed",
                ownerAttemptId: "attempt-pending",
                resultDeadlineAt: Date.parse("2026-10-19T17:00:00.000Z"),
                answerManifest: { count: 1, complete: false },
              }),
              textChunk(1, pendingId, "user", 0, "Consulta pendiente"),
              turnRecord(2, failedId, { status: "failed" }),
              textChunk(2, failedId, "assistant", 0, "Prefijo fallido"),
            ],
          };
        }
        throw new Error("expected a consistent META Get or paginated Query");
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
          if (command instanceof GetCommand) {
            return {
              Item: {
                pk: `CONV#${conversationId}`,
                sk: "META",
                conversationId,
                ...owner,
                lastOrdinal: 1,
                closed: false,
              },
            };
          }
          if (command instanceof QueryCommand) return { Items: [turn, ...chunks] };
          throw new Error("expected a consistent META Get or paginated Query");
        }),
      );

      await expect(store.readContext({ conversationId })).rejects.toBeInstanceOf(Error);
    },
  );

  it("admits the first turn, its complete question and quota marker atomically", async () => {
    const { documentClient, store } = makeStore();

    const input = startInput();
    const result = await store.startTurn(input);

    const transaction = documentClient.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof TransactWriteCommand);
    expect(transaction).toBeTruthy();
    const items = transactionItems(transaction);
    const meta = items.find(({ sk }) => sk === "META");
    const turn = items.find(
      ({ sk, queryId: turnQueryId }) => String(sk).startsWith("TURN#") && turnQueryId === queryId,
    );
    const marker = items.find(({ sk }) => sk === "SEND#" + queryId);
    expect(meta).toMatchObject({
      pk: `CONV#${conversationId}`,
      sk: "META",
      conversationId,
      ...owner,
      closed: false,
    });
    expect(turn).toMatchObject({
      pk: `CONV#${conversationId}`,
      queryId,
      status: "in_progress",
      profileSnapshot,
    });
    expect(turn.sk).toMatch(/^TURN#/);
    expect(turn.questionManifest).toMatchObject({ count: 1, complete: true });
    expect(marker).toMatchObject({
      ...owner,
      queryId,
      requestFingerprint: input.requestFingerprint,
    });
    const markerPut = transactionActions(transaction).find(
      (action) => action.Put?.Item === marker,
    )?.Put;
    expect(markerPut?.ConditionExpression).toMatch(/attribute_not_exists/);
    expect(JSON.stringify(transaction.input)).toContain(input.quota.policyRevision);
    const questionChunks = items.filter(
      ({ role, queryId: chunkQueryId }) => role === "user" && chunkQueryId === queryId,
    );
    expect(questionChunks.map(({ text }) => text).join("")).toBe(input.text);
    expect(
      transactionActions(transaction)
        .filter((action) => action.Put?.Item?.role === "user")
        .every(({ Put }) => /attribute_not_exists/i.test(Put.ConditionExpression ?? "")),
    ).toBe(true);
    expect(result).toMatchObject({ queryId, ordinal: 1 });
    expect(standaloneWrites(documentClient)).toEqual([]);
  });

  it("admits and publishes a complete continuation question in the allocation transaction", async () => {
    const { documentClient, store } = makeStore();
    const input = startInput({ text: "Ahora adaptala para trabajar sin decimales." });

    const result = await store.continueTurn({
      ...input,
      operation: "message",
      baseOrdinal: 1,
      contextReferences: [],
    });

    expect(result).toMatchObject({ queryId, ordinal: 2 });
    const transactions = documentClient.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof TransactWriteCommand);
    expect(transactions).toHaveLength(1);
    const transaction = transactions[0];
    const items = transactionItems(transaction);
    const turn = items.find(
      ({ sk, queryId: turnQueryId }) => String(sk).startsWith("TURN#") && turnQueryId === queryId,
    );
    const questionChunks = items.filter(
      ({ role, queryId: chunkQueryId }) => role === "user" && chunkQueryId === queryId,
    );
    expect(turn).toMatchObject({
      ordinal: 2,
      queryId,
      status: "in_progress",
      profileSnapshot,
    });
    expect(turn.questionManifest).toMatchObject({
      count: questionChunks.length,
      complete: true,
    });
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
    expect(JSON.stringify(transaction.input)).toContain(input.quota.policyRevision);
    expect(standaloneWrites(documentClient)).toEqual([]);
  });

  it("does not treat a start collision as permission to replace another conversation", async () => {
    const collision = Object.assign(new Error("transaction canceled"), {
      name: "TransactionCanceledException",
    });
    const send = vi.fn(async (command) => {
      if (command instanceof TransactWriteCommand) throw collision;
      if (command instanceof GetCommand) return {};
      return {};
    });
    const { documentClient, store } = makeStore(send);

    await expect(store.startTurn(startInput())).rejects.toBeInstanceOf(Error);

    const transactions = transactionCommands(documentClient);
    expect(transactions).toHaveLength(1);
    const marker = transactionActions(transactions[0]).find(
      (action) => action.Put?.Item?.sk === "SEND#" + queryId,
    )?.Put;
    expect(marker).toBeTruthy();
    expect(marker.ConditionExpression).toMatch(/attribute_not_exists/i);
    expect(standaloneWrites(documentClient)).toEqual([]);
  });

  it("stores the original question and server profile in the admitted turn", async () => {
    const { documentClient, store } = makeStore();

    await store.startTurn(startInput());

    const transaction = transactionCommands(documentClient)[0];
    expect(transaction).toBeTruthy();
    const items = transactionItems(transaction);
    const turn = items.find(
      ({ sk, queryId: turnQueryId }) => String(sk).startsWith("TURN#") && turnQueryId === queryId,
    );
    const content = items.filter(
      ({ role, queryId: chunkQueryId }) => role === "user" && chunkQueryId === queryId,
    );
    expect(turn).toBeTruthy();
    expect(turn).toMatchObject({
      status: "in_progress",
      profileSnapshot,
    });
    expect(turn.questionManifest).toMatchObject({ count: content.length, complete: true });
    expect(content.map(({ text }) => text).join("")).toBe("Armá una actividad de porcentajes.");
    expect(content.every((item) => item.pk === `CONV#${conversationId}`)).toBe(true);
    expect(
      transactionActions(transaction)
        .filter((action) => action.Put?.Item?.role === "user")
        .every(({ Put }) => /attribute_not_exists/i.test(Put.ConditionExpression ?? "")),
    ).toBe(true);
    expect(standaloneWrites(documentClient)).toEqual([]);
  });

  it("conditions continuation admission on the observed ordinal and creates its turn atomically", async () => {
    const expectedLastOrdinal = 4;
    const input = startInput({ queryId: "fcdd5a71-b6db-4ad9-a2c3-934cb56fe749" });
    const { documentClient, store } = makeStore();

    await store.continueTurn({
      ...input,
      operation: "message",
      baseOrdinal: expectedLastOrdinal,
      contextReferences: [],
    });

    const transactions = transactionCommands(documentClient);
    expect(transactions).toHaveLength(1);
    const transaction = transactions[0];
    const meta = transactionUpdates(transaction).find(({ Key }) => Key?.sk === "META");
    const turn = transactionItems(transaction).find(
      ({ sk, queryId: turnQueryId }) =>
        String(sk).startsWith("TURN#") && turnQueryId === input.queryId,
    );
    expect(meta).toBeTruthy();
    expect(meta.ConditionExpression).toBeTruthy();
    expect(meta.ConditionExpression).toContain("#closed = :false");
    expect(meta.ConditionExpression).not.toMatch(/attribute_not_exists\(#closed\)/);
    expect(namedAttributes(meta).some((name) => /ordinal/i.test(name))).toBe(true);
    expect(expressionValues(meta)).toContain(expectedLastOrdinal);
    expect(turn).toMatchObject({
      ordinal: expectedLastOrdinal + 1,
      queryId: input.queryId,
      profileSnapshot,
      questionManifest: { complete: true },
    });
    expect(standaloneWrites(documentClient)).toEqual([]);
  });

  it("uses distinct conditional chunk keys scoped to the requested turn and role", async () => {
    const { documentClient, store } = makeStore();

    await store.appendChunk({
      conversationId,
      ordinal: 2,
      queryId,
      role: "assistant",
      index: 0,
      text: "respuesta",
      ownerAttemptId: "attempt-a",
      now: Date.parse("2026-10-19T16:01:00.000Z"),
    });
    await store.appendChunk({
      conversationId,
      ordinal: 2,
      queryId,
      role: "assistant",
      index: 1,
      text: " continuación",
      ownerAttemptId: "attempt-a",
      now: Date.parse("2026-10-19T16:01:01.000Z"),
    });

    const transactions = transactionCommands(documentClient);
    expect(transactions).toHaveLength(2);
    const items = transactions.map((transaction) => {
      const actions = transactionActions(transaction);
      const put = actions.find(({ Put }) => Put?.Item?.role === "assistant")?.Put;
      const cursor = actions.find(({ Update }) => Update?.Key?.sk?.startsWith("TURN#"))?.Update;
      expect(put).toBeTruthy();
      expect(cursor).toBeTruthy();
      expect(put.ConditionExpression).toMatch(/attribute_not_exists/i);
      expect(cursor.ConditionExpression).toBeTruthy();
      expect(conditionBoundValues(cursor)).toContain("attempt-a");
      return put.Item;
    });
    expect(items).toHaveLength(2);
    items.forEach(expectScopedKey);
    expect(new Set(items.map(({ sk }) => sk)).size).toBe(2);
    expect(items.map(({ role, index, text }) => ({ role, index, text }))).toEqual([
      { role: "assistant", index: 0, text: "respuesta" },
      { role: "assistant", index: 1, text: " continuación" },
    ]);
    expect(standaloneWrites(documentClient)).toEqual([]);
  });

  it("splits a large UTF-8 question below the DynamoDB item ceiling without losing text", async () => {
    const largeQuestion = "¿Porcentajes? 🧮 á ".repeat(35_000);
    const { documentClient, store } = makeStore();

    await store.startTurn(startInput({ text: largeQuestion }));

    const transaction = transactionCommands(documentClient)[0];
    expect(transaction).toBeTruthy();
    const items = transactionItems(transaction).filter(
      ({ role, queryId: itemQueryId }) => role === "user" && itemQueryId === queryId,
    );
    const questionItems = items;
    expect(questionItems.length).toBeGreaterThan(1);
    for (const item of items) {
      expect(Buffer.byteLength(JSON.stringify(item), "utf8")).toBeLessThan(400 * 1024);
      expect(() => Buffer.from(item.text, "utf8").toString("utf8")).not.toThrow();
    }
    expect(questionItems.map(({ text }) => text).join("")).toBe(largeQuestion);
    const turn = transactionItems(transaction).find(
      ({ sk, queryId: itemQueryId }) => String(sk).startsWith("TURN#") && itemQueryId === queryId,
    );
    expect(turn.questionManifest).toMatchObject({
      count: questionItems.length,
      complete: true,
    });
    expect(standaloneWrites(documentClient)).toEqual([]);
  });

  it("commits terminal state with the conversation release and guards against a completed-turn downgrade", async () => {
    const { documentClient, store } = makeStore();

    await store.completeTurn({
      conversationId,
      ordinal: 2,
      queryId,
      ownerAttemptId: "attempt-a",
      now: Date.parse("2026-10-19T17:00:00.000Z"),
      answerManifest: { count: 1, complete: true },
      invocation: { modelId: "global.anthropic.claude-sonnet-4-6" },
    });
    await store.failTurn({
      conversationId,
      ordinal: 2,
      queryId,
      ownerAttemptId: "attempt-a",
      code: "provider_error",
      invocationClaimed: true,
      providerFinished: true,
      now: Date.parse("2026-10-19T17:00:01.000Z"),
    });

    const transactions = transactionCommands(documentClient);
    expect(transactions).toHaveLength(2);
    for (const [index, transaction] of transactions.entries()) {
      const actions = transactionActions(transaction);
      const turn = actions.find(({ Update }) => Update?.Key?.sk?.startsWith("TURN#"))?.Update;
      const meta = actions.find(({ Update }) => Update?.Key?.sk === "META")?.Update;
      expect(turn).toBeTruthy();
      expect(turn.ConditionExpression).toBeTruthy();
      expect(namedAttributes(turn).some((name) => /status|stage|phase/i.test(name))).toBe(true);
      expect(conditionBoundValues(turn)).toContain("attempt-a");
      expect(conditionBoundValues(turn)).toContain("invocation_claimed");
      expect(
        conditionIncludesInstant(
          turn,
          index === 0
            ? Date.parse("2026-10-19T17:00:00.000Z")
            : Date.parse("2026-10-19T17:00:01.000Z"),
        ),
      ).toBe(true);
      expect(namedAttributes(turn).some((name) => /ownerAttemptId/i.test(name))).toBe(true);
      expect(namedAttributes(turn).some((name) => /status/i.test(name))).toBe(true);
      expect(namedAttributes(turn).some((name) => /deadline/i.test(name))).toBe(true);
      expect(expressionValues(turn)).toContain(index === 0 ? "completed" : "failed");
      const sourceStates = conditionBoundValues(turn);
      expect(sourceStates).not.toContain("completed");
      expect(meta).toBeTruthy();
      expect(meta.ConditionExpression).toBeTruthy();
      expect(conditionBoundValues(meta)).toContain(queryId);
      expect(namedAttributes(meta).some((name) => /activeQueryId/i.test(name))).toBe(true);
    }
    expect(standaloneWrites(documentClient)).toEqual([]);
  });
});
