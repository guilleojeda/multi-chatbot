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
const secondQueryId = "b0d7cf70-ae36-49f4-a1b9-2837633a54ca";
const thirdId = "c166b6c3-5c0d-4b45-a9da-77b675bed25b";
const quotaMessagePrefix = "Llegaste al límite de uso, vas a poder seguir usando la aplicación en ";

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

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function event(type, fields = {}) {
  return { type, ...fields };
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

function uuidSequence() {
  const values = [conversationId, firstQueryId, secondQueryId, thirdId];
  let cursor = 0;
  return () => values[cursor++] || "d266b6c3-5c0d-4b45-a9da-77b675bed25b";
}

function runtimeUrl() {
  return (
    `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/` +
    `${encodeURIComponent(config.runtimeArn)}/invocations?qualifier=${encodeURIComponent(config.runtimeQualifier)}`
  );
}

function createEnvironment({ streamHandler }) {
  const storage = new MemorySessionStorage();
  const runtimeRequests = [];
  const apiRequests = [];
  const session = {
    accessToken: vi.fn(() => "temporary-access-token"),
    idToken: vi.fn(() => "temporary-id-token"),
    restore: vi.fn(async () => ({ accessToken: "temporary-access-token" })),
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
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboardWrite } });

  const fetch = vi.fn(async (input, init = {}) => {
    const url = String(input);
    if (url === "/public-config.json") return jsonResponse(config);
    if (url === "/api/account/me") {
      apiRequests.push({ url, init });
      return jsonResponse(identity);
    }
    if (url === "/api/profile") {
      apiRequests.push({ url, init });
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
      const call = { request, body: String(init.body), accept: headers.get("accept") };
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

  return { storage, session, runtimeRequests, apiRequests, fetch, clipboardWrite };
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

function accepted(request, answer) {
  return [
    event("accepted", {
      conversationId: request.conversationId,
      queryId: request.queryId,
      ordinal: request.baseOrdinal + 1,
    }),
    event("text", { queryId: request.queryId, index: 0, text: answer }),
    event("completed", { queryId: request.queryId }),
  ];
}

function failed(request, { code, message, recordStatus = "not_admitted", quota, canContinue }) {
  return [
    event("failed", {
      code,
      message,
      recordStatus,
      queryId: request.queryId,
      ...(quota ? { quota } : {}),
      ...(canContinue === undefined ? {} : { canContinue }),
    }),
  ];
}

describe("chat input and history capacity in the web account flow", () => {
  it("keeps a rejected quota request distinct and shows the server availability", async () => {
    const serverNow = Date.UTC(2026, 9, 21, 12);
    const quota = {
      daily: { used: 20, limit: 20, resetAt: serverNow + 8 * 60 * 60 * 1000, period: "2026-10-21" },
      monthly: {
        used: 200,
        limit: 200,
        resetAt: serverNow + 21 * 24 * 60 * 60 * 1000,
        period: "2026-10",
      },
      serverNow,
      blockedUntil: serverNow + 21 * 24 * 60 * 60 * 1000,
      policyRevision: "quota-policy-1",
    };
    const question = "Prepará una actividad breve sobre porcentajes.";
    const environment = createEnvironment({
      streamHandler: (request) =>
        sse(
          failed(request, {
            code: "quota_exceeded",
            message: "Llegaste al límite de uso.",
            quota,
          }),
        ),
    });
    const app = mount(environment);
    await initialize(app);

    expect(app.current().props.onSubmit(question)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(1));
    await app.flush();

    const state = app.current().props.state;
    const html = await app.html();
    expect(state).toMatchObject({
      queryStatus: "rejected",
      question,
      quota,
    });
    expect(plainText(html)).toContain(quotaMessagePrefix);
    expect(plainText(html)).not.toMatch(/no cabe en la ventana|conteo de tokens/i);
  });

  it("offers a new conversation after context rejection without deleting remote history", async () => {
    const firstQuestion = "¿Cómo explico porcentajes con descuentos?";
    const rejectedFollowUp = "Ampliá la secuencia con ejercicios de varios niveles.";
    let streamCount = 0;
    const environment = createEnvironment({
      streamHandler: (request) => {
        streamCount += 1;
        if (streamCount === 1) return sse(accepted(request, "Usá descuentos en una librería."));
        if (streamCount === 2) {
          return sse(
            failed(request, {
              code: "capacity_exceeded",
              message:
                "La conversación completa no cabe en la ventana del modelo. Empezá otra conversación para continuar.",
              canContinue: true,
            }),
          );
        }
        return sse(accepted(request, "Nueva conversación iniciada con el pedido conservado."));
      },
    });
    const app = mount(environment);
    await initialize(app);

    expect(app.current().props.onSubmit(firstQuestion)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(1));
    await app.flush();
    const originalConversationId = submissions(environment)[0].request.conversationId;
    expect(app.current().props.state.queryStatus).toBe("completed");

    expect(app.current().props.onSubmit(rejectedFollowUp)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(2));
    await app.flush();

    const rejectedState = app.current().props.state;
    const rejectedHtml = await app.html();
    expect(submissions(environment)[1].request).toMatchObject({
      operation: "message",
      conversationId: originalConversationId,
      text: rejectedFollowUp,
    });
    expect(rejectedState).toMatchObject({
      queryStatus: "rejected",
      question: rejectedFollowUp,
    });
    expect(rejectedState.quota).toBeUndefined();
    expect(plainText(rejectedHtml)).toContain("La conversación completa no cabe en la ventana");
    expect(buttonNames(rejectedHtml)).toContain("Volver al inicio");
    expect(submissions(environment)).toHaveLength(2);

    // The public reset callback starts a fresh local conversation; the app never sends a remote
    // history deletion. The rejected text remains available in AccountApp state before reset and
    // can be submitted as the first request of the new conversation.
    app.current().props.onReset();
    await app.flush();
    expect(app.current().props.state.queryStatus).toBe("idle");
    expect(app.current().props.onSubmit(rejectedFollowUp)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(3));
    await app.flush();

    const newRequest = submissions(environment)[2].request;
    expect(newRequest).toMatchObject({ operation: "start", text: rejectedFollowUp });
    expect(newRequest.conversationId).not.toBe(originalConversationId);
    expect(environment.runtimeRequests.map(({ request }) => request.operation)).toEqual([
      "start",
      "message",
      "start",
    ]);
  });

  it("lets token-count failures retry the original request identity without claiming quota or size rejection", async () => {
    const question = "Prepará una actividad de proporcionalidad.";
    let streamCount = 0;
    const environment = createEnvironment({
      streamHandler: (request) => {
        streamCount += 1;
        if (streamCount === 1) {
          return sse(
            failed(request, {
              code: "token_count_unavailable",
              message: "No pudimos comprobar el conteo de tokens; podés reintentar el mismo envío.",
            }),
          );
        }
        return sse(accepted(request, "Respuesta luego de reintentar el conteo."));
      },
    });
    const app = mount(environment);
    await initialize(app);

    expect(app.current().props.onSubmit(question)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(1));
    await app.flush();

    const firstBody = submissions(environment)[0].body;
    const failedState = app.current().props.state;
    const failedHtml = await app.html();
    expect(failedState.question).toBe(question);
    expect(failedState.quota).toBeUndefined();
    expect(failedState.canRetry).toBe(true);
    expect(plainText(failedHtml)).toContain("No pudimos comprobar el conteo de tokens");
    expect(plainText(failedHtml)).not.toContain(quotaMessagePrefix);
    expect(plainText(failedHtml)).not.toMatch(/no cabe en la ventana|demasiado grande|capacidad/i);
    expect(buttonNames(failedHtml)).toContain("Reintentar el mismo envío");

    expect(app.current().props.onSubmit(question)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(2));
    await app.flush();

    expect(submissions(environment)[1].body).toBe(firstBody);
    expect(submissions(environment)[1].request).toMatchObject({ text: question });
  });

  it("renders an incomplete response as a copyable partial result", async () => {
    const question = "Prepará una actividad con varias consignas.";
    const partial = "Consigna 1: calculá el 25 % de 80.";
    const environment = createEnvironment({
      streamHandler: (request) =>
        sse([
          ...accepted(request, partial).slice(0, 2),
          event("failed", {
            code: "incomplete_response",
            message: "La respuesta quedó incompleta.",
            recordStatus: "failed",
            queryId: request.queryId,
          }),
        ]),
    });
    const app = mount(environment);
    await initialize(app);

    expect(app.current().props.onSubmit(question)).toBe(true);
    await vi.waitFor(() => expect(submissions(environment)).toHaveLength(1));
    await app.flush();

    const state = app.current().props.state;
    const html = await app.html();
    expect(state).toMatchObject({ queryStatus: "failed", question, answer: partial });
    expect(plainText(html)).toContain("La respuesta quedó incompleta.");
    expect(buttonNames(html)).toContain("Copiar texto parcial");
    expect(buttonNames(html)).not.toContain("Copiar respuesta");
    expect(plainText(html)).not.toMatch(/respuesta está completa|respuesta completa/i);

    await app.current().props.onCopy(partial);
    expect(environment.clipboardWrite).toHaveBeenCalledWith(partial);
  });
});
