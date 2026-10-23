import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAccountAppHookHarness,
  loadAccountAppForHookTests,
} from "../support/account-app-hook-harness.mjs";

const config = {
  region: "us-east-1",
  userPoolId: "us-east-1_example",
  clientId: "web-client",
  apiBaseUrl: "/api",
  botId: "docentes",
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
  runtimeQualifier: "DEFAULT",
};
const identity = { sub: "teacher-a", botId: "docentes" };
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const firstQueryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";
const question = "Prepará una secuencia breve sobre porcentajes.";
const answer = "Actividad: calculen el 25 % de 80 y expliquen el procedimiento.";
const internalSentinels = [
  "DOCUMENT_CONTEXT_SENTINEL",
  "KB_ID_SENTINEL",
  "s3://private-documents/lesson.pdf",
  "PROFILE_TEXT_SENTINEL",
  "TOKEN_COUNT_SENTINEL",
];

let AccountApp;
let disposeAccountAppModule;
const apps = [];

beforeAll(async () => {
  ({ AccountApp, dispose: disposeAccountAppModule } = await loadAccountAppForHookTests());
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

  getItem(key) {
    return this.values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function event(type, fields = {}) {
  return { type, ...fields };
}

function eventFrame(item) {
  return `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`;
}

function controlledSse() {
  let controller;
  const encoder = new TextEncoder();
  const response = new Response(
    new ReadableStream({
      start(current) {
        controller = current;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  return {
    response,
    send(item) {
      controller.enqueue(encoder.encode(eventFrame(item)));
    },
    close() {
      controller.close();
    },
  };
}

function uuidSequence() {
  const values = [conversationId, firstQueryId];
  let cursor = 0;
  return () => values[cursor++] || "d266b6c3-5c0d-4b45-a9da-77b675bed25b";
}

function runtimeUrl() {
  return (
    `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/` +
    `${encodeURIComponent(config.runtimeArn)}/invocations?qualifier=${encodeURIComponent(config.runtimeQualifier)}`
  );
}

function findStoredRecord(storage, queryId) {
  for (const [key, raw] of storage.values) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.request?.queryId === queryId) return { key, raw, value: parsed };
    } catch {
      // Other session values are not chat journal records.
    }
  }
  return null;
}

function allStorageText(storage) {
  return [...storage.values.values()].join("\n");
}

function createEnvironment({ streamHandler }) {
  const storage = new MemorySessionStorage();
  const runtimeRequests = [];
  const session = {
    accessToken: vi.fn(() => "ACCESS_TOKEN_SENTINEL"),
    idToken: vi.fn(() => "ID_TOKEN_SENTINEL"),
    restore: vi.fn(async () => ({ accessToken: "ACCESS_TOKEN_SENTINEL" })),
    signOut: vi.fn(async () => undefined),
  };
  const clipboardWrite = vi.fn(async () => undefined);

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
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboardWrite } });

  const fetch = vi.fn(async (input, init = {}) => {
    const url = String(input);
    if (url === "/public-config.json") return jsonResponse(config);
    if (url === "/api/account/me") return jsonResponse(identity);
    if (url === "/api/profile") {
      return jsonResponse({
        sub: identity.sub,
        botId: identity.botId,
        profile: {
          sub: identity.sub,
          botId: identity.botId,
          updatedAt: "2026-10-20T00:00:00.000Z",
          fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
          responsePreferenceIds: [],
        },
      });
    }
    if (url === runtimeUrl()) {
      const request = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      const call = {
        request,
        body: String(init.body),
        accept: headers.get("accept"),
        journalAtPost: findStoredRecord(storage, request.queryId)?.value,
      };
      runtimeRequests.push(call);
      if (headers.get("accept") === "application/json") {
        return jsonResponse({
          type: "failed",
          code: "conversation_unavailable",
          message: "No se encontró el envío.",
          recordStatus: "not_admitted",
          queryId: request.queryId,
        });
      }
      return streamHandler(request, call);
    }
    throw new Error(`Unexpected web request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);

  return { storage, session, runtimeRequests, fetch, clipboardWrite };
}

function mount(environment) {
  globalThis.__accountSession = environment.session;
  const app = createAccountAppHookHarness({
    AccountApp,
    getSession: () => environment.session,
  });
  apps.push(app);
  return app;
}

async function initialize(app) {
  await app.flush();
  return app.html();
}

function submissions(environment) {
  return environment.runtimeRequests.filter(({ request }) =>
    ["start", "message"].includes(request.operation),
  );
}

function plainText(markup) {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buttonNames(markup) {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map(([, attrs, label]) => {
    const ariaLabel = attrs.match(/\baria-label="([^"]*)"/i)?.[1];
    return ariaLabel || plainText(label);
  });
}

function expectNoInternalSentinels(text) {
  for (const sentinel of internalSentinels) expect(text).not.toContain(sentinel);
  for (const field of [
    "documentContext",
    "knowledgeBaseId",
    "uri",
    "retrievedText",
    "profileText",
    "tokenCount",
    "score",
  ]) {
    expect(text).not.toContain(field);
  }
  expect(text).not.toContain("0.93");
}

describe("document-backed chat acceptance in the web account flow", () => {
  it("keeps a pre-acceptance journal and retries a document rejection only on explicit action", async () => {
    const streams = [];
    const environment = createEnvironment({
      streamHandler: () => {
        const stream = controlledSse();
        streams.push(stream);
        return stream.response;
      },
    });
    const app = mount(environment);
    await initialize(app);

    expect(app.current().props.onSubmit(question)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(1));
    await app.flush();

    const first = submissions(environment)[0];
    const pendingJournal = findStoredRecord(environment.storage, first.request.queryId);
    expect(first.request).toEqual({
      version: 2,
      operation: "start",
      conversationId,
      queryId: firstQueryId,
      baseOrdinal: 0,
      text: question,
    });
    expect(first.journalAtPost).toMatchObject({ request: first.request, admitted: false });
    expect(pendingJournal?.value).toMatchObject({ request: first.request, admitted: false });
    expect(app.current().props.state).toMatchObject({ queryStatus: "sending", question });
    const pendingHtml = await app.html();
    expect(plainText(pendingHtml)).toMatch(/enviando consulta/i);
    expect(plainText(pendingHtml)).not.toMatch(/respuesta está completa|respuesta completa/i);
    expect(buttonNames(pendingHtml).some((name) => /copiar/i.test(name))).toBe(false);
    expect(submissions(environment)).toHaveLength(1);

    streams[0].send(
      event("failed", {
        code: "documents_unavailable",
        message:
          "No pudimos consultar los documentos. Conservamos tu pedido para que puedas reintentar.",
        recordStatus: "not_admitted",
        queryId: first.request.queryId,
        documentContext: internalSentinels[0],
        knowledgeBaseId: internalSentinels[1],
        uri: internalSentinels[2],
        score: 0.93,
        retrievedText: internalSentinels[3],
      }),
    );
    streams[0].close();
    await app.flush();

    const rejectedState = app.current().props.state;
    const rejectedHtml = await app.html();
    expect(rejectedState).toMatchObject({
      queryStatus: "rejected",
      question,
      queryErrorCode: "documents_unavailable",
      canRetry: true,
    });
    expect(rejectedState.answer || "").toBe("");
    expect(plainText(rejectedHtml)).toMatch(/documentos/i);
    expect(buttonNames(rejectedHtml)).toContain("Reintentar el mismo envío");
    expect(buttonNames(rejectedHtml).some((name) => /copiar/i.test(name))).toBe(false);
    expectNoInternalSentinels(rejectedHtml);
    const rejectedJournal = findStoredRecord(environment.storage, first.request.queryId);
    expect(rejectedJournal?.value).toMatchObject({ request: first.request, admitted: false });
    expect(submissions(environment)).toHaveLength(1);

    expect(app.current().props.onSubmit(question)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(2));
    await app.flush();

    const retry = submissions(environment)[1];
    expect(retry.body).toBe(first.body);
    expect(retry.request).toEqual(first.request);
    expect(retry.journalAtPost).toMatchObject({ request: first.request, admitted: false });
    expect(submissions(environment)).toHaveLength(2);

    streams[1].send(
      event("accepted", {
        conversationId,
        queryId: firstQueryId,
        ordinal: 1,
        documentContext: internalSentinels[0],
        knowledgeBaseId: internalSentinels[1],
        uri: internalSentinels[2],
        score: 0.93,
        profileText: internalSentinels[3],
        tokenCount: internalSentinels[4],
      }),
    );
    await app.flush();

    expect(app.current().props.state.queryStatus).toBe("streaming");
    const admittedJournal = findStoredRecord(environment.storage, first.request.queryId);
    expect(admittedJournal?.value).toMatchObject({
      request: {
        version: 2,
        operation: "start",
        conversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
      },
      admitted: true,
      ordinal: 1,
    });
    expect(admittedJournal?.value.request).not.toHaveProperty("text");
    expect(allStorageText(environment.storage)).not.toContain(question);
    expect(allStorageText(environment.storage)).not.toContain("Matemática");
    expect(allStorageText(environment.storage)).not.toContain("secundario");
    expect(allStorageText(environment.storage)).not.toContain("ACCESS_TOKEN_SENTINEL");
    expect(allStorageText(environment.storage)).not.toContain("ID_TOKEN_SENTINEL");
    expectNoInternalSentinels(allStorageText(environment.storage));

    streams[1].send(
      event("text", {
        queryId: firstQueryId,
        index: 0,
        text: answer,
        documentContext: internalSentinels[0],
        knowledgeBaseId: internalSentinels[1],
        uri: internalSentinels[2],
        score: 0.93,
        tokenCount: internalSentinels[4],
      }),
    );
    await app.flush();
    expect(app.current().props.state).toMatchObject({ queryStatus: "streaming", answer });
    const streamingHtml = await app.html();
    expect(plainText(streamingHtml)).toMatch(/generando respuesta/i);
    expect(plainText(streamingHtml)).not.toMatch(/respuesta está completa|respuesta completa/i);
    expect(buttonNames(streamingHtml).some((name) => /copiar/i.test(name))).toBe(false);
    expectNoInternalSentinels(streamingHtml);

    streams[1].send(
      event("completed", {
        queryId: firstQueryId,
        documentContext: internalSentinels[0],
        knowledgeBaseId: internalSentinels[1],
        uri: internalSentinels[2],
        score: 0.93,
      }),
    );
    streams[1].close();
    await app.flush();

    expect(app.current().props.state).toMatchObject({ queryStatus: "completed", question, answer });
    const completedHtml = await app.html();
    expect(completedHtml).toContain(answer);
    expect(buttonNames(completedHtml)).toContain("Copiar respuesta");
    expectNoInternalSentinels(completedHtml);
    await app.current().props.onCopy(answer);
    expect(environment.clipboardWrite).toHaveBeenCalledTimes(1);
    expect(environment.clipboardWrite).toHaveBeenCalledWith(answer);
    expectNoInternalSentinels(allStorageText(environment.storage));
    expect(environment.runtimeRequests.map(({ body }) => body)).toHaveLength(2);
    for (const { body } of environment.runtimeRequests) expectNoInternalSentinels(body);
  });

  it("keeps an uncertain document retry recoverable until an explicit retry resolves it", async () => {
    const streams = [];
    const environment = createEnvironment({
      streamHandler: () => {
        const stream = controlledSse();
        streams.push(stream);
        return stream.response;
      },
    });
    const app = mount(environment);
    await initialize(app);

    expect(app.current().props.onSubmit(question)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(1));
    streams[0].send(
      event("failed", {
        code: "documents_unavailable",
        message:
          "No pudimos consultar los documentos. Conservamos tu pedido para que puedas reintentar.",
        recordStatus: "not_admitted",
        queryId: firstQueryId,
      }),
    );
    streams[0].close();
    await app.flush();
    expect(app.current().props.state).toMatchObject({
      queryStatus: "rejected",
      question,
      canRetry: true,
    });

    expect(app.current().props.onSubmit(question)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(2));
    streams[1].close();
    await app.flush();
    expect(app.current().props.state).toMatchObject({
      queryStatus: "unconfirmed",
      question,
      canRetry: true,
    });
    await vi.waitFor(async () => {
      await app.flush();
      expect(
        environment.runtimeRequests.filter(({ request }) => request.operation === "recover"),
      ).toHaveLength(1);
    });
    await app.flush();

    const uncertain = app.current().props.state;
    const uncertainHtml = await app.html();
    expect(uncertain).toMatchObject({ queryStatus: "unconfirmed", question, canRetry: true });
    expect(plainText(uncertainHtml)).toMatch(/no pudimos confirmar/i);
    expect(buttonNames(uncertainHtml)).toContain("Reintentar el mismo envío");
    expect(buttonNames(uncertainHtml).some((name) => /copiar/i.test(name))).toBe(false);
    expect(submissions(environment)).toHaveLength(2);
    expect(findStoredRecord(environment.storage, firstQueryId)?.value).toMatchObject({
      request: {
        operation: "start",
        conversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
        text: question,
      },
      admitted: false,
    });

    expect(app.current().props.onSubmit(question)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(3));
    const retry = submissions(environment)[2];
    expect(retry.body).toBe(submissions(environment)[0].body);
    expect(retry.request).toEqual(submissions(environment)[0].request);
    streams[2].send(
      event("accepted", {
        conversationId,
        queryId: firstQueryId,
        ordinal: 1,
      }),
    );
    streams[2].send(event("text", { queryId: firstQueryId, index: 0, text: answer }));
    streams[2].send(event("completed", { queryId: firstQueryId }));
    streams[2].close();
    await app.flush();
    expect(app.current().props.state).toMatchObject({ queryStatus: "completed", question, answer });
  });
});
