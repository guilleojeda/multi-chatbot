import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { markChatJournalAdmitted, writeChatSelection } from "../../web/chat-journal.ts";
import {
  createHistoryEnvironment,
  firstConversationId,
  firstQueryId,
  historyConfig,
  jsonResponse,
  loadHistoryAccountApp,
  MemorySessionStorage,
  mountHistoryAccountApp,
  secondConversationId,
  secondQueryId,
} from "../support/history-web-harness.mjs";

const apps = [];
const legacyIdentity = { sub: "teacher-a", botId: "docentes" };
let AccountApp;
let disposeAccountAppModule;

beforeAll(async () => {
  ({ AccountApp, dispose: disposeAccountAppModule } = await loadHistoryAccountApp());
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

function mount(environment) {
  const app = mountHistoryAccountApp(environment, AccountApp);
  apps.push(app);
  return app;
}

function props(app) {
  return app.current()?.props || {};
}

function state(app) {
  return props(app).state;
}

async function initialize(app) {
  await app.flush();
  return props(app);
}

async function select(app, conversationId) {
  const callback = props(app).onSelectConversation;
  expect(callback, "AccountApp should expose onSelectConversation").toBeTypeOf("function");
  if (typeof callback !== "function") return;
  await callback(conversationId);
  await app.flush();
}

function makeTurn(ordinal, queryId, overrides = {}) {
  return {
    ordinal,
    queryId,
    status: "completed",
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: 1, complete: true },
    cursor: 1,
    ...overrides,
  };
}

function streamFor(request, { text = "" } = {}) {
  let controller;
  const encoder = new TextEncoder();
  const response = new Response(
    new ReadableStream({
      start(value) {
        controller = value;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const send = (type, value) => {
    try {
      controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`));
    } catch {
      // The browser can stop observing while server work continues.
    }
  };
  return {
    response,
    accept() {
      send("accepted", {
        type: "accepted",
        conversationId: request.conversationId,
        queryId: request.queryId,
        ordinal: request.baseOrdinal + 1,
      });
    },
    text(value = text, index = 0) {
      send("text", { type: "text", queryId: request.queryId, index, text: value });
    },
    complete() {
      try {
        send("completed", { type: "completed", queryId: request.queryId });
        controller.close();
      } catch {
        // A closed observer does not affect the server-side terminal result.
      }
    },
    fail() {
      controller.close();
    },
  };
}

function storageText(storage) {
  return [...storage.values.values()].join("\n");
}

function entriesContaining(storage, value) {
  return [...storage.values].filter(([, raw]) => String(raw).includes(value));
}

function legacyJournalKeys(config, owner) {
  const scope = [
    config.region,
    config.clientId,
    config.apiBaseUrl,
    config.runtimeArn ?? "",
    config.runtimeQualifier ?? "",
    config.botId,
  ];
  const encodedScope = encodeURIComponent(JSON.stringify(scope));
  return {
    entry: `chat-journal:v2:entry:${encodeURIComponent(JSON.stringify([...scope, owner.sub, owner.botId]))}`,
    owner: `chat-journal:v2:owner:${encodedScope}`,
    scope,
  };
}

function installConversationMetaRoute(environment, conversations) {
  const defaultFetch = environment.fetch.getMockImplementation();
  const byId = new Map(
    conversations.map((conversation) => [conversation.conversationId, conversation]),
  );
  environment.fetch.mockImplementation(async (input, init = {}) => {
    const url = String(input);
    const parsed = new URL(url, "https://app.invalid");
    const path = parsed.pathname.slice("/api".length);
    const method = init.method || "GET";
    const match = path.match(/^\/chat\/conversations\/([^/]+)$/);
    if (method === "GET" && match) {
      const conversationId = decodeURIComponent(match[1]);
      environment.apiRequests.push({
        path,
        url: parsed,
        method,
        headers: new Headers(init.headers),
        init,
        body: init.body,
        conversationId,
      });
      const conversation = byId.get(conversationId);
      return conversation
        ? jsonResponse({ version: 1, ...conversation })
        : jsonResponse({ code: "CONVERSATION_NOT_FOUND" }, 404);
    }
    return defaultFetch(input, init);
  });
}

describe("per-conversation recovery references", () => {
  it("keeps separate admitted references, removes plaintext at acceptance, and removes each terminal entry", async () => {
    const streams = new Map();
    let storageAtSecondPost = "";
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Primero",
              lastOrdinal: 1,
              closed: false,
            },
            {
              conversationId: secondConversationId,
              label: "Segundo",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      turnsHandler: async ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [
            makeTurn(1, conversationId === firstConversationId ? firstQueryId : secondQueryId),
          ],
        }),
      textHandler: async ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: url.searchParams.get("queryId"),
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: "Intercambio anterior." }],
          complete: true,
        }),
      runtimeHandler: async (request) => {
        if (request.conversationId === secondConversationId)
          storageAtSecondPost = storageText(environment.storage);
        const stream = streamFor(request);
        streams.set(request.conversationId, stream);
        return stream.response;
      },
      recoverHandler: async (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 2,
          status: "completed",
          question: "Pregunta admitida.",
          answer: "Respuesta terminal recuperada.",
          canContinue: true,
        }),
    });
    const app = mount(environment);
    await initialize(app);
    await select(app, firstConversationId);

    const firstBody = "Pregunta privada del primer hilo.";
    expect(props(app).onSubmit(firstBody)).toBe(true);
    await vi.waitFor(() => expect(streams.has(firstConversationId)).toBe(true));
    const firstRequest = environment.runtimeRequests.at(-1).request;
    const rawBeforeFirstAcceptance = storageText(environment.storage);
    expect(rawBeforeFirstAcceptance).toContain(firstBody);
    expect(rawBeforeFirstAcceptance).toContain(firstRequest.queryId);
    streams.get(firstConversationId).accept();
    streams.get(firstConversationId).text("Prefijo uno.");
    await vi.waitFor(async () => {
      await app.flush();
      expect(state(app)?.queryStatus).toBe("streaming");
    });

    await select(app, secondConversationId);
    const secondBody = "Pregunta privada del segundo hilo.";
    expect(props(app).onSubmit(secondBody)).toBe(true);
    await vi.waitFor(() => expect(streams.has(secondConversationId)).toBe(true));
    const secondRequest = environment.runtimeRequests.at(-1).request;
    expect(storageAtSecondPost).toContain(firstRequest.queryId);
    expect(storageAtSecondPost).toContain(secondBody);
    streams.get(secondConversationId).accept();
    streams.get(secondConversationId).text("Prefijo dos.");
    await vi.waitFor(async () => {
      await app.flush();
      expect(state(app)?.queryStatus).toBe("streaming");
    });

    expect(entriesContaining(environment.storage, firstRequest.queryId)).toHaveLength(1);
    expect(entriesContaining(environment.storage, secondRequest.queryId)).toHaveLength(1);
    expect(storageText(environment.storage)).not.toContain(firstBody);
    expect(storageText(environment.storage)).not.toContain(secondBody);
    expect(storageText(environment.storage)).not.toContain("Intercambio anterior.");
    expect(storageText(environment.storage)).not.toMatch(/temporary-(?:access|id)-token/);
    expect(storageText(environment.storage)).not.toMatch(/educationLevels|subjects/);

    streams.get(secondConversationId).complete();
    await vi.waitFor(async () => {
      await app.flush();
      expect(state(app)?.queryStatus).toBe("completed");
    });
    await app.flush();
    expect(entriesContaining(environment.storage, secondRequest.queryId)).toHaveLength(0);
    expect(entriesContaining(environment.storage, firstRequest.queryId)).toHaveLength(1);

    await select(app, firstConversationId);
    await vi.waitFor(() =>
      expect(
        environment.runtimeRequests.some(({ request }) => request.operation === "recover"),
      ).toBe(true),
    );
    await vi.waitFor(async () => {
      await app.flush();
      expect(state(app)?.queryStatus).toBe("completed");
    });
    await app.flush();
    expect(entriesContaining(environment.storage, firstRequest.queryId)).toHaveLength(0);
  });

  it("keeps earlier recovery references when a later conversation cannot write its journal", async () => {
    const streams = new Map();
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            { conversationId: firstConversationId, label: "Uno", lastOrdinal: 1, closed: false },
            { conversationId: secondConversationId, label: "Dos", lastOrdinal: 1, closed: false },
          ],
        }),
      turnsHandler: async ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [makeTurn(1, firstQueryId)],
        }),
      textHandler: async ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: url.searchParams.get("queryId"),
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: "Anterior." }],
          complete: true,
        }),
      runtimeHandler: async (request) => {
        const stream = streamFor(request);
        streams.set(request.conversationId, stream);
        return stream.response;
      },
    });
    const app = mount(environment);
    await initialize(app);
    await select(app, firstConversationId);
    expect(props(app).onSubmit("Pedido uno.")).toBe(true);
    await vi.waitFor(() => expect(streams.has(firstConversationId)).toBe(true));
    const firstRequest = environment.runtimeRequests.at(-1).request;
    streams.get(firstConversationId).accept();
    streams.get(firstConversationId).text("En curso.");
    await vi.waitFor(async () => {
      await app.flush();
      expect(state(app)?.queryStatus).toBe("streaming");
    });
    const previousValues = new Map(environment.storage.values);

    environment.storage.denyWrites = true;
    await select(app, secondConversationId);
    expect(props(app).onSubmit("Pedido dos no persistible.")).toBe(false);
    await app.flush();

    expect(environment.runtimeRequests).toHaveLength(1);
    expect(entriesContaining(environment.storage, firstRequest.queryId)).toHaveLength(1);
    expect(
      environment.storage.values.get(
        entriesContaining(environment.storage, firstRequest.queryId)[0][0],
      ),
    ).toBe(previousValues.get(entriesContaining(environment.storage, firstRequest.queryId)[0][0]));
    expect(storageText(environment.storage)).not.toContain("Pedido dos no persistible.");
  });

  it("does not restore or migrate a v2 journal and keeps an independent current v3 reference", async () => {
    const storage = new MemorySessionStorage();
    const keys = legacyJournalKeys(historyConfig, legacyIdentity);
    const oldRequest = {
      version: 2,
      operation: "message",
      conversationId: firstConversationId,
      queryId: firstQueryId,
      baseOrdinal: 2,
    };
    storage.setItem(keys.owner, legacyIdentity.sub);
    storage.setItem(
      keys.entry,
      JSON.stringify({
        version: 2,
        scope: keys.scope,
        sub: legacyIdentity.sub,
        botId: legacyIdentity.botId,
        request: oldRequest,
        admitted: true,
        ordinal: 3,
      }),
    );
    const conversations = [
      {
        conversationId: firstConversationId,
        label: "Conversación con journal retirado",
        lastOrdinal: 3,
        closed: false,
        activeQueryId: firstQueryId,
      },
      {
        conversationId: secondConversationId,
        label: "Conversación con journal actual",
        lastOrdinal: 3,
        closed: false,
        activeQueryId: secondQueryId,
      },
    ];
    const listHandler = async () => jsonResponse({ version: 1, conversations });
    const environment = createHistoryEnvironment({
      storage,
      listHandler,
      turnsHandler: async ({ conversationId }) => {
        const current = conversations.find((item) => item.conversationId === conversationId);
        const queryId = conversationId === firstConversationId ? firstQueryId : secondQueryId;
        return jsonResponse({
          version: 1,
          conversationId,
          label: current?.label,
          throughOrdinal: 3,
          closed: false,
          canContinue: false,
          turns: [
            makeTurn(3, queryId, {
              status: "in_progress",
              answerManifest: { count: 1, complete: false },
              cursor: 1,
            }),
          ],
        });
      },
      recoverHandler: async (recoverRequest) =>
        jsonResponse({
          version: 2,
          conversationId: recoverRequest.conversationId,
          queryId: recoverRequest.queryId,
          ordinal: 3,
          status: "in_progress",
          question:
            recoverRequest.conversationId === secondConversationId
              ? "Pedido recuperado del journal actual."
              : "Pedido procedente del journal v2.",
          answer:
            recoverRequest.conversationId === secondConversationId
              ? "Respuesta recuperada del formato actual."
              : "Respuesta procedente del journal v2.",
          canContinue: false,
        }),
    });
    installConversationMetaRoute(environment, conversations);
    const currentRequest = {
      version: 2,
      operation: "message",
      conversationId: secondConversationId,
      queryId: secondQueryId,
      baseOrdinal: 2,
      text: "se elimina al confirmar admitted",
    };
    markChatJournalAdmitted(environment.config, legacyIdentity, currentRequest, 3);
    writeChatSelection(environment.config, legacyIdentity, secondConversationId);
    const app = mount(environment);
    await initialize(app);
    await vi.waitFor(() =>
      expect(
        environment.runtimeRequests.some(({ request: actual }) => actual.operation === "recover"),
      ).toBe(true),
    );
    await app.flush();

    expect(state(app)?.history.selectedConversationId).toBe(secondConversationId);
    expect(environment.runtimeRequests.map(({ request: actual }) => actual)).toEqual([
      {
        version: 2,
        operation: "recover",
        conversationId: secondConversationId,
        queryId: secondQueryId,
      },
    ]);
    expect(state(app)?.queryStatus).toBe("streaming");
    expect(state(app)?.question).toBe("Pedido recuperado del journal actual.");
    expect(state(app)?.answer).toBe("Respuesta recuperada del formato actual.");
    const staleFormatEntries = [...storage.values].filter(
      ([key, raw]) =>
        key.startsWith("chat-journal:v3:entry:") && String(raw).includes(firstQueryId),
    );
    expect(staleFormatEntries).toHaveLength(0);
    expect(entriesContaining(storage, secondQueryId)).toHaveLength(1);
  });

  it("keeps active references across New conversation, blocks a second send, and clears all on logout", async () => {
    const streams = new Map();
    const activeRequests = new Map();
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            { conversationId: firstConversationId, label: "Uno", lastOrdinal: 1, closed: false },
            { conversationId: secondConversationId, label: "Dos", lastOrdinal: 1, closed: false },
          ],
        }),
      turnsHandler: async ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: true,
          turns: [
            makeTurn(1, firstQueryId),
            ...(activeRequests.has(conversationId)
              ? [
                  makeTurn(2, activeRequests.get(conversationId).queryId, {
                    status: "in_progress",
                    answerManifest: { count: 1, complete: false },
                    cursor: 1,
                  }),
                ]
              : []),
          ],
        }),
      textHandler: async ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: url.searchParams.get("queryId"),
          role: url.searchParams.get("role"),
          chunks: [
            {
              index: 0,
              text:
                ordinal === 2 && url.searchParams.get("role") === "assistant"
                  ? "Prefijo durable."
                  : "Anterior.",
            },
          ],
          complete: !(ordinal === 2 && url.searchParams.get("role") === "assistant"),
        }),
      runtimeHandler: async (request) => {
        activeRequests.set(request.conversationId, request);
        const stream = streamFor(request);
        streams.set(request.conversationId, stream);
        return stream.response;
      },
      recoverHandler: async (request) => {
        const active = activeRequests.get(request.conversationId);
        return jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 2,
          status: "in_progress",
          question: active.text,
          answer: "Prefijo durable.",
          canContinue: false,
        });
      },
    });
    const app = mount(environment);
    await initialize(app);
    await select(app, firstConversationId);
    expect(props(app).onSubmit("Pedido uno pendiente.")).toBe(true);
    await vi.waitFor(() => expect(streams.has(firstConversationId)).toBe(true));
    const firstRequest = environment.runtimeRequests.at(-1).request;
    streams.get(firstConversationId).accept();
    streams.get(firstConversationId).text("Uno.");
    await vi.waitFor(async () => {
      await app.flush();
      expect(state(app)?.queryStatus).toBe("streaming");
    });
    await select(app, secondConversationId);
    expect(props(app).onSubmit("Pedido dos pendiente.")).toBe(true);
    await vi.waitFor(() => expect(streams.has(secondConversationId)).toBe(true));
    const secondRequest = environment.runtimeRequests.at(-1).request;
    streams.get(secondConversationId).accept();
    streams.get(secondConversationId).text("Dos.");
    await vi.waitFor(async () => {
      await app.flush();
      expect(state(app)?.queryStatus).toBe("streaming");
    });
    expect(entriesContaining(environment.storage, firstRequest.queryId)).toHaveLength(1);
    expect(entriesContaining(environment.storage, secondRequest.queryId)).toHaveLength(1);

    const reset = props(app).onReset;
    expect(reset, "onReset should start a new conversation").toBeTypeOf("function");
    if (typeof reset === "function") reset();
    await app.flush();
    expect(entriesContaining(environment.storage, firstRequest.queryId)).toHaveLength(1);
    expect(entriesContaining(environment.storage, secondRequest.queryId)).toHaveLength(1);
    expect(environment.runtimeRequests[0].signal.aborted).toBe(true);
    expect(environment.runtimeRequests[1].signal.aborted).toBe(true);
    expect(state(app)?.question).toBeUndefined();
    streams.get(firstConversationId).text("Late text after reset.", 1);
    streams.get(secondConversationId).text("Late text after reset.", 1);
    await app.flush();
    expect(JSON.stringify(state(app))).not.toContain("Late text after reset.");

    await select(app, firstConversationId);
    await vi.waitFor(() =>
      expect(
        environment.runtimeRequests.some(({ request }) => request.operation === "recover"),
      ).toBe(true),
    );
    await app.flush();
    expect(state(app)?.queryStatus).toBe("streaming");
    expect(state(app)?.question).toBe(activeRequests.get(firstConversationId).text);
    expect(props(app).onSubmit("A second request while the first remains active.")).toBe(false);
    expect(
      environment.runtimeRequests.filter(({ request }) => request.operation === "message"),
    ).toHaveLength(2);

    const signOut = props(app).onSignOut;
    expect(signOut).toBeTypeOf("function");
    if (typeof signOut === "function") await signOut();
    await app.flush();
    expect(entriesContaining(environment.storage, firstRequest.queryId)).toHaveLength(0);
    expect(entriesContaining(environment.storage, secondRequest.queryId)).toHaveLength(0);
    streams.get(firstConversationId).text("Late text after logout.", 1);
    await app.flush();
    expect(JSON.stringify(app.current())).not.toContain("Late text after logout.");

    const nextIdentityEnvironment = createHistoryEnvironment({
      storage: environment.storage,
      identity: { sub: "teacher-b", botId: "docentes" },
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: "77777777-7777-4777-8777-777777777777",
              label: "Solo otra identidad",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
    });
    const nextIdentityApp = mount(nextIdentityEnvironment);
    await initialize(nextIdentityApp);
    expect(state(nextIdentityApp)?.history?.conversations).toMatchObject([
      { conversationId: "77777777-7777-4777-8777-777777777777", label: "Solo otra identidad" },
    ]);
    expect(JSON.stringify(state(nextIdentityApp)?.history)).not.toContain(firstConversationId);
    expect(JSON.stringify(state(nextIdentityApp)?.history)).not.toContain(secondConversationId);
    expect(nextIdentityEnvironment.runtimeRequests).toHaveLength(0);
  });
});
