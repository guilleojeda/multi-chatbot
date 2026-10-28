import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createConversationStoreAdapter } from "../../runtime/conversation-store.ts";

const conversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const queryIds = [
  "a4bfbc9f-3699-4e93-b120-a03c0204bc67",
  "b5cfbc9f-3699-4e93-b120-a03c0204bc68",
  "c6dfbc9f-3699-4e93-b120-a03c0204bc69",
  "d7efbc9f-3699-4e93-b120-a03c0204bc60",
];
const now = Date.parse("2026-10-20T12:00:00.000Z");

function admissionFields(queryId, timestamp = now) {
  return {
    ownerAttemptId: "attempt-" + queryId,
    resultDeadlineAt: timestamp + 60 * 60 * 1000,
    requestFingerprint: "fingerprint-" + queryId,
    contextSnapshot: { version: 1, recentReferences: [] },
    documentContext: {
      knowledgeBaseId: "kb-docentes-dev",
      query: "referencias de conversación",
      revision: "documents-r1",
      retrievedAt: timestamp,
      status: "empty",
      results: [],
    },
    quota: {
      daily: {
        used: 1,
        limit: 20,
        resetAt: Date.parse("2026-10-21T03:00:00.000Z"),
        period: "2026-10-20",
      },
      monthly: {
        used: 1,
        limit: 200,
        resetAt: Date.parse("2026-11-01T03:00:00.000Z"),
        period: "2026-10",
      },
      serverNow: timestamp,
      blockedUntil: null,
      policyRevision: "policy-r7",
    },
  };
}

function completedTurn(ordinal, queryId, overrides = {}) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}`,
    conversationId,
    sub: "teacher-123",
    botId: "bot-aurora",
    queryId,
    ordinal,
    operation: ordinal === 1 ? "start" : "message",
    baseOrdinal: ordinal - 1,
    requestFingerprint: "fingerprint-" + queryId,
    ownerAttemptId: "attempt-" + queryId,
    resultDeadlineAt: now + 60 * 60 * 1000,
    status: "completed",
    phase: "complete",
    cursor: 1,
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: 1, complete: true },
    contextManifest: { count: 0, complete: true },
    contextSnapshot: { version: 1, recentReferences: [] },
    documentContextManifest: { count: 1, complete: true },
    ...overrides,
  };
}

function turnChunk(ordinal, queryId, role, text) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}#${queryId}#${role.toUpperCase()}#00000000`,
    conversationId,
    queryId,
    ordinal,
    role,
    index: 0,
    text,
  };
}

const continuation = {
  sub: "teacher-123",
  botId: "bot-aurora",
  conversationId,
  queryId: queryIds[3],
  now,
  ...admissionFields(queryIds[3]),
  operation: "message",
  baseOrdinal: 3,
  text: "Seguí con una adaptación.",
  profileSnapshot: { fields: {} },
  invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "revision-123" },
};

function summaryContextHarness(sourceOrdinal) {
  const summaryId = "e8f0feca-8714-421c-9152-5f229f5af829";
  const summaryKey = `SUMMARY#${encodeURIComponent(summaryId)}#VERSION#1`;
  const meta = {
    pk: `CONV#${conversationId}`,
    sk: "META",
    conversationId,
    sub: "teacher-123",
    botId: "bot-aurora",
    lastOrdinal: 1,
    summary: { summaryId, throughOrdinal: 1 },
  };
  const summary = {
    pk: `CONV#${conversationId}`,
    sk: summaryKey,
    conversationId,
    sub: "teacher-123",
    botId: "bot-aurora",
    version: 1,
    summaryId,
    throughOrdinal: 1,
    modelId: "global.anthropic.claude-sonnet-4-6",
    revision: "summary-r1",
    preparedAt: now,
    inputTokens: 8,
    textManifest: { count: 1, complete: true },
    sourceReferences: [{ ordinal: 1, queryId: queryIds[0] }],
  };
  const summaryText = {
    pk: `CONV#${conversationId}`,
    sk: `${summaryKey}#TEXT#00000000`,
    conversationId,
    sub: "teacher-123",
    botId: "bot-aurora",
    summaryId,
    version: 1,
    index: 0,
    text: "Resumen durable de la conversación.",
  };
  const sourceTurn = completedTurn(1, queryIds[0], { ordinal: sourceOrdinal });
  const documentClient = {
    send: vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        const item =
          command.input.Key.sk === "META"
            ? meta
            : command.input.Key.sk === summaryKey
              ? summary
              : command.input.Key.sk === "TURN#00000001"
                ? sourceTurn
                : undefined;
        return { Item: item };
      }
      if (command instanceof QueryCommand) {
        if (command.input.ExpressionAttributeValues[":prefix"] === `${summaryKey}#TEXT#`) {
          return { Items: [summaryText] };
        }
      }
      throw new Error(`Unexpected document operation: ${command.constructor.name}`);
    }),
  };
  const store = createConversationStoreAdapter({
    documentClient,
    tableName: "conversations-aurora-dev",
  });
  return { documentClient, store };
}

describe("conversation context references", () => {
  it("records an explicitly empty context for the first turn", async () => {
    const documentClient = { send: vi.fn(async () => ({})) };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
      now: () => now,
    });

    await store.startTurn({
      sub: "teacher-123",
      botId: "bot-aurora",
      conversationId,
      queryId: queryIds[0],
      operation: "start",
      baseOrdinal: 0,
      now,
      ...admissionFields(queryIds[0]),
      text: "Primera pregunta.",
      profileSnapshot: { fields: {} },
      contextSnapshot: { version: 1, recentReferences: [] },
      documentContext: {
        knowledgeBaseId: "kb-docentes-dev",
        query: "primera pregunta",
        revision: "documents-r1",
        retrievedAt: now,
        status: "empty",
        results: [],
      },
      invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "revision-123" },
    });

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const transaction = commands.find((command) => command instanceof TransactWriteCommand);
    const record = transaction.input.TransactItems.find(({ Put }) =>
      Put?.Item?.sk.startsWith("TURN#"),
    ).Put.Item;
    expect(record.contextManifest).toEqual({ count: 0, complete: true });
    expect(
      transaction.input.TransactItems.some(({ Put }) => Put?.Item?.sk.includes("#CONTEXT#")),
    ).toBe(false);
    expect(commands.filter((command) => command instanceof TransactWriteCommand)).toHaveLength(1);
    expect(commands.filter((command) => command instanceof GetCommand)).toHaveLength(1);
  });

  it("excludes failed turns with whitespace-only prefixes from the selected context", async () => {
    const items = [
      completedTurn(1, queryIds[0]),
      turnChunk(1, queryIds[0], "user", "Pregunta completa."),
      turnChunk(1, queryIds[0], "assistant", "Respuesta completa."),
      {
        ...completedTurn(2, queryIds[1]),
        status: "failed",
        phase: "failed",
        questionManifest: { count: 1, complete: true },
        answerManifest: { count: 1, complete: false },
      },
      turnChunk(2, queryIds[1], "user", "Pregunta fallida."),
      turnChunk(2, queryIds[1], "assistant", " \n\t "),
      {
        ...completedTurn(3, queryIds[2]),
        status: "in_progress",
        phase: "invocation_claimed",
        cursor: 0,
        ownerAttemptId: "attempt-active",
        resultDeadlineAt: now + 60 * 60 * 1000,
        questionManifest: { count: 1, complete: true },
        answerManifest: { count: 0, complete: false },
      },
      turnChunk(3, queryIds[2], "user", "T1 sigue generándose."),
    ];
    const meta = {
      pk: `CONV#${conversationId}`,
      sk: "META",
      conversationId,
      sub: "teacher-123",
      botId: "bot-aurora",
      lastOrdinal: 3,
    };
    const documentClient = {
      send: vi.fn(async (command) =>
        command instanceof QueryCommand
          ? { Items: structuredClone(items) }
          : command instanceof GetCommand
            ? command.input.Key.sk === "META"
              ? { Item: meta }
              : {}
            : {},
      ),
    };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
      now: () => now,
    });

    const selectedContext = await store.readContext({ conversationId });
    expect(selectedContext.messages).toEqual([
      { role: "user", content: [{ text: "Pregunta completa." }] },
      { role: "assistant", content: [{ text: "Respuesta completa." }] },
    ]);
    expect(selectedContext.references).toEqual([{ ordinal: 1, queryId: queryIds[0] }]);

    // T1 finishes after the consistent Query returned, before this continuation is allocated.
    items[6] = completedTurn(3, queryIds[2]);
    items.push(turnChunk(3, queryIds[2], "assistant", "T1 terminó tarde."));
    await store.continueTurn({
      ...continuation,
      contextReferences: selectedContext.references,
      contextSnapshot: { version: 1, recentReferences: selectedContext.references },
    });

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const allocation = commands.find((command) => command instanceof TransactWriteCommand);
    const turnPut = allocation.input.TransactItems.find(
      ({ Put }) => Put?.Item?.profileSnapshot,
    ).Put;
    expect(turnPut.Item).toMatchObject({
      ordinal: 4,
      contextManifest: { count: 0, complete: true },
      contextSnapshot: { version: 1, recentReferences: selectedContext.references },
    });
    expect(Object.hasOwn(turnPut.Item, "messages")).toBe(false);

    expect(
      allocation.input.TransactItems.some(({ Put }) => Put?.Item?.sk.includes("#CONTEXT#")),
    ).toBe(false);
    expect(JSON.stringify(turnPut.Item.contextSnapshot)).not.toContain(queryIds[2]);
    expect(turnPut.Item.questionManifest).toEqual({ count: 1, complete: true });
    expect(turnPut.Item.contextManifest).toEqual({ count: 0, complete: true });
    expect(commands.some((command) => command instanceof TransactWriteCommand)).toBe(true);
  });

  it("splits a long reference list into bounded chunks in the admission transaction", async () => {
    const references = Array.from({ length: 7000 }, (_, index) => ({
      ordinal: index + 1,
      queryId: `a4bfbc9f-3699-4e93-b120-${String(index + 100000000000).slice(-12)}`,
    }));
    const meta = {
      pk: `CONV#${conversationId}`,
      sk: "META",
      conversationId,
      sub: "teacher-123",
      botId: "bot-aurora",
      lastOrdinal: 7000,
    };
    const documentClient = {
      send: vi.fn(async (command) =>
        command instanceof GetCommand && command.input.Key.sk === "META" ? { Item: meta } : {},
      ),
    };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
      now: () => now,
    });

    await store.continueTurn({
      ...continuation,
      baseOrdinal: 7000,
      contextReferences: references,
      contextSnapshot: { version: 1, recentReferences: references },
    });

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const transaction = commands.find((command) => command instanceof TransactWriteCommand);
    const record = transaction.input.TransactItems.find(({ Put }) => Put).Put.Item;
    const contextPuts = transaction.input.TransactItems.filter(({ Put }) =>
      Put?.Item?.sk.includes("#CONTEXT#"),
    ).map(({ Put }) => Put);

    expect(contextPuts.length).toBeGreaterThan(1);
    expect(
      contextPuts.every(({ Item }) => Buffer.byteLength(Item.text, "utf8") <= 300 * 1024),
    ).toBe(true);
    expect(record.contextManifest).toEqual({ count: contextPuts.length, complete: true });
    expect(commands.filter((command) => command instanceof TransactWriteCommand)).toHaveLength(1);
  });

  it("rejects a quota period that changes while admission preflight is waiting on a read", async () => {
    let currentNow = Date.parse("2026-10-22T02:59:59.000Z");
    const documentClient = {
      send: vi.fn(async (command) => {
        if (command instanceof GetCommand && command.input.Key.sk.startsWith("SEND#")) {
          currentNow = Date.parse("2026-10-22T03:00:00.000Z");
        }
        return {};
      }),
    };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
      now: () => currentNow,
    });
    const admittedAt = Date.parse("2026-10-22T02:59:59.000Z");
    const fields = admissionFields(queryIds[0], admittedAt);
    fields.quota.daily.period = "2026-10-21";
    fields.quota.daily.resetAt = Date.parse("2026-10-22T03:00:00.000Z");

    await expect(
      store.startTurn({
        sub: "teacher-123",
        botId: "bot-aurora",
        conversationId,
        queryId: queryIds[0],
        operation: "start",
        baseOrdinal: 0,
        now: admittedAt,
        ...fields,
        text: "Primera pregunta.",
        profileSnapshot: { fields: {} },
        invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "revision-123" },
      }),
    ).rejects.toMatchObject({ code: "quota_period_changed" });

    expect(
      documentClient.send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(0);
  });

  it("rejects a completed turn with a missing context reference chunk", async () => {
    const meta = {
      pk: `CONV#${conversationId}`,
      sk: "META",
      conversationId,
      sub: "teacher-123",
      botId: "bot-aurora",
      lastOrdinal: 1,
    };
    const documentClient = {
      send: vi.fn(async (command) => {
        if (command instanceof GetCommand) return { Item: meta };
        return {
          Items: [
            {
              ...completedTurn(1, queryIds[0], {
                contextManifest: { count: 1, complete: true },
                contextSnapshot: { version: 1, recentReferencesStorage: "context_chunks" },
              }),
            },
            turnChunk(1, queryIds[0], "user", "Pregunta completa."),
            turnChunk(1, queryIds[0], "assistant", "Respuesta completa."),
          ],
        };
      }),
    };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
    });

    await expect(store.readContext({ conversationId })).rejects.toThrow(
      /incomplete reference manifest/,
    );
  });

  it("reads a current summary whose source turn has a numeric ordinal without loading its originals", async () => {
    const { documentClient, store } = summaryContextHarness(1);

    const context = await store.readContext({ conversationId });

    expect(context.summary).toMatchObject({
      summaryId: "e8f0feca-8714-421c-9152-5f229f5af829",
      throughOrdinal: 1,
      sourceReferences: [{ ordinal: 1, queryId: queryIds[0] }],
    });
    const commands = documentClient.send.mock.calls.map(([command]) => command);
    expect(
      commands.filter((command) => command instanceof GetCommand).map(({ input }) => input.Key.sk),
    ).toEqual(["META", "SUMMARY#e8f0feca-8714-421c-9152-5f229f5af829#VERSION#1", "TURN#00000001"]);
    expect(
      commands
        .filter((command) => command instanceof QueryCommand)
        .map(({ input }) => input.ExpressionAttributeValues[":prefix"]),
    ).toEqual(["SUMMARY#e8f0feca-8714-421c-9152-5f229f5af829#VERSION#1#TEXT#"]);
  });

  it("rejects a current summary whose source turn ordinal is stored as a string", async () => {
    const { documentClient, store } = summaryContextHarness("1");

    await expect(store.readContext({ conversationId })).rejects.toThrow(
      /summary source turns are malformed/,
    );
    expect(
      documentClient.send.mock.calls.some(
        ([command]) =>
          command instanceof QueryCommand &&
          command.input.ExpressionAttributeValues[":prefix"].startsWith("TURN#"),
      ),
    ).toBe(false);
  });
});
