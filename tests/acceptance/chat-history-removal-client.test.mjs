import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let hideChatConversation;
let readChatConversationMeta;

const config = {
  region: "us-east-1",
  userPoolId: "us-east-1_example",
  clientId: "web-client",
  apiBaseUrl: "/api",
  botId: "docentes",
};

const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const otherConversationId = "c166b6c3-5c0d-4b45-a9da-77b675bed25b";

function session({ accessToken = "access-before-refresh", restore } = {}) {
  return {
    accessToken: vi.fn(() => accessToken),
    restore: vi.fn(restore ?? (async () => null)),
  };
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function summary(overrides = {}) {
  return {
    version: 1,
    conversationId,
    label: "Actividad de porcentajes",
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    lastOrdinal: 2,
    closed: false,
    activeQueryId: "a4bfbc9f-3699-4a93-b120-a03c0204bc67",
    ...overrides,
  };
}

function requireHideChatConversation() {
  expect(
    hideChatConversation,
    "chat-api.ts must export hideChatConversation(config, session, conversationId, isActive)",
  ).toBeTypeOf("function");
  return hideChatConversation;
}

function requireReadChatConversationMeta() {
  expect(
    readChatConversationMeta,
    "chat-api.ts must export readChatConversationMeta(config, session, conversationId, isActive)",
  ).toBeTypeOf("function");
  return readChatConversationMeta;
}

beforeAll(async () => {
  const client = await import("../../web/chat-api.ts");
  hideChatConversation = client.hideChatConversation;
  readChatConversationMeta = client.readChatConversationMeta;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat removal API client", () => {
  it("hides a conversation with an empty POST and returns only the confirmed fields", async () => {
    const fetch = vi.fn(async () =>
      response({
        version: 1,
        conversationId,
        hiddenAt: "2026-10-27T13:45:00.000Z",
        hiddenBy: "must not escape the public response",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const active = vi.fn(() => true);

    await expect(
      requireHideChatConversation()(config, session(), conversationId, active),
    ).resolves.toEqual({ conversationId, hiddenAt: "2026-10-27T13:45:00.000Z" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`/api/chat/conversations/${conversationId}/hide`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has("content-type")).toBe(false);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-before-refresh");
    expect(init.cache).toBe("no-store");
  });

  it.each([
    ["wrong version", { version: 2, conversationId, hiddenAt: "2026-10-27T13:45:00.000Z" }],
    [
      "mismatched conversation",
      { version: 1, conversationId: otherConversationId, hiddenAt: "2026-10-27T13:45:00.000Z" },
    ],
    ["missing timestamp", { version: 1, conversationId }],
    ["invalid timestamp", { version: 1, conversationId, hiddenAt: "later" }],
  ])("rejects a hide response with %s", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(body)),
    );

    await expect(
      requireHideChatConversation()(config, session(), conversationId, () => true),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 502 });
  });

  it("preserves a hidden-conversation 404 as an operation error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ code: "CONVERSATION_HIDDEN" }, 404)),
    );

    await expect(
      requireHideChatConversation()(config, session(), conversationId, () => true),
    ).rejects.toMatchObject({ code: "CONVERSATION_HIDDEN", status: 404 });
  });

  it("reads only the brief visible metadata and validates its complete public shape", async () => {
    const fetch = vi.fn(async () => response(summary()));
    vi.stubGlobal("fetch", fetch);

    await expect(
      requireReadChatConversationMeta()(config, session(), conversationId, () => true),
    ).resolves.toEqual({
      conversationId,
      label: "Actividad de porcentajes",
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-23T10:00:00.000Z",
      lastOrdinal: 2,
      closed: false,
      activeQueryId: "a4bfbc9f-3699-4a93-b120-a03c0204bc67",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`/api/chat/conversations/${conversationId}`);
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
  });

  it.each([
    ["wrong version", { version: 2 }],
    ["mismatched conversation ID", { conversationId: otherConversationId }],
    ["missing label", { label: undefined }],
    ["negative ordinal", { lastOrdinal: -1 }],
    ["non-boolean closed flag", { closed: "false" }],
    ["invalid optional timestamp", { updatedAt: "unknown" }],
    ["invalid active query ID", { activeQueryId: "not-a-uuid" }],
  ])("rejects brief metadata with %s", async (_name, changes) => {
    const body = summary();
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete body[key];
      else body[key] = value;
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(body)),
    );

    await expect(
      requireReadChatConversationMeta()(config, session(), conversationId, () => true),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 502 });
  });

  it("rejects an invalid local conversation ID without making a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      requireReadChatConversationMeta()(config, session(), "not-an-id", () => true),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes once after 401 and retries the same hide destination with the new token", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ code: "UNAUTHORIZED" }, 401))
      .mockResolvedValueOnce(
        response({ version: 1, conversationId, hiddenAt: "2026-10-27T13:45:00.000Z" }),
      );
    vi.stubGlobal("fetch", fetch);
    const auth = session({
      restore: async () => ({ accessToken: "access-after-refresh", idToken: "id-token" }),
    });
    const active = vi.fn(() => true);

    await expect(
      requireHideChatConversation()(config, auth, conversationId, active),
    ).resolves.toEqual({ conversationId, hiddenAt: "2026-10-27T13:45:00.000Z" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `/api/chat/conversations/${conversationId}/hide`,
      `/api/chat/conversations/${conversationId}/hide`,
    ]);
    expect(fetch.mock.calls.map(([, init]) => init.method)).toEqual(["POST", "POST"]);
    expect(fetch.mock.calls.every(([, init]) => init.body === undefined)).toBe(true);
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init.headers).get("authorization")),
    ).toEqual(["Bearer access-before-refresh", "Bearer access-after-refresh"]);
    expect(auth.restore).toHaveBeenCalledTimes(1);
    expect(active).toHaveBeenCalled();
  });

  it("does not refresh or retry a 401 after the request becomes inactive", async () => {
    const fetch = vi.fn(async () => response({ code: "UNAUTHORIZED" }, 401));
    vi.stubGlobal("fetch", fetch);
    const auth = session({ restore: async () => ({ accessToken: "late-token", idToken: "id" }) });
    const active = vi.fn(() => false);

    await expect(
      requireHideChatConversation()(config, auth, conversationId, active),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(auth.restore).not.toHaveBeenCalled();
  });
});
