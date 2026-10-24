import { vi } from "vitest";
import {
  createAccountAppHookHarness,
  loadAccountAppForHookTests,
} from "./account-app-hook-harness.mjs";

export const historyConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_example",
  clientId: "web-client",
  apiBaseUrl: "/api",
  botId: "docentes",
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
  runtimeQualifier: "DEFAULT",
};

export const historyIdentity = { sub: "teacher-a", botId: "docentes" };
export const firstConversationId = "550e8400-e29b-41d4-a716-446655440000";
export const secondConversationId = "c166b6c3-5c0d-4b45-a9da-77b675bed25b";
export const firstQueryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";
export const secondQueryId = "b0d7cf70-ae36-49f4-a1b9-2837633a54ca";
export const thirdQueryId = "d266b6c3-5c0d-4b45-a9da-77b675bed25b";
export const accessToken = "temporary-access-token-not-for-storage";
export const idToken = "temporary-id-token-not-for-storage";

export class MemorySessionStorage {
  values = new Map();
  events = [];

  constructor({ denyWrites = false } = {}) {
    this.denyWrites = denyWrites;
  }

  getItem(key) {
    return this.values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    const name = String(key);
    this.events.push(`storage:${name}`);
    if (this.denyWrites && name !== "auth-refresh") {
      throw new DOMException("Storage is unavailable", "QuotaExceededError");
    }
    this.values.set(name, String(value));
  }

  removeItem(key) {
    const name = String(key);
    this.events.push(`remove:${name}`);
    this.values.delete(name);
  }

  clear() {
    this.values.clear();
  }
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function streamResponse(request, { accepted = true, text = "Respuesta completa." } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      if (accepted) {
        controller.enqueue(
          encoder.encode(
            `event: accepted\ndata: ${JSON.stringify({
              type: "accepted",
              conversationId: request.conversationId,
              queryId: request.queryId,
              ordinal: request.baseOrdinal + 1,
            })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `event: text\ndata: ${JSON.stringify({
              type: "text",
              queryId: request.queryId,
              index: 0,
              text,
            })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `event: completed\ndata: ${JSON.stringify({
              type: "completed",
              queryId: request.queryId,
            })}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export function runtimeUrl(config = historyConfig) {
  return (
    `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/` +
    `${encodeURIComponent(config.runtimeArn)}/invocations?qualifier=${encodeURIComponent(config.runtimeQualifier)}`
  );
}

export function createHistoryEnvironment({
  storage = new MemorySessionStorage(),
  identity = historyIdentity,
  config = historyConfig,
  profileComplete = true,
  membershipStatus = 200,
  session: providedSession,
  listHandler = async () => jsonResponse({ version: 1, conversations: [] }),
  turnsHandler = async () =>
    jsonResponse({ version: 1, throughOrdinal: 0, closed: false, canContinue: true, turns: [] }),
  textHandler = async () => jsonResponse({ version: 1, chunks: [], complete: true }),
  runtimeHandler = async (request) => streamResponse(request),
  recoverHandler = async (request) =>
    jsonResponse({
      type: "failed",
      code: "conversation_unavailable",
      message: "No se encontró el envío.",
      recordStatus: "not_admitted",
      queryId: request.queryId,
    }),
} = {}) {
  const apiRequests = [];
  const runtimeRequests = [];
  const counters = { uuid: 0 };
  let token = accessToken;
  const session = providedSession || {
    accessToken: vi.fn(() => token),
    idToken: vi.fn(() => idToken),
    restore: vi.fn(async () => ({ accessToken: token, idToken })),
    signOut: vi.fn(async () => {
      token = null;
      storage.removeItem("auth-refresh");
    }),
    requestPasswordReset: vi.fn(async () => undefined),
    confirmPasswordReset: vi.fn(async () => undefined),
    signIn: vi.fn(),
  };

  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("window", {
    location: { hash: "#/chat", pathname: "/", search: "" },
    history: { replaceState() {} },
    crypto: {
      randomUUID: () => {
        const values = [
          "33333333-3333-4333-8333-333333333333",
          "44444444-4444-4444-8444-444444444444",
          "55555555-5555-4555-8555-555555555555",
          "66666666-6666-4666-8666-666666666666",
        ];
        return values[counters.uuid++] || "e367c7d4-6d1e-4a6b-a55f-42cab0d35b4f";
      },
    },
    sessionStorage: storage,
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args),
    clearInterval: (...args) => globalThis.clearInterval(...args),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });

  const fetch = vi.fn(async (input, init = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    const headers = new Headers(init.headers);
    if (url === "/public-config.json") return jsonResponse(config);
    if (url === "/api/account/me") {
      apiRequests.push({ path: "/account/me", method, headers, init });
      if (membershipStatus !== 200) {
        return jsonResponse(
          { code: membershipStatus === 403 ? "FORBIDDEN" : "UNAUTHORIZED" },
          membershipStatus,
        );
      }
      return jsonResponse(identity);
    }
    if (url === "/api/profile") {
      apiRequests.push({ path: "/profile", method, headers, init });
      return jsonResponse({
        sub: identity.sub,
        botId: identity.botId,
        profile: profileComplete
          ? {
              sub: identity.sub,
              botId: identity.botId,
              updatedAt: "2026-10-20T00:00:00.000Z",
              fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
              responsePreferenceIds: [],
            }
          : null,
      });
    }
    if (url.startsWith("/api/chat/conversations")) {
      const parsed = new URL(url, "https://app.invalid");
      const path = parsed.pathname.slice("/api".length);
      const call = { path, url: parsed, method, headers, init, body: init.body };
      apiRequests.push(call);
      if (path === "/chat/conversations") return listHandler(call);
      const textMatch = path.match(/^\/chat\/conversations\/([^/]+)\/turns\/(\d+)\/text$/);
      if (textMatch) {
        return textHandler({
          ...call,
          conversationId: decodeURIComponent(textMatch[1]),
          ordinal: Number(textMatch[2]),
        });
      }
      const turnsMatch = path.match(/^\/chat\/conversations\/([^/]+)\/turns$/);
      if (turnsMatch)
        return turnsHandler({ ...call, conversationId: decodeURIComponent(turnsMatch[1]) });
      return jsonResponse({ code: "NOT_FOUND" }, 404);
    }
    if (url === runtimeUrl(config)) {
      const request = JSON.parse(String(init.body));
      const call = {
        request,
        url,
        method,
        headers,
        body: String(init.body),
        signal: init.signal,
      };
      runtimeRequests.push(call);
      if (headers.get("accept") === "application/json") return recoverHandler(request, call);
      return runtimeHandler(request, call);
    }
    throw new Error(`Unexpected history web request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);

  return { storage, identity, config, session, apiRequests, runtimeRequests, fetch };
}

export async function loadHistoryAccountApp() {
  return loadAccountAppForHookTests();
}

export function mountHistoryAccountApp(environment, AccountApp, initialRoute = { kind: "chat" }) {
  globalThis.__accountSession = environment.session;
  return createAccountAppHookHarness({
    AccountApp,
    getSession: () => environment.session,
    initialRoute,
  });
}

export function chatView(app) {
  const element = app.current();
  return element?.props || {};
}

export async function settle(app) {
  await app.flush();
  return chatView(app);
}
