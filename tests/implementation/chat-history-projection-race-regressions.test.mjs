import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  createHistoryEnvironment,
  deferred,
  firstConversationId,
  firstQueryId,
  jsonResponse,
  loadHistoryAccountApp,
  mountHistoryAccountApp,
  secondConversationId,
  secondQueryId,
} from "../support/history-web-harness.mjs";

let AccountApp;
let disposeAccountAppModule;
const apps = [];

beforeAll(async () => {
  ({ AccountApp, dispose: disposeAccountAppModule } = await loadHistoryAccountApp());
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

const latestUpdatedAt = "2026-10-27T10:15:00.000Z";

function summary(
  lastOrdinal,
  closed,
  updatedAt = latestUpdatedAt,
  conversationId = firstConversationId,
) {
  return {
    conversationId,
    label: "Conversación actualizada",
    lastOrdinal,
    closed,
    updatedAt,
  };
}

function turn(ordinal, queryId, status = "completed") {
  return {
    ordinal,
    queryId,
    status,
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: 1, complete: status === "completed" },
    cursor: 1,
    ...(status === "failed" ? { failure: { code: "runtime_failed" } } : {}),
  };
}

function currentClosedView(conversationId = firstConversationId) {
  return jsonResponse({
    version: 1,
    conversationId,
    label: "Conversación actualizada",
    updatedAt: latestUpdatedAt,
    throughOrdinal: 2,
    closed: true,
    canContinue: false,
    turns: [turn(2, secondQueryId, "failed")],
  });
}

function olderOpenView(conversationId = firstConversationId) {
  return jsonResponse({
    version: 1,
    conversationId,
    label: "Conversación anterior",
    updatedAt: "2026-10-26T09:00:00.000Z",
    throughOrdinal: 1,
    closed: false,
    canContinue: true,
    turns: [turn(1, firstQueryId)],
  });
}

function historyText({ conversationId, ordinal, url }) {
  const role = url.searchParams.get("role");
  return jsonResponse({
    version: 1,
    conversationId,
    ordinal,
    queryId: ordinal === 1 ? firstQueryId : secondQueryId,
    role,
    chunks: [{ index: 0, text: ordinal === 1 ? `older ${role}` : `current ${role}` }],
    complete: true,
  });
}

function mount(environment) {
  const app = mountHistoryAccountApp(environment, AccountApp);
  apps.push(app);
  return app;
}

async function observeNewerClosedHistory(app, environment, stateRef, conversationId) {
  stateRef.current = summary(2, true, latestUpdatedAt, conversationId);
  await app.current().props.onRefreshHistory();
  await app.flush();
  expect(
    app
      .current()
      .props.state.history.conversations.find(
        (conversation) => conversation.conversationId === conversationId,
      ),
  ).toMatchObject({ lastOrdinal: 2, closed: true, updatedAt: latestUpdatedAt });
  expect(environment.runtimeRequests).toHaveLength(1);
}

async function expectCurrentClosedProjection(app, conversationId = firstConversationId) {
  await app.flush();
  const state = app.current().props.state;
  const row = state.history.conversations.find(
    (conversation) => conversation.conversationId === conversationId,
  );
  expect(row).toMatchObject({
    lastOrdinal: 2,
    closed: true,
    updatedAt: latestUpdatedAt,
  });
  expect(row.activeQueryId).toBeUndefined();
  expect(state).toMatchObject({
    ordinal: 2,
    queryStatus: "failed",
    canContinue: false,
    history: {
      selectedConversationId: conversationId,
      throughOrdinal: 2,
      closed: true,
      canContinue: false,
      turns: [
        { ordinal: 2, queryId: secondQueryId, status: "failed", answer: "current assistant" },
      ],
    },
  });
  expect(state.history.turns.some(({ queryId }) => queryId === firstQueryId)).toBe(false);
  expect(await app.current().props.onSubmit("Do not continue a closed thread")).toBe(false);
}

it("reconciles accepted and text events that arrive after a newer closed history observation", async () => {
  const stream = createDeferredStreamController();
  const serverSummary = { current: undefined };
  const environment = createHistoryEnvironment({
    listHandler: () =>
      jsonResponse({
        version: 1,
        conversations: serverSummary.current ? [serverSummary.current] : [],
      }),
    turnsHandler: ({ conversationId }) => currentClosedView(conversationId),
    textHandler: historyText,
    runtimeHandler: stream.runtimeHandler,
  });
  const app = mount(environment);
  await app.flush();

  expect(app.current().props.onSubmit("First question")).toBe(true);
  await app.flush();
  const request = stream.request();
  await observeNewerClosedHistory(app, environment, serverSummary, request.conversationId);

  stream.emit("accepted", {
    conversationId: request.conversationId,
    queryId: request.queryId,
    ordinal: 1,
  });
  stream.emit("text", {
    queryId: request.queryId,
    index: 0,
    text: "stale prefix",
  });
  await expectCurrentClosedProjection(app, request.conversationId);
});

it("resolves text-only delivery against a closure observed after accepted", async () => {
  const stream = createDeferredStreamController();
  const serverSummary = { current: undefined };
  const environment = createHistoryEnvironment({
    listHandler: () =>
      jsonResponse({
        version: 1,
        conversations: serverSummary.current ? [serverSummary.current] : [],
      }),
    turnsHandler: ({ conversationId }) => currentClosedView(conversationId),
    textHandler: historyText,
    runtimeHandler: stream.runtimeHandler,
  });
  const app = mount(environment);
  await app.flush();

  expect(app.current().props.onSubmit("First question")).toBe(true);
  await app.flush();
  const request = stream.request();
  stream.emit("accepted", {
    conversationId: request.conversationId,
    queryId: request.queryId,
    ordinal: 1,
  });
  await app.flush();
  expect(app.current().props.state).toMatchObject({ ordinal: 1, queryStatus: "streaming" });

  await observeNewerClosedHistory(app, environment, serverSummary, request.conversationId);
  stream.emit("text", { queryId: request.queryId, index: 0, text: "stale prefix" });

  await expectCurrentClosedProjection(app, request.conversationId);
});

it("still projects an ordinary accepted prefix when no newer history has been observed", async () => {
  const stream = createDeferredStreamController();
  const environment = createHistoryEnvironment({
    listHandler: () => jsonResponse({ version: 1, conversations: [] }),
    runtimeHandler: stream.runtimeHandler,
  });
  const app = mount(environment);
  await app.flush();

  expect(app.current().props.onSubmit("First question")).toBe(true);
  await app.flush();
  const request = stream.request();
  stream.emit("accepted", {
    conversationId: request.conversationId,
    queryId: request.queryId,
    ordinal: 1,
  });
  stream.emit("text", { queryId: request.queryId, index: 0, text: "current prefix" });
  await app.flush();

  expect(app.current().props.state).toMatchObject({
    ordinal: 1,
    queryStatus: "streaming",
    history: {
      throughOrdinal: 1,
      turns: [
        { ordinal: 1, queryId: request.queryId, status: "in_progress", answer: "current prefix" },
      ],
    },
  });
  expect(
    app
      .current()
      .props.state.history.conversations.find(
        ({ conversationId }) => conversationId === request.conversationId,
      ),
  ).toMatchObject({ lastOrdinal: 1, closed: false, activeQueryId: request.queryId });
  expect(environment.runtimeRequests).toHaveLength(1);
});

it("opens a locally completed turn when the same-ordinal server view has an earlier timestamp", async () => {
  const stream = createDeferredStreamController();
  const oldServerActivity = "2026-10-26T09:00:00.000Z";
  const environment = createHistoryEnvironment({
    listHandler: () => jsonResponse({ version: 1, conversations: [] }),
    turnsHandler: ({ conversationId }) =>
      jsonResponse({
        version: 1,
        conversationId,
        label: "First question",
        updatedAt: oldServerActivity,
        throughOrdinal: 1,
        closed: false,
        canContinue: true,
        turns: [turn(1, stream.request().queryId)],
      }),
    textHandler: ({ conversationId, ordinal, url }) => {
      const role = url.searchParams.get("role");
      return jsonResponse({
        version: 1,
        conversationId,
        ordinal,
        queryId: stream.request().queryId,
        role,
        chunks: [{ index: 0, text: `current ${role}` }],
        complete: true,
      });
    },
    runtimeHandler: stream.runtimeHandler,
  });
  const app = mount(environment);
  await app.flush();

  expect(app.current().props.onSubmit("First question")).toBe(true);
  await app.flush();
  const request = stream.request();
  stream.emit("accepted", {
    conversationId: request.conversationId,
    queryId: request.queryId,
    ordinal: 1,
  });
  stream.emit("text", { queryId: request.queryId, index: 0, text: "current prefix" });
  stream.emit("completed", { queryId: request.queryId });
  stream.close();
  await app.flush();

  expect(await app.current().props.onSelectConversation(request.conversationId)).toBe(true);
  await app.flush();
  expect(app.current().props.state).toMatchObject({
    ordinal: 1,
    queryStatus: "completed",
    canContinue: true,
    history: {
      selectedConversationId: request.conversationId,
      turnsStatus: "ready",
      throughOrdinal: 1,
      closed: false,
      canContinue: true,
    },
  });
  expect(environment.apiRequests.filter(({ path }) => path.endsWith("/turns"))).toHaveLength(1);
});

it("replaces a delayed stale opening with the latest closed conversation before enabling follow-up", async () => {
  const textGate = deferred();
  let serverSummary = summary(1, false, "2026-10-26T09:00:00.000Z");
  let turnsReads = 0;
  const environment = createHistoryEnvironment({
    listHandler: () => jsonResponse({ version: 1, conversations: [serverSummary] }),
    turnsHandler: ({ conversationId }) => {
      turnsReads += 1;
      return turnsReads === 1 ? olderOpenView(conversationId) : currentClosedView(conversationId);
    },
    textHandler: async ({ conversationId, ordinal, url }) => {
      if (ordinal === 1) await textGate.promise;
      return historyText({ conversationId, ordinal, url });
    },
  });
  const app = mount(environment);
  await app.flush();

  const opening = app.current().props.onSelectConversation(firstConversationId);
  await app.flush();
  expect(environment.apiRequests.filter(({ path }) => path.endsWith("/text"))).toHaveLength(2);
  serverSummary = summary(2, true);
  await app.current().props.onRefreshHistory();
  await app.flush();
  expect(app.current().props.state.history.conversations[0]).toMatchObject({
    lastOrdinal: 2,
    closed: true,
  });

  textGate.resolve();
  await opening;
  await app.flush();

  await expectCurrentClosedProjection(app);
  expect(turnsReads).toBeGreaterThanOrEqual(2);
  expect(await app.html()).not.toContain("La respuesta está completa. Podés continuar este hilo.");
  expect(environment.runtimeRequests).toEqual([]);
});

it("keeps a same-ordinal closure observed while its open transcript is hydrating", async () => {
  const textGate = deferred();
  let serverSummary = summary(1, false, "2026-10-26T09:00:00.000Z");
  let turnsReads = 0;
  const environment = createHistoryEnvironment({
    listHandler: () => jsonResponse({ version: 1, conversations: [serverSummary] }),
    turnsHandler: ({ conversationId }) => {
      turnsReads += 1;
      if (turnsReads === 1) return olderOpenView(conversationId);
      return jsonResponse({
        version: 1,
        conversationId,
        label: "Conversación actualizada",
        updatedAt: latestUpdatedAt,
        throughOrdinal: 1,
        closed: true,
        canContinue: false,
        turns: [turn(1, firstQueryId, "failed")],
      });
    },
    textHandler: async ({ conversationId, ordinal, url }) => {
      if (turnsReads === 1) await textGate.promise;
      return historyText({ conversationId, ordinal, url });
    },
  });
  const app = mount(environment);
  await app.flush();

  const opening = app.current().props.onSelectConversation(firstConversationId);
  await app.flush();
  serverSummary = summary(1, true);
  await app.current().props.onRefreshHistory();
  await app.flush();

  textGate.resolve();
  expect(await opening).toBe(true);
  await app.flush();
  expect(turnsReads).toBe(2);
  expect(app.current().props.state).toMatchObject({
    ordinal: 1,
    queryStatus: "failed",
    canContinue: false,
    history: {
      selectedConversationId: firstConversationId,
      turnsStatus: "ready",
      throughOrdinal: 1,
      closed: true,
      canContinue: false,
      turns: [{ ordinal: 1, queryId: firstQueryId, status: "failed" }],
    },
  });
  expect(
    app
      .current()
      .props.state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ),
  ).toMatchObject({ lastOrdinal: 1, closed: true, updatedAt: latestUpdatedAt });
  expect(app.current().props.onSubmit("Do not continue a closed thread")).toBe(false);
  expect(environment.runtimeRequests).toEqual([]);
});

it("keeps the safe closed transcript and retry error if a stale opening cannot be reread", async () => {
  const textGate = deferred();
  let turnsReads = 0;
  let serverSummary = summary(1, false, "2026-10-26T09:00:00.000Z");
  const environment = createHistoryEnvironment({
    listHandler: () => jsonResponse({ version: 1, conversations: [serverSummary] }),
    turnsHandler: ({ conversationId }) => {
      turnsReads += 1;
      if (turnsReads <= 2) return olderOpenView(conversationId);
      if (turnsReads === 3) return jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503);
      return currentClosedView(conversationId);
    },
    textHandler: async ({ conversationId, ordinal, url }) => {
      if (turnsReads === 2 && ordinal === 1) await textGate.promise;
      return historyText({ conversationId, ordinal, url });
    },
  });
  const app = mount(environment);
  await app.flush();
  expect(await app.current().props.onSelectConversation(firstConversationId)).toBe(true);
  await app.flush();
  expect(app.current().props.state).toMatchObject({
    ordinal: 1,
    queryStatus: "completed",
    canContinue: true,
    history: {
      throughOrdinal: 1,
      closed: false,
      canContinue: true,
      turns: [{ ordinal: 1, queryId: firstQueryId, answer: "older assistant" }],
    },
  });

  const reopening = app.current().props.onSelectConversation(firstConversationId);
  await app.flush();
  expect(app.current().props.state.history.openingConversationId).toBe(firstConversationId);
  expect(app.current().props.state.history.turns[0]).toMatchObject({
    ordinal: 1,
    queryId: firstQueryId,
    answer: "older assistant",
  });
  serverSummary = summary(2, true);
  await app.current().props.onRefreshHistory();
  await app.flush();
  expect(app.current().props.state.history.conversations[0]).toMatchObject({
    lastOrdinal: 2,
    closed: true,
    updatedAt: latestUpdatedAt,
  });

  textGate.resolve();
  await reopening;
  await app.flush();
  expect(app.current().props.state).toMatchObject({
    ordinal: 1,
    queryStatus: "completed",
    canContinue: false,
    history: {
      selectedConversationId: firstConversationId,
      turnsStatus: "error",
      throughOrdinal: 1,
      closed: true,
      canContinue: false,
      turns: [{ ordinal: 1, queryId: firstQueryId, answer: "older assistant" }],
    },
  });
  expect(
    app
      .current()
      .props.state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ),
  ).toMatchObject({ lastOrdinal: 2, closed: true, updatedAt: latestUpdatedAt });
  expect(turnsReads).toBeGreaterThanOrEqual(3);
  expect(app.current().props.state.history.turnsError).toBeTruthy();
  expect(await app.current().props.onSubmit("Do not continue a closed thread")).toBe(false);
  expect(environment.runtimeRequests).toEqual([]);

  await app.current().props.onSelectConversation(firstConversationId);
  await app.flush();
  expect(app.current().props.state).toMatchObject({
    ordinal: 2,
    queryStatus: "failed",
    canContinue: false,
    history: {
      turnsStatus: "ready",
      turnsError: undefined,
      closed: true,
      throughOrdinal: 2,
      turns: [{ ordinal: 2, queryId: secondQueryId, answer: "current assistant" }],
    },
  });
});

it("preserves the selected conversation and draft when a stale different-thread open fails", async () => {
  const textGate = deferred();
  let serverSummaries = [
    summary(1, false, "2026-10-26T09:00:00.000Z", firstConversationId),
    summary(1, false, "2026-10-26T09:00:00.000Z", secondConversationId),
  ];
  let readsForB = 0;
  const environment = createHistoryEnvironment({
    listHandler: () => jsonResponse({ version: 1, conversations: serverSummaries }),
    turnsHandler: ({ conversationId }) => {
      if (conversationId === firstConversationId) {
        return jsonResponse({
          version: 1,
          conversationId,
          label: "Conversation A",
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, firstQueryId)],
          nextCursor: "older-A",
        });
      }
      readsForB += 1;
      if (readsForB === 1) {
        return jsonResponse({
          version: 1,
          conversationId,
          label: "Conversation B",
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, secondQueryId)],
        });
      }
      return jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503);
    },
    textHandler: async ({ conversationId, ordinal, url }) => {
      const role = url.searchParams.get("role");
      if (conversationId === secondConversationId) await textGate.promise;
      return jsonResponse({
        version: 1,
        conversationId,
        ordinal,
        queryId: conversationId === firstConversationId ? firstQueryId : secondQueryId,
        role,
        chunks: [
          { index: 0, text: `${conversationId === firstConversationId ? "A" : "B"} ${role}` },
        ],
        complete: true,
      });
    },
  });
  const app = mount(environment);
  await app.flush();
  expect(await app.current().props.onSelectConversation(firstConversationId)).toBe(true);
  await app.flush();
  app.current().props.onDraftChange("Draft in A");
  await app.flush();

  const openingB = app.current().props.onSelectConversation(secondConversationId);
  await app.flush();
  expect(app.current().props.state.history).toMatchObject({
    selectedConversationId: firstConversationId,
    openingConversationId: secondConversationId,
    turnsStatus: "loading",
  });
  serverSummaries = [
    summary(1, false, "2026-10-26T09:00:00.000Z", firstConversationId),
    summary(2, true, latestUpdatedAt, secondConversationId),
  ];
  await app.current().props.onRefreshHistory();
  await app.flush();

  textGate.resolve();
  expect(await openingB).toBe(false);
  await app.flush();
  expect(app.current().props.state).toMatchObject({
    draft: "Draft in A",
    ordinal: 1,
    canContinue: true,
    history: {
      selectedConversationId: firstConversationId,
      turnsStatus: "error",
      closed: false,
      canContinue: true,
      turns: [{ ordinal: 1, queryId: firstQueryId, answer: "A assistant" }],
    },
  });
  expect(
    app
      .current()
      .props.state.history.conversations.find(
        ({ conversationId }) => conversationId === secondConversationId,
      ),
  ).toMatchObject({ lastOrdinal: 2, closed: true, updatedAt: latestUpdatedAt });
  expect(app.current().props.onSubmit("Continue A")).toBe(true);
  await app.flush();
  expect(
    environment.runtimeRequests.find(({ request }) => request.operation === "message").request,
  ).toMatchObject({ conversationId: firstConversationId, baseOrdinal: 1 });
});

it("keeps the open-history continuation control when no newer closure exists", async () => {
  const textGate = deferred();
  const openSummary = summary(1, false, "2026-10-26T09:00:00.000Z");
  const environment = createHistoryEnvironment({
    listHandler: () => jsonResponse({ version: 1, conversations: [openSummary] }),
    turnsHandler: ({ conversationId }) => olderOpenView(conversationId),
    textHandler: async ({ conversationId, ordinal, url }) => {
      await textGate.promise;
      return historyText({ conversationId, ordinal, url });
    },
    runtimeHandler: async () => jsonResponse({ code: "CONVERSATION_CLOSED" }, 409),
  });
  const app = mount(environment);
  await app.flush();

  const opening = app.current().props.onSelectConversation(firstConversationId);
  await app.flush();
  expect(app.current().props.state.history.turnsStatus).toBe("loading");
  textGate.resolve();
  expect(await opening).toBe(true);
  await app.flush();

  expect(app.current().props.state).toMatchObject({
    ordinal: 1,
    queryStatus: "completed",
    canContinue: true,
    history: { throughOrdinal: 1, closed: false, canContinue: true },
  });
  expect(await app.html()).toContain("La respuesta está completa. Podés continuar este hilo.");
  expect(app.current().props.onSubmit("Follow-up after opening")).toBe(true);
  await app.flush();
  expect(
    environment.runtimeRequests.findLast(({ request }) => request.operation === "message").request,
  ).toMatchObject({
    operation: "message",
    conversationId: firstConversationId,
    baseOrdinal: 1,
  });
});

function createDeferredStreamController() {
  let request;
  let controller;
  const encoder = new TextEncoder();
  return {
    runtimeHandler(value) {
      request = value;
      return new Response(
        new ReadableStream({
          start(streamController) {
            controller = streamController;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    request() {
      return request;
    },
    emit(type, fields = {}) {
      controller.enqueue(
        encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`),
      );
    },
    close() {
      controller.close();
    },
  };
}
