import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAccountAppHookHarness,
  loadAccountAppForHookTests,
} from "../support/account-app-hook-harness.mjs";
import { markChatJournalAdmitted, writePendingChatJournal } from "../../web/chat-journal.ts";

const initialConversationId = "550e8400-e29b-41d4-a716-446655440000";
const initialQueryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";
const secondQueryId = "b0d7cf70-ae36-49f4-a1b9-2837633a54ca";
const thirdId = "c166b6c3-5c0d-4b45-a9da-77b675bed25b";
const baseConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_example",
  clientId: "web-client",
  apiBaseUrl: "/api",
  botId: "docentes",
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
  runtimeQualifier: "DEFAULT",
};
const defaultIdentity = { sub: "teacher-a", botId: "docentes" };
const originalQuestion = "Prepará una actividad completa de porcentajes.";
const accessToken = "temporary-access-token-not-for-storage";
const idToken = "temporary-id-token-not-for-storage";

let AccountApp;
let createSession;
let disposeAccountAppModule;
const apps = [];

beforeAll(async () => {
  ({
    AccountApp,
    createSession,
    dispose: disposeAccountAppModule,
  } = await loadAccountAppForHookTests());
});

afterAll(async () => {
  await disposeAccountAppModule?.();
});

afterEach(() => {
  for (const app of apps.splice(0).reverse()) app.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete globalThis.__accountHooks;
  delete globalThis.__accountScreens;
  delete globalThis.__accountSession;
});

class MemorySessionStorage {
  values = new Map();
  events = [];

  constructor({ denyJournalWrites = false } = {}) {
    this.denyJournalWrites = denyJournalWrites;
  }

  getItem(key) {
    return this.values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    const name = String(key);
    this.events.push(`storage:${name}`);
    if (this.denyJournalWrites && name !== "auth-refresh") {
      throw new DOMException("Storage is unavailable", "QuotaExceededError");
    }
    this.values.set(name, String(value));
  }

  removeItem(key) {
    this.events.push(`remove:${String(key)}`);
    this.values.delete(String(key));
  }

  clear() {
    this.values.clear();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function snapshot(request, overrides = {}) {
  return {
    version: 2,
    conversationId: request.conversationId,
    queryId: request.queryId,
    ordinal: request.baseOrdinal === undefined ? 1 : request.baseOrdinal + 1,
    status: "completed",
    question: request.text || originalQuestion,
    answer: "Respuesta recuperada y durable.",
    canContinue: true,
    ...overrides,
  };
}

function sse(events, { close = true } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const item of events) {
        controller.enqueue(
          encoder.encode(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`),
        );
      }
      if (close) controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function openAcceptedStream(request) {
  const accepted = deferred();
  let controller;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(current) {
      controller = current;
      current.enqueue(
        encoder.encode(
          `event: accepted\ndata: ${JSON.stringify({
            type: "accepted",
            conversationId: request.conversationId,
            queryId: request.queryId,
            ordinal: request.baseOrdinal + 1,
          })}\n\n`,
        ),
      );
      accepted.resolve();
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    accepted: accepted.promise,
    finish(answer = "Respuesta terminada.") {
      controller.enqueue(
        encoder.encode(
          `event: text\ndata: ${JSON.stringify({
            type: "text",
            queryId: request.queryId,
            index: 0,
            text: answer,
          })}\n\n` +
            `event: completed\ndata: ${JSON.stringify({ type: "completed", queryId: request.queryId })}\n\n`,
        ),
      );
      controller.close();
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function runtimeUrl(config) {
  return (
    `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/` +
    `${encodeURIComponent(config.runtimeArn)}/invocations?qualifier=${encodeURIComponent(config.runtimeQualifier)}`
  );
}

function walkRecords(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkRecords(item, visit);
  } else if (value && typeof value === "object") {
    visit(value);
    for (const item of Object.values(value)) walkRecords(item, visit);
  }
}

function findStoredRecord(storage, queryId) {
  for (const [key, raw] of storage.values) {
    try {
      const parsed = JSON.parse(raw);
      let found;
      walkRecords(parsed, (value) => {
        if (!found && value.queryId === queryId) found = value;
      });
      if (found) return { key, raw, value: found };
    } catch {
      // Non-JSON session values, such as the refresh token, are not journal records.
    }
  }
  return null;
}

function allStorageText(storage) {
  return [...storage.values.values()].join("\n");
}

function uuidSequence() {
  const values = [initialConversationId, initialQueryId, secondQueryId, thirdId];
  let cursor = 0;
  return () => values[cursor++] || "d266b6c3-5c0d-4b45-a9da-77b675bed25b";
}

function confirmedHistoryMeta(conversationId, { label = originalQuestion, lastOrdinal = 1 } = {}) {
  return {
    conversationId,
    ownerSub: defaultIdentity.sub,
    botId: defaultIdentity.botId,
    label,
    lastOrdinal,
    closed: false,
  };
}

function createEnvironment({
  storage = new MemorySessionStorage(),
  identity = defaultIdentity,
  config = baseConfig,
  profileComplete = true,
  restoreSession = true,
  session: providedSession,
  membershipStatus = 200,
  requestPasswordReset = vi.fn(async () => undefined),
  confirmPasswordReset = vi.fn(async () => undefined),
  historySnapshot,
  historyMeta,
  streamHandler = (request) =>
    sse([
      {
        type: "accepted",
        conversationId: request.conversationId,
        queryId: request.queryId,
        ordinal: request.baseOrdinal + 1,
      },
      { type: "text", queryId: request.queryId, index: 0, text: "Respuesta completada." },
      { type: "completed", queryId: request.queryId },
    ]),
  recoverHandler = (request) =>
    jsonResponse({
      type: "failed",
      code: "conversation_unavailable",
      message: "No se encontró el envío.",
      recordStatus: "not_admitted",
      queryId: request.queryId,
    }),
} = {}) {
  const runtimeRequests = [];
  const apiRequests = [];
  const events = storage.events;
  let token = accessToken;
  const session = providedSession || {
    accessToken: vi.fn(() => token),
    idToken: vi.fn(() => idToken),
    restore: vi.fn(async () => {
      events.push("session:restore");
      return restoreSession ? { accessToken: token, idToken } : null;
    }),
    signOut: vi.fn(async () => {
      token = null;
      storage.removeItem("auth-refresh");
    }),
    requestPasswordReset,
    confirmPasswordReset,
    signIn: vi.fn(),
  };

  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("window", {
    location: { hash: "#/chat", pathname: "/", search: "" },
    history: { replaceState() {} },
    crypto: { randomUUID: uuidSequence() },
    sessionStorage: storage,
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args),
    clearInterval: (...args) => globalThis.clearInterval(...args),
  });
  const clipboardWrite = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboardWrite } });

  const fetch = vi.fn(async (input, init = {}) => {
    const url = String(input);
    if (url === "/public-config.json") return jsonResponse(config);
    if (url === "/api/account/me") {
      events.push("api:account/me");
      apiRequests.push({ url, init });
      if (membershipStatus !== 200) {
        return jsonResponse(
          { code: membershipStatus === 403 ? "FORBIDDEN" : "UNAUTHORIZED" },
          membershipStatus,
        );
      }
      return jsonResponse(identity);
    }
    if (url === "/api/profile") {
      apiRequests.push({ url, init });
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
      apiRequests.push({ url, init });
      const parsed = new URL(url, "https://fixture.invalid");
      if (parsed.pathname === "/api/chat/conversations") {
        return jsonResponse({
          version: 1,
          conversations: historySnapshot
            ? [
                {
                  conversationId: historySnapshot.conversationId,
                  label: historySnapshot.question,
                  lastOrdinal: historySnapshot.ordinal,
                  closed: false,
                },
              ]
            : [],
        });
      }
      const metaMatch = /^\/api\/chat\/conversations\/([^/]+)$/.exec(parsed.pathname);
      if (metaMatch && (!init.method || init.method === "GET")) {
        const conversationId = decodeURIComponent(metaMatch[1]);
        const headers = new Headers(init.headers);
        if (
          !historyMeta ||
          conversationId !== historyMeta.conversationId ||
          historyMeta.ownerSub !== identity.sub ||
          historyMeta.botId !== identity.botId ||
          identity.botId !== config.botId ||
          headers.get("authorization") !== `Bearer ${session.accessToken()}`
        ) {
          return jsonResponse({ code: "CONVERSATION_UNAVAILABLE" }, 404);
        }
        return jsonResponse({
          version: 1,
          conversationId: historyMeta.conversationId,
          label: historyMeta.label,
          lastOrdinal: historyMeta.lastOrdinal,
          closed: historyMeta.closed,
        });
      }
      if (!historySnapshot) return jsonResponse({ code: "CONVERSATION_UNAVAILABLE" }, 404);
      const base = `/api/chat/conversations/${historySnapshot.conversationId}/turns`;
      if (parsed.pathname === base) {
        return jsonResponse({
          version: 1,
          conversationId: historySnapshot.conversationId,
          throughOrdinal: historySnapshot.ordinal,
          closed: false,
          canContinue: true,
          turns: [
            {
              ordinal: historySnapshot.ordinal,
              queryId: historySnapshot.queryId,
              status: "completed",
              questionManifest: { count: 1, complete: true },
              answerManifest: { count: 1, complete: true },
              cursor: 1,
            },
          ],
        });
      }
      if (parsed.pathname === `${base}/${historySnapshot.ordinal}/text`) {
        const role = parsed.searchParams.get("role");
        return jsonResponse({
          version: 1,
          conversationId: historySnapshot.conversationId,
          queryId: historySnapshot.queryId,
          ordinal: historySnapshot.ordinal,
          role,
          chunks: [
            { index: 0, text: role === "user" ? historySnapshot.question : historySnapshot.answer },
          ],
          complete: true,
        });
      }
      throw new Error(`Unexpected history request: ${url}`);
    }
    if (url === runtimeUrl(config)) {
      const headers = new Headers(init.headers);
      const request = JSON.parse(String(init.body));
      const journalAtPost = findStoredRecord(storage, request.queryId)?.value;
      events.push(`runtime:${request.operation}`);
      const call = {
        request,
        body: String(init.body),
        accept: headers.get("accept"),
        authorization: headers.get("authorization"),
        journalAtPost,
      };
      runtimeRequests.push(call);
      if (headers.get("accept") === "application/json") return recoverHandler(request, call);
      return streamHandler(request, call);
    }
    throw new Error(`Unexpected web request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);

  return {
    storage,
    identity,
    config,
    session,
    runtimeRequests,
    apiRequests,
    events,
    fetch,
    clipboardWrite,
  };
}

function mount(environment, initialRoute = { kind: "chat" }) {
  globalThis.__accountSession = environment.session;
  const app = createAccountAppHookHarness({
    AccountApp,
    getSession: () => environment.session,
    initialRoute,
  });
  apps.push(app);
  return app;
}

async function initialize(app) {
  await app.flush();
  return app.html();
}

async function seedAcceptedJournal(storage = new MemorySessionStorage()) {
  let acceptedStream;
  const environment = createEnvironment({
    storage,
    streamHandler: (request) => {
      acceptedStream = openAcceptedStream(request);
      return acceptedStream.response;
    },
  });
  const app = mount(environment);
  await initialize(app);
  expect(app.current().props.onSubmit(originalQuestion)).toBe(true);
  await vi.waitFor(() => expect(startCalls(environment)).toHaveLength(1));
  await acceptedStream.accepted;
  await app.flush();
  const request = startCalls(environment)[0].request;
  const historyMeta = confirmedHistoryMeta(request.conversationId, {
    label: originalQuestion,
    lastOrdinal: request.baseOrdinal + 1,
  });
  expect(findStoredRecord(storage, request.queryId)).not.toBeNull();
  return { environment, app, request, acceptedStream, historyMeta, storage };
}

function recoverCalls(environment) {
  return environment.runtimeRequests.filter(({ request }) => request.operation === "recover");
}

function startCalls(environment) {
  return environment.runtimeRequests.filter(({ request }) => request.operation === "start");
}

function submissionCalls(environment) {
  return environment.runtimeRequests.filter(({ request }) =>
    ["start", "message"].includes(request.operation),
  );
}

describe("the chat recovery journal and restored submission", () => {
  it("keeps an admitted journal through real session restoration failure and recovers it after retry", async () => {
    const storage = new MemorySessionStorage();
    storage.setItem("auth-refresh", "refresh-before-network-error");
    const authRequests = [];
    let refreshAttempts = 0;
    const session = createSession({
      clientId: baseConfig.clientId,
      region: baseConfig.region,
      storage,
      fetch: async (_url, init) => {
        const target = new Headers(init.headers).get("x-amz-target") || "";
        const body = JSON.parse(String(init.body));
        authRequests.push({ target, body });
        if (!target.endsWith("InitiateAuth") || body.AuthFlow !== "REFRESH_TOKEN_AUTH") {
          throw new Error(`Unexpected Cognito request: ${target}`);
        }
        refreshAttempts += 1;
        if (refreshAttempts === 1) throw new TypeError("network unavailable");
        return jsonResponse({
          AuthenticationResult: {
            AccessToken: "restored-access-token",
            IdToken: "restored-id-token",
            RefreshToken: "refresh-after-retry",
          },
        });
      },
    });
    const environment = createEnvironment({
      storage,
      session,
      historyMeta: confirmedHistoryMeta(initialConversationId),
      recoverHandler: (request) =>
        jsonResponse(
          snapshot(request, {
            status: "completed",
            question: originalQuestion,
            answer: "Respuesta recuperada tras revalidar la sesión.",
          }),
        ),
    });
    const request = {
      version: 2,
      operation: "start",
      conversationId: initialConversationId,
      queryId: initialQueryId,
      baseOrdinal: 0,
      text: originalQuestion,
    };
    writePendingChatJournal(baseConfig, defaultIdentity, request);
    markChatJournalAdmitted(baseConfig, defaultIdentity, request, 1);

    const app = mount(environment);
    await initialize(app);

    expect(app.current().props.state).toMatchObject({ view: "denied", retryable: true });
    expect(authRequests).toHaveLength(1);
    expect(storage.getItem("auth-refresh")).toBe("refresh-before-network-error");
    expect(JSON.parse(findStoredRecord(storage, initialQueryId).raw)).toMatchObject({
      admitted: true,
      request: { queryId: initialQueryId },
    });
    expect(environment.runtimeRequests).toHaveLength(0);

    await app.current().props.onSubmit({ action: "retry" });
    await app.flush();
    await vi.waitFor(async () => {
      expect(recoverCalls(environment)).toHaveLength(1);
      expect(await app.html()).toContain("Respuesta recuperada tras revalidar la sesión.");
    });

    expect(authRequests).toHaveLength(2);
    expect(session.accessToken()).toBe("restored-access-token");
    expect(storage.getItem("auth-refresh")).toBe("refresh-after-retry");
    expect(environment.runtimeRequests.map(({ request: actual }) => actual.operation)).toEqual([
      "recover",
    ]);
    expect(recoverCalls(environment)[0].request).toEqual({
      version: 2,
      operation: "recover",
      conversationId: initialConversationId,
      queryId: initialQueryId,
    });
    expect(submissionCalls(environment)).toHaveLength(0);
    expect(allStorageText(storage)).not.toContain(originalQuestion);
  });

  it("writes the exact request before POST and minimizes it after accepted", async () => {
    const storage = new MemorySessionStorage();
    let pendingStream;
    const environment = createEnvironment({
      storage,
      streamHandler: (request) => {
        pendingStream = openAcceptedStream(request);
        return pendingStream.response;
      },
    });
    const app = mount(environment);
    await initialize(app);

    expect(app.current().props.onSubmit(originalQuestion)).toBe(true);
    await vi.waitFor(() => expect(environment.runtimeRequests).toHaveLength(1));
    const request = environment.runtimeRequests[0].request;
    expect(environment.runtimeRequests[0].journalAtPost).toMatchObject(request);
    expect(request).toEqual({
      version: 2,
      operation: "start",
      conversationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      queryId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      baseOrdinal: 0,
      text: originalQuestion,
    });
    expect(environment.events.indexOf(`runtime:start`)).toBeGreaterThan(
      environment.events.findIndex((entry) => entry.startsWith("storage:")),
    );
    await pendingStream.accepted;
    await app.flush();

    const recordAfterAccepted = findStoredRecord(storage, request.queryId);
    expect(recordAfterAccepted?.value).toMatchObject({
      conversationId: request.conversationId,
      queryId: request.queryId,
      operation: "start",
      baseOrdinal: 0,
    });
    expect(recordAfterAccepted?.value).not.toHaveProperty("text");
    expect(recordAfterAccepted?.value).not.toHaveProperty("question");
    expect(recordAfterAccepted?.value).not.toHaveProperty("answer");
    expect(JSON.stringify(recordAfterAccepted?.value)).not.toMatch(
      /profile|educationLevels|subjects/i,
    );
    expect(allStorageText(storage)).not.toContain(originalQuestion);
    expect(allStorageText(storage)).not.toContain(accessToken);
    expect(allStorageText(storage)).not.toContain(idToken);
  });

  it("does not POST when session storage refuses the pre-send journal and returns false to retain the draft", async () => {
    const environment = createEnvironment({
      storage: new MemorySessionStorage({ denyJournalWrites: true }),
    });
    const app = mount(environment);
    await initialize(app);

    expect(app.current().props.onSubmit(originalQuestion)).toBe(false);
    await app.flush();

    expect(environment.runtimeRequests).toHaveLength(0);
    const html = await app.html();
    expect(html).toMatch(/role="alert"/);
  });

  it("recovers a cut-before-accepted request by the same IDs without a new start, even with an incomplete profile", async () => {
    const storage = new MemorySessionStorage();
    const first = createEnvironment({
      storage,
      streamHandler: () => sse([]),
    });
    const firstApp = mount(first);
    await initialize(firstApp);
    expect(firstApp.current().props.onSubmit(originalQuestion)).toBe(true);
    await vi.waitFor(() => expect(startCalls(first)).toHaveLength(1));
    await vi.waitFor(async () => expect(await firstApp.html()).toMatch(/no pudimos confirmar/i));
    const original = startCalls(first)[0].request;
    const pending = findStoredRecord(storage, original.queryId);
    expect(pending?.value).toMatchObject(original);
    firstApp.dispose();

    const restored = createEnvironment({
      storage,
      profileComplete: false,
      recoverHandler: (request) =>
        jsonResponse(
          snapshot(request, {
            status: "completed",
            question: originalQuestion,
            answer: "Respuesta encontrada después del corte.",
            canContinue: true,
          }),
        ),
    });
    const eventOffset = restored.events.length;
    const restoredApp = mount(restored);
    const html = await initialize(restoredApp);
    const restorationEvents = restored.events.slice(eventOffset);

    expect(restored.session.restore).toHaveBeenCalledTimes(1);
    expect(restorationEvents.indexOf("session:restore")).toBeLessThan(
      restorationEvents.indexOf("api:account/me"),
    );
    expect(restorationEvents.indexOf("api:account/me")).toBeLessThan(
      restorationEvents.indexOf("runtime:recover"),
    );
    expect(recoverCalls(restored).map(({ request }) => request)).toContainEqual({
      version: 2,
      operation: "recover",
      conversationId: original.conversationId,
      queryId: original.queryId,
    });
    expect(submissionCalls(restored)).toHaveLength(0);
    expect(submissionCalls(restored)).toHaveLength(0);
    expect(html).toContain(originalQuestion);
    expect(html).toContain("Respuesta encontrada después del corte.");
    expect(html).toContain("Recuperamos el último envío de esta conversación");
    expect(allStorageText(storage)).not.toContain(originalQuestion);
  });

  it("does not auto-resend when recover finds no snapshot and an explicit retry keeps the original body and IDs", async () => {
    const storage = new MemorySessionStorage();
    const first = createEnvironment({ storage, streamHandler: () => sse([]) });
    const firstApp = mount(first);
    await initialize(firstApp);
    firstApp.current().props.onSubmit(originalQuestion);
    await vi.waitFor(() => expect(startCalls(first)).toHaveLength(1));
    await vi.waitFor(async () => expect(await firstApp.html()).toMatch(/no pudimos confirmar/i));
    const original = startCalls(first)[0];
    firstApp.dispose();

    const restored = createEnvironment({
      storage,
      recoverHandler: (request) =>
        jsonResponse({
          type: "failed",
          code: "conversation_unavailable",
          message: "No se encontró el envío.",
          recordStatus: "not_admitted",
          queryId: request.queryId,
        }),
      streamHandler: (request) =>
        sse([
          {
            type: "accepted",
            conversationId: request.conversationId,
            queryId: request.queryId,
            ordinal: request.baseOrdinal + 1,
          },
          { type: "text", queryId: request.queryId, index: 0, text: "Reintento explícito." },
          { type: "completed", queryId: request.queryId },
        ]),
    });
    const restoredApp = mount(restored);
    await initialize(restoredApp);
    await vi.waitFor(() => expect(recoverCalls(restored)).toHaveLength(1));
    expect(submissionCalls(restored)).toHaveLength(0);

    expect(restoredApp.current().props.onSubmit(originalQuestion)).toBe(true);
    await vi.waitFor(() => expect(startCalls(restored)).toHaveLength(1));
    expect(startCalls(restored)[0].body).toBe(original.body);
    expect(recoverCalls(restored)).toHaveLength(1);
  });

  it("restores a failed partial answer, keeps it copyable, and blocks a follow-up when canContinue is false", async () => {
    const seeded = await seedAcceptedJournal();
    seeded.app.dispose();
    const restored = createEnvironment({
      storage: seeded.storage,
      historyMeta: seeded.historyMeta,
      recoverHandler: (request) =>
        jsonResponse(
          snapshot(request, {
            status: "failed",
            question: originalQuestion,
            answer: "Prefijo parcial guardado.",
            canContinue: false,
          }),
        ),
    });
    const app = mount(restored);
    const html = await initialize(app);

    expect(recoverCalls(restored)).toHaveLength(1);
    expect(html).toContain(originalQuestion);
    expect(html).toContain("Prefijo parcial guardado.");
    expect(html).toMatch(/respuesta quedó incompleta/i);
    await app.current().props.onCopy("Prefijo parcial guardado.");
    expect(restored.clipboardWrite).toHaveBeenCalledWith("Prefijo parcial guardado.");
    expect(app.current().props.onSubmit("No continuar este hilo.")).toBe(false);
    expect(submissionCalls(restored)).toHaveLength(0);
  });

  it("polls one recovery at a time, replaces rather than appends snapshots, and stops at terminal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const storage = new MemorySessionStorage();
    let initialStream;
    const first = createEnvironment({
      storage,
      streamHandler: (request) => {
        initialStream = openAcceptedStream(request);
        return initialStream.response;
      },
    });
    const firstApp = mount(first);
    await initialize(firstApp);
    firstApp.current().props.onSubmit(originalQuestion);
    await vi.waitFor(() => expect(startCalls(first)).toHaveLength(1));
    await initialStream.accepted;
    await firstApp.flush();
    const admittedRequest = startCalls(first)[0].request;
    firstApp.dispose();

    const secondPoll = deferred();
    let pollCount = 0;
    const restored = createEnvironment({
      storage,
      historyMeta: confirmedHistoryMeta(admittedRequest.conversationId, {
        label: originalQuestion,
        lastOrdinal: admittedRequest.baseOrdinal + 1,
      }),
      recoverHandler: (request) => {
        pollCount += 1;
        if (pollCount === 1) {
          return jsonResponse(
            snapshot(request, {
              status: "in_progress",
              question: originalQuestion,
              answer: "Prefijo durable inicial.",
              canContinue: false,
            }),
          );
        }
        if (pollCount === 2) return secondPoll.promise;
        return jsonResponse(
          snapshot(request, {
            status: "completed",
            question: originalQuestion,
            answer: "Respuesta final durable.",
            canContinue: true,
          }),
        );
      },
    });
    const restoredApp = mount(restored);
    await initialize(restoredApp);
    expect(recoverCalls(restored)).toHaveLength(1);
    expect(await restoredApp.html()).toContain("Prefijo durable inicial.");

    for (let attempt = 0; attempt < 10 && recoverCalls(restored).length < 2; attempt += 1) {
      await vi.advanceTimersToNextTimerAsync();
    }
    expect(recoverCalls(restored)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(recoverCalls(restored)).toHaveLength(2);

    secondPoll.resolve(
      jsonResponse(
        snapshot(recoverCalls(restored)[1].request, {
          status: "in_progress",
          question: originalQuestion,
          answer: "Prefijo durable actualizado.",
          canContinue: false,
        }),
      ),
    );
    await restoredApp.flush();
    expect(await restoredApp.html()).toContain("Prefijo durable actualizado.");

    for (let attempt = 0; attempt < 10 && recoverCalls(restored).length < 3; attempt += 1) {
      await vi.advanceTimersToNextTimerAsync();
    }
    expect(recoverCalls(restored)).toHaveLength(3);
    await restoredApp.flush();
    const html = await restoredApp.html();
    expect(html).toContain("Respuesta final durable.");
    expect(html).not.toContain("Prefijo durable actualizado.");
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(recoverCalls(restored)).toHaveLength(3);
  });

  it("increases the recovery wait after consecutive transient errors and retains the same IDs", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const seeded = await seedAcceptedJournal();
    seeded.app.dispose();
    const attemptedAt = [];
    const restored = createEnvironment({
      storage: seeded.storage,
      historyMeta: seeded.historyMeta,
      recoverHandler: (request) => {
        attemptedAt.push(Date.now());
        return attemptedAt.length <= 2
          ? jsonResponse({ message: "temporarily unavailable" }, 503)
          : jsonResponse(snapshot(request, { question: originalQuestion }));
      },
    });
    const app = mount(restored);
    await initialize(app);

    expect(recoverCalls(restored)).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    for (const count of [2, 3]) {
      for (let attempt = 0; attempt < 10 && recoverCalls(restored).length < count; attempt += 1) {
        await vi.advanceTimersToNextTimerAsync();
        await app.flush();
      }
      expect(recoverCalls(restored)).toHaveLength(count);
    }
    const firstWait = attemptedAt[1] - attemptedAt[0];
    const secondWait = attemptedAt[2] - attemptedAt[1];
    expect(firstWait).toBeGreaterThan(0);
    expect(secondWait).toBeGreaterThan(firstWait);
    for (const call of recoverCalls(restored)) {
      expect(call.request).toEqual(recoverCalls(restored)[0].request);
    }
    expect(allStorageText(seeded.storage)).not.toContain(seeded.request.queryId);
    expect(await app.html()).toContain("Respuesta recuperada y durable.");
  });

  it("stops polling outside chat and resumes the same reference when returning", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const seeded = await seedAcceptedJournal();
    seeded.app.dispose();
    const olderRecover = deferred();
    const restored = createEnvironment({
      storage: seeded.storage,
      historyMeta: seeded.historyMeta,
      recoverHandler: (request) =>
        recoverCalls(restored).length === 1
          ? olderRecover.promise
          : jsonResponse(
              snapshot(request, {
                status: "completed",
                question: originalQuestion,
                answer: "Terminal observado al volver al chat.",
                canContinue: true,
              }),
            ),
    });
    const app = mount(restored);
    await initialize(app);
    expect(recoverCalls(restored)).toHaveLength(1);

    await app.setRoute("profile");
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(recoverCalls(restored)).toHaveLength(1);
    await app.setRoute("chat");
    await vi.waitFor(async () =>
      expect(await app.html()).toContain("Terminal observado al volver al chat."),
    );
    expect(recoverCalls(restored)).toHaveLength(2);
    expect(recoverCalls(restored)[1].request).toEqual(recoverCalls(restored)[0].request);
    olderRecover.resolve(
      jsonResponse(
        snapshot(recoverCalls(restored)[0].request, {
          status: "in_progress",
          question: originalQuestion,
          answer: "Prefijo tardío que no debe sustituir el terminal.",
          canContinue: false,
        }),
      ),
    );
    await app.flush();
    const html = await app.html();
    expect(html).toContain("Terminal observado al volver al chat.");
    expect(html).not.toContain("Prefijo tardío que no debe sustituir el terminal.");
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(recoverCalls(restored)).toHaveLength(2);
  });

  it.each([
    ["different member", { identity: { sub: "teacher-b", botId: "docentes" } }],
    [
      "different bot",
      {
        identity: { sub: "teacher-a", botId: "otro-bot" },
        config: { ...baseConfig, botId: "otro-bot" },
      },
    ],
    [
      "different environment",
      { config: { ...baseConfig, runtimeArn: `${baseConfig.runtimeArn}-other` } },
    ],
  ])("does not apply a journal from a %s", async (_label, target) => {
    const storage = new MemorySessionStorage();
    let firstStream;
    const first = createEnvironment({
      storage,
      streamHandler: (request) => {
        firstStream = openAcceptedStream(request);
        return firstStream.response;
      },
    });
    const firstApp = mount(first);
    await initialize(firstApp);
    firstApp.current().props.onSubmit(originalQuestion);
    await vi.waitFor(() => expect(startCalls(first)).toHaveLength(1));
    await firstStream.accepted;
    await firstApp.flush();
    const accepted = startCalls(first)[0].request;
    expect(findStoredRecord(storage, accepted.queryId)).not.toBeNull();
    firstApp.dispose();

    const other = createEnvironment({
      storage,
      identity: target.identity || defaultIdentity,
      config: target.config || baseConfig,
    });
    const otherApp = mount(other);
    await initialize(otherApp);

    expect(recoverCalls(other)).toHaveLength(0);
    expect(submissionCalls(other)).toHaveLength(0);
  });

  it("ignores an invalid journal rather than turning it into a new automatic start", async () => {
    const storage = new MemorySessionStorage();
    let firstStream;
    const first = createEnvironment({
      storage,
      streamHandler: (request) => {
        firstStream = openAcceptedStream(request);
        return firstStream.response;
      },
    });
    const firstApp = mount(first);
    await initialize(firstApp);
    firstApp.current().props.onSubmit(originalQuestion);
    await vi.waitFor(() => expect(startCalls(first)).toHaveLength(1));
    await firstStream.accepted;
    await firstApp.flush();
    const queryId = startCalls(first)[0].request.queryId;
    const record = findStoredRecord(storage, queryId);
    expect(record).not.toBeNull();
    if (!record) return;
    storage.setItem(record.key, JSON.stringify({ version: -1, queryId, corrupt: true }));
    firstApp.dispose();

    const restored = createEnvironment({ storage });
    const restoredApp = mount(restored);
    await initialize(restoredApp);

    expect(recoverCalls(restored)).toHaveLength(0);
    expect(submissionCalls(restored)).toHaveLength(0);
  });

  it("keeps the same reference through profile navigation and uses the recovered ordinal for a follow-up", async () => {
    const storage = new MemorySessionStorage();
    const first = createEnvironment({
      storage,
      recoverHandler: (request) =>
        jsonResponse(
          snapshot(request, { question: originalQuestion, answer: "Respuesta completa." }),
        ),
      streamHandler: (request) =>
        sse([
          {
            type: "accepted",
            conversationId: request.conversationId,
            queryId: request.queryId,
            ordinal: 1,
          },
          { type: "text", queryId: request.queryId, index: 0, text: "Respuesta completa." },
          { type: "completed", queryId: request.queryId },
        ]),
    });
    const firstApp = mount(first);
    await initialize(firstApp);
    firstApp.current().props.onSubmit(originalQuestion);
    await vi.waitFor(() => expect(startCalls(first)).toHaveLength(1));
    await vi.waitFor(async () => expect(await firstApp.html()).toContain("Respuesta completa."));
    const original = startCalls(first)[0].request;

    await firstApp.setRoute("profile");
    await firstApp.setRoute("chat");
    await firstApp.flush();
    expect(startCalls(first)).toHaveLength(1);
    expect(findStoredRecord(storage, original.queryId)).toBeNull();
    for (const { request } of recoverCalls(first)) {
      expect(request).toMatchObject({
        conversationId: original.conversationId,
        queryId: original.queryId,
      });
    }

    firstApp.dispose();
    const restored = createEnvironment({
      storage,
      historySnapshot: snapshot(original, {
        question: originalQuestion,
        answer: "Respuesta completa.",
      }),
      recoverHandler: (request) =>
        jsonResponse(
          snapshot(request, { question: originalQuestion, answer: "Respuesta completa." }),
        ),
    });
    const app = mount(restored);
    await initialize(app);
    expect(recoverCalls(restored)).toHaveLength(0);
    expect(restored.apiRequests.some(({ url }) => url.includes("/turns"))).toBe(true);
    expect(await app.html()).toContain("Respuesta completa.");
    await app.current().props.onCopy("Respuesta completa.");
    expect(restored.clipboardWrite).toHaveBeenCalledWith("Respuesta completa.");
    expect(app.current().props.onSubmit("Un seguimiento del mismo hilo.")).toBe(true);
    await vi.waitFor(() => expect(submissionCalls(restored)).toHaveLength(1));
    expect(submissionCalls(restored)[0].request).toMatchObject({
      operation: "message",
      conversationId: original.conversationId,
      baseOrdinal: 1,
      text: "Un seguimiento del mismo hilo.",
    });
    expect(submissionCalls(restored)[0].request.queryId).not.toBe(original.queryId);
  });

  it("shows what happens to an accepted task and its consumed quota while it is active", async () => {
    const seeded = await seedAcceptedJournal();
    const text = (await seeded.app.html()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

    expect(text).toMatch(
      /(trabajo|tarea|generaci[oó]n).{0,60}(puede seguir|puede continuar|contin[uú]a)/i,
    );
    expect(text).toMatch(
      /(cupo.{0,40}(consumido|devuelve|reintegra)|consumido.{0,40}cupo|no devuelve el cupo)/i,
    );
    seeded.app.current().props.onReset();
    await seeded.app.flush();
    expect(allStorageText(seeded.storage)).toContain(seeded.request.queryId);
    expect(startCalls(seeded.environment)).toHaveLength(1);
  });

  it("clears the owner reference on logout and ignores an older recovery result", async () => {
    const storage = new MemorySessionStorage();
    let initialStream;
    const initial = createEnvironment({
      storage,
      streamHandler: (request) => {
        initialStream = openAcceptedStream(request);
        return initialStream.response;
      },
    });
    const initialApp = mount(initial);
    await initialize(initialApp);
    initialApp.current().props.onSubmit(originalQuestion);
    await vi.waitFor(() => expect(startCalls(initial)).toHaveLength(1));
    await initialStream.accepted;
    await initialApp.flush();
    const original = startCalls(initial)[0].request;
    initialApp.dispose();

    const pendingSnapshot = deferred();
    const restored = createEnvironment({
      storage,
      historyMeta: confirmedHistoryMeta(original.conversationId, {
        label: originalQuestion,
        lastOrdinal: original.baseOrdinal + 1,
      }),
      recoverHandler: () => pendingSnapshot.promise,
    });
    const restoredApp = mount(restored);
    await initialize(restoredApp);
    await vi.waitFor(() => expect(recoverCalls(restored)).toHaveLength(1));
    await restoredApp.current().props.onSignOut();
    await restoredApp.flush();
    expect(allStorageText(storage)).not.toContain(original.queryId);
    pendingSnapshot.resolve(
      jsonResponse(
        snapshot(recoverCalls(restored)[0].request, {
          question: originalQuestion,
          answer: "Respuesta tardía de otra identidad.",
        }),
      ),
    );
    await restoredApp.flush();
    expect(await restoredApp.html()).not.toContain("Respuesta tardía de otra identidad.");
    expect(submissionCalls(restored)).toHaveLength(0);
  });

  it("clears the journal after a successful password reset", async () => {
    const seeded = await seedAcceptedJournal();
    const queryId = seeded.request.queryId;
    await seeded.app.setRoute("recover");
    await seeded.app.current().props.onSubmit({
      action: "request-password-reset",
      email: "teacher@example.test",
    });
    await vi.waitFor(async () => expect(await seeded.app.html()).toContain('id="recovery-code"'));
    expect(findStoredRecord(seeded.storage, queryId)).not.toBeNull();
    await seeded.app.current().props.onSubmit({
      action: "confirm-password-reset",
      email: "teacher@example.test",
      code: "123456",
      password: "ValidPassword1!",
    });
    await seeded.app.flush();

    expect(allStorageText(seeded.storage)).not.toContain(queryId);
    expect(seeded.environment.session.confirmPasswordReset).toHaveBeenCalledTimes(1);
  });

  it("clears a loaded journal when a password reset starts directly on the recovery route", async () => {
    const seeded = await seedAcceptedJournal();
    const queryId = seeded.request.queryId;
    seeded.app.dispose();

    const recovered = createEnvironment({ storage: seeded.storage });
    const app = mount(recovered, { kind: "recover" });
    await initialize(app);
    await app.current().props.onSubmit({
      action: "request-password-reset",
      email: "teacher@example.test",
    });
    await vi.waitFor(async () => expect(await app.html()).toContain('id="recovery-code"'));
    await app.current().props.onSubmit({
      action: "confirm-password-reset",
      email: "teacher@example.test",
      code: "123456",
      password: "ValidPassword1!",
    });
    await app.flush();

    expect(allStorageText(seeded.storage)).not.toContain(queryId);
    app.dispose();

    const reentered = createEnvironment({ storage: seeded.storage });
    const reenteredApp = mount(reentered);
    await initialize(reenteredApp);
    expect(recoverCalls(reentered)).toHaveLength(0);
  });

  it("clears the durable journal when signing out from a reloaded login route", async () => {
    const seeded = await seedAcceptedJournal();
    const queryId = seeded.request.queryId;
    seeded.app.dispose();

    const reloaded = createEnvironment({ storage: seeded.storage });
    const loginApp = mount(reloaded, { kind: "login" });
    await initialize(loginApp);
    expect(reloaded.session.restore).toHaveBeenCalledTimes(1);
    await loginApp.current().props.onSignOut();
    await loginApp.flush();

    expect(allStorageText(seeded.storage)).not.toContain(queryId);
    loginApp.dispose();

    const sameIdentity = createEnvironment({ storage: seeded.storage });
    const chatApp = mount(sameIdentity);
    await initialize(chatApp);
    expect(sameIdentity.identity).toEqual(defaultIdentity);
    expect(recoverCalls(sameIdentity)).toHaveLength(0);
  });

  it("clears the journal when membership is definitively revoked before recovery", async () => {
    const seeded = await seedAcceptedJournal();
    const queryId = seeded.request.queryId;
    seeded.app.dispose();
    const revoked = createEnvironment({ storage: seeded.storage, membershipStatus: 403 });
    const app = mount(revoked);
    await initialize(app);

    expect(recoverCalls(revoked)).toHaveLength(0);
    expect(submissionCalls(revoked)).toHaveLength(0);
    expect(allStorageText(seeded.storage)).not.toContain(queryId);
  });
});
