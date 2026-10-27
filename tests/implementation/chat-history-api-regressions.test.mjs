import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createChatHistoryHandler } from "../../api/chat-history.ts";
import { createHistoryStore } from "../../runtime/history-store.ts";

const botId = "bot-history-api";
const sub = "history-api-owner";
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const queryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";

function makeHandler(turnsResult) {
  const store = {
    listConversations: vi.fn(async () => ({ version: 1, conversations: [] })),
    readTurns: vi.fn(async () => turnsResult),
    readText: vi.fn(async () => ({})),
  };
  const handler = createChatHistoryHandler({
    botId,
    store,
    getMembership: async () => true,
    now: () => Date.parse("2026-10-25T12:00:00.000Z"),
  });
  return { handler, store };
}

function turnsEvent() {
  return {
    rawPath: `/api/chat/conversations/${conversationId}/turns`,
    requestContext: {
      http: { method: "GET" },
      authorizer: { jwt: { claims: { sub, token_use: "access" } } },
    },
  };
}

function textEvent() {
  return {
    rawPath: `/api/chat/conversations/${conversationId}/turns/1/text`,
    queryStringParameters: { role: "assistant", queryId },
    requestContext: {
      http: { method: "GET" },
      authorizer: { jwt: { claims: { sub, token_use: "access" } } },
    },
  };
}

function baseTurns(overrides = {}) {
  return {
    version: 1,
    conversationId,
    throughOrdinal: 1,
    closed: false,
    canContinue: true,
    turns: [
      {
        ordinal: 1,
        queryId,
        status: "completed",
        questionManifest: { count: 1, complete: true },
        answerManifest: { count: 1, complete: true },
        cursor: 1,
      },
    ],
    ...overrides,
  };
}

describe("chat history API presentation metadata regressions", () => {
  it("whitelists authoritative turn-page metadata from META", async () => {
    const { handler } = makeHandler(
      baseTurns({
        label: "Actividad de porcentajes",
        createdAt: "2026-10-20T10:00:00.000Z",
        updatedAt: "2026-10-24T11:00:00.000Z",
        historyLabel: "must not leak separately",
        profileSnapshot: { private: "value" },
      }),
    );

    const response = await handler(turnsEvent());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      version: 1,
      conversationId,
      label: "Actividad de porcentajes",
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-24T11:00:00.000Z",
      throughOrdinal: 1,
      closed: false,
      canContinue: true,
      turns: [
        {
          ordinal: 1,
          queryId,
          status: "completed",
          questionManifest: { count: 1, complete: true },
          answerManifest: { count: 1, complete: true },
          cursor: 1,
        },
      ],
    });
  });

  it("omits presentation metadata when META has no usable label or timestamps", async () => {
    const { handler } = makeHandler(baseTurns());

    const response = await handler(turnsEvent());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).not.toHaveProperty("label");
    expect(JSON.parse(response.body)).not.toHaveProperty("createdAt");
    expect(JSON.parse(response.body)).not.toHaveProperty("updatedAt");
  });

  it.each([
    ["an empty label", { label: "  " }],
    ["an empty creation time", { createdAt: "" }],
    ["a non-string update time", { updatedAt: 7 }],
  ])("rejects invalid optional presentation metadata (%s)", async (_name, metadata) => {
    const { handler } = makeHandler(baseTurns(metadata));

    const response = await handler(turnsEvent());

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      code: "INTERNAL_ERROR",
      message: "No pudimos completar la solicitud.",
    });
  });
});

describe("completed assistant text integrity regressions", () => {
  function apiForAnswer(answer) {
    const pk = "CONV#" + conversationId;
    const meta = { pk, sk: "META", conversationId, sub, botId, lastOrdinal: 1, closed: false };
    const turn = {
      pk,
      sk: "TURN#00000001",
      conversationId,
      sub,
      botId,
      ordinal: 1,
      queryId,
      operation: "start",
      baseOrdinal: 0,
      requestFingerprint: "sha256:current-api-regression",
      status: "completed",
      phase: "complete",
      ownerAttemptId: "attempt-api-regression",
      resultDeadlineAt: Date.parse("2026-10-25T13:00:00.000Z"),
      cursor: 1,
      questionManifest: { count: 1, complete: true },
      answerManifest: { count: 1, complete: true },
      contextManifest: { count: 0, complete: true },
      contextSnapshot: { version: 1, recentReferences: [] },
      documentContextManifest: { count: 1, complete: true },
      profileSnapshot: { fields: {} },
      invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "runtime-r1" },
    };
    const documentContext = {
      knowledgeBaseId: "kb-history-api",
      query: "respuesta de prueba",
      revision: "documents-r1",
      retrievedAt: Date.parse("2026-10-25T12:00:00.000Z"),
      status: "empty",
      results: [],
    };
    const rows = [
      {
        pk,
        sk: `TURN#00000001#${queryId}#USER#00000000`,
        conversationId,
        ordinal: 1,
        queryId,
        role: "user",
        index: 0,
        text: "Pregunta de prueba.",
      },
      {
        pk,
        sk: `TURN#00000001#${queryId}#ASSISTANT#00000000`,
        conversationId,
        ordinal: 1,
        queryId,
        role: "assistant",
        index: 0,
        text: answer,
      },
      {
        pk,
        sk: "TURN#00000001#DOCUMENT#00000000",
        conversationId,
        queryId,
        ordinal: 1,
        index: 0,
        text: JSON.stringify(documentContext),
      },
    ];
    const documentClient = {
      send: vi.fn(async (command) => {
        if (command instanceof GetCommand) {
          return { Item: command.input.Key.sk === "META" ? meta : turn };
        }
        if (command instanceof QueryCommand) {
          const prefix = command.input.ExpressionAttributeValues[":prefix"];
          return { Items: rows.filter((row) => row.sk.startsWith(prefix)) };
        }
        throw new Error("Unexpected command " + command.constructor.name);
      }),
    };
    const handler = createChatHistoryHandler({
      botId,
      store: createHistoryStore({ documentClient, tableName: "history-test", botId }),
      getMembership: async () => true,
      now: Date.now,
    });
    return { handler, documentClient };
  }

  it.each(["", "   \t\n"])(
    "returns 404 for a completed assistant answer containing only %j",
    async (answer) => {
      const { handler } = apiForAnswer(answer);

      const response = await handler(textEvent());

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toEqual({
        code: "NOT_FOUND",
        message: "No encontramos esa conversación.",
      });
    },
  );

  it("returns a completed assistant answer that contains text after leading whitespace", async () => {
    const { handler } = apiForAnswer(" \nRespuesta válida.");

    const response = await handler(textEvent());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      role: "assistant",
      chunks: [{ index: 0, text: " \nRespuesta válida." }],
      complete: true,
    });
  });
});
