import { describe, expect, it, vi } from "vitest";
import { createChatHistoryHandler } from "../../api/chat-history.ts";

// The HTTP handler is real. Storage and membership are controlled boundaries;
// DynamoDB conditions and retained records are exercised by store acceptance.
const botId = "docentes";
const sub = "teacher-removal-owner";
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const otherConversationId = "550e8400-e29b-41d4-a716-446655440001";
const queryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";
const hiddenAt = "2026-10-27T15:00:00.000Z";
const hidePath = `/api/chat/conversations/${conversationId}/hide`;
const metaPath = `/api/chat/conversations/${conversationId}`;
const scope = { sub, botId, conversationId };
const privateFields = {
  profileSnapshot: { subjects: ["private subject"] },
  documentContext: { text: "private document" },
  summary: { text: "private summary" },
  requestFingerprint: "private fingerprint",
  ownerAttemptId: "private attempt",
};

function event(method, route, { claims = { sub, token_use: "access" }, query = {} } = {}) {
  return {
    rawPath: route,
    rawQueryString: new URLSearchParams(query).toString(),
    queryStringParameters: query,
    requestContext: {
      http: { method, path: route },
      authorizer: { jwt: { claims } },
    },
  };
}

function harness({ member = true, hideResult, metaResult } = {}) {
  const store = {
    listConversations: vi.fn(async () => ({ version: 1, conversations: [] })),
    readTurns: vi.fn(async () => {
      throw new Error("metadata and hiding must not open the transcript");
    }),
    readText: vi.fn(async () => {
      throw new Error("metadata and hiding must not read original text");
    }),
    hideConversation: vi.fn(async () => hideResult ?? { version: 1, conversationId, hiddenAt }),
    readConversationMeta: vi.fn(
      async () =>
        metaResult ?? {
          version: 1,
          conversationId,
          label: "Prepará una actividad de fracciones",
          createdAt: "2026-10-27T13:00:00.000Z",
          updatedAt: "2026-10-27T14:00:00.000Z",
          lastOrdinal: 2,
          closed: false,
          activeQueryId: queryId,
        },
    ),
  };
  const getMembership = vi.fn(async () => member);
  const handler = createChatHistoryHandler({
    botId,
    store,
    getMembership,
    now: () => Date.parse(hiddenAt),
  });
  return { handler, store, getMembership };
}

function body(response) {
  return JSON.parse(response.body);
}

function expectNoPrivateContent(response) {
  expect(response.body).not.toMatch(
    /private subject|private document|private summary|private fingerprint|private attempt|profileSnapshot|documentContext|requestFingerprint|ownerAttemptId/,
  );
}

function expectNoStorageCalls(store) {
  for (const operation of Object.values(store)) expect(operation).not.toHaveBeenCalled();
}

describe("removing a conversation through the public HTTP API", () => {
  it("confirms the owner's hide with a server result and an explicit output whitelist", async () => {
    const { handler, store, getMembership } = harness({
      hideResult: { version: 1, conversationId, hiddenAt, ...privateFields },
    });
    const request = event("POST", hidePath, {
      query: { sub: "another-person", botId: "another-bot", hiddenAt: "1900-01-01" },
    });
    request.body = JSON.stringify({ sub: "another-person", botId: "another-bot" });

    const response = await handler(request);

    expect(response.statusCode).toBe(200);
    expect(body(response)).toEqual({ version: 1, conversationId, hiddenAt });
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(getMembership).toHaveBeenCalledExactlyOnceWith({ sub, botId });
    expect(store.hideConversation).toHaveBeenCalledExactlyOnceWith(scope);
    expect(getMembership.mock.invocationCallOrder[0]).toBeLessThan(
      store.hideConversation.mock.invocationCallOrder[0],
    );
    expect(store.readConversationMeta).not.toHaveBeenCalled();
    expect(store.readTurns).not.toHaveBeenCalled();
    expect(store.readText).not.toHaveBeenCalled();
    expectNoPrivateContent(response);
  });

  it("repeats the same hide without inventing a new timestamp or request identity", async () => {
    const { handler, store } = harness();
    const first = await handler(event("POST", hidePath));
    const repeated = await handler(event("POST", hidePath));

    expect(first.statusCode).toBe(200);
    expect(repeated.statusCode).toBe(200);
    expect(body(repeated)).toEqual(body(first));
    expect(store.hideConversation.mock.calls).toEqual([[scope], [scope]]);
  });

  it("reads only the public META summary without a profile or transcript dependency", async () => {
    const summary = {
      version: 1,
      conversationId,
      label: "Prepará una actividad de fracciones",
      lastOrdinal: 2,
      closed: false,
      activeQueryId: queryId,
    };
    const { handler, store } = harness({ metaResult: { ...summary, ...privateFields } });

    const response = await handler(event("GET", metaPath));

    expect(response.statusCode).toBe(200);
    expect(body(response)).toEqual(summary);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(store.readConversationMeta).toHaveBeenCalledExactlyOnceWith(scope);
    expect(store.hideConversation).not.toHaveBeenCalled();
    expect(store.readTurns).not.toHaveBeenCalled();
    expect(store.readText).not.toHaveBeenCalled();
    expectNoPrivateContent(response);
  });

  it.each([
    ["POST", hidePath, "hideConversation"],
    ["GET", metaPath, "readConversationMeta"],
  ])("rejects unauthenticated %s before storage", async (method, route) => {
    const { handler, store, getMembership } = harness();
    const response = await handler(event(method, route, { claims: {} }));
    expect(response.statusCode).toBe(401);
    expect(getMembership).not.toHaveBeenCalled();
    expectNoStorageCalls(store);
  });

  it.each([
    ["POST", hidePath],
    ["GET", metaPath],
  ])("rejects an ID token for %s before membership or storage", async (method, route) => {
    const { handler, store, getMembership } = harness();
    const response = await handler(event(method, route, { claims: { sub, token_use: "id" } }));
    expect(response.statusCode).toBe(401);
    expect(getMembership).not.toHaveBeenCalled();
    expectNoStorageCalls(store);
  });

  it.each([
    ["POST", hidePath],
    ["GET", metaPath],
  ])("rejects missing chatbot membership for %s without accessing data", async (method, route) => {
    const { handler, store } = harness({ member: false });
    const response = await handler(event(method, route));
    expect(response.statusCode).toBe(403);
    expectNoStorageCalls(store);
  });

  it.each([
    ["POST", "/api/chat/conversations/not-a-uuid/hide"],
    ["GET", "/api/chat/conversations/not-a-uuid"],
  ])("validates the conversation ID on %s before storage", async (method, route) => {
    const { handler, store } = harness();
    const response = await handler(event(method, route));
    expect(response.statusCode).toBe(400);
    expectNoStorageCalls(store);
  });

  it("does not mutate when membership verification is unavailable", async () => {
    const { handler, store, getMembership } = harness();
    getMembership.mockRejectedValueOnce(new Error("private membership outage"));
    const response = await handler(event("POST", hidePath));
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private membership outage");
    expectNoStorageCalls(store);
  });

  it.each([
    ["forbidden", 403],
    ["conversation_unavailable", 404],
  ])("preserves a %s rejection without announcing hide success", async (code, status) => {
    const { handler, store } = harness();
    store.hideConversation.mockRejectedValueOnce(Object.assign(new Error("private"), { code }));
    const response = await handler(event("POST", hidePath));
    expect(store.hideConversation).toHaveBeenCalledExactlyOnceWith(scope);
    expect(response.statusCode).toBe(status);
    expect(body(response)).not.toHaveProperty("hiddenAt");
    expect(response.body).not.toContain("private");
  });

  it.each([
    [metaPath, "readConversationMeta"],
    [`${metaPath}/turns`, "readTurns"],
    [`${metaPath}/turns/1/text?queryId=${queryId}&role=user`, "readText"],
  ])("reports an owned hidden conversation without originals on %s", async (route, method) => {
    const { handler, store } = harness();
    store[method].mockRejectedValueOnce(
      Object.assign(new Error("private hidden transcript"), { code: "conversation_hidden" }),
    );
    const url = new URL(route, "https://app.invalid");
    const response = await handler(
      event("GET", url.pathname, { query: Object.fromEntries(url.searchParams) }),
    );
    expect(store[method]).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(404);
    expect(body(response)).toMatchObject({ code: "CONVERSATION_HIDDEN" });
    expect(response.body).not.toContain("private hidden transcript");
    expectNoPrivateContent(response);
    expect(store.hideConversation).not.toHaveBeenCalled();
  });

  it("does not turn a lost storage acknowledgement into a successful hide", async () => {
    const { handler, store } = harness();
    store.hideConversation.mockRejectedValueOnce(new Error("private lost write acknowledgement"));
    const response = await handler(event("POST", hidePath));
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(body(response)).not.toHaveProperty("hiddenAt");
    expect(response.body).not.toContain("private lost write acknowledgement");
    expect(store.hideConversation).toHaveBeenCalledTimes(1);
  });

  it.each([
    { version: 1, conversationId: otherConversationId, hiddenAt },
    { version: 1, conversationId, hiddenAt: "not-a-date" },
    { version: 1, conversationId },
  ])("rejects an unconfirmed or mismatched hide result: %j", async (hideResult) => {
    const { handler, store } = harness({ hideResult });
    const response = await handler(event("POST", hidePath));
    expect(store.hideConversation).toHaveBeenCalledExactlyOnceWith(scope);
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(body(response)).not.toHaveProperty("hiddenAt");
  });

  it("does not return another conversation's META when the requested ID differs", async () => {
    const { handler } = harness({
      metaResult: {
        version: 1,
        conversationId: otherConversationId,
        label: "must not be returned",
        lastOrdinal: 1,
        closed: false,
      },
    });
    const response = await handler(event("GET", metaPath));
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(response.body).not.toContain("must not be returned");
  });
});
