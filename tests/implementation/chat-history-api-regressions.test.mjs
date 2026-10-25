import { describe, expect, it, vi } from "vitest";
import { createChatHistoryHandler } from "../../api/chat-history.ts";

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
