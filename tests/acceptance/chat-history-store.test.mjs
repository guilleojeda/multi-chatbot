import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const storePath = path.join(projectRoot, "runtime/history-store.ts");
const tableName = "conversations-aurora-dev";
const owner = { sub: "teacher-123", botId: "bot-aurora" };
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const otherConversationId = "550e8400-e29b-41d4-a716-446655440001";
const queryIds = [
  "a4bfbc9f-3699-4a93-b120-a03c0204bc67",
  "b0d7cf70-ae36-49f4-a1b9-2837633a54ca",
  "c166b6c3-5c0d-4b45-a9da-77b675bed25b",
  "d277b7d4-6d1e-4c56-b19a-88c869cf36c6",
];

let createHistoryStore;

function makeStore(send = vi.fn(async () => ({})), botId = owner.botId) {
  const documentClient = { send };
  const store =
    typeof createHistoryStore === "function"
      ? createHistoryStore({
          documentClient,
          tableName,
          botId,
          historyIndexName: "ConversationHistory",
          now: () => Date.parse("2026-10-24T12:00:00.000Z"),
        })
      : null;
  return { documentClient, store };
}

function meta(id = conversationId, overrides = {}) {
  return {
    pk: `CONV#${id}`,
    sk: "META",
    conversationId: id,
    ...owner,
    lastOrdinal: 1,
    closed: false,
    historyOwner: `USER#${owner.sub}#BOT#${owner.botId}`,
    historyOrder: `0000#${id}`,
    historyLabel: "Actividad de porcentajes",
    ...overrides,
  };
}

function legacyMeta(id) {
  const item = meta(id, { activeQueryId: undefined, lastOrdinal: 2, historyLabel: "Geometría" });
  delete item.closed;
  return item;
}

function historyDescriptor(id, historyOrder = `0000#${id}`, scope = owner) {
  return {
    pk: `CONV#${id}`,
    sk: "META",
    historyOwner: `USER#${scope.sub}#BOT#${scope.botId}`,
    historyOrder,
  };
}

function turn(ordinal, queryId, overrides = {}) {
  const status = overrides.status ?? "completed";
  const phase =
    overrides.phase ??
    { completed: "complete", failed: "failed", in_progress: "invocation_claimed" }[status] ??
    "complete";
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}`,
    conversationId,
    sub: owner.sub,
    botId: owner.botId,
    queryId,
    ordinal,
    status,
    phase,
    operation: ordinal === 1 ? "start" : "message",
    baseOrdinal: ordinal - 1,
    ownerAttemptId: `attempt-${ordinal}`,
    requestFingerprint: `fingerprint-${ordinal}`,
    resultDeadlineAt: Date.parse("2026-10-24T13:00:00.000Z"),
    createdAt: "2026-10-24T11:00:00.000Z",
    updatedAt: "2026-10-24T11:00:00.000Z",
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: status === "completed" ? 1 : 0, complete: status === "completed" },
    cursor: status === "completed" ? 1 : 0,
    ...overrides,
  };
}

function textChunk(ordinal, queryId, role, index, text) {
  const roleKey = role.toUpperCase();
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}#${queryId}#${roleKey}#${String(index).padStart(8, "0")}`,
    conversationId,
    queryId,
    role,
    ordinal,
    index,
    text,
  };
}

function commands(documentClient) {
  return documentClient.send.mock.calls.map(([command]) => command);
}

function getKey(command) {
  return command.input.Key ?? {};
}

function expectNoPrivateFields(value) {
  expect(JSON.stringify(value)).not.toMatch(
    /profileSnapshot|profile|#DOCUMENT#|#CONTEXT#|documentContext|contextManifest|fingerprint|ownerAttemptId/i,
  );
}

describe("the public DynamoDB history store", () => {
  beforeAll(async () => {
    if (!existsSync(storePath)) return;
    const module = await import(pathToFileURL(storePath).href);
    createHistoryStore = module.createHistoryStore;
  });

  beforeEach(() => {
    expect(existsSync(storePath), "Expected runtime/history-store.ts").toBe(true);
    expect(typeof createHistoryStore, "Expected exported createHistoryStore").toBe("function");
  });

  it("exports the history store required by the chat history API", () => {
    expect(existsSync(storePath), "Expected runtime/history-store.ts").toBe(true);
    expect(typeof createHistoryStore, "Expected exported createHistoryStore").toBe("function");
  });

  it("lists GSI descriptors through consistent owned META reads", async () => {
    const firstId = conversationId;
    const staleForeignId = otherConversationId;
    const secondId = "550e8400-e29b-41d4-a716-446655440002";
    const firstOrder = `2026-10-24T11:00:00.000Z#${firstId}`;
    const pages = [
      {
        Items: [historyDescriptor(firstId, firstOrder), historyDescriptor(firstId, firstOrder)],
        LastEvaluatedKey: historyDescriptor(firstId, firstOrder),
      },
      {
        Items: [
          historyDescriptor(staleForeignId, `2026-10-24T10:00:00.000Z#${staleForeignId}`),
          historyDescriptor(secondId),
        ],
      },
    ];
    const reads = new Map([
      [
        firstId,
        meta(firstId, {
          createdAt: "2026-10-20T10:00:00.000Z",
          updatedAt: "2026-10-24T11:00:00.000Z",
          historyOrder: firstOrder,
          lastOrdinal: 3,
        }),
      ],
      [staleForeignId, meta(staleForeignId, { sub: "someone-else" })],
      [secondId, legacyMeta(secondId)],
    ]);
    const send = vi.fn(async (command) => {
      if (command instanceof QueryCommand) {
        const page = pages.shift();
        if (!page) throw new Error("Unexpected extra history-index query");
        return page;
      }
      if (command instanceof GetCommand) return { Item: reads.get(getKey(command).pk.slice(5)) };
      throw new Error(`Unexpected document operation: ${command.constructor.name}`);
    });
    const { documentClient, store } = makeStore(send);

    const result = await store.listConversations({ ...owner, limit: 2 });

    expect(result).toMatchObject({
      conversations: [
        {
          conversationId: firstId,
          label: "Actividad de porcentajes",
          createdAt: "2026-10-20T10:00:00.000Z",
          updatedAt: "2026-10-24T11:00:00.000Z",
          lastOrdinal: 3,
          closed: false,
        },
        { conversationId: secondId, label: "Geometría", lastOrdinal: 2, closed: false },
      ],
    });
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[1].createdAt).toBeUndefined();
    expect(result.conversations[1].updatedAt).toBeUndefined();
    expect(result.conversations[1].activeQueryId).toBeUndefined();
    expectNoPrivateFields(result);

    const sent = commands(documentClient);
    const indexQueries = sent.filter((command) => command instanceof QueryCommand);
    const metaReads = sent.filter((command) => command instanceof GetCommand);
    expect(indexQueries).toHaveLength(2);
    expect(indexQueries.every(({ input }) => input.IndexName === "ConversationHistory")).toBe(true);
    expect(indexQueries.every(({ input }) => input.TableName === tableName)).toBe(true);
    expect(indexQueries.every(({ input }) => input.ConsistentRead !== true)).toBe(true);
    expect(indexQueries.every(({ input }) => input.ScanIndexForward === false)).toBe(true);
    expect(
      indexQueries.every(({ input }) =>
        JSON.stringify(input).includes(`USER#${owner.sub}#BOT#${owner.botId}`),
      ),
    ).toBe(true);
    expect(
      indexQueries.every(({ input }) => Number.isSafeInteger(input.Limit) && input.Limit > 0),
    ).toBe(true);
    expect(indexQueries[1].input.ExclusiveStartKey).toEqual(historyDescriptor(firstId, firstOrder));
    expect(metaReads).toHaveLength(3);
    expect(metaReads.every(({ input }) => input.ConsistentRead === true)).toBe(true);
    expect(metaReads.every(({ input }) => input.Key.sk === "META")).toBe(true);
    expect(metaReads.filter(({ input }) => input.Key.pk === `CONV#${firstId}`)).toHaveLength(1);
    expect(sent.some((command) => JSON.stringify(command.input).includes("SEND#"))).toBe(false);
  });

  it.each([
    ["another subject", { sub: "someone-else" }],
    ["another chatbot", { botId: "bot-other" }],
  ])("checks META ownership before reading turns or text for %s", async (_label, wrongOwner) => {
    for (const method of ["readTurns", "readText"]) {
      const send = vi.fn(async (command) => {
        if (command instanceof GetCommand) {
          return { Item: meta(conversationId, wrongOwner) };
        }
        throw new Error(`History data was read before ownership: ${command.constructor.name}`);
      });
      const { documentClient, store } = makeStore(send);

      const input = {
        ...owner,
        conversationId,
        limit: 1,
        ordinal: 1,
        queryId: queryIds[0],
        role: "user",
      };
      await expect(store[method](input)).rejects.toBeInstanceOf(Error);

      const sent = commands(documentClient);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toBeInstanceOf(GetCommand);
      expect(sent[0].input.Key).toEqual({ pk: `CONV#${conversationId}`, sk: "META" });
      expect(sent[0].input.ConsistentRead).toBe(true);
    }
  });

  it("rejects a list cursor issued in another subject's scope", async () => {
    const foreignSub = "teacher-456";
    const pages = [
      {
        Items: [
          historyDescriptor(conversationId, `0000#${conversationId}`, {
            sub: foreignSub,
            botId: owner.botId,
          }),
          historyDescriptor(otherConversationId, `0000#${otherConversationId}`, {
            sub: foreignSub,
            botId: owner.botId,
          }),
        ],
        LastEvaluatedKey: historyDescriptor(otherConversationId, `0000#${otherConversationId}`, {
          sub: foreignSub,
          botId: owner.botId,
        }),
      },
    ];
    const send = vi.fn(async (command) => {
      if (command instanceof QueryCommand) return pages.shift() ?? {};
      if (command instanceof GetCommand) return { Item: meta(conversationId, { sub: foreignSub }) };
      throw new Error(`Unexpected document operation: ${command.constructor.name}`);
    });
    const { store } = makeStore(send);
    const foreign = await store.listConversations({
      sub: foreignSub,
      botId: owner.botId,
      limit: 1,
    });

    expect(typeof foreign.nextCursor).toBe("string");
    await expect(
      store.listConversations({ ...owner, limit: 1, cursor: foreign.nextCursor }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("starts with recent turns and pages earlier without changing the initial ordinal", async () => {
    const firstMeta = meta(conversationId, { lastOrdinal: 3, activeQueryId: queryIds[2] });
    const laterMeta = meta(conversationId, { lastOrdinal: 4, activeQueryId: queryIds[3] });
    const queryPages = [
      {
        Items: [
          turn(3, queryIds[2], {
            status: "in_progress",
            answerManifest: { count: 2, complete: false },
            cursor: 2,
            profileSnapshot: { promptTexts: ["private profile text"] },
          }),
          turn(2, queryIds[1], {
            status: "failed",
            failure: { code: "model_failure" },
            answerManifest: { count: 2, complete: false },
            cursor: 2,
            requestFingerprint: "private-fingerprint",
            ownerAttemptId: "private-attempt",
            contextManifest: { count: 1, complete: true },
          }),
        ],
        LastEvaluatedKey: {
          pk: `CONV#${conversationId}`,
          sk: "TURN#00000002",
        },
      },
      {
        Items: [turn(1, queryIds[0]), turn(4, queryIds[3])],
      },
    ];
    const metas = [firstMeta, laterMeta];
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: metas.shift() };
      if (command instanceof QueryCommand) return queryPages.shift() ?? {};
      throw new Error(`Unexpected document operation: ${command.constructor.name}`);
    });
    const { documentClient, store } = makeStore(send);

    const first = await store.readTurns({ ...owner, conversationId, limit: 2 });
    expect(first).toMatchObject({
      version: 1,
      conversationId,
      throughOrdinal: 3,
      closed: false,
      canContinue: false,
      turns: [
        {
          ordinal: 2,
          queryId: queryIds[1],
          status: "failed",
          failure: { code: "model_failure" },
        },
        { ordinal: 3, queryId: queryIds[2], status: "in_progress", cursor: 2 },
      ],
    });
    expect(first.turns.map(({ ordinal }) => ordinal)).toEqual([2, 3]);
    expect(typeof first.nextCursor).toBe("string");
    expectNoPrivateFields(first);

    const second = await store.readTurns({
      ...owner,
      conversationId,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second).toMatchObject({
      conversationId,
      throughOrdinal: 3,
      closed: false,
      canContinue: false,
      turns: [{ ordinal: 1, queryId: queryIds[0], status: "completed" }],
    });
    expect(second.turns).toHaveLength(1);
    expect(second.turns.some(({ ordinal }) => ordinal === 4)).toBe(false);
    expect(second.turns.map(({ ordinal }) => ordinal)).toEqual([1]);
    expectNoPrivateFields(second);

    const sent = commands(documentClient);
    const reads = sent.filter((command) => command instanceof GetCommand);
    const queries = sent.filter((command) => command instanceof QueryCommand);
    expect(reads).toHaveLength(2);
    expect(reads.every(({ input }) => input.ConsistentRead === true)).toBe(true);
    expect(queries).toHaveLength(2);
    expect(queries.every(({ input }) => input.ConsistentRead === true)).toBe(true);
    expect(queries.every(({ input }) => input.ScanIndexForward === false)).toBe(true);
    expect(queries.every(({ input }) => Number.isSafeInteger(input.Limit) && input.Limit > 0)).toBe(
      true,
    );
    expect(queries[1].input.ExclusiveStartKey).toEqual({
      pk: `CONV#${conversationId}`,
      sk: "TURN#00000002",
    });
    expect(sent.some((command) => JSON.stringify(command.input).includes("SEND#"))).toBe(false);
  });

  it("marks an open conversation with a completed latest turn as continuable", async () => {
    const completedTurn = turn(1, queryIds[0]);
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: meta() };
      if (command instanceof QueryCommand) return { Items: [completedTurn] };
      throw new Error(`Unexpected document operation: ${command.constructor.name}`);
    });
    const { store } = makeStore(send);

    const page = await store.readTurns({ ...owner, conversationId, limit: 5 });

    expect(page).toMatchObject({
      throughOrdinal: 1,
      closed: false,
      canContinue: true,
      turns: [{ ordinal: 1, status: "completed" }],
    });
  });

  it("lists and restores persisted turns through a fresh store instance", async () => {
    const updatedAt = "2026-10-24T11:00:00.000Z";
    const savedMeta = meta(conversationId, {
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt,
      historyOrder: `${updatedAt}#${conversationId}`,
    });
    const savedTurn = turn(1, queryIds[0]);
    const question = textChunk(1, queryIds[0], "user", 0, "Armá una actividad.");
    const answer = textChunk(1, queryIds[0], "assistant", 0, "Con material y rúbrica.");
    const queryPages = [
      { Items: [historyDescriptor(conversationId, savedMeta.historyOrder)] },
      { Items: [savedTurn] },
      { Items: [question] },
      { Items: [answer] },
    ];
    const send = vi.fn(async (command) => {
      if (command instanceof QueryCommand) return queryPages.shift() ?? {};
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? savedMeta : savedTurn };
      }
      throw new Error(`Unexpected document operation: ${command.constructor.name}`);
    });

    const firstProcess = makeStore(send).store;
    const history = await firstProcess.listConversations({ ...owner, limit: 1 });
    expect(history.conversations).toMatchObject([{ conversationId, lastOrdinal: 1 }]);

    const restartedProcess = makeStore(send).store;
    const turns = await restartedProcess.readTurns({ ...owner, conversationId, limit: 1 });
    expect(turns.turns).toMatchObject([{ ordinal: 1, queryId: queryIds[0], status: "completed" }]);

    const restoredQuestion = await restartedProcess.readText({
      ...owner,
      conversationId,
      ordinal: 1,
      queryId: queryIds[0],
      role: "user",
    });
    const restoredAnswer = await restartedProcess.readText({
      ...owner,
      conversationId,
      ordinal: 1,
      queryId: queryIds[0],
      role: "assistant",
    });
    expect(restoredQuestion.chunks).toEqual([{ index: 0, text: question.text }]);
    expect(restoredAnswer.chunks).toEqual([{ index: 0, text: answer.text }]);
    expect(
      commands({ send }).some((command) => JSON.stringify(command.input).includes("SEND#")),
    ).toBe(false);
  });

  it("loads a frozen answer prefix without mistaking it for remote completion", async () => {
    const frozenTurn = turn(1, queryIds[0], {
      status: "in_progress",
      answerManifest: { count: 9, complete: false },
      cursor: 9,
    });
    const pages = [
      {
        Items: [0, 1, 2, 3].map((index) =>
          textChunk(1, queryIds[0], "assistant", index, `p${index}`),
        ),
        LastEvaluatedKey: textChunk(1, queryIds[0], "assistant", 3, "p3"),
      },
      {
        Items: [4, 5, 6, 7, 8].map((index) =>
          textChunk(1, queryIds[0], "assistant", index, `p${index}`),
        ),
      },
    ];
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? meta() : frozenTurn };
      }
      if (command instanceof QueryCommand) return pages.shift() ?? {};
      throw new Error(`Unexpected document operation: ${command.constructor.name}`);
    });
    const { documentClient, store } = makeStore(send);

    const first = await store.readText({
      ...owner,
      conversationId,
      ordinal: 1,
      queryId: queryIds[0],
      role: "assistant",
      throughCursor: 7,
    });
    expect(first).toMatchObject({
      version: 1,
      conversationId,
      ordinal: 1,
      queryId: queryIds[0],
      role: "assistant",
      chunks: [
        { index: 0, text: "p0" },
        { index: 1, text: "p1" },
        { index: 2, text: "p2" },
        { index: 3, text: "p3" },
      ],
      complete: false,
    });
    expect(typeof first.nextCursor).toBe("string");

    await expect(
      store.readText({
        ...owner,
        conversationId,
        ordinal: 1,
        queryId: queryIds[0],
        role: "user",
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(
      commands(documentClient).filter((command) => command instanceof QueryCommand),
    ).toHaveLength(1);

    const second = await store.readText({
      ...owner,
      conversationId,
      ordinal: 1,
      queryId: queryIds[0],
      role: "assistant",
      throughCursor: 7,
      cursor: first.nextCursor,
    });
    expect(second.chunks).toEqual([
      { index: 4, text: "p4" },
      { index: 5, text: "p5" },
      { index: 6, text: "p6" },
    ]);
    expect(second.complete).toBe(true);
    expect(second).not.toHaveProperty("nextCursor");
    expectNoPrivateFields(first);
    expectNoPrivateFields(second);

    const sent = commands(documentClient);
    const textQueries = sent.filter((command) => command instanceof QueryCommand);
    expect(textQueries).toHaveLength(2);
    expect(textQueries.every(({ input }) => input.ConsistentRead === true)).toBe(true);
    expect(
      textQueries.every(({ input }) => Number.isSafeInteger(input.Limit) && input.Limit > 0),
    ).toBe(true);
    expect(textQueries[1].input.ExclusiveStartKey).toEqual(
      textChunk(1, queryIds[0], "assistant", 3, "p3"),
    );
    expect(
      textQueries.every(
        ({ input }) =>
          !JSON.stringify(input).includes("#DOCUMENT#") &&
          !JSON.stringify(input).includes("#CONTEXT#"),
      ),
    ).toBe(true);
    expect(sent.some((command) => JSON.stringify(command.input).includes("SEND#"))).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThan(3 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(second), "utf8")).toBeLessThan(3 * 1024 * 1024);
  });

  it("keeps a completed turn distinct from a text page that has not loaded its full prefix", async () => {
    const completedTurn = turn(1, queryIds[0], {
      answerManifest: { count: 5, complete: true },
      cursor: 5,
    });
    const queryPages = [
      { Items: [completedTurn] },
      {
        Items: [0, 1].map((index) => textChunk(1, queryIds[0], "assistant", index, `p${index}`)),
        LastEvaluatedKey: textChunk(1, queryIds[0], "assistant", 1, "p1"),
      },
      {
        Items: [2, 3, 4].map((index) => textChunk(1, queryIds[0], "assistant", index, `p${index}`)),
      },
    ];
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? meta() : completedTurn };
      }
      if (command instanceof QueryCommand) return queryPages.shift() ?? {};
      throw new Error(`Unexpected document operation: ${command.constructor.name}`);
    });
    const { store } = makeStore(send);

    const turns = await store.readTurns({ ...owner, conversationId, limit: 1 });
    expect(turns.turns).toMatchObject([{ ordinal: 1, status: "completed" }]);
    expect(turns.turns[0].answerManifest).toEqual({ count: 5, complete: true });

    const first = await store.readText({
      ...owner,
      conversationId,
      ordinal: 1,
      queryId: queryIds[0],
      role: "assistant",
      throughCursor: 5,
    });
    expect(first.chunks).toEqual([
      { index: 0, text: "p0" },
      { index: 1, text: "p1" },
    ]);
    expect(first.complete).toBe(false);

    const second = await store.readText({
      ...owner,
      conversationId,
      ordinal: 1,
      queryId: queryIds[0],
      role: "assistant",
      throughCursor: 5,
      cursor: first.nextCursor,
    });
    expect(second.chunks).toEqual([
      { index: 2, text: "p2" },
      { index: 3, text: "p3" },
      { index: 4, text: "p4" },
    ]);
    expect(second.complete).toBe(true);
  });

  it.each([
    [
      "an index gap",
      [
        textChunk(1, queryIds[0], "user", 0, "Pregunta"),
        textChunk(1, queryIds[0], "user", 2, "fin"),
      ],
      { questionManifest: { count: 2, complete: true } },
    ],
    [
      "a chunk from a different query",
      [
        textChunk(1, queryIds[1], "user", 0, "Otra consulta"),
        textChunk(1, queryIds[0], "user", 1, "fin"),
      ],
      { questionManifest: { count: 2, complete: true } },
    ],
    [
      "a chunk from another ordinal",
      [
        textChunk(2, queryIds[0], "user", 0, "Pregunta"),
        textChunk(1, queryIds[0], "user", 1, "fin"),
      ],
      { questionManifest: { count: 2, complete: true } },
    ],
    [
      "a chunk with the wrong role",
      [
        textChunk(1, queryIds[0], "assistant", 0, "No es la pregunta"),
        textChunk(1, queryIds[0], "user", 1, "fin"),
      ],
      { questionManifest: { count: 2, complete: true } },
    ],
    [
      "an incomplete manifest",
      [
        textChunk(1, queryIds[0], "user", 0, "Pregunta"),
        textChunk(1, queryIds[0], "user", 1, "fin"),
      ],
      { questionManifest: { count: 2, complete: false } },
    ],
  ])("rejects a question prefix with %s", async (_failure, chunks, turnOverrides) => {
    const brokenTurn = turn(1, queryIds[0], turnOverrides);
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? meta() : brokenTurn };
      }
      if (command instanceof QueryCommand) return { Items: chunks };
      throw new Error(`Unexpected document operation: ${command.constructor.name}`);
    });
    const { store } = makeStore(send);

    await expect(
      store.readText({
        ...owner,
        conversationId,
        ordinal: 1,
        queryId: queryIds[0],
        role: "user",
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
