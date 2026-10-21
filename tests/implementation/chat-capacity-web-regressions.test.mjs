import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAccountAppHookHarness,
  loadAccountAppForHookTests,
} from "../support/account-app-hook-harness.mjs";
import { markChatJournalAdmitted, writePendingChatJournal } from "../../web/chat-journal.ts";

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
