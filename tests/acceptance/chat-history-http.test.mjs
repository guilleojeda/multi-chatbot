import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const handlerPath = path.join(projectRoot, "api/chat-history.ts");
const botId = "bot-aurora";
const sub = "teacher-123";
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const queryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";

let createChatHistoryHandler;

function responseBody(response) {
  return typeof response.body === "string" ? JSON.parse(response.body) : (response.body ?? {});
}

function event(method, route, { claims = { sub, token_use: "access" }, query = {} } = {}) {
  const url = new URL(route, "https://history.example.test");
  const rawQueryString = new URLSearchParams(query).toString();
  return {
    version: "2.0",
    routeKey: `${method} ${url.pathname}`,
    rawPath: url.pathname,
    rawQueryString,
    queryStringParameters: query,
    headers: { authorization: "Bearer access-token" },
    requestContext: {
      http: { method, path: url.pathname },
      authorizer: { jwt: { claims } },
    },
  };
}

function makeHarness({
  bot = botId,
  member = true,
  listResult = { version: 1, conversations: [] },
  turnsResult = {
    version: 1,
    conversationId,
    throughOrdinal: 0,
    closed: false,
    canContinue: false,
    turns: [],
  },
  textResult = {
    version: 1,
    conversationId,
    queryId,
    ordinal: 1,
    role: "user",
    chunks: [],
    complete: true,
  },
} = {}) {
  const store = {
    listConversations: vi.fn(async () => listResult),
    readTurns: vi.fn(async () => turnsResult),
    readText: vi.fn(async () => textResult),
  };
  const getMembership = vi.fn(async (scope) => {
    if (!scope || typeof scope !== "object") throw new Error("membership scope must be explicit");
    return member;
  });
  const handler =
    typeof createChatHistoryHandler === "function"
      ? createChatHistoryHandler({
          botId: bot,
          store,
          getMembership,
          now: () => Date.parse("2026-10-24T12:00:00.000Z"),
        })
      : null;
  return { handler, store, getMembership };
}

function noPrivateFields(value) {
  expect(JSON.stringify(value)).not.toMatch(
    /profileSnapshot|promptTexts|#DOCUMENT#|#CONTEXT#|#SUMMARY#|documentContext|contextManifest|contextSnapshot|sourceReferences|summary|fingerprint|ownerAttemptId|private document text/i,
  );
}

describe("the public chat history HTTP API", () => {
  beforeAll(async () => {
    if (!existsSync(handlerPath)) return;
    const module = await import(pathToFileURL(handlerPath).href);
    createChatHistoryHandler = module.createChatHistoryHandler;
  });

  beforeEach(() => {
    expect(existsSync(handlerPath), "Expected the chat history API at api/chat-history.ts").toBe(
      true,
    );
    expect(typeof createChatHistoryHandler, "Expected exported createChatHistoryHandler").toBe(
      "function",
    );
  });

  it("exports the chat history API handler", () => {
    expect(existsSync(handlerPath), "Expected the chat history API at api/chat-history.ts").toBe(
      true,
    );
    expect(typeof createChatHistoryHandler, "Expected exported createChatHistoryHandler").toBe(
      "function",
    );
  });

  it("lists only explicit public fields and binds the request to the access-token subject", async () => {
    const { handler, store, getMembership } = makeHarness({
      listResult: {
        version: 1,
        conversations: [
          {
            conversationId,
            label: "Actividad de porcentajes",
            createdAt: "2026-10-20T10:00:00.000Z",
            updatedAt: "2026-10-24T11:00:00.000Z",
            lastOrdinal: 4,
            closed: false,
            activeQueryId: queryId,
            summary: { text: "private summary text" },
            contextSnapshot: { version: 1, summary: { summaryId: "private-summary" } },
          },
        ],
        nextCursor: "opaque-next-page",
      },
    });

    const response = await handler(
      event("GET", "/api/chat/conversations", {
        query: {
          limit: "8",
          cursor: "opaque-list-cursor",
          sub: "teacher-456",
          botId: "other-bot",
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toMatch(/no-store/i);
    expect(responseBody(response)).toEqual({
      version: 1,
      conversations: [
        {
          conversationId,
          label: "Actividad de porcentajes",
          createdAt: "2026-10-20T10:00:00.000Z",
          updatedAt: "2026-10-24T11:00:00.000Z",
          lastOrdinal: 4,
          closed: false,
          activeQueryId: queryId,
        },
      ],
      nextCursor: "opaque-next-page",
    });
    expect(getMembership).toHaveBeenCalledWith({ sub, botId });
    expect(store.listConversations).toHaveBeenCalledWith({
      sub,
      botId,
      cursor: "opaque-list-cursor",
      limit: 8,
    });
    expect(store.readTurns).not.toHaveBeenCalled();
    expect(store.readText).not.toHaveBeenCalled();
    noPrivateFields(responseBody(response));
  });

  it("reads a paginated turn page without requiring a profile", async () => {
    const { handler, store, getMembership } = makeHarness({
      turnsResult: {
        version: 1,
        conversationId,
        throughOrdinal: 3,
        closed: false,
        canContinue: false,
        turns: [
          {
            ordinal: 2,
            queryId,
            status: "failed",
            questionManifest: { count: 1, complete: true },
            answerManifest: { count: 2, complete: false },
            cursor: 2,
            resultDeadlineAt: 1792843200000,
            failure: { code: "model_failure" },
            summary: { text: "private summary text" },
            contextSnapshot: { version: 1, summary: { summaryId: "private-summary" } },
            sourceReferences: [{ ordinal: 1, queryId }],
          },
        ],
        nextCursor: "older-turns",
      },
    });

    const response = await handler(
      event("GET", `/api/chat/conversations/${conversationId}/turns`, {
        query: { cursor: "turn-page", limit: "1", sub: "teacher-456" },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toEqual({
      version: 1,
      conversationId,
      throughOrdinal: 3,
      closed: false,
      canContinue: false,
      turns: [
        {
          ordinal: 2,
          queryId,
          status: "failed",
          questionManifest: { count: 1, complete: true },
          answerManifest: { count: 2, complete: false },
          cursor: 2,
          resultDeadlineAt: 1792843200000,
          failure: { code: "model_failure" },
        },
      ],
      nextCursor: "older-turns",
    });
    expect(getMembership).toHaveBeenCalledWith({ sub, botId });
    expect(store.readTurns).toHaveBeenCalledWith({
      sub,
      botId,
      conversationId,
      cursor: "turn-page",
      limit: 1,
    });
    expect(store.listConversations).not.toHaveBeenCalled();
    expect(store.readText).not.toHaveBeenCalled();
    noPrivateFields(responseBody(response));
  });

  it("reads only the selected role/query prefix and exposes text chunks", async () => {
    const firstText = 'Parte "pública": á';
    const secondText = "C:\\Materiales\nsin truncar";
    const { handler, store } = makeHarness({
      textResult: {
        version: 1,
        conversationId,
        queryId,
        ordinal: 3,
        role: "assistant",
        chunks: [
          { index: 2, text: firstText },
          { index: 3, text: secondText },
        ],
        complete: true,
        summary: { text: "private summary text" },
      },
    });

    const response = await handler(
      event("GET", `/api/chat/conversations/${conversationId}/turns/3/text`, {
        query: {
          role: "assistant",
          queryId,
          throughCursor: "4",
          cursor: "fragment-page",
          sub: "teacher-456",
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toEqual({
      version: 1,
      conversationId,
      queryId,
      ordinal: 3,
      role: "assistant",
      chunks: [
        { index: 2, text: firstText },
        { index: 3, text: secondText },
      ],
      complete: true,
    });
    expect(store.readText).toHaveBeenCalledWith({
      sub,
      botId,
      conversationId,
      ordinal: 3,
      queryId,
      role: "assistant",
      throughCursor: 4,
      cursor: "fragment-page",
    });
    expect(store.readTurns).not.toHaveBeenCalled();
    noPrivateFields(responseBody(response));
  });

  it.each([
    ["an ID token", { sub, token_use: "id" }],
    ["a token without a subject", { token_use: "access" }],
    ["an empty subject", { sub: "", token_use: "access" }],
  ])("rejects %s before membership or history reads", async (_label, claims) => {
    const { handler, store, getMembership } = makeHarness();

    const response = await handler(event("GET", "/api/chat/conversations", { claims }));

    expect(response.statusCode).toBe(401);
    expect(getMembership).not.toHaveBeenCalled();
    expect(store.listConversations).not.toHaveBeenCalled();
    expect(store.readTurns).not.toHaveBeenCalled();
    expect(store.readText).not.toHaveBeenCalled();
  });

  it("checks current chatbot membership before reading a known conversation", async () => {
    const { handler, store, getMembership } = makeHarness({ member: false });

    const response = await handler(event("GET", `/api/chat/conversations/${conversationId}/turns`));

    expect(response.statusCode).toBe(403);
    expect(getMembership).toHaveBeenCalledWith({ sub, botId });
    expect(store.listConversations).not.toHaveBeenCalled();
    expect(store.readTurns).not.toHaveBeenCalled();
    expect(store.readText).not.toHaveBeenCalled();
  });

  it("rejects text reads with invalid role or missing query identity", async () => {
    const { handler, store } = makeHarness();
    const badRole = await handler(
      event("GET", `/api/chat/conversations/${conversationId}/turns/1/text`, {
        query: { role: "document", queryId },
      }),
    );
    const missingQuery = await handler(
      event("GET", `/api/chat/conversations/${conversationId}/turns/1/text`, {
        query: { role: "user" },
      }),
    );

    expect(badRole.statusCode).toBe(400);
    expect(missingQuery.statusCode).toBe(400);
    expect(store.readText).not.toHaveBeenCalled();
  });

  it("caps the serialized Lambda envelope when escaping expands a page body", async () => {
    const quote = '"'.repeat(300 * 1024);
    const textResult = {
      version: 1,
      conversationId,
      queryId,
      ordinal: 1,
      role: "assistant",
      chunks: [0, 1, 2].map((index) => ({ index, text: quote })),
      complete: true,
    };
    const candidate = {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
      body: JSON.stringify(textResult),
    };
    const maxBytes = 3 * 1024 * 1024;
    expect(Buffer.byteLength(candidate.body, "utf8")).toBeLessThan(maxBytes);
    expect(Buffer.byteLength(JSON.stringify(candidate), "utf8")).toBeGreaterThan(maxBytes);

    const { handler } = makeHarness({
      textResult,
    });

    const response = await handler(
      event("GET", `/api/chat/conversations/${conversationId}/turns/1/text`, {
        query: { role: "assistant", queryId },
      }),
    );

    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(responseBody(response)).not.toMatchObject({ chunks: [], complete: true });
  });

  it("does not turn a transient history failure into an empty conversation list", async () => {
    const { handler, store } = makeHarness();
    store.listConversations.mockRejectedValueOnce(new Error("temporary DynamoDB failure"));

    const response = await handler(event("GET", "/api/chat/conversations"));

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(responseBody(response)).not.toEqual({ version: 1, conversations: [] });
    expect(JSON.stringify(responseBody(response))).not.toContain("temporary DynamoDB failure");
  });
});
