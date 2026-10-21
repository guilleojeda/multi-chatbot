import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAccountAppHookHarness,
  loadAccountAppForHookTests,
} from "../support/account-app-hook-harness.mjs";
import { markChatJournalAdmitted, writePendingChatJournal } from "../../web/chat-journal.ts";

const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const queryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";
const question = "Prepará una actividad para la clase.";
const config = {
  region: "us-east-1",
  userPoolId: "us-east-1_example",
  clientId: "web-client",
  apiBaseUrl: "/api",
  botId: "docentes",
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
  runtimeQualifier: "DEFAULT",
};

let AccountApp;
let disposeModule;

beforeAll(async () => {
  ({ AccountApp, dispose: disposeModule } = await loadAccountAppForHookTests());
});

afterAll(async () => {
  await disposeModule?.();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete globalThis.__accountHooks;
  delete globalThis.__accountScreens;
  delete globalThis.__accountSession;
});

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function runtimeUrl() {
  return (
    `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/` +
    `${encodeURIComponent(config.runtimeArn)}/invocations?qualifier=${encodeURIComponent(config.runtimeQualifier)}`
  );
}

describe("chat recovery after an uncertain stream in the current view", () => {
  it("starts recover polling after EOF without remounting or sending another start", async () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(String(key)) ?? null,
      setItem: (key, value) => values.set(String(key), String(value)),
      removeItem: (key) => values.delete(String(key)),
    };
    let nextId = 0;
    let onlineListener;
    let lastOnlineListener;
    vi.stubGlobal("window", {
      location: { hash: "#/chat", pathname: "/", search: "" },
      history: { replaceState() {} },
      sessionStorage: storage,
      crypto: {
        randomUUID: () =>
          [conversationId, queryId, "b0d7cf70-ae36-49f4-a1b9-2837633a54ca"][nextId++],
      },
      addEventListener(_name, listener) {
        onlineListener = listener;
        lastOnlineListener = listener;
      },
      removeEventListener(_name, listener) {
        if (onlineListener === listener) onlineListener = undefined;
      },
    });
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });

    const requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init = {}) => {
        const url = String(input);
        if (url === "/public-config.json") return jsonResponse(config);
        if (url === "/api/account/me") return jsonResponse({ sub: "teacher-a", botId: "docentes" });
        if (url === "/api/profile") {
          return jsonResponse({
            sub: "teacher-a",
            botId: "docentes",
            profile: {
              sub: "teacher-a",
              botId: "docentes",
              updatedAt: "2026-10-20T00:00:00.000Z",
              fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
              responsePreferenceIds: [],
            },
          });
        }
        if (url === runtimeUrl()) {
          const request = JSON.parse(String(init.body));
          requests.push(request);
          if (request.operation === "start") {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.close();
                },
              }),
              {
                headers: { "content-type": "text/event-stream" },
              },
            );
          }
          return jsonResponse({
            version: 2,
            conversationId: request.conversationId,
            queryId: request.queryId,
            ordinal: 1,
            status: "completed",
            question,
            answer: "Respuesta recuperada sin cambiar de vista.",
            canContinue: true,
          });
        }
        throw new Error(`Unexpected web request: ${url}`);
      }),
    );

    const session = {
      accessToken: () => "access-token",
      idToken: () => "id-token",
      restore: vi.fn(async () => ({ accessToken: "access-token", idToken: "id-token" })),
      signOut: vi.fn(async () => undefined),
    };
    globalThis.__accountSession = session;
    const app = createAccountAppHookHarness({ AccountApp, getSession: () => session });

    try {
      await app.flush();
      expect(app.current().props.onSubmit(question)).toBe(true);
      await vi.waitFor(async () => {
        await app.flush();
        expect(requests.map(({ operation }) => operation)).toEqual(["start", "recover"]);
        expect(await app.html()).toContain("Respuesta recuperada sin cambiar de vista.");
      });
      expect(requests[1]).toEqual({
        version: 2,
        operation: "recover",
        conversationId,
        queryId,
      });
      expect(requests.filter(({ operation }) => operation === "start")).toHaveLength(1);
      expect(onlineListener).toBeUndefined();
      lastOnlineListener?.();
      await app.flush();
      expect(requests.map(({ operation }) => operation)).toEqual(["start", "recover"]);
    } finally {
      app.dispose();
    }
  });

  it("preserves the completed turn and admitted journal when a follow-up cannot be journaled", async () => {
    const values = new Map();
    const storage = {
      denyJournalWrites: false,
      getItem(key) {
        return values.get(String(key)) ?? null;
      },
      setItem(key, value) {
        if (this.denyJournalWrites && String(key) !== "auth-refresh") {
          throw new DOMException("Storage is unavailable", "QuotaExceededError");
        }
        values.set(String(key), String(value));
      },
      removeItem(key) {
        values.delete(String(key));
      },
    };
    const ids = [
      conversationId,
      queryId,
      "b0d7cf70-ae36-49f4-a1b9-2837633a54ca",
      "d266b6c3-5c0d-4b45-a9da-77b675bed25b",
    ];
    let nextId = 0;
    vi.stubGlobal("window", {
      location: { hash: "#/chat", pathname: "/", search: "" },
      history: { replaceState() {} },
      sessionStorage: storage,
      crypto: { randomUUID: () => ids[nextId++] },
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });

    const requests = [];
    const firstAnswer = "Respuesta completa del primer turno.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init = {}) => {
        const url = String(input);
        if (url === "/public-config.json") return jsonResponse(config);
        if (url === "/api/account/me") return jsonResponse({ sub: "teacher-a", botId: "docentes" });
        if (url === "/api/profile") {
          return jsonResponse({
            sub: "teacher-a",
            botId: "docentes",
            profile: {
              sub: "teacher-a",
              botId: "docentes",
              updatedAt: "2026-10-20T00:00:00.000Z",
              fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
              responsePreferenceIds: [],
            },
          });
        }
        if (url === runtimeUrl()) {
          const request = JSON.parse(String(init.body));
          requests.push(request);
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    {
                      type: "accepted",
                      conversationId: request.conversationId,
                      queryId: request.queryId,
                      ordinal: request.baseOrdinal + 1,
                    },
                    {
                      type: "text",
                      queryId: request.queryId,
                      index: 0,
                      text: request.operation === "start" ? firstAnswer : "Seguimiento completo.",
                    },
                    { type: "completed", queryId: request.queryId },
                  ]
                    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                    .join(""),
                ),
              );
              controller.close();
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        throw new Error(`Unexpected web request: ${url}`);
      }),
    );

    const session = {
      accessToken: () => "access-token",
      idToken: () => "id-token",
      restore: vi.fn(async () => ({ accessToken: "access-token", idToken: "id-token" })),
      signOut: vi.fn(async () => undefined),
    };
    globalThis.__accountSession = session;
    const app = createAccountAppHookHarness({ AccountApp, getSession: () => session });

    try {
      await app.flush();
      expect(app.current().props.onSubmit(question)).toBe(true);
      await vi.waitFor(async () => {
        await app.flush();
        expect(await app.html()).toContain(firstAnswer);
      });
      expect(requests).toHaveLength(1);
      const firstQueryId = requests[0].queryId;

      storage.denyJournalWrites = true;
      const followUp = "Un seguimiento que se conserva como borrador.";
      expect(app.current().props.onSubmit(followUp)).toBe(false);
      await app.flush();
      const rejectedHtml = await app.html();
      expect(requests).toHaveLength(1);
      expect(rejectedHtml).toContain(firstAnswer);
      expect(rejectedHtml).toContain("Copiar respuesta");
      expect(rejectedHtml).toContain("no se envió al asistente");
      expect([...values.values()].join("\n")).toContain(firstQueryId);
      expect([...values.values()].join("\n")).not.toContain(followUp);

      storage.denyJournalWrites = false;
      expect(app.current().props.onSubmit(followUp)).toBe(true);
      await app.flush();
      await vi.waitFor(async () => {
        await app.flush();
        expect(requests).toHaveLength(2);
        expect(await app.html()).toContain("Respuesta anterior 1");
      });
      expect(requests[1]).toMatchObject({
        version: 2,
        operation: "message",
        conversationId,
        baseOrdinal: 1,
        text: followUp,
      });
      expect(requests[1].queryId).not.toBe(firstQueryId);
    } finally {
      app.dispose();
    }
  });

  it("keeps polling with increasing backoff for transient JSON failures and clears access-denied references", async () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(String(key)) ?? null,
      setItem: (key, value) => values.set(String(key), String(value)),
      removeItem: (key) => values.delete(String(key)),
    };
    let nextId = 0;
    vi.stubGlobal("window", {
      location: { hash: "#/chat", pathname: "/", search: "" },
      history: { replaceState() {} },
      sessionStorage: storage,
      crypto: { randomUUID: () => [conversationId, queryId][nextId++] },
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });

    const requests = [];
    let recoveryResponses = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init = {}) => {
        const url = String(input);
        if (url === "/public-config.json") return jsonResponse(config);
        if (url === "/api/account/me") return jsonResponse({ sub: "teacher-a", botId: "docentes" });
        if (url === "/api/profile") {
          return jsonResponse({
            sub: "teacher-a",
            botId: "docentes",
            profile: {
              sub: "teacher-a",
              botId: "docentes",
              updatedAt: "2026-10-20T00:00:00.000Z",
              fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
              responsePreferenceIds: [],
            },
          });
        }
        if (url === runtimeUrl()) {
          const request = JSON.parse(String(init.body));
          requests.push(request);
          if (request.operation === "start") {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.close();
                },
              }),
              {
                headers: { "content-type": "text/event-stream" },
              },
            );
          }
          recoveryResponses += 1;
          if (recoveryResponses < 3) {
            return jsonResponse({
              type: "failed",
              code: "temporarily_unavailable",
              message: "No pudimos consultar el envío todavía.",
              recordStatus: "not_admitted",
              queryId: request.queryId,
            });
          }
          return jsonResponse({
            type: "failed",
            code: "access_denied",
            message: "Esta cuenta ya no tiene acceso.",
            recordStatus: "not_admitted",
            queryId: request.queryId,
          });
        }
        throw new Error(`Unexpected web request: ${url}`);
      }),
    );

    const session = {
      accessToken: () => "access-token",
      idToken: () => "id-token",
      restore: vi.fn(async () => ({ accessToken: "access-token", idToken: "id-token" })),
      signOut: vi.fn(async () => undefined),
    };
    globalThis.__accountSession = session;
    const app = createAccountAppHookHarness({ AccountApp, getSession: () => session });

    try {
      await app.flush();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      expect(app.current().props.onSubmit(question)).toBe(true);
      for (let attempt = 0; attempt < 5 && requests.length < 2; attempt += 1) await app.flush();
      expect(requests.map(({ operation }) => operation)).toEqual(["start", "recover"]);
      expect([...values.values()].join("\n")).toContain(queryId);

      await vi.advanceTimersByTimeAsync(999);
      await app.flush();
      expect(requests.filter(({ operation }) => operation === "recover")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      for (let attempt = 0; attempt < 5 && requests.length < 3; attempt += 1) await app.flush();
      expect(requests.filter(({ operation }) => operation === "recover")).toHaveLength(2);
      expect([...values.values()].join("\n")).toContain(queryId);

      await vi.advanceTimersByTimeAsync(1_999);
      await app.flush();
      expect(requests.filter(({ operation }) => operation === "recover")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      for (let attempt = 0; attempt < 5 && requests.length < 4; attempt += 1) await app.flush();
      expect(requests.filter(({ operation }) => operation === "recover")).toHaveLength(3);
      expect(await app.html()).toContain("Esta cuenta no tiene acceso a este asistente.");
      expect(requests.map(({ operation }) => operation)).toEqual([
        "start",
        "recover",
        "recover",
        "recover",
      ]);
      expect([...values.values()].join("\n")).not.toContain(queryId);
    } finally {
      app.dispose();
    }
  });

  it("clears a transient poll error when recovery returns a copyable partial answer", async () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(String(key)) ?? null,
      setItem: (key, value) => values.set(String(key), String(value)),
      removeItem: (key) => values.delete(String(key)),
    };
    vi.stubGlobal("window", {
      location: { hash: "#/chat", pathname: "/", search: "" },
      history: { replaceState() {} },
      sessionStorage: storage,
      crypto: { randomUUID: () => queryId },
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal("sessionStorage", storage);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const owner = { sub: "teacher-a", botId: "docentes" };
    const request = {
      version: 2,
      operation: "start",
      conversationId,
      queryId,
      baseOrdinal: 0,
      text: question,
    };
    writePendingChatJournal(config, owner, request);
    markChatJournalAdmitted(config, owner, request, 1);

    let recoveryCount = 0;
    const recoveryRequests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init = {}) => {
        const url = String(input);
        if (url === "/public-config.json") return jsonResponse(config);
        if (url === "/api/account/me") return jsonResponse(owner);
        if (url === "/api/profile") {
          return jsonResponse({
            ...owner,
            profile: {
              ...owner,
              updatedAt: "2026-10-20T00:00:00.000Z",
              fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
              responsePreferenceIds: [],
            },
          });
        }
        if (url === runtimeUrl()) {
          const currentRequest = JSON.parse(String(init.body));
          recoveryRequests.push(currentRequest);
          recoveryCount += 1;
          if (recoveryCount === 1) {
            return jsonResponse({
              type: "failed",
              code: "temporarily_unavailable",
              message: "No pudimos actualizar el estado. Vamos a volver a consultarlo.",
              recordStatus: "unconfirmed",
              queryId,
            });
          }
          return jsonResponse({
            version: 2,
            conversationId,
            queryId,
            ordinal: 1,
            status: "failed",
            question,
            answer: "Prefijo parcial durable.",
            canContinue: true,
          });
        }
        throw new Error(`Unexpected web request: ${url}`);
      }),
    );

    const session = {
      accessToken: () => "access-token",
      idToken: () => "id-token",
      restore: vi.fn(async () => ({ accessToken: "access-token", idToken: "id-token" })),
      signOut: vi.fn(async () => undefined),
    };
    globalThis.__accountSession = session;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const app = createAccountAppHookHarness({ AccountApp, getSession: () => session });

    try {
      for (let attempt = 0; attempt < 5 && recoveryRequests.length < 1; attempt += 1) {
        await app.flush();
      }
      expect(recoveryRequests).toHaveLength(1);
      expect(recoveryRequests[0]).toEqual({
        version: 2,
        operation: "recover",
        conversationId,
        queryId,
      });
      expect(app.current().props.state.queryStatus).toBe("streaming");
      expect(await app.html()).toContain("No pudimos actualizar el estado.");

      await vi.advanceTimersByTimeAsync(999);
      await app.flush();
      expect(recoveryRequests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      for (
        let attempt = 0;
        attempt < 5 && app.current().props.state.queryStatus !== "failed";
        attempt += 1
      ) {
        await app.flush();
      }
      expect(recoveryRequests).toHaveLength(2);
      expect(app.current().props.state.queryStatus).toBe("failed");
      expect(app.current().props.state.canContinue).toBe(true);
      const terminalHtml = await app.html();
      expect(terminalHtml).toContain("Prefijo parcial durable.");
      expect(terminalHtml).toContain("Copiar texto parcial");
      expect(terminalHtml).toContain("Este intercambio incompleto no se incluirá");
      expect(terminalHtml).not.toContain("No pudimos actualizar el estado.");
      await app.current().props.onCopy("Prefijo parcial durable.");
      expect(writeText).toHaveBeenCalledWith("Prefijo parcial durable.");
    } finally {
      app.dispose();
    }
  });
});
