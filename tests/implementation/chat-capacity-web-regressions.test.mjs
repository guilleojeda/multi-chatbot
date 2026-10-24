import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAccountAppHookHarness,
  loadAccountAppForHookTests,
} from "../support/account-app-hook-harness.mjs";
import {
  markChatJournalAdmitted,
  readChatJournal,
  writePendingChatJournal,
} from "../../web/chat-journal.ts";

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
const recoveredQueryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";

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
  vi.unstubAllGlobals();
  delete globalThis.__accountHooks;
  delete globalThis.__accountScreens;
  delete globalThis.__accountSession;
});

class MemorySessionStorage {
  values = new Map();
  failAdmittedWrites = false;

  getItem(key) {
    return this.values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    const serialized = String(value);
    if (this.failAdmittedWrites) {
      try {
        if (JSON.parse(serialized).admitted === true) {
          throw new DOMException("Journal admission write failed", "QuotaExceededError");
        }
      } catch (error) {
        if (error instanceof DOMException) throw error;
      }
    }
    this.values.set(String(key), serialized);
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sse(events) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const item of events) {
        controller.enqueue(
          encoder.encode(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`),
        );
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function runtimeUrl() {
  return (
    `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/` +
    `${encodeURIComponent(config.runtimeArn)}/invocations?qualifier=${encodeURIComponent(config.runtimeQualifier)}`
  );
}

function accepted(request) {
  return sse([
    {
      type: "accepted",
      conversationId: request.conversationId,
      queryId: request.queryId,
      ordinal: request.baseOrdinal + 1,
    },
    { type: "text", queryId: request.queryId, index: 0, text: "Respuesta corregida." },
    { type: "completed", queryId: request.queryId },
  ]);
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

describe("AccountApp capacity rejection regressions", () => {
  it("keeps an uncertain journal when an explicit retry fails preflight until recovery finds the original", async () => {
    const storage = new MemorySessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", {
      location: { hash: "#/chat", pathname: "/", search: "" },
      history: { replaceState() {} },
      crypto: { randomUUID: vi.fn() },
      sessionStorage: storage,
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
      setInterval: (...args) => globalThis.setInterval(...args),
      clearInterval: (...args) => globalThis.clearInterval(...args),
      addEventListener() {},
      removeEventListener() {},
    });

    const session = {
      accessToken: vi.fn(() => "temporary-access-token"),
      idToken: vi.fn(() => "temporary-id-token"),
      restore: vi.fn(async () => ({ accessToken: "temporary-access-token" })),
      signOut: vi.fn(async () => undefined),
    };
    const request = {
      version: 2,
      operation: "start",
      conversationId,
      queryId: recoveredQueryId,
      baseOrdinal: 0,
      text: "La pregunta original todavía en vuelo.",
    };
    writePendingChatJournal(config, identity, request);
    const runtimeRequests = [];
    let recoveryCount = 0;
    let resolveCommittedRecovery;
    const committedRecovery = new Promise((resolve) => {
      resolveCommittedRecovery = resolve;
    });
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
      if (url !== runtimeUrl()) throw new Error(`Unexpected web request: ${url}`);

      const body = JSON.parse(String(init.body));
      runtimeRequests.push(body);
      if (body.operation === "recover") {
        recoveryCount += 1;
        if (recoveryCount === 1) {
          return jsonResponse({
            type: "failed",
            code: "conversation_unavailable",
            recordStatus: "not_admitted",
            queryId: request.queryId,
          });
        }
        return committedRecovery;
      }
      return sse([
        {
          type: "failed",
          code: "token_count_unavailable",
          message: "No pudimos comprobar la capacidad del pedido.",
          recordStatus: "not_admitted",
          queryId: request.queryId,
        },
      ]);
    });
    vi.stubGlobal("fetch", fetch);

    const app = mount({ session });
    await app.flush();
    await vi.waitFor(() => expect(recoveryCount).toBe(1));
    await app.flush();
    expect(app.current().props.state).toMatchObject({
      queryStatus: "unconfirmed",
      canRetry: true,
    });
    expect(app.current().props.onSubmit(request.text)).toBe(true);
    await vi.waitFor(() =>
      expect(runtimeRequests.filter((item) => item.operation === "start")).toHaveLength(1),
    );
    await app.flush();
    await vi.waitFor(() => expect(recoveryCount).toBe(2));
    await app.flush();

    expect(app.current().props.state).toMatchObject({
      queryStatus: "unconfirmed",
      question: request.text,
      canRetry: true,
      queryErrorCode: "token_count_unavailable",
    });
    expect(runtimeRequests).toHaveLength(3);
    expect(runtimeRequests.filter((item) => item.operation !== "recover")).toEqual([request]);
    expect(readChatJournal(config, identity)).toMatchObject({
      admitted: false,
      request,
    });

    resolveCommittedRecovery(
      jsonResponse({
        version: 2,
        conversationId,
        queryId: recoveredQueryId,
        ordinal: 1,
        status: "completed",
        question: request.text,
        answer: "La respuesta del envío original.",
        canContinue: true,
      }),
    );
    await app.flush();

    expect(app.current().props.state).toMatchObject({
      queryStatus: "completed",
      question: request.text,
      answer: "La respuesta del envío original.",
      recovered: true,
      ordinal: 1,
    });
    expect(runtimeRequests.map((item) => item.operation)).toEqual(["recover", "start", "recover"]);
    expect(runtimeRequests.every((item) => item.queryId === recoveredQueryId)).toBe(true);
    expect(readChatJournal(config, identity)).toBeNull();
  });

  it("keeps the live conversation ID when its admitted journal write fails across profile navigation", async () => {
    const storage = new MemorySessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", {
      location: { hash: "#/chat", pathname: "/", search: "" },
      history: { replaceState() {} },
      crypto: {
        randomUUID: vi
          .fn()
          .mockReturnValueOnce("d6d5a391-85cb-41f7-b714-461d54c2a1a0")
          .mockReturnValueOnce("6fc31adc-9034-41da-a599-2da7a1dddc53")
          .mockReturnValueOnce("506bbbfa-8b73-4afd-bc08-b93df5ca7bd6")
          .mockReturnValueOnce("dbe7f5d2-79a5-490a-9e3d-e63cb7bca84f"),
      },
      sessionStorage: storage,
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
      setInterval: (...args) => globalThis.setInterval(...args),
      clearInterval: (...args) => globalThis.clearInterval(...args),
      addEventListener() {},
      removeEventListener() {},
    });

    const session = {
      accessToken: vi.fn(() => "temporary-access-token"),
      idToken: vi.fn(() => "temporary-id-token"),
      restore: vi.fn(async () => ({ accessToken: "temporary-access-token" })),
      signOut: vi.fn(async () => undefined),
    };
    const runtimeRequests = [];
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
      if (url !== runtimeUrl()) throw new Error(`Unexpected web request: ${url}`);

      const request = JSON.parse(String(init.body));
      runtimeRequests.push(request);
      if (request.operation === "start") {
        storage.failAdmittedWrites = true;
        return accepted(request);
      }
      return accepted(request);
    });
    vi.stubGlobal("fetch", fetch);

    const app = mount({ session });
    await app.flush();
    const firstQuestion = "Armá una secuencia para una clase de Matemática.";
    expect(app.current().props.onSubmit(firstQuestion)).toBe(true);
    await vi.waitFor(() => expect(runtimeRequests).toHaveLength(1));
    await app.flush();
    expect(app.current().props.state).toMatchObject({
      queryStatus: "completed",
      question: firstQuestion,
    });
    expect([...storage.values.keys()].some((key) => key.includes(":entry:"))).toBe(false);

    await app.setRoute("profile");
    await app.setRoute("chat");
    expect(app.current().props.state).toMatchObject({
      profileStatus: "complete",
      queryStatus: "completed",
      canContinue: true,
    });
    const followup = "Sumá una actividad de cierre.";
    expect(app.current().props.onSubmit(followup)).toBe(true);
    await vi.waitFor(() => expect(runtimeRequests).toHaveLength(2));

    expect(runtimeRequests[1]).toMatchObject({
      operation: "message",
      conversationId: runtimeRequests[0].conversationId,
      baseOrdinal: 1,
      text: followup,
    });
  });

  it("keeps a later rejected follow-up visible when returning with its prior admitted turn in history", async () => {
    const storage = new MemorySessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", {
      location: { hash: "#/chat", pathname: "/", search: "" },
      history: { replaceState() {} },
      crypto: {
        randomUUID: vi
          .fn()
          .mockReturnValueOnce("9a41a917-bdb1-48c4-911a-801d165e4d9d")
          .mockReturnValueOnce("da9604d5-2db4-4c14-a8b7-82cc68567755")
          .mockReturnValueOnce("9f1e5773-355e-4b88-ae86-a3c57f80284b"),
      },
      sessionStorage: storage,
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
      setInterval: (...args) => globalThis.setInterval(...args),
      clearInterval: (...args) => globalThis.clearInterval(...args),
      addEventListener() {},
      removeEventListener() {},
    });

    const session = {
      accessToken: vi.fn(() => "temporary-access-token"),
      idToken: vi.fn(() => "temporary-id-token"),
      restore: vi.fn(async () => ({ accessToken: "temporary-access-token" })),
      signOut: vi.fn(async () => undefined),
    };
    const runtimeRequests = [];
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
      if (url !== runtimeUrl()) throw new Error(`Unexpected web request: ${url}`);

      const request = JSON.parse(String(init.body));
      runtimeRequests.push(request);
      if (request.operation === "recover") {
        return jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 1,
          status: "completed",
          question: firstQuestion,
          answer: "Respuesta de la primera consulta.",
          canContinue: true,
        });
      }
      if (request.operation === "start") return accepted(request);
      return sse([
        {
          type: "failed",
          code: "storage_capacity_exceeded",
          message: "El pedido excede el espacio disponible.",
          recordStatus: "not_admitted",
          queryId: request.queryId,
        },
      ]);
    });
    vi.stubGlobal("fetch", fetch);

    const firstQuestion = "Armá una secuencia para una clase de Matemática.";
    const app = mount({ session });
    await app.flush();
    expect(app.current().props.onSubmit(firstQuestion)).toBe(true);
    await vi.waitFor(() =>
      expect(runtimeRequests.filter((item) => item.operation === "start")).toHaveLength(1),
    );
    await app.flush();
    expect(app.current().props.state).toMatchObject({ queryStatus: "completed" });

    const rejectedText = "Agregá ejemplos para distintos niveles.";
    expect(app.current().props.onSubmit(rejectedText)).toBe(true);
    await vi.waitFor(() =>
      expect(runtimeRequests.filter((item) => item.operation === "message")).toHaveLength(1),
    );
    await app.flush();
    expect(app.current().props.state).toMatchObject({
      queryStatus: "rejected",
      question: rejectedText,
      queryErrorCode: "storage_capacity_exceeded",
      history: { turns: [{ question: firstQuestion, answer: "Respuesta corregida." }] },
    });

    await app.setRoute("profile");
    await app.setRoute("chat");
    await app.flush();
    expect(app.current().props.state).toMatchObject({
      queryStatus: "rejected",
      question: rejectedText,
      queryErrorCode: "storage_capacity_exceeded",
      history: { turns: [{ question: firstQuestion, answer: "Respuesta corregida." }] },
    });
    expect(app.current().props.state.history.turns).toHaveLength(1);
    expect(app.current().props.state.history.turns[0]).toMatchObject({
      question: firstQuestion,
      answer: "Respuesta corregida.",
      status: "completed",
    });
    expect(runtimeRequests.filter((item) => item.operation === "recover")).toHaveLength(0);
  });

  it("preserves a recovered ordinal across storage rejection and edited resubmission", async () => {
    const storage = new MemorySessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", {
      location: { hash: "#/chat", pathname: "/", search: "" },
      history: { replaceState() {} },
      crypto: {
        randomUUID: vi
          .fn()
          .mockReturnValueOnce("b0d7cf70-ae36-49f4-a1b9-2837633a54ca")
          .mockReturnValueOnce("c166b6c3-5c0d-4b45-a9da-77b675bed25b"),
      },
      sessionStorage: storage,
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
      setInterval: (...args) => globalThis.setInterval(...args),
      clearInterval: (...args) => globalThis.clearInterval(...args),
      addEventListener() {},
      removeEventListener() {},
    });

    const recoveredRequest = {
      version: 2,
      operation: "message",
      conversationId,
      queryId: recoveredQueryId,
      baseOrdinal: 4,
      text: "El seguimiento anterior que llevó al ordinal cinco.",
    };
    writePendingChatJournal(config, identity, recoveredRequest);
    markChatJournalAdmitted(config, identity, recoveredRequest, 5);

    const runtimeRequests = [];
    const session = {
      accessToken: vi.fn(() => "temporary-access-token"),
      idToken: vi.fn(() => "temporary-id-token"),
      restore: vi.fn(async () => ({ accessToken: "temporary-access-token" })),
      signOut: vi.fn(async () => undefined),
    };
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
      if (url !== runtimeUrl()) throw new Error(`Unexpected web request: ${url}`);

      const request = JSON.parse(String(init.body));
      runtimeRequests.push({ request, body: String(init.body) });
      if (request.operation === "recover") {
        return jsonResponse({
          version: 2,
          conversationId,
          queryId: recoveredQueryId,
          ordinal: 5,
          status: "completed",
          question: recoveredRequest.text,
          answer: "Respuesta recuperada del ordinal cinco.",
          canContinue: true,
        });
      }
      if (
        runtimeRequests.filter(({ request: item }) => item.operation !== "recover").length === 1
      ) {
        return sse([
          {
            type: "failed",
            code: "storage_capacity_exceeded",
            message: "El pedido no cabe en una admisión de almacenamiento.",
            recordStatus: "not_admitted",
            queryId: request.queryId,
          },
        ]);
      }
      return accepted(request);
    });
    vi.stubGlobal("fetch", fetch);

    const app = mount({ session });
    await app.flush();
    await vi.waitFor(() =>
      expect(runtimeRequests.some(({ request }) => request.operation === "recover")).toBe(true),
    );
    await app.flush();
    expect(app.current().props.state).toMatchObject({ queryStatus: "completed", ordinal: 5 });

    const rejectedText = "Ampliá el material con ejemplos para tres niveles.";
    expect(app.current().props.onSubmit(rejectedText)).toBe(true);
    await vi.waitFor(() =>
      expect(runtimeRequests.filter(({ request }) => request.operation === "message")).toHaveLength(
        1,
      ),
    );
    await app.flush();

    expect(runtimeRequests[1].request).toMatchObject({
      operation: "message",
      conversationId,
      baseOrdinal: 5,
      text: rejectedText,
    });
    expect(app.current().props.state).toMatchObject({
      queryStatus: "rejected",
      queryErrorCode: "storage_capacity_exceeded",
      ordinal: 5,
    });
    expect(runtimeRequests.filter(({ request }) => request.operation === "message")).toHaveLength(
      1,
    );

    const editedText = "Ampliá el material con ejemplos para dos niveles.";
    expect(app.current().props.onSubmit(editedText)).toBe(true);
    await vi.waitFor(() =>
      expect(runtimeRequests.filter(({ request }) => request.operation === "message")).toHaveLength(
        2,
      ),
    );
    await app.flush();

    expect(runtimeRequests[2].request).toMatchObject({
      operation: "message",
      conversationId,
      baseOrdinal: 5,
      text: editedText,
    });
    expect(runtimeRequests.map(({ request }) => request.operation)).toEqual([
      "recover",
      "message",
      "message",
    ]);
  });
});
