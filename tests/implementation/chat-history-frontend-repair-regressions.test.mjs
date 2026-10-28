import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  thirdQueryId,
  streamResponse,
} from "../support/history-web-harness.mjs";
import {
  act,
  buttonByText,
  clickPhase8,
  createPhase8Dom,
  conversationRow,
  hideButtonFor,
  mountPhase8AccountApp,
  React,
  renderPhase8AccountApp,
  statusText,
} from "../support/phase8-web-harness.mjs";
import {
  clearChatJournal,
  markChatJournalAdmitted,
  readChatJournals,
  writePendingChatJournal,
  writeChatSelection,
} from "../../web/chat-journal.ts";
import { ChatBrowserFixture } from "../fixtures/chat/harness.ts";
import { AccountApp as RealAccountApp } from "../../web/AccountApp.tsx";
import { siteConfig } from "../../config/site.ts";

let AccountApp;
let ChatScreen;
let disposeAccountAppModule;
const apps = [];
const domStates = [];

beforeAll(async () => {
  ({ AccountApp, dispose: disposeAccountAppModule } = await loadHistoryAccountApp());
  ChatScreen = globalThis.__accountScreens.ChatScreen;
});

afterAll(async () => {
  await disposeAccountAppModule?.();
});

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) app.dispose();
  for (const domState of domStates.splice(0).reverse()) await domState.dispose();
  vi.unstubAllGlobals();
  delete globalThis.__accountHooks;
  delete globalThis.__accountScreens;
  delete globalThis.__accountSession;
});

const props = (app) => app.current()?.props;
const mount = (environment) => {
  const app = mountHistoryAccountApp(environment, AccountApp);
  apps.push(app);
  return app;
};

describe("local fixture recovery snapshots", () => {
  it.each(["admitted", "pending"])(
    "derives recover.canContinue from the latest turn for a %s journal",
    async (journalMode) => {
      const storage = createFixtureStorage();
      const fakeWindow = {
        location: {
          href: "https://fixture.invalid/?scenario=ready#/chat",
          pathname: "/",
          search: "?scenario=ready",
          hash: "#/chat",
        },
        history: { replaceState() {} },
        crypto: { randomUUID: () => "77777777-7777-4777-8777-777777777777" },
        sessionStorage: storage,
        setTimeout: (...args) => globalThis.setTimeout(...args),
        clearTimeout: (...args) => globalThis.clearTimeout(...args),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal("window", fakeWindow);
      vi.stubGlobal("sessionStorage", storage);
      vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });
      const fixture = new ChatBrowserFixture();
      vi.stubGlobal("sessionStorage", fakeWindow.sessionStorage);
      fixture.selectScenario(journalMode === "pending" ? "runtime-admission-pending" : "ready");

      const identity = { sub: "fixture-teacher", botId: fixture.publicConfig.botId };
      const body = "Admitted remotely while its SSE acknowledgement was lost";
      const request = {
        version: 2,
        operation: "start",
        conversationId: firstConversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
        text: body,
      };
      writeChatSelection(fixture.publicConfig, identity, firstConversationId);
      writePendingChatJournal(fixture.publicConfig, identity, request);
      const tokens = await fixture.session.signIn("docente@example.test", "fixture-password");
      const runtimeUrl =
        `https://bedrock-agentcore.${fixture.publicConfig.region}.amazonaws.com/runtimes/` +
        `${encodeURIComponent(fixture.publicConfig.runtimeArn)}/invocations?qualifier=${fixture.publicConfig.runtimeQualifier}`;
      await fixture.fetch(runtimeUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        body: JSON.stringify(request),
      });
      if (journalMode === "pending") {
        fixture.disconnectPendingStream();
        fixture.admitStream();
      } else {
        markChatJournalAdmitted(fixture.publicConfig, identity, request, 1);
      }

      expect(fixture.snapshot("#/chat").canAdvanceRemoteConversation).toBe(true);
      expect(fixture.advanceAdmittedTurnFromAnotherSession()).toBe(true);
      const journalAfterAdvance = readChatJournals(fixture.publicConfig, identity).get(
        firstConversationId,
      );
      expect(journalAfterAdvance).toMatchObject({
        admitted: journalMode === "admitted",
        request: { queryId: firstQueryId },
      });
      if (journalMode === "pending") {
        expect(journalAfterAdvance.request).toHaveProperty("text", body);
      } else {
        expect(journalAfterAdvance.request).not.toHaveProperty("text");
      }

      const recover = async (queryId) => {
        const response = await fixture.fetch(runtimeUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${tokens.accessToken}` },
          body: JSON.stringify({
            version: 2,
            operation: "recover",
            conversationId: firstConversationId,
            queryId,
          }),
        });
        return response.json();
      };
      expect(await recover(firstQueryId)).toMatchObject({
        ordinal: 1,
        status: "completed",
        canContinue: false,
      });
      const conversation = fixture
        .snapshot("#/chat")
        .conversations.find(({ conversationId }) => conversationId === firstConversationId);
      const followUpQueryId = conversation.turns.at(-1).queryId;
      expect(conversation.turns.at(-1).status).toBe("streaming");
      expect(await recover(followUpQueryId)).toMatchObject({
        ordinal: 2,
        status: "in_progress",
        canContinue: false,
      });

      fixture.finishStream("complete");
      expect(await recover(followUpQueryId)).toMatchObject({
        ordinal: 2,
        status: "completed",
        canContinue: true,
      });
      expect(await recover(firstQueryId)).toMatchObject({
        ordinal: 1,
        status: "completed",
        canContinue: false,
      });
    },
  );
});

function writePendingStart(environment, text) {
  writeChatSelection(environment.config, environment.identity, firstConversationId);
  writePendingChatJournal(environment.config, environment.identity, {
    version: 2,
    operation: "start",
    conversationId: firstConversationId,
    queryId: firstQueryId,
    baseOrdinal: 0,
    text,
  });
}

function registerConversationMeta(
  environment,
  {
    conversationId = firstConversationId,
    label,
    lastOrdinal,
    closed,
    activeQueryId,
    createdAt,
    updatedAt,
  },
) {
  environment.conversationMeta.set(conversationId, {
    version: 1,
    conversationId,
    label,
    lastOrdinal,
    closed,
    ...(activeQueryId ? { activeQueryId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  });
}

const historyList = () =>
  jsonResponse({
    version: 1,
    conversations: [
      {
        conversationId: firstConversationId,
        label: "Conversación anterior",
        lastOrdinal: 2,
        closed: false,
      },
    ],
  });

const turn = (ordinal = 2, queryId = firstQueryId) => ({
  ordinal,
  queryId,
  status: "completed",
  questionManifest: { count: 1, complete: true },
  answerManifest: { count: 1, complete: true },
  cursor: 1,
});

const emptyFailedTurn = () => ({
  ...turn(1, firstQueryId),
  status: "failed",
  answerManifest: { count: 0, complete: false },
  cursor: 0,
  failure: { code: "runtime_failed" },
});

const turnText = ({ conversationId, ordinal, url }) =>
  jsonResponse({
    version: 1,
    conversationId,
    ordinal,
    queryId: url.searchParams.get("queryId"),
    role: url.searchParams.get("role"),
    chunks: [{ index: 0, text: `ORIGINAL_TEXT_${ordinal}` }],
    complete: true,
  });

describe("earlier history pages follow the current selection", () => {
  const fourthQueryId = "9ed06c25-b5c8-40d0-9b04-f93c2f7e8900";
  const queryIds = new Map([
    [`${firstConversationId}:1`, firstQueryId],
    [`${firstConversationId}:2`, secondQueryId],
    [`${secondConversationId}:1`, thirdQueryId],
    [`${secondConversationId}:2`, fourthQueryId],
  ]);
  const page = (conversationId, turns, nextCursor) =>
    jsonResponse({
      version: 1,
      conversationId,
      throughOrdinal: 2,
      closed: false,
      canContinue: true,
      turns,
      ...(nextCursor ? { nextCursor } : {}),
    });

  it("clears A's pending-page state before B can load its own history and ignores A's late result", async () => {
    const pendingA = deferred();
    let aEarlierReads = 0;
    let failFirstBOpen = true;
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            { conversationId: firstConversationId, label: "A", lastOrdinal: 2, closed: false },
            { conversationId: secondConversationId, label: "B", lastOrdinal: 2, closed: false },
          ],
        }),
      turnsHandler: ({ conversationId, url }) => {
        const cursor = url.searchParams.get("cursor");
        if (!cursor) {
          if (conversationId === secondConversationId && failFirstBOpen) {
            failFirstBOpen = false;
            return jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503);
          }
          return page(
            conversationId,
            [turn(2, queryIds.get(`${conversationId}:2`))],
            `${conversationId}-older`,
          );
        }
        if (conversationId === firstConversationId && aEarlierReads++ === 0)
          return pendingA.promise;
        return page(conversationId, [turn(1, queryIds.get(`${conversationId}:1`))]);
      },
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: queryIds.get(`${conversationId}:${ordinal}`),
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: `original-${conversationId}-${ordinal}` }],
          complete: true,
        }),
    });
    const app = mount(environment);
    await app.flush();
    const current = () => props(app).state.history;

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    const pendingPage = props(app).onLoadEarlierTurns();
    await app.flush();
    expect(current()).toMatchObject({
      selectedConversationId: firstConversationId,
      loadingEarlier: true,
    });

    expect(await props(app).onSelectConversation(secondConversationId)).toBe(false);
    await app.flush();
    expect(current()).toMatchObject({
      selectedConversationId: firstConversationId,
      turnsStatus: "error",
      loadingEarlier: false,
    });
    const openingError = current().turnsError;

    expect(await props(app).onSelectConversation(secondConversationId)).toBe(true);
    await app.flush();
    expect(current()).toMatchObject({
      selectedConversationId: secondConversationId,
      turnsStatus: "ready",
      turnsNextCursor: `${secondConversationId}-older`,
      loadingEarlier: false,
    });
    await props(app).onLoadEarlierTurns();
    await app.flush();
    expect(current().turns.map(({ queryId }) => queryId)).toEqual([thirdQueryId, fourthQueryId]);

    pendingA.resolve(page(firstConversationId, [turn(1, firstQueryId)]));
    await pendingPage;
    await app.flush();
    expect(current()).toMatchObject({
      selectedConversationId: secondConversationId,
      turnsStatus: "ready",
      loadingEarlier: false,
      turnsError: undefined,
    });
    expect(current().turns.map(({ queryId }) => queryId)).toEqual([thirdQueryId, fourthQueryId]);
    expect(openingError).toContain("No pudimos abrir");

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    expect(current()).toMatchObject({
      selectedConversationId: firstConversationId,
      turnsNextCursor: `${firstConversationId}-older`,
      loadingEarlier: false,
    });
    await props(app).onLoadEarlierTurns();
    await app.flush();
    expect(current().turns.map(({ queryId }) => queryId)).toEqual([firstQueryId, secondQueryId]);
  });

  it("keeps a same-thread page load through list refresh and clears it when starting a new chat", async () => {
    const pendingA = deferred();
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            { conversationId: firstConversationId, label: "A", lastOrdinal: 2, closed: false },
          ],
        }),
      turnsHandler: ({ conversationId, url }) =>
        url.searchParams.has("cursor")
          ? pendingA.promise
          : page(conversationId, [turn(2, secondQueryId)], `${conversationId}-older`),
      textHandler: turnText,
    });
    const app = mount(environment);
    await app.flush();
    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    const pendingPage = props(app).onLoadEarlierTurns();
    await app.flush();
    expect(props(app).state.history.loadingEarlier).toBe(true);

    await props(app).onRefreshHistory();
    await app.flush();
    expect(props(app).state.history).toMatchObject({
      selectedConversationId: firstConversationId,
      loadingEarlier: true,
    });

    props(app).onReset();
    await app.flush();
    expect(props(app).state.history).toMatchObject({
      selectedConversationId: null,
      loadingEarlier: false,
      turnsNextCursor: null,
    });
    pendingA.resolve(page(firstConversationId, [turn(1, firstQueryId)]));
    await pendingPage;
    await app.flush();
    expect(props(app).state.history).toMatchObject({
      selectedConversationId: null,
      loadingEarlier: false,
      turns: [],
    });
  });
});

describe("active recovery preserves authoritative activity", () => {
  it("keeps an older in-progress conversation behind a newer conversation after recover", async () => {
    const olderUpdatedAt = new Date(Date.now() - 120_000).toISOString();
    const newerUpdatedAt = new Date(Date.now() - 60_000).toISOString();
    const activeTurn = {
      ...turn(1, firstQueryId),
      status: "in_progress",
      answerManifest: { count: 1, complete: false },
    };
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: secondConversationId,
              label: "B reciente",
              updatedAt: newerUpdatedAt,
              lastOrdinal: 1,
              closed: false,
            },
            {
              conversationId: firstConversationId,
              label: "A antiguo y activo",
              updatedAt: olderUpdatedAt,
              lastOrdinal: 1,
              closed: false,
              activeQueryId: firstQueryId,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          label: "A antiguo y activo",
          updatedAt: olderUpdatedAt,
          throughOrdinal: 1,
          closed: false,
          canContinue: false,
          turns: [activeTurn],
        }),
      textHandler: turnText,
      recoverHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 1,
          status: "in_progress",
          question: "Consulta activa A",
          answer: "Prefijo durable",
          canContinue: false,
        }),
    });
    const app = mount(environment);
    await app.flush();
    expect(
      props(app).state.history.conversations.map(({ conversationId }) => conversationId),
    ).toEqual([secondConversationId, firstConversationId]);

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();

    expect(environment.runtimeRequests.map(({ request }) => request.operation)).toEqual([
      "recover",
    ]);
    expect(props(app).state).toMatchObject({ queryId: firstQueryId, queryStatus: "streaming" });
    expect(
      props(app).state.history.conversations.map(({ conversationId }) => conversationId),
    ).toEqual([secondConversationId, firstConversationId]);
    expect(props(app).state.history.conversations[0]).toMatchObject({
      conversationId: secondConversationId,
      updatedAt: newerUpdatedAt,
    });
    expect(props(app).state.history.conversations[1]).toMatchObject({
      conversationId: firstConversationId,
      updatedAt: olderUpdatedAt,
      lastOrdinal: 1,
      activeQueryId: firstQueryId,
    });
  });

  it("keeps a local terminal state when delayed verified META is still active at the same ordinal", async () => {
    const delayedMeta = deferred();
    let listReads = 0;
    let streamController;
    let submittedRequest;
    const encoder = new TextEncoder();
    const rows = [
      {
        conversationId: firstConversationId,
        label: "A en curso",
        lastOrdinal: 1,
        closed: false,
      },
      {
        conversationId: secondConversationId,
        label: "B reciente",
        lastOrdinal: 1,
        closed: false,
      },
    ];
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: ++listReads === 1 ? rows : [rows[1]],
        }),
      metaHandler: () => delayedMeta.promise,
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          label: conversationId === firstConversationId ? "A en curso" : "B reciente",
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, conversationId === firstConversationId ? firstQueryId : secondQueryId)],
        }),
      textHandler: turnText,
      runtimeHandler: (request) => {
        submittedRequest = request;
        return new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
              controller.enqueue(
                encoder.encode(
                  `event: accepted\ndata: ${JSON.stringify({
                    type: "accepted",
                    conversationId: firstConversationId,
                    queryId: request.queryId,
                    ordinal: 2,
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `event: text\ndata: ${JSON.stringify({
                    type: "text",
                    queryId: request.queryId,
                    index: 0,
                    text: "Listo",
                  })}\n\n`,
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const app = mount(environment);
    await app.flush();
    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    expect(props(app).onSubmit("Seguimiento")).toBe(true);
    await app.flush();

    const refresh = props(app).onRefreshHistory();
    await app.flush();
    expect(
      environment.apiRequests.some(
        ({ path }) => path === `/chat/conversations/${firstConversationId}`,
      ),
    ).toBe(true);
    streamController.enqueue(
      encoder.encode(
        `event: completed\ndata: ${JSON.stringify({
          type: "completed",
          queryId: submittedRequest.queryId,
        })}\n\n`,
      ),
    );
    streamController.close();
    await app.flush();
    expect(props(app).state.queryStatus).toBe("completed");
    expect(
      props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ).activeQueryId,
    ).toBeUndefined();

    delayedMeta.resolve(
      jsonResponse({
        version: 1,
        ...rows[0],
        lastOrdinal: 2,
        activeQueryId: submittedRequest.queryId,
      }),
    );
    await refresh;
    await app.flush();

    expect(props(app).state.queryStatus).toBe("completed");
    expect(
      props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ).activeQueryId,
    ).toBeUndefined();
    expect(await app.html()).not.toContain(" · En curso");
  });

  it("retains an unselected history-only terminal when refresh reuses an older META read", async () => {
    const delayedMeta = deferred();
    const firstList = deferred();
    let listReads = 0;
    const rows = [
      {
        conversationId: firstConversationId,
        label: "A finalizada",
        createdAt: "2026-10-27T12:00:00.000Z",
        updatedAt: "2026-10-27T12:30:00.000Z",
        lastOrdinal: 1,
        closed: false,
      },
      {
        conversationId: secondConversationId,
        label: "B reciente",
        createdAt: "2026-10-27T12:05:00.000Z",
        updatedAt: "2026-10-27T12:35:00.000Z",
        lastOrdinal: 1,
        closed: false,
      },
    ];
    const environment = createHistoryEnvironment({
      listHandler: () =>
        ++listReads === 1
          ? firstList.promise
          : jsonResponse({ version: 1, conversations: [rows[1]] }),
      metaHandler: () => delayedMeta.promise,
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          label: conversationId === firstConversationId ? "A finalizada" : "B reciente",
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, conversationId === firstConversationId ? firstQueryId : secondQueryId)],
        }),
      textHandler: turnText,
    });
    markChatJournalAdmitted(
      environment.config,
      environment.identity,
      {
        version: 2,
        operation: "start",
        conversationId: firstConversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
      },
      1,
    );
    writeChatSelection(environment.config, environment.identity, firstConversationId);

    const app = mount(environment);
    await app.flush();
    expect(
      environment.apiRequests.some(
        ({ path }) => path === `/chat/conversations/${firstConversationId}`,
      ),
    ).toBe(true);
    firstList.resolve(jsonResponse({ version: 1, conversations: rows }));
    await app.flush();
    expect(
      props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ).activeQueryId,
    ).toBeUndefined();

    expect(await props(app).onSelectConversation(secondConversationId)).toBe(true);
    await app.flush();
    const refresh = props(app).onRefreshHistory();
    await app.flush();
    delayedMeta.resolve(jsonResponse({ version: 1, ...rows[0], activeQueryId: firstQueryId }));
    await refresh;
    await app.flush();

    expect(props(app).state.history.selectedConversationId).toBe(secondConversationId);
    const retained = props(app).state.history.conversations.find(
      ({ conversationId }) => conversationId === firstConversationId,
    );
    expect(retained).toBeDefined();
    expect(retained.activeQueryId).toBeUndefined();
    expect(retained.lastOrdinal).toBe(1);
  });

  it.each([
    {
      name: "a later closed META snapshot",
      newerSummary: { lastOrdinal: 2, closed: true },
      expectedSummary: { lastOrdinal: 2, closed: true },
      expectedHistory: { closed: true, canContinue: false, throughOrdinal: 2 },
    },
    {
      name: "a later active META snapshot",
      newerSummary: { lastOrdinal: 2, closed: false, activeQueryId: secondQueryId },
      expectedSummary: { lastOrdinal: 2, closed: false, activeQueryId: secondQueryId },
      expectedHistory: { closed: false, canContinue: false, throughOrdinal: 2 },
    },
  ])(
    "does not let an older terminal recover overwrite $name",
    async ({ newerSummary, expectedSummary, expectedHistory }) => {
      let currentSummary = {
        conversationId: firstConversationId,
        label: "Hilo",
        lastOrdinal: 1,
        closed: false,
        activeQueryId: firstQueryId,
      };
      const recovery = deferred();
      const latestTurns = deferred();
      let holdLatestTurns = false;
      const currentTurnsPage = () => {
        const ordinal = currentSummary.lastOrdinal;
        const queryId = ordinal === 1 ? firstQueryId : secondQueryId;
        const active = Boolean(currentSummary.activeQueryId);
        return {
          version: 1,
          conversationId: firstConversationId,
          label: "Hilo",
          throughOrdinal: ordinal,
          closed: currentSummary.closed,
          canContinue: !currentSummary.closed && !active,
          turns: [
            {
              ...turn(ordinal, queryId),
              ...(active
                ? {
                    status: "in_progress",
                    answerManifest: { count: 0, complete: false },
                    cursor: 0,
                  }
                : {}),
            },
          ],
        };
      };
      const environment = createHistoryEnvironment({
        listHandler: () => jsonResponse({ version: 1, conversations: [currentSummary] }),
        turnsHandler: () =>
          holdLatestTurns && currentSummary.lastOrdinal > 1
            ? latestTurns.promise
            : jsonResponse(currentTurnsPage()),
        textHandler: turnText,
        recoverHandler: (recoverRequest) =>
          recoverRequest.queryId === firstQueryId
            ? recovery.promise
            : jsonResponse({
                version: 2,
                conversationId: firstConversationId,
                queryId: secondQueryId,
                ordinal: 2,
                status: "in_progress",
                question: "Seguimiento",
                answer: "",
                canContinue: false,
              }),
      });
      const request = {
        version: 2,
        operation: "start",
        conversationId: firstConversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
        text: "Pregunta original",
      };
      writePendingChatJournal(environment.config, environment.identity, request);
      markChatJournalAdmitted(environment.config, environment.identity, request, 1);
      writeChatSelection(environment.config, environment.identity, firstConversationId);

      const app = mount(environment);
      await app.flush();
      expect(
        environment.runtimeRequests.map(({ request: runtimeRequest }) => runtimeRequest.operation),
      ).toEqual(["recover"]);

      currentSummary = {
        conversationId: firstConversationId,
        label: "Hilo",
        ...newerSummary,
      };
      await props(app).onRefreshHistory();
      await app.flush();
      expect(
        props(app).state.history.conversations.find(
          ({ conversationId }) => conversationId === firstConversationId,
        ),
      ).toMatchObject(expectedSummary);

      const turnsReadCount = () =>
        environment.apiRequests.filter(
          ({ path }) => path === `/chat/conversations/${firstConversationId}/turns`,
        ).length;
      const turnsBeforeRecovery = turnsReadCount();
      holdLatestTurns = true;
      recovery.resolve(
        jsonResponse({
          version: 2,
          conversationId: firstConversationId,
          queryId: firstQueryId,
          ordinal: 1,
          status: "completed",
          question: "Pregunta original",
          answer: "Respuesta recuperada",
          canContinue: true,
        }),
      );
      await app.flush();

      expect(turnsReadCount()).toBeGreaterThan(turnsBeforeRecovery);
      const summary = props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      );
      expect(summary).toMatchObject(expectedSummary);
      expect(props(app).state.canContinue).toBe(false);
      latestTurns.resolve(jsonResponse(currentTurnsPage()));
      await app.flush();

      const refreshedSummary = props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      );
      expect(refreshedSummary).toMatchObject(expectedSummary);
      expect(props(app).state.ordinal).toBe(2);
      expect(props(app).state.history).toMatchObject(expectedHistory);
      const html = await app.html();
      if (expectedSummary.closed) {
        expect(html).toContain(" · Cerrada");
        expect(html).not.toContain(" · Abierta");
        expect(html).not.toContain("La respuesta está completa. Podés continuar este hilo.");
      } else {
        expect(html).toContain(" · En curso");
      }
    },
  );
});

describe("delayed active recovery snapshots preserve the current transcript", () => {
  it.each([
    {
      name: "the same active Q1",
      latestSummary: { lastOrdinal: 1, closed: false, activeQueryId: firstQueryId },
      latestStatus: "in_progress",
      latestQueryId: firstQueryId,
      latestOrdinal: 1,
      shouldReload: false,
    },
    {
      name: "closed Q1",
      latestSummary: { lastOrdinal: 1, closed: true },
      latestStatus: "failed",
      latestQueryId: firstQueryId,
      latestOrdinal: 1,
      shouldReload: true,
    },
    {
      name: "an open Q2",
      latestSummary: { lastOrdinal: 2, closed: false },
      latestStatus: "completed",
      latestQueryId: secondQueryId,
      latestOrdinal: 2,
      shouldReload: true,
    },
    {
      name: "an active Q2",
      latestSummary: { lastOrdinal: 2, closed: false, activeQueryId: secondQueryId },
      latestStatus: "in_progress",
      latestQueryId: secondQueryId,
      latestOrdinal: 2,
      shouldReload: true,
    },
    {
      name: "closed Q2",
      latestSummary: { lastOrdinal: 2, closed: true },
      latestStatus: "failed",
      latestQueryId: secondQueryId,
      latestOrdinal: 2,
      shouldReload: true,
    },
  ])(
    "keeps a delayed in-progress Q1 snapshot from replacing $name",
    async ({ latestSummary, latestStatus, latestQueryId, latestOrdinal, shouldReload }) => {
      let currentSummary = {
        conversationId: firstConversationId,
        label: "Hilo",
        lastOrdinal: 1,
        closed: false,
        activeQueryId: firstQueryId,
      };
      const recovery = deferred();
      const latestRecovery = deferred();
      let environment;
      const turnReads = () =>
        environment.apiRequests.filter(
          ({ path }) => path === `/chat/conversations/${firstConversationId}/turns`,
        ).length;
      const transcriptTurn = (ordinal) => {
        const queryId = ordinal === 1 ? firstQueryId : secondQueryId;
        const status =
          ordinal < currentSummary.lastOrdinal
            ? "completed"
            : currentSummary.activeQueryId
              ? "in_progress"
              : currentSummary.closed
                ? "failed"
                : "completed";
        return {
          ...turn(ordinal, queryId),
          status,
          answerManifest: {
            count: 1,
            complete: status === "completed",
          },
          cursor: 1,
          ...(status === "failed" ? { failure: { code: "runtime_failed" } } : {}),
        };
      };
      environment = createHistoryEnvironment({
        listHandler: () => jsonResponse({ version: 1, conversations: [currentSummary] }),
        turnsHandler: ({ conversationId }) =>
          jsonResponse({
            version: 1,
            conversationId,
            label: "Hilo",
            throughOrdinal: currentSummary.lastOrdinal,
            closed: currentSummary.closed,
            canContinue: !currentSummary.closed && !currentSummary.activeQueryId,
            turns: Array.from({ length: currentSummary.lastOrdinal }, (_, index) =>
              transcriptTurn(index + 1),
            ),
          }),
        textHandler: ({ conversationId, ordinal, url }) =>
          jsonResponse({
            version: 1,
            conversationId,
            ordinal,
            queryId: ordinal === 1 ? firstQueryId : secondQueryId,
            role: url.searchParams.get("role"),
            chunks: [{ index: 0, text: `TRANSCRIPT_Q${ordinal}_${url.searchParams.get("role")}` }],
            complete: true,
          }),
        recoverHandler: (request) => {
          if (request.queryId === firstQueryId) return recovery.promise;
          return latestRecovery.promise;
        },
      });
      markChatJournalAdmitted(
        environment.config,
        environment.identity,
        {
          version: 2,
          operation: "start",
          conversationId: firstConversationId,
          queryId: firstQueryId,
          baseOrdinal: 0,
        },
        1,
      );
      writeChatSelection(environment.config, environment.identity, firstConversationId);

      const app = mount(environment);
      await app.flush();
      expect(environment.runtimeRequests.map(({ request }) => request.queryId)).toContain(
        firstQueryId,
      );

      currentSummary = {
        conversationId: firstConversationId,
        label: "Hilo",
        ...latestSummary,
      };
      await props(app).onRefreshHistory();
      await app.flush();
      const turnReadsBeforeRecovery = turnReads();
      expect(
        props(app).state.history.conversations.find(
          ({ conversationId }) => conversationId === firstConversationId,
        ),
      ).toMatchObject(latestSummary);

      recovery.resolve(
        jsonResponse({
          version: 2,
          conversationId: firstConversationId,
          queryId: firstQueryId,
          ordinal: 1,
          status: "in_progress",
          question: "Pregunta recuperada Q1",
          answer: "Prefijo recuperado Q1",
          canContinue: false,
        }),
      );
      await app.flush();

      expect(turnReads() > turnReadsBeforeRecovery).toBe(shouldReload);
      const state = props(app).state;
      expect(state.history).toMatchObject({
        selectedConversationId: firstConversationId,
        throughOrdinal: latestOrdinal,
        closed: latestSummary.closed,
      });
      expect(state.history.turns.at(-1)).toMatchObject({
        ordinal: latestOrdinal,
        queryId: latestQueryId,
        status: latestStatus,
      });
      expect(
        state.history.conversations.find(
          ({ conversationId }) => conversationId === firstConversationId,
        ),
      ).toMatchObject(latestSummary);
      const html = await app.html();
      if (shouldReload) {
        expect(html).toContain(`TRANSCRIPT_Q${latestOrdinal}_user`);
        expect(html).not.toContain("Prefijo recuperado Q1");
      } else {
        expect(html).toContain("Pregunta recuperada Q1");
        expect(html).toContain("Prefijo recuperado Q1");
      }
      if (latestSummary.closed) {
        expect(html).toContain(" · Cerrada");
        expect(html).not.toContain(" · En curso");
      } else if (latestSummary.activeQueryId) {
        expect(html).toContain(" · En curso");
      }
      if (latestStatus === "in_progress" && latestQueryId === firstQueryId) {
        expect(state).toMatchObject({
          queryId: firstQueryId,
          ordinal: 1,
          queryStatus: "streaming",
          answer: "Prefijo recuperado Q1",
        });
        expect(state.history.turns.at(-1)).toMatchObject({
          question: "Pregunta recuperada Q1",
          answer: "Prefijo recuperado Q1",
        });
        expect(turnReads()).toBe(turnReadsBeforeRecovery);
      } else if (latestStatus === "in_progress") {
        expect(state.history.turns.at(-1)).toMatchObject({
          question: "TRANSCRIPT_Q2_user",
          answer: "TRANSCRIPT_Q2_assistant",
        });
        latestRecovery.resolve(
          jsonResponse({
            version: 2,
            conversationId: firstConversationId,
            queryId: secondQueryId,
            ordinal: 2,
            status: "in_progress",
            question: "Pregunta vigente Q2",
            answer: "Prefijo vigente Q2",
            canContinue: false,
          }),
        );
        await app.flush();
        expect(props(app).state).toMatchObject({
          queryId: secondQueryId,
          ordinal: 2,
          queryStatus: "streaming",
          answer: "Prefijo vigente Q2",
        });
      } else {
        expect(state.ordinal).toBe(latestOrdinal);
        expect(state.queryStatus).toBe(latestStatus);
        expect(state.history.turns.at(-1)).toMatchObject({
          question: `TRANSCRIPT_Q${latestOrdinal}_user`,
          answer: `TRANSCRIPT_Q${latestOrdinal}_assistant`,
        });
      }
    },
  );

  it("keeps a superseded active poll closed to submission when the transcript reload fails", async () => {
    let currentSummary = {
      conversationId: firstConversationId,
      label: "Q1 activa",
      lastOrdinal: 1,
      closed: false,
      activeQueryId: firstQueryId,
    };
    const recovery = deferred();
    let turnsReads = 0;
    let recoveryReads = 0;
    const environment = createHistoryEnvironment({
      listHandler: () => jsonResponse({ version: 1, conversations: [currentSummary] }),
      turnsHandler: ({ conversationId }) => {
        turnsReads += 1;
        if (turnsReads > 1) return jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503);
        return jsonResponse({
          version: 1,
          conversationId,
          label: currentSummary.label,
          throughOrdinal: 1,
          closed: false,
          canContinue: false,
          turns: [
            {
              ...turn(1, firstQueryId),
              status: "in_progress",
              answerManifest: { count: 1, complete: false },
              cursor: 1,
            },
          ],
        });
      },
      textHandler: turnText,
      recoverHandler: () => {
        recoveryReads += 1;
        return recovery.promise;
      },
    });
    markChatJournalAdmitted(
      environment.config,
      environment.identity,
      {
        version: 2,
        operation: "start",
        conversationId: firstConversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
      },
      1,
    );
    writeChatSelection(environment.config, environment.identity, firstConversationId);

    const app = mount(environment);
    await app.flush();
    expect(recoveryReads).toBe(1);

    currentSummary = {
      conversationId: firstConversationId,
      label: "Q2 cerrada",
      lastOrdinal: 2,
      closed: true,
    };
    await props(app).onRefreshHistory();
    await app.flush();

    recovery.resolve(
      jsonResponse({
        version: 2,
        conversationId: firstConversationId,
        queryId: firstQueryId,
        ordinal: 1,
        status: "in_progress",
        question: "Pregunta recuperada Q1",
        answer: "Prefijo recuperado Q1",
        canContinue: false,
      }),
    );
    await app.flush();

    expect(recoveryReads).toBe(1);
    expect(turnsReads).toBe(2);
    expect(
      readChatJournals(environment.config, environment.identity).has(firstConversationId),
    ).toBe(false);
    expect(props(app).state.history).toMatchObject({
      turnsStatus: "error",
      turnsError: "No pudimos abrir la conversación. Podés volver a intentarlo.",
    });
    expect(
      props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ),
    ).toMatchObject({ lastOrdinal: 2, closed: true });
    expect(props(app).onSubmit("No continuar")).toBe(false);
    const html = await app.html();
    expect(html).toContain(" · Cerrada");
    expect(html).not.toContain("Prefijo recuperado Q1");
    const sendButton = html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0];
    expect(sendButton).toContain("disabled");
  });
});

describe("delayed SSE terminals preserve newer conversation state", () => {
  function eventFrame(event) {
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  async function startDelayedTerminalScenario({ currentAtTerminal }) {
    const encoder = new TextEncoder();
    let remoteSummary;
    let originalRequest;
    let streamController;
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({ version: 1, conversations: remoteSummary ? [remoteSummary] : [] }),
      turnsHandler: ({ conversationId }) => {
        const ordinal = remoteSummary?.lastOrdinal ?? 1;
        const queryId = ordinal > 1 ? secondQueryId : firstQueryId;
        const active = Boolean(remoteSummary?.activeQueryId);
        const failedAndClosed = ordinal > 1 && Boolean(remoteSummary?.closed);
        return jsonResponse({
          version: 1,
          conversationId,
          label: "Hilo",
          throughOrdinal: ordinal,
          closed: remoteSummary?.closed ?? false,
          canContinue: !remoteSummary?.closed && !active,
          turns: [
            {
              ...turn(ordinal, queryId),
              ...(active
                ? {
                    status: "in_progress",
                    answerManifest: { count: 0, complete: false },
                    cursor: 0,
                  }
                : failedAndClosed
                  ? {
                      status: "failed",
                      answerManifest: { count: 1, complete: false },
                      cursor: 1,
                      failure: { code: "runtime_failed" },
                    }
                  : {}),
            },
          ],
        });
      },
      textHandler: turnText,
      runtimeHandler: (request) => {
        originalRequest = request;
        return new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
              controller.enqueue(
                encoder.encode(
                  eventFrame({
                    type: "accepted",
                    conversationId: request.conversationId,
                    queryId: request.queryId,
                    ordinal: 1,
                  }),
                ),
              );
              controller.enqueue(
                encoder.encode(
                  eventFrame({
                    type: "text",
                    queryId: request.queryId,
                    index: 0,
                    text: "Respuesta Q1",
                  }),
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const app = mount(environment);
    await app.flush();

    expect(props(app).onSubmit("Pregunta Q1")).toBe(true);
    await app.flush();
    expect(originalRequest).toMatchObject({ operation: "start", baseOrdinal: 0 });
    expect(props(app).state).toMatchObject({
      ordinal: 1,
      queryStatus: "streaming",
      history: {
        turns: [
          {
            ordinal: 1,
            queryId: originalRequest.queryId,
            status: "in_progress",
            answer: "Respuesta Q1",
          },
        ],
      },
    });

    remoteSummary = currentAtTerminal(originalRequest.conversationId, originalRequest.queryId);
    await props(app).onRefreshHistory();
    await app.flush();
    expect(
      props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === originalRequest.conversationId,
      ),
    ).toMatchObject(remoteSummary);

    return {
      app,
      environment,
      originalRequest,
      streamController,
      turnsReadCount: () =>
        environment.apiRequests.filter(
          ({ path }) => path === `/chat/conversations/${originalRequest.conversationId}/turns`,
        ).length,
      emitTerminal: async (event) => {
        streamController.enqueue(encoder.encode(eventFrame(event)));
        await app.flush();
      },
      closeStream: async () => {
        streamController.close();
        await app.flush();
      },
    };
  }

  it.each([
    {
      name: "completed SSE",
      terminalEvent: (queryId) => ({ type: "completed", queryId }),
    },
    {
      name: "failed but continuable SSE",
      terminalEvent: (queryId) => ({
        type: "failed",
        code: "provider_error",
        message: "No se pudo completar.",
        recordStatus: "failed",
        queryId,
        canContinue: true,
      }),
    },
  ])("reloads latest history before applying a stale $name terminal", async ({ terminalEvent }) => {
    const scenario = await startDelayedTerminalScenario({
      currentAtTerminal: (conversationId) => ({
        conversationId,
        label: "Pregunta Q1",
        lastOrdinal: 2,
        closed: true,
      }),
    });
    const turnsBeforeTerminal = scenario.turnsReadCount();

    await scenario.emitTerminal(terminalEvent(scenario.originalRequest.queryId));
    expect(props(scenario.app).state.canContinue).toBe(false);
    expect(
      props(scenario.app).state.history.conversations.find(
        ({ conversationId }) => conversationId === scenario.originalRequest.conversationId,
      ),
    ).toMatchObject({ lastOrdinal: 2, closed: true });
    expect(await scenario.app.html()).not.toContain(
      "La respuesta está completa. Podés continuar este hilo.",
    );

    await scenario.closeStream();

    expect(scenario.turnsReadCount()).toBeGreaterThan(turnsBeforeTerminal);
    expect(props(scenario.app).state).toMatchObject({
      ordinal: 2,
      queryStatus: "failed",
      canContinue: false,
      history: {
        selectedConversationId: scenario.originalRequest.conversationId,
        turnsStatus: "ready",
        throughOrdinal: 2,
        closed: true,
        canContinue: false,
        turns: [
          {
            ordinal: 2,
            queryId: secondQueryId,
            status: "failed",
            question: "ORIGINAL_TEXT_2",
            answer: "ORIGINAL_TEXT_2",
            failure: { code: "runtime_failed" },
          },
        ],
      },
    });
    expect(
      props(scenario.app).state.history.conversations.find(
        ({ conversationId }) => conversationId === scenario.originalRequest.conversationId,
      ),
    ).toMatchObject({ lastOrdinal: 2, closed: true });
    const requestsBeforeRejectedFollowUp = scenario.environment.runtimeRequests.length;
    expect(props(scenario.app).onSubmit("No continuar")).toBe(false);
    expect(scenario.environment.runtimeRequests).toHaveLength(requestsBeforeRejectedFollowUp);
  });

  it("reloads newer closed history for a stale failed recovery without a snapshot version", async () => {
    let currentSummary = {
      conversationId: firstConversationId,
      label: "Hilo",
      lastOrdinal: 1,
      closed: false,
      activeQueryId: firstQueryId,
    };
    const recovery = deferred();
    const environment = createHistoryEnvironment({
      listHandler: () => jsonResponse({ version: 1, conversations: [currentSummary] }),
      turnsHandler: ({ conversationId }) => {
        const ordinal = currentSummary.lastOrdinal;
        const queryId = ordinal === 1 ? firstQueryId : secondQueryId;
        const failedAndClosed = ordinal === 2 && currentSummary.closed;
        return jsonResponse({
          version: 1,
          conversationId,
          label: "Hilo",
          throughOrdinal: ordinal,
          closed: currentSummary.closed,
          canContinue: !currentSummary.closed && !currentSummary.activeQueryId,
          turns: [
            {
              ...turn(ordinal, queryId),
              ...(failedAndClosed
                ? {
                    status: "failed",
                    answerManifest: { count: 1, complete: false },
                    cursor: 1,
                    failure: { code: "runtime_failed" },
                  }
                : {
                    status: "in_progress",
                    answerManifest: { count: 0, complete: false },
                    cursor: 0,
                  }),
            },
          ],
        });
      },
      textHandler: turnText,
      recoverHandler: () => recovery.promise,
    });
    markChatJournalAdmitted(
      environment.config,
      environment.identity,
      {
        version: 2,
        operation: "start",
        conversationId: firstConversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
      },
      1,
    );
    writeChatSelection(environment.config, environment.identity, firstConversationId);

    const app = mount(environment);
    await app.flush();
    expect(environment.runtimeRequests.map(({ request }) => request.operation)).toContain(
      "recover",
    );

    currentSummary = {
      conversationId: firstConversationId,
      label: "Hilo",
      lastOrdinal: 2,
      closed: true,
    };
    await props(app).onRefreshHistory();
    await app.flush();
    const turnsBeforeTerminal = environment.apiRequests.filter(
      ({ path }) => path === `/chat/conversations/${firstConversationId}/turns`,
    ).length;

    recovery.resolve(
      jsonResponse({
        type: "failed",
        code: "provider_error",
        message: "No se pudo completar.",
        recordStatus: "failed",
        queryId: firstQueryId,
        canContinue: true,
      }),
    );
    await app.flush();

    expect(
      environment.apiRequests.filter(
        ({ path }) => path === `/chat/conversations/${firstConversationId}/turns`,
      ).length,
    ).toBeGreaterThan(turnsBeforeTerminal);
    expect(props(app).state).toMatchObject({
      ordinal: 2,
      queryStatus: "failed",
      canContinue: false,
      history: {
        selectedConversationId: firstConversationId,
        turnsStatus: "ready",
        throughOrdinal: 2,
        closed: true,
        canContinue: false,
        turns: [
          {
            ordinal: 2,
            queryId: secondQueryId,
            status: "failed",
            question: "ORIGINAL_TEXT_2",
            answer: "ORIGINAL_TEXT_2",
            failure: { code: "runtime_failed" },
          },
        ],
      },
    });
    expect(
      props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ),
    ).toMatchObject({ lastOrdinal: 2, closed: true });
    expect(await app.html()).not.toContain("Podés continuar este hilo.");
  });

  it("keeps a current completed SSE terminal continuable without a history reload", async () => {
    const scenario = await startDelayedTerminalScenario({
      currentAtTerminal: (conversationId, queryId) => ({
        conversationId,
        label: "Pregunta Q1",
        lastOrdinal: 1,
        closed: false,
        activeQueryId: queryId,
      }),
    });
    const turnsBeforeTerminal = scenario.turnsReadCount();

    await scenario.emitTerminal({ type: "completed", queryId: scenario.originalRequest.queryId });
    expect(props(scenario.app).state).toMatchObject({
      ordinal: 1,
      queryStatus: "completed",
      canContinue: true,
    });
    await scenario.closeStream();

    expect(scenario.turnsReadCount()).toBe(turnsBeforeTerminal);
    expect(props(scenario.app).state).toMatchObject({
      ordinal: 1,
      queryStatus: "completed",
      canContinue: true,
    });
    expect(
      props(scenario.app).state.history.conversations.find(
        ({ conversationId }) => conversationId === scenario.originalRequest.conversationId,
      ),
    ).toMatchObject({ lastOrdinal: 1, closed: false });
    expect(await scenario.app.html()).toContain(
      "La respuesta está completa. Podés continuar este hilo.",
    );
  });
});

describe("history removal state transitions", () => {
  async function mountRemovalDom(hideHandler, { listHandler, metaHandler } = {}) {
    const environment = createHistoryEnvironment({
      listHandler:
        listHandler ??
        (() =>
          jsonResponse({
            version: 1,
            conversations: [
              {
                conversationId: firstConversationId,
                label: "Conversación A",
                lastOrdinal: 1,
                closed: false,
              },
              {
                conversationId: secondConversationId,
                label: "Conversación B",
                lastOrdinal: 1,
                closed: false,
              },
            ],
          })),
      metaHandler,
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, conversationId === firstConversationId ? firstQueryId : secondQueryId)],
        }),
      textHandler: turnText,
      hideHandler,
    });
    const domState = await createPhase8Dom();
    domStates.push(domState);
    const app = await mountPhase8AccountApp(environment, AccountApp, domState);
    apps.push(app);
    const render = () => renderPhase8AccountApp(app, domState);
    return { app, domState, environment, render };
  }

  it.each(["button", "Escape"])(
    "cancels before the POST with %s and restores focus to the enabled trigger",
    async (method) => {
      const hideHandler = vi.fn(() => jsonResponse({ version: 1 }));
      const { app, domState, environment, render } = await mountRemovalDom(hideHandler);
      const trigger = hideButtonFor(domState.document, "Conversación A");

      await clickPhase8(trigger, app, domState);
      const row = conversationRow(domState.document, "Conversación A");
      if (method === "button") {
        await clickPhase8(buttonByText(domState.document, "Cancelar"), app, domState);
      } else {
        const confirmation = row.querySelector(".chat-history__remove-confirmation");
        await act(async () => {
          confirmation.dispatchEvent(
            new domState.dom.window.KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
            }),
          );
        });
        await render();
      }

      expect(hideHandler).not.toHaveBeenCalled();
      expect(
        environment.apiRequests.filter(({ method: requestMethod }) => requestMethod === "POST"),
      ).toHaveLength(0);
      expect(trigger.disabled).toBe(false);
      expect(domState.document.activeElement).toBe(trigger);
      expect(
        conversationRow(domState.document, "Conversación A").querySelector(
          ".chat-history__remove-confirmation",
        ),
      ).toBeNull();
    },
  );

  it("keeps the pending hide visible and focused while Escape cannot dismiss it or block another thread", async () => {
    const pendingHide = deferred();
    const hideHandler = vi.fn(() => pendingHide.promise);
    const { app, domState, render } = await mountRemovalDom(hideHandler);

    await clickPhase8(hideButtonFor(domState.document, "Conversación A"), app, domState);
    const rowA = conversationRow(domState.document, "Conversación A");
    await clickPhase8(rowA.querySelector(".chat-history__remove-confirm"), app, domState);

    const pendingStatus = statusText(domState.document, "Quitando…");
    expect(pendingStatus).not.toBeNull();
    expect(domState.document.activeElement).toBe(pendingStatus);
    expect(buttonByText(domState.document, "Cancelar")).toBeUndefined();
    expect(hideButtonFor(domState.document, "Conversación A").disabled).toBe(true);
    expect(props(app).state.history.removal).toMatchObject({
      conversationId: firstConversationId,
      status: "hiding",
    });

    await act(async () => {
      pendingStatus.dispatchEvent(
        new domState.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await render();
    expect(statusText(domState.document, "Quitando…")).toBe(pendingStatus);
    expect(domState.document.activeElement).toBe(pendingStatus);
    expect(props(app).state.history.removal.status).toBe("hiding");
    expect(hideHandler).toHaveBeenCalledTimes(1);

    const rowB = conversationRow(domState.document, "Conversación B");
    await clickPhase8(rowB.querySelector(".chat-history__item"), app, domState);
    expect(props(app).state.history.selectedConversationId).toBe(secondConversationId);
    expect(statusText(domState.document, "Quitando…")).not.toBeNull();

    pendingHide.resolve(
      jsonResponse({
        version: 1,
        conversationId: firstConversationId,
        hiddenAt: "2026-10-27T14:00:00.000Z",
      }),
    );
    await render();
    expect(props(app).state.history.removal).toBeUndefined();
  });

  it.each(["success", "transport error"])(
    "keeps B's open confirmation and focus when A's POST returns late with %s after META hid A",
    async (lateAOutcome) => {
      const pendingHide = deferred();
      const rows = [
        {
          conversationId: firstConversationId,
          label: "Conversación A",
          lastOrdinal: 1,
          closed: false,
        },
        {
          conversationId: secondConversationId,
          label: "Conversación B",
          lastOrdinal: 1,
          closed: false,
        },
      ];
      let listAttempt = 0;
      const hideHandler = vi.fn(() => pendingHide.promise);
      const { app, domState, environment, render } = await mountRemovalDom(hideHandler, {
        listHandler: () =>
          jsonResponse({
            version: 1,
            conversations: listAttempt++ === 0 ? rows : [rows[1]],
          }),
        metaHandler: ({ conversationId }) =>
          conversationId === firstConversationId
            ? jsonResponse({ code: "CONVERSATION_HIDDEN" }, 404)
            : jsonResponse({
                version: 1,
                ...rows[1],
              }),
      });

      await clickPhase8(hideButtonFor(domState.document, "Conversación A"), app, domState);
      await clickPhase8(
        conversationRow(domState.document, "Conversación A").querySelector(
          ".chat-history__remove-confirm",
        ),
        app,
        domState,
      );
      expect(hideHandler).toHaveBeenCalledTimes(1);
      expect(statusText(domState.document, "Quitando…")).not.toBeNull();

      await clickPhase8(
        domState.document.querySelector('[aria-label="Actualizar historial"]'),
        app,
        domState,
      );
      expect(conversationRow(domState.document, "Conversación A")).toBeUndefined();
      expect(conversationRow(domState.document, "Conversación B")).toBeDefined();
      expect(hideButtonFor(domState.document, "Conversación B").disabled).toBe(false);
      expect(statusText(domState.document, "Quitando…")).toBeUndefined();

      await clickPhase8(hideButtonFor(domState.document, "Conversación B"), app, domState);
      const confirmationB = conversationRow(domState.document, "Conversación B").querySelector(
        ".chat-history__remove-confirmation",
      );
      const cancelB = buttonByText(domState.document, "Cancelar");
      expect(confirmationB).not.toBeNull();
      expect(domState.document.activeElement).toBe(cancelB);
      expect(
        environment.apiRequests.filter(
          ({ method, path }) => method === "POST" && path.endsWith("/hide"),
        ),
      ).toHaveLength(1);

      if (lateAOutcome === "success") {
        pendingHide.resolve(
          jsonResponse({
            version: 1,
            conversationId: firstConversationId,
            hiddenAt: "2026-10-27T14:00:00.000Z",
          }),
        );
      } else {
        pendingHide.reject(new TypeError("connection closed after the hide was committed"));
      }
      await render();

      expect(conversationRow(domState.document, "Conversación A")).toBeUndefined();
      expect(
        conversationRow(domState.document, "Conversación B").querySelector(
          ".chat-history__remove-confirmation",
        ),
      ).toBe(confirmationB);
      expect(domState.document.activeElement).toBe(cancelB);
      expect(statusText(domState.document, "Conversación quitada del historial.")).toBeUndefined();
      expect(domState.document.querySelector('[role="alert"]')).toBeNull();
      expect(hideHandler).toHaveBeenCalledTimes(1);

      await clickPhase8(cancelB, app, domState);
      expect(domState.document.activeElement).toBe(
        hideButtonFor(domState.document, "Conversación B"),
      );
      expect(hideHandler).toHaveBeenCalledTimes(1);
    },
  );

  it("reopens an uncertain removal for retry and focuses the next row after confirmation", async () => {
    let attempts = 0;
    const { app, domState, render } = await mountRemovalDom(() => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503)
        : jsonResponse({
            version: 1,
            conversationId: firstConversationId,
            hiddenAt: "2026-10-27T14:00:00.000Z",
          });
    });

    await clickPhase8(hideButtonFor(domState.document, "Conversación A"), app, domState);
    let rowA = conversationRow(domState.document, "Conversación A");
    await clickPhase8(rowA.querySelector(".chat-history__remove-confirm"), app, domState);

    rowA = conversationRow(domState.document, "Conversación A");
    expect(props(app).state.history.removal).toMatchObject({
      conversationId: firstConversationId,
      status: "unconfirmed",
    });
    expect(rowA.querySelector('[role="alert"]')?.textContent).toContain("No pudimos confirmar");
    expect(domState.document.activeElement).toBe(buttonByText(domState.document, "Cancelar"));

    await clickPhase8(rowA.querySelector(".chat-history__remove-confirm"), app, domState);
    await render();
    expect(attempts).toBe(2);
    expect(conversationRow(domState.document, "Conversación A")).toBeUndefined();
    const rowB = conversationRow(domState.document, "Conversación B");
    expect(domState.document.activeElement).toBe(rowB.querySelector(".chat-history__item"));
  });

  it("keeps a known pre-admission rejection out of the pending disclosure after reselection", async () => {
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Conversación A",
              lastOrdinal: 1,
              closed: false,
            },
            {
              conversationId: secondConversationId,
              label: "Conversación B",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, conversationId === firstConversationId ? firstQueryId : secondQueryId)],
        }),
      textHandler: turnText,
      runtimeHandler: (request) => {
        const encoder = new TextEncoder();
        return new Response(
          encoder.encode(
            `event: failed\ndata: ${JSON.stringify({
              type: "failed",
              code: "context_unavailable",
              message: "No se pudo preparar el contexto.",
              recordStatus: "not_admitted",
              queryId: request.queryId,
              canContinue: true,
            })}\n\n`,
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const app = mount(environment);
    await app.flush();
    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    expect(props(app).onSubmit("El contexto no está disponible")).toBe(true);
    await app.flush();
    const request = environment.runtimeRequests[0].request;
    expect(props(app).state.queryStatus).toBe("rejected");
    expect(
      props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ).pendingQueryId,
    ).toBeUndefined();
    expect(
      readChatJournals(environment.config, environment.identity).get(firstConversationId),
    ).toMatchObject({
      admitted: false,
      request: { queryId: request.queryId },
    });

    expect(await props(app).onSelectConversation(secondConversationId)).toBe(true);
    await app.flush();
    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    expect(
      props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ).pendingQueryId,
    ).toBeUndefined();
  });

  it("does not disclose an admitted journal as active after META confirms its terminal ordinal", async () => {
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Conversación A",
              lastOrdinal: 1,
              closed: false,
            },
            {
              conversationId: secondConversationId,
              label: "Conversación B",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, conversationId === firstConversationId ? firstQueryId : secondQueryId)],
        }),
      textHandler: turnText,
    });
    markChatJournalAdmitted(
      environment.config,
      environment.identity,
      {
        version: 2,
        operation: "start",
        conversationId: firstConversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
      },
      1,
    );
    writeChatSelection(environment.config, environment.identity, secondConversationId);

    const app = mount(environment);
    await app.flush();

    expect(props(app).state.history.selectedConversationId).toBe(secondConversationId);
    expect(
      props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ),
    ).toMatchObject({ lastOrdinal: 1, closed: false });
    expect(
      props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ).pendingQueryId,
    ).toBeUndefined();
  });

  it("keeps an unconfirmed follow-up disclosure with its conversation through mobile selection changes", async () => {
    const domState = await createPhase8Dom();
    domStates.push(domState);
    const fixture = new ChatBrowserFixture();
    fixture.seedHistoryDemo();
    let initialActiveStreams;
    let holdRuntime = false;
    let releaseRuntime;
    const runtimeGate = new Promise((resolve) => {
      releaseRuntime = resolve;
    });
    let firstHide = true;
    const fixtureFetch = fixture.fetch.bind(fixture);
    vi.stubGlobal("fetch", async (input, init = {}) => {
      const url = String(input);
      if (firstHide && init.method === "POST" && url.endsWith("/hide")) {
        firstHide = false;
        return jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503);
      }
      const response = await fixtureFetch(input, init);
      if (holdRuntime && url.includes("bedrock-agentcore")) await runtimeGate;
      return response;
    });
    const flush = async () => {
      await act(async () => {
        for (let attempt = 0; attempt < 45; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });
    };
    const click = async (element) => {
      expect(element).not.toBeNull();
      await act(async () => {
        element.click();
        await Promise.resolve();
      });
      await flush();
    };
    const findRow = (label) =>
      [...domState.document.querySelectorAll(".chat-history__conversation")].find((row) =>
        row.textContent?.includes(label),
      );
    const targetLabel = "conversación 3";
    const otherLabel = "conversación 4";

    try {
      await act(async () => {
        domState.root.render(
          React.createElement(RealAccountApp, {
            route: { kind: "chat" },
            projectName: siteConfig.projectName,
            profileConfig: siteConfig.profile,
            getSession: () => fixture.session,
          }),
        );
      });
      await flush();
      expect(
        domState.document.querySelectorAll(".chat-history__conversation").length,
      ).toBeGreaterThan(2);
      initialActiveStreams = fixture.snapshot("#/chat").admittedStreams;

      await click(findRow(targetLabel).querySelector(".chat-history__item"));
      const targetId = "70000000-0000-4000-8000-000000000003";
      holdRuntime = true;
      const textarea = domState.document.querySelector("textarea");
      const valueSetter = Object.getOwnPropertyDescriptor(
        domState.dom.window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      valueSetter.call(textarea, "Seguimiento antes de recibir el ACK");
      textarea.dispatchEvent(new domState.dom.window.Event("input", { bubbles: true }));
      textarea.dispatchEvent(new domState.dom.window.Event("change", { bubbles: true }));
      await flush();
      await act(async () => {
        domState.document
          .querySelector(".chat-form")
          .dispatchEvent(
            new domState.dom.window.Event("submit", { bubbles: true, cancelable: true }),
          );
      });
      await flush();
      for (
        let attempt = 0;
        attempt < 20 && fixture.snapshot("#/chat").admittedStreams <= initialActiveStreams;
        attempt += 1
      ) {
        await flush();
      }
      expect(fixture.snapshot("#/chat").admittedStreams).toBe(initialActiveStreams + 1);

      await click(domState.document.querySelector(".chat-mobile-history-back"));
      await click(findRow(otherLabel).querySelector(".chat-history__item"));
      await click(domState.document.querySelector(".chat-mobile-history-back"));
      expect(findRow(targetLabel).querySelector("[aria-current]")).toBeNull();
      expect(findRow(otherLabel).querySelector(".chat-history__meta").textContent).not.toContain(
        "En curso",
      );

      await click(findRow(targetLabel).querySelector(".chat-history__remove"));
      let confirmation = findRow(targetLabel).querySelector(".chat-history__remove-confirmation");
      expect(confirmation.textContent).toContain("El pedido en curso puede terminar de procesarse");
      await click(confirmation.querySelector(".chat-history__remove-confirm"));
      confirmation = findRow(targetLabel).querySelector(".chat-history__remove-confirmation");
      expect(confirmation.textContent).toContain("El pedido en curso puede terminar de procesarse");
      expect(confirmation.textContent).toContain("No pudimos confirmar");

      await click(confirmation.querySelector('button[type="button"]'));
      expect(findRow(targetLabel).querySelector(".chat-history__remove-confirmation")).toBeNull();
      await click(findRow(targetLabel).querySelector(".chat-history__remove"));
      confirmation = findRow(targetLabel).querySelector(".chat-history__remove-confirmation");
      await act(async () => {
        confirmation.dispatchEvent(
          new domState.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      await flush();
      expect(findRow(targetLabel).querySelector(".chat-history__remove-confirmation")).toBeNull();

      fixture.finishStream("complete");
      releaseRuntime();
      await flush();
      await click(findRow(targetLabel).querySelector(".chat-history__item"));
      await flush();
      await click(domState.document.querySelector(".chat-mobile-history-back"));
      await click(findRow(targetLabel).querySelector(".chat-history__remove"));
      confirmation = findRow(targetLabel).querySelector(".chat-history__remove-confirmation");
      expect(confirmation.textContent).not.toContain(
        "El pedido en curso puede terminar de procesarse",
      );
      await click(confirmation.querySelector('button[type="button"]'));
      expect(firstHide).toBe(false);
      expect(
        fixture
          .snapshot("#/chat")
          .conversations.find(({ conversationId }) => conversationId === targetId).hiddenAt,
      ).toBeUndefined();
    } finally {
      releaseRuntime();
    }
  });

  it("disables the composer only for the selected conversation being removed", async () => {
    const pendingHide = deferred();
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Conversación A",
              lastOrdinal: 1,
              closed: false,
            },
            {
              conversationId: secondConversationId,
              label: "Conversación B",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, conversationId === firstConversationId ? firstQueryId : secondQueryId)],
        }),
      textHandler: turnText,
      hideHandler: () => pendingHide.promise,
    });
    const domState = await createPhase8Dom();
    domStates.push(domState);
    const app = await mountPhase8AccountApp(environment, AccountApp, domState);
    apps.push(app);
    const render = () => renderPhase8AccountApp(app, domState);

    await render();
    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await render();
    props(app).onDraftChange("seguimiento para A");
    await render();

    const hide = props(app).onHideConversation(firstConversationId);
    await render();
    expect(props(app).state.history.removal).toMatchObject({
      conversationId: firstConversationId,
      status: "hiding",
    });
    expect(buttonByText(domState.document, "Enviar").disabled).toBe(true);

    pendingHide.reject(new TypeError("connection lost after the server may have committed"));
    expect(await hide).toBe(false);
    await render();
    expect(props(app).state.history.removal).toMatchObject({
      conversationId: firstConversationId,
      status: "unconfirmed",
    });
    expect(buttonByText(domState.document, "Enviar").disabled).toBe(true);

    expect(await props(app).onSelectConversation(secondConversationId)).toBe(true);
    await render();
    props(app).onDraftChange("seguimiento para B");
    await render();
    expect(props(app).state.history).toMatchObject({
      selectedConversationId: secondConversationId,
      removal: { conversationId: firstConversationId, status: "unconfirmed" },
    });
    expect(buttonByText(domState.document, "Enviar").disabled).toBe(false);
  });

  it.each([
    ["rejected", "hiding"],
    ["rejected", "unconfirmed"],
    ["unconfirmed", "hiding"],
    ["unconfirmed", "unconfirmed"],
  ])(
    "disables same-thread retry for %s query while removal is %s",
    async (queryStatus, removalStatus) => {
      const domState = await createPhase8Dom();
      domStates.push(domState);
      const state = {
        profileStatus: "complete",
        queryStatus,
        question: "Reintentar esta consulta",
        draft: "Reintentar esta consulta",
        ordinal: 1,
        canContinue: true,
        canRetry: true,
        history: {
          status: "ready",
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Conversación A",
              lastOrdinal: 1,
              closed: false,
            },
          ],
          nextCursor: null,
          loadingMore: false,
          selectedConversationId: firstConversationId,
          turnsStatus: "ready",
          turns: [],
          turnsNextCursor: null,
          refreshRequired: false,
          removal: { conversationId: firstConversationId, status: removalStatus },
        },
      };

      await act(async () => {
        domState.root.render(
          React.createElement(ChatScreen, {
            state,
            onSubmit: vi.fn(() => false),
            onSignOut: vi.fn(),
            onRetryProfile: vi.fn(),
            onReset: vi.fn(),
            onCopy: vi.fn(),
          }),
        );
      });

      expect(buttonByText(domState.document, "Reintentar el mismo envío").disabled).toBe(true);
    },
  );

  it("preserves the selected conversation's draft disclosure after a history refresh", async () => {
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Conversación A",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1)],
        }),
      textHandler: turnText,
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    props(app).onDraftChange("borrador que se descartará");
    await app.flush();
    expect(
      props(app).state.history.conversations.find(
        (conversation) => conversation.conversationId === firstConversationId,
      ).hasDraft,
    ).toBe(true);

    await props(app).onRefreshHistory();
    await app.flush();

    expect(
      props(app).state.history.conversations.find(
        (conversation) => conversation.conversationId === firstConversationId,
      ),
    ).toMatchObject({ conversationId: firstConversationId, hasDraft: true });
  });

  it("restores the current selection after hiding another conversation whose open is pending", async () => {
    const lateOpen = deferred();
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Conversación A",
              lastOrdinal: 1,
              closed: false,
            },
            {
              conversationId: secondConversationId,
              label: "Conversación B",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) =>
        conversationId === secondConversationId
          ? lateOpen.promise
          : jsonResponse({
              version: 1,
              conversationId,
              label: "Conversación A",
              throughOrdinal: 1,
              closed: false,
              canContinue: true,
              turns: [turn(1)],
              nextCursor: "older-A",
            }),
      textHandler: turnText,
      hideHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          hiddenAt: "2026-10-27T13:45:00.000Z",
        }),
      runtimeHandler: (request) => streamResponse(request),
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    props(app).onDraftChange("seguir trabajando en A");
    await app.flush();
    const openingB = props(app).onSelectConversation(secondConversationId);
    await app.flush();
    expect(props(app).state.history).toMatchObject({
      selectedConversationId: firstConversationId,
      openingConversationId: secondConversationId,
      turnsStatus: "loading",
    });

    expect(await props(app).onHideConversation(secondConversationId)).toBe(true);
    await app.flush();
    lateOpen.resolve(
      jsonResponse({
        version: 1,
        conversationId: secondConversationId,
        throughOrdinal: 1,
        closed: false,
        canContinue: true,
        turns: [turn(1, secondQueryId)],
      }),
    );
    expect(await openingB).toBe(false);
    await app.flush();

    expect(props(app).state.history).toMatchObject({
      selectedConversationId: firstConversationId,
      turnsStatus: "ready",
      turnsNextCursor: "older-A",
      turns: [{ ordinal: 1, question: "ORIGINAL_TEXT_1" }],
    });
    expect(props(app).state.history.openingConversationId).toBeUndefined();
    expect(props(app).state.draft).toBe("seguir trabajando en A");
    expect(
      props(app).state.history.conversations.map((conversation) => conversation.conversationId),
    ).toEqual([firstConversationId]);
    expect(props(app).onSubmit("seguimiento en A")).toBe(true);
    await app.flush();
    expect(environment.runtimeRequests.at(-1).request).toMatchObject({
      operation: "message",
      conversationId: firstConversationId,
      baseOrdinal: 1,
    });
  });
});

describe("explicit replay preserves authoritative activity", () => {
  it.each(["start", "message"])(
    "does not move an already admitted %s when the Runtime returns its JSON snapshot",
    async (operation) => {
      const body = "Original uncertain request";
      const ordinal = operation === "start" ? 1 : 2;
      const selectedUpdatedAt = new Date(Date.now() - 20 * 60_000).toISOString();
      const recentUpdatedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      const activeTurn = {
        ...turn(ordinal, firstQueryId),
        status: "in_progress",
        answerManifest: { count: 1, complete: false },
      };
      const environment = createHistoryEnvironment({
        listHandler: () =>
          jsonResponse({
            version: 1,
            conversations: [
              {
                conversationId: secondConversationId,
                label: "Actividad reciente",
                updatedAt: recentUpdatedAt,
                lastOrdinal: 1,
                closed: false,
              },
              {
                conversationId: firstConversationId,
                label: "Actividad antigua",
                updatedAt: selectedUpdatedAt,
                lastOrdinal: ordinal,
                closed: false,
                activeQueryId: firstQueryId,
              },
            ],
          }),
        turnsHandler: ({ conversationId }) =>
          jsonResponse({
            version: 1,
            conversationId,
            label: "Actividad antigua",
            updatedAt: selectedUpdatedAt,
            throughOrdinal: ordinal,
            closed: false,
            canContinue: false,
            turns: [activeTurn],
          }),
        textHandler: ({ conversationId, ordinal: turnOrdinal, url }) =>
          jsonResponse({
            version: 1,
            conversationId,
            ordinal: turnOrdinal,
            queryId: firstQueryId,
            role: url.searchParams.get("role"),
            chunks: [
              {
                index: 0,
                text:
                  url.searchParams.get("role") === "user"
                    ? body
                    : "Prefijo durable de la respuesta",
              },
            ],
            complete: true,
          }),
        recoverHandler: () => jsonResponse({ code: "TEMPORARY_UNAVAILABLE" }, 503),
        runtimeHandler: (request) =>
          jsonResponse({
            version: 2,
            conversationId: request.conversationId,
            queryId: request.queryId,
            ordinal,
            status: "in_progress",
            question: body,
            answer: "Prefijo durable de la respuesta",
            canContinue: false,
          }),
      });
      const request = {
        version: 2,
        operation,
        conversationId: firstConversationId,
        queryId: firstQueryId,
        baseOrdinal: ordinal - 1,
        text: body,
      };
      writeChatSelection(environment.config, environment.identity, firstConversationId);
      writePendingChatJournal(environment.config, environment.identity, request);

      const app = mount(environment);
      await app.flush();
      expect(props(app).state).toMatchObject({ queryStatus: "unconfirmed", canRetry: true });
      expect(
        props(app).state.history.conversations.map(({ conversationId }) => conversationId),
      ).toEqual([secondConversationId, firstConversationId]);

      expect(props(app).onSubmit(body)).toBe(true);
      await app.flush();

      expect(props(app).state.queryStatus).toBe("streaming");
      expect(
        props(app).state.history.conversations.map(({ conversationId }) => conversationId),
      ).toEqual([secondConversationId, firstConversationId]);
      expect(props(app).state.history.conversations[1]).toMatchObject({
        conversationId: firstConversationId,
        updatedAt: selectedUpdatedAt,
      });
      expect(environment.runtimeRequests.map(({ request: sent }) => sent.operation)).toContain(
        operation,
      );
    },
  );
});

function createFixtureStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(String(key)) ?? null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
    clear() {
      values.clear();
    },
  };
}

function acceptedOnlyStream(request) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
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
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("phase 7 frontend repair regressions", () => {
  it.each(["in_progress", "completed"])(
    "reconciles a stale admitted journal with the latest %s server turn",
    async (latestStatus) => {
      const latestCanContinue = latestStatus === "completed";
      const recoveredQueries = [];
      const latestTurn = {
        ...turn(2, secondQueryId),
        status: latestStatus,
        answerManifest: {
          count: latestStatus === "completed" ? 1 : 0,
          complete: latestStatus === "completed",
        },
        cursor: latestStatus === "completed" ? 1 : 0,
      };
      const environment = createHistoryEnvironment({
        listHandler: () =>
          jsonResponse({
            version: 1,
            conversations: [
              {
                conversationId: firstConversationId,
                label: "Hilo con seguimiento",
                updatedAt: "2026-10-25T12:00:00.000Z",
                lastOrdinal: 2,
                closed: false,
                ...(latestStatus === "in_progress" ? { activeQueryId: secondQueryId } : {}),
              },
            ],
          }),
        turnsHandler: ({ conversationId }) =>
          jsonResponse({
            version: 1,
            conversationId,
            label: "Hilo con seguimiento",
            updatedAt: "2026-10-25T12:00:00.000Z",
            throughOrdinal: 2,
            closed: false,
            canContinue: latestCanContinue,
            turns: [turn(1, firstQueryId), latestTurn],
          }),
        textHandler: ({ conversationId, ordinal, url }) =>
          jsonResponse({
            version: 1,
            conversationId,
            ordinal,
            queryId: ordinal === 1 ? firstQueryId : secondQueryId,
            role: url.searchParams.get("role"),
            chunks: [{ index: 0, text: `${ordinal}-${url.searchParams.get("role")}` }],
            complete: true,
          }),
        recoverHandler: (request) => {
          recoveredQueries.push(request.queryId);
          return jsonResponse({
            version: 2,
            conversationId: request.conversationId,
            queryId: request.queryId,
            ordinal: 2,
            status: latestStatus,
            question: "2-user",
            answer: latestStatus === "completed" ? "2-assistant" : "",
            canContinue: latestCanContinue,
          });
        },
      });
      writeChatSelection(environment.config, environment.identity, firstConversationId);
      markChatJournalAdmitted(
        environment.config,
        environment.identity,
        {
          version: 2,
          operation: "start",
          conversationId: firstConversationId,
          queryId: firstQueryId,
          baseOrdinal: 0,
        },
        1,
      );

      const app = mount(environment);
      await app.flush();

      expect(props(app).state.history).toMatchObject({
        selectedConversationId: firstConversationId,
        throughOrdinal: 2,
        closed: false,
      });
      expect(props(app).state.history.turns.at(-1)).toMatchObject({
        ordinal: 2,
        queryId: secondQueryId,
        status: latestStatus,
      });
      expect(recoveredQueries).toEqual(latestStatus === "in_progress" ? [secondQueryId] : []);

      if (latestStatus === "in_progress") {
        expect(props(app).state).toMatchObject({
          queryId: secondQueryId,
          ordinal: 2,
          queryStatus: "streaming",
          history: { canContinue: false, closed: false },
        });
        expect(
          readChatJournals(environment.config, environment.identity).get(firstConversationId),
        ).toMatchObject({ admitted: true, request: { queryId: secondQueryId } });
      } else {
        expect(props(app).state).toMatchObject({
          queryStatus: "completed",
          canContinue: true,
          history: { canContinue: true, closed: false },
        });
        expect(
          readChatJournals(environment.config, environment.identity).has(firstConversationId),
        ).toBe(false);
      }
      expect(props(app).state.history.conversations[0]).toMatchObject({
        conversationId: firstConversationId,
        closed: false,
        ...(latestStatus === "in_progress" ? { activeQueryId: secondQueryId } : {}),
      });
    },
  );

  it("preserves an uncertain journal body until recovery explicitly resolves it", async () => {
    const body = "Keep this unconfirmed body for an explicit retry";
    const recoveredQueries = [];
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Hilo avanzado",
              lastOrdinal: 2,
              closed: false,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: true,
          turns: [turn(2, secondQueryId)],
        }),
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: secondQueryId,
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: `latest-${url.searchParams.get("role")}` }],
          complete: true,
        }),
      recoverHandler: (request) => {
        recoveredQueries.push(request.queryId);
        return jsonResponse({
          type: "failed",
          code: "conversation_unavailable",
          message: "No se encontró el envío.",
          recordStatus: "not_admitted",
          queryId: request.queryId,
        });
      },
    });
    writeChatSelection(environment.config, environment.identity, firstConversationId);
    writePendingChatJournal(environment.config, environment.identity, {
      version: 2,
      operation: "start",
      conversationId: firstConversationId,
      queryId: firstQueryId,
      baseOrdinal: 0,
      text: body,
    });

    const app = mount(environment);
    await app.flush();

    expect(recoveredQueries).toEqual([firstQueryId]);
    expect(props(app).state).toMatchObject({
      queryId: firstQueryId,
      queryStatus: "unconfirmed",
      question: body,
      canRetry: true,
    });
    expect(
      readChatJournals(environment.config, environment.identity).get(firstConversationId),
    ).toMatchObject({
      admitted: false,
      request: { queryId: firstQueryId, text: body },
    });
    expect(
      environment.runtimeRequests.filter(
        (item) => item.headers.get("accept") !== "application/json",
      ),
    ).toHaveLength(0);
  });

  it("reopens authoritative history after replaying an older terminal snapshot", async () => {
    const body = "Original uncertain start";
    let environment;
    let originalRequest;
    let remoteAdvanced = false;
    let turnsReads = 0;
    const recoveredQueries = [];
    const journalAtMetaRead = [];
    environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: remoteAdvanced
            ? [
                {
                  conversationId: originalRequest?.conversationId ?? firstConversationId,
                  label: body,
                  lastOrdinal: 2,
                  closed: false,
                },
              ]
            : [],
        }),
      turnsHandler: ({ conversationId }) => {
        turnsReads += 1;
        journalAtMetaRead.push(
          readChatJournals(environment.config, environment.identity).get(
            originalRequest.conversationId,
          ),
        );
        return jsonResponse({
          version: 1,
          conversationId,
          label: body,
          throughOrdinal: 2,
          closed: false,
          canContinue: true,
          turns: [turn(2, secondQueryId)],
        });
      },
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: secondQueryId,
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: `latest-${url.searchParams.get("role")}` }],
          complete: true,
        }),
      recoverHandler: (request) => {
        recoveredQueries.push(request.queryId);
        return jsonResponse({
          type: "failed",
          code: "conversation_unavailable",
          message: "No se encontró el envío.",
          recordStatus: "not_admitted",
          queryId: request.queryId,
        });
      },
      runtimeHandler: (request) => {
        if (!originalRequest) {
          originalRequest = request;
          return streamResponse(request, { accepted: false });
        }
        return request.queryId === originalRequest.queryId
          ? jsonResponse({
              version: 2,
              conversationId: request.conversationId,
              queryId: request.queryId,
              ordinal: 1,
              status: "completed",
              question: body,
              answer: "Older completed result",
              canContinue: true,
            })
          : streamResponse(request);
      },
    });

    const app = mount(environment);
    await app.flush();
    expect(props(app).onSubmit(body)).toBe(true);
    await app.flush();
    expect(originalRequest).toMatchObject({ operation: "start", baseOrdinal: 0, text: body });
    expect(props(app).state).toMatchObject({
      queryStatus: "unconfirmed",
      question: body,
      canRetry: true,
    });
    expect(recoveredQueries).toContain(originalRequest.queryId);
    expect(
      readChatJournals(environment.config, environment.identity).get(
        originalRequest.conversationId,
      ),
    ).toMatchObject({
      admitted: false,
      request: { queryId: originalRequest.queryId, text: body },
    });
    expect(environment.apiRequests.filter((item) => item.path.endsWith("/turns"))).toHaveLength(0);

    // The uncertain admission and a follow-up finish in another session.
    remoteAdvanced = true;
    await props(app).onRefreshHistory();
    await app.flush();
    expect(props(app).state.history.conversations[0]).toMatchObject({
      conversationId: originalRequest.conversationId,
      lastOrdinal: 2,
      closed: false,
    });

    expect(props(app).onSubmit(body)).toBe(true);
    await app.flush();

    expect(turnsReads).toBeGreaterThan(0);
    expect(journalAtMetaRead[0]).toBeUndefined();
    expect(
      readChatJournals(environment.config, environment.identity).has(
        originalRequest.conversationId,
      ),
    ).toBe(false);
    expect(props(app).state).toMatchObject({
      ordinal: 2,
      queryStatus: "completed",
      canContinue: true,
      history: {
        selectedConversationId: originalRequest.conversationId,
        throughOrdinal: 2,
        closed: false,
        canContinue: true,
        turns: [{ ordinal: 2, queryId: secondQueryId, answer: "latest-assistant" }],
      },
    });
    expect(props(app).state.history.conversations[0]).toMatchObject({
      conversationId: originalRequest.conversationId,
      lastOrdinal: 2,
      closed: false,
    });
    expect(props(app).onSubmit("New follow-up")).toBe(true);
    await app.flush();
    expect(environment.runtimeRequests.at(-1).request).toMatchObject({
      operation: "message",
      conversationId: originalRequest.conversationId,
      baseOrdinal: 2,
      text: "New follow-up",
    });
  });

  it("keeps a confirmed replay result when reopening newer history fails", async () => {
    let turnsReads = 0;
    const body = "Confirmed completed result";
    const environment = createHistoryEnvironment({
      turnsHandler: ({ conversationId }) => {
        turnsReads += 1;
        if (turnsReads > 1) return jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503);
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: true,
          turns: [turn(2, secondQueryId)],
        });
      },
      recoverHandler: (request) =>
        jsonResponse({
          type: "failed",
          code: "conversation_unavailable",
          message: "No se encontró el envío.",
          recordStatus: "not_admitted",
          queryId: request.queryId,
        }),
      runtimeHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 1,
          status: "completed",
          question: "Original uncertain start",
          answer: body,
          canContinue: false,
        }),
    });
    writePendingStart(environment, "Original uncertain start");

    const app = mount(environment);
    await app.flush();
    expect(props(app).state.queryStatus).toBe("unconfirmed");
    expect(props(app).onSubmit("Original uncertain start")).toBe(true);
    await app.flush();

    expect(turnsReads).toBe(2);
    expect(props(app).state).toMatchObject({
      ordinal: 1,
      queryStatus: "completed",
      answer: body,
      canContinue: false,
      history: {
        throughOrdinal: 2,
        closed: false,
        canContinue: true,
        turnsStatus: "error",
        turnsError: "No pudimos abrir la conversación. Podés volver a intentarlo.",
      },
    });
    expect(
      readChatJournals(environment.config, environment.identity).has(firstConversationId),
    ).toBe(false);
    let html = await app.html();
    expect(html).toContain("Recuperamos este envío. No pudimos actualizar la conversación.");
    expect(html).toContain(
      "La respuesta está completa. No pudimos confirmar si podés continuar este hilo.",
    );
    expect(html).not.toContain("Recuperamos el último envío de esta conversación");
    expect(html).not.toContain("La respuesta está completa. Podés continuar este hilo.");
    expect(html).toContain("Copiar respuesta");

    props(app).onDraftChange("Seguimiento pendiente de actualizar");
    await app.flush();
    html = await app.html();
    expect(props(app).state.draft).toBe("Seguimiento pendiente de actualizar");
    expect(html).toContain("Seguimiento pendiente de actualizar");
    const textarea = html.match(/<textarea\b[^>]*>/)?.[0];
    expect(textarea).toContain('id="chat-query"');
    expect(textarea).not.toContain("disabled");
    const sendButton = html.match(/<button\b[^>]*type="submit"[^>]*>Enviar<\/button>/)?.[0];
    expect(sendButton).toContain("disabled");
    expect(props(app).onSubmit("Next follow-up")).toBe(false);
  });

  it("reloads a closed newer transcript before applying an explicitly replayed active snapshot", async () => {
    const replay = deferred();
    const body = "Original uncertain start";
    let currentSummary;
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: currentSummary ? [currentSummary] : [],
        }),
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          label: "Hilo cerrado",
          throughOrdinal: 2,
          closed: true,
          canContinue: false,
          turns: [
            turn(1, firstQueryId),
            {
              ...turn(2, secondQueryId),
              status: "failed",
              failure: { code: "runtime_failed" },
            },
          ],
        }),
      textHandler: turnText,
      recoverHandler: (request) =>
        jsonResponse({
          type: "failed",
          code: "conversation_unavailable",
          message: "No se encontró el envío.",
          recordStatus: "not_admitted",
          queryId: request.queryId,
        }),
      runtimeHandler: () => replay.promise,
    });
    writePendingStart(environment, body);

    const app = mount(environment);
    await app.flush();
    expect(props(app).state).toMatchObject({ queryStatus: "unconfirmed", canRetry: true });
    expect(props(app).onSubmit(body)).toBe(true);
    await app.flush();
    expect(environment.runtimeRequests.at(-1).request).toMatchObject({
      operation: "start",
      queryId: firstQueryId,
      text: body,
    });

    currentSummary = {
      conversationId: firstConversationId,
      label: "Hilo cerrado",
      lastOrdinal: 2,
      closed: true,
    };
    await props(app).onRefreshHistory();
    await app.flush();
    expect(props(app).state.history.conversations[0]).toMatchObject(currentSummary);

    replay.resolve(
      jsonResponse({
        version: 2,
        conversationId: firstConversationId,
        queryId: firstQueryId,
        ordinal: 1,
        status: "in_progress",
        question: body,
        answer: "Prefijo replayado Q1",
        canContinue: false,
      }),
    );
    await app.flush();

    expect(props(app).state).toMatchObject({
      ordinal: 2,
      queryStatus: "failed",
      canContinue: false,
      history: {
        selectedConversationId: firstConversationId,
        throughOrdinal: 2,
        closed: true,
      },
    });
    expect(props(app).state.history.turns.at(-1)).toMatchObject({
      ordinal: 2,
      queryId: secondQueryId,
      status: "failed",
    });
    expect(
      props(app).state.history.conversations.find(
        ({ conversationId }) => conversationId === firstConversationId,
      ),
    ).toMatchObject({ lastOrdinal: 2, closed: true });
    expect(
      readChatJournals(environment.config, environment.identity).has(firstConversationId),
    ).toBe(false);
    const html = await app.html();
    expect(html).toContain("ORIGINAL_TEXT_2");
    expect(html).toContain(" · Cerrada");
    expect(html).not.toContain("Prefijo replayado Q1");
    expect(html).not.toContain('class="chat-form"');
    expect(props(app).onSubmit("No continuar")).toBe(false);
  });

  it("uses current META closure for an explicitly replayed failed terminal", async () => {
    const body = "Retry an uncertain request that failed durably";
    let turnsReads = 0;
    const environment = createHistoryEnvironment({
      turnsHandler: ({ conversationId }) => {
        turnsReads += 1;
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: true,
          canContinue: false,
          turns: [
            {
              ...turn(1, firstQueryId),
              status: "failed",
              answerManifest: { count: 0, complete: false },
              cursor: 0,
              failure: { code: "runtime_failed" },
            },
          ],
        });
      },
      recoverHandler: (request) =>
        jsonResponse({
          type: "failed",
          code: "conversation_unavailable",
          message: "No se encontró el envío.",
          recordStatus: "not_admitted",
          queryId: request.queryId,
        }),
      runtimeHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 1,
          status: "failed",
          question: body,
          answer: "Durable partial result",
          canContinue: false,
        }),
    });
    writePendingStart(environment, body);

    const app = mount(environment);
    await app.flush();
    expect(props(app).state.queryStatus).toBe("unconfirmed");
    expect(props(app).onSubmit(body)).toBe(true);
    await app.flush();

    expect(turnsReads).toBe(1);
    expect(props(app).state).toMatchObject({
      queryStatus: "failed",
      answer: "Durable partial result",
      canContinue: false,
      history: { throughOrdinal: 1, closed: true, canContinue: false },
    });
    expect(props(app).state.history.conversations[0]).toMatchObject({
      lastOrdinal: 1,
      closed: true,
    });
  });

  it("keeps a replayed terminal result and reports META failure without closing the thread", async () => {
    const body = "Keep the confirmed answer if current history is unavailable";
    let turnsReads = 0;
    const environment = createHistoryEnvironment({
      turnsHandler: () => {
        turnsReads += 1;
        return jsonResponse({ code: "TEMPORARY" }, 503);
      },
      recoverHandler: (request) =>
        jsonResponse({
          type: "failed",
          code: "conversation_unavailable",
          message: "No se encontró el envío.",
          recordStatus: "not_admitted",
          queryId: request.queryId,
        }),
      runtimeHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 1,
          status: "completed",
          question: body,
          answer: "Confirmed result remains visible",
          canContinue: false,
        }),
    });
    writePendingStart(environment, body);

    const app = mount(environment);
    await app.flush();
    expect(props(app).state.queryStatus).toBe("unconfirmed");
    expect(props(app).onSubmit(body)).toBe(true);
    await app.flush();

    expect(turnsReads).toBe(1);
    expect(props(app).state).toMatchObject({
      queryStatus: "completed",
      answer: "Confirmed result remains visible",
      canContinue: false,
      history: {
        selectedConversationId: firstConversationId,
        turnsError:
          "No pudimos confirmar si el hilo sigue abierto. Volvé a seleccionarlo en el historial para actualizarlo.",
      },
    });
    expect(props(app).state.history.conversations[0]).toMatchObject({
      conversationId: firstConversationId,
      lastOrdinal: 1,
      closed: false,
    });
    const html = await app.html();
    expect(html).toContain("Recuperamos este envío. No pudimos actualizar la conversación.");
    expect(html).toContain(
      "La respuesta está completa. No pudimos confirmar si podés continuar este hilo.",
    );
    expect(html).not.toContain("Recuperamos el último envío de esta conversación");
    expect(html).not.toContain("La respuesta está completa. Podés continuar este hilo.");
  });

  it("describes a confirmed closed completed thread without inviting a follow-up", async () => {
    const environment = createHistoryEnvironment({
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: true,
          canContinue: false,
          turns: [
            {
              ...turn(1, firstQueryId),
              status: "completed",
              answerManifest: { count: 1, complete: true },
              cursor: 1,
            },
          ],
        }),
      textHandler: ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        return jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: firstQueryId,
          role,
          chunks: [{ index: 0, text: role === "user" ? "Pregunta" : "Respuesta" }],
          complete: true,
        });
      },
    });
    registerConversationMeta(environment, {
      label: "Conversación cerrada",
      lastOrdinal: 1,
      closed: true,
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();

    expect(props(app).state).toMatchObject({
      queryStatus: "completed",
      canContinue: false,
      history: { closed: true, turnsStatus: "ready" },
    });
    const html = await app.html();
    expect(html).toContain("La respuesta está completa. Este hilo está cerrado.");
    expect(html).not.toContain("La respuesta está completa. Podés continuar este hilo.");
  });

  it("ignores a newer-history reload after explicit selection changes", async () => {
    const terminalMeta = deferred();
    let firstConversationReads = 0;
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Pendiente",
              lastOrdinal: 0,
              closed: false,
            },
            {
              conversationId: secondConversationId,
              label: "Otra conversación",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) => {
        if (conversationId === secondConversationId) {
          return jsonResponse({
            version: 1,
            conversationId,
            throughOrdinal: 1,
            closed: false,
            canContinue: true,
            turns: [turn(1, secondQueryId)],
          });
        }
        firstConversationReads += 1;
        if (firstConversationReads === 1) {
          return jsonResponse({
            version: 1,
            conversationId,
            throughOrdinal: 2,
            closed: false,
            canContinue: true,
            turns: [turn(2, secondQueryId)],
          });
        }
        return terminalMeta.promise;
      },
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: url.searchParams.get("queryId"),
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: `text-${conversationId}` }],
          complete: true,
        }),
      recoverHandler: (request) =>
        jsonResponse({
          type: "failed",
          code: "conversation_unavailable",
          message: "No se encontró el envío.",
          recordStatus: "not_admitted",
          queryId: request.queryId,
        }),
      runtimeHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 1,
          status: "completed",
          question: "Older request",
          answer: "Older result",
          canContinue: false,
        }),
    });
    writePendingStart(environment, "Older request");

    const app = mount(environment);
    await app.flush();
    expect(props(app).state.queryStatus).toBe("unconfirmed");
    expect(props(app).onSubmit("Older request")).toBe(true);
    await vi.waitFor(() => expect(firstConversationReads).toBe(2));

    expect(await props(app).onSelectConversation(secondConversationId)).toBe(true);
    await app.flush();
    terminalMeta.resolve(
      jsonResponse({
        version: 1,
        conversationId: firstConversationId,
        throughOrdinal: 2,
        closed: true,
        canContinue: false,
        turns: [
          {
            ...turn(2, secondQueryId),
            status: "failed",
            answerManifest: { count: 0, complete: false },
            cursor: 0,
            failure: { code: "runtime_failed" },
          },
        ],
      }),
    );
    await app.flush();

    expect(props(app).state.history.selectedConversationId).toBe(secondConversationId);
    expect(props(app).state).toMatchObject({
      queryStatus: "completed",
      history: { throughOrdinal: 1, closed: false, canContinue: true },
    });
    expect(props(app).state.history.turns.at(-1)).toMatchObject({
      ordinal: 1,
      queryId: secondQueryId,
      question: `text-${secondConversationId}`,
    });
  });

  it("minimizes a pending start when recover confirms its active turn", async () => {
    const body = "Confirmed after the accepted event was lost";
    const recoveredQueries = [];
    const environment = createHistoryEnvironment({
      recoverHandler: (request) => {
        recoveredQueries.push(request.queryId);
        return jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 1,
          status: "in_progress",
          question: body,
          answer: "Prefijo durable de Q1.",
          canContinue: false,
        });
      },
    });
    writePendingStart(environment, body);

    const app = mount(environment);
    await app.flush();

    expect(recoveredQueries).toEqual([firstQueryId]);
    expect(props(app).state).toMatchObject({
      queryId: firstQueryId,
      ordinal: 1,
      queryStatus: "streaming",
      question: body,
      canContinue: false,
      history: { selectedConversationId: firstConversationId },
    });
    expect(
      readChatJournals(environment.config, environment.identity).get(firstConversationId),
    ).toMatchObject({
      admitted: true,
      ordinal: 1,
      request: { queryId: firstQueryId },
    });
    expect(
      readChatJournals(environment.config, environment.identity).get(firstConversationId).request,
    ).not.toHaveProperty("text");
    expect(environment.apiRequests.filter((item) => item.path.endsWith("/turns"))).toHaveLength(0);
    expect(
      environment.runtimeRequests.filter(
        (item) => item.headers.get("accept") !== "application/json",
      ),
    ).toHaveLength(0);
  });

  it.each([
    { latest: "q1 terminal", throughOrdinal: 1, latestStatus: "completed", closed: true },
    { latest: "q2 active", throughOrdinal: 2, latestStatus: "in_progress", closed: false },
    { latest: "q2 terminal", throughOrdinal: 2, latestStatus: "failed", closed: true },
  ])(
    "minimizes a confirmed pending q1 before selecting $latest from authoritative history",
    async ({ throughOrdinal, latestStatus, closed }) => {
      let turnsReads = 0;
      const recoveredQueries = [];
      const latestTurn =
        throughOrdinal === 1
          ? turn(1, firstQueryId)
          : {
              ...turn(2, secondQueryId),
              status: latestStatus,
              answerManifest: {
                count: latestStatus === "in_progress" ? 0 : 1,
                complete: false,
              },
              cursor: latestStatus === "in_progress" ? 0 : 1,
              ...(latestStatus === "failed" ? { failure: { code: "runtime_failed" } } : {}),
            };
      const environment = createHistoryEnvironment({
        turnsHandler: ({ conversationId }) => {
          turnsReads += 1;
          return jsonResponse({
            version: 1,
            conversationId,
            throughOrdinal,
            closed,
            canContinue: !closed,
            turns:
              throughOrdinal === 1
                ? [{ ...latestTurn, status: "completed" }]
                : [turn(1, firstQueryId), latestTurn],
          });
        },
        textHandler: turnText,
        recoverHandler: (request) => {
          recoveredQueries.push(request.queryId);
          return jsonResponse({
            version: 2,
            conversationId: request.conversationId,
            queryId: request.queryId,
            ordinal: request.queryId === firstQueryId ? 1 : 2,
            status: request.queryId === firstQueryId ? "completed" : "in_progress",
            question: request.queryId === firstQueryId ? "Pregunta Q1" : "Pregunta Q2",
            answer: request.queryId === firstQueryId ? "Respuesta Q1" : "Prefijo Q2",
            canContinue: false,
          });
        },
      });
      writePendingStart(environment, "Cuerpo original incierto de Q1");

      const app = mount(environment);
      await app.flush();

      expect(turnsReads).toBe(throughOrdinal === 1 ? 1 : 2);
      expect(recoveredQueries).toEqual(
        latestStatus === "in_progress" ? [firstQueryId, secondQueryId] : [firstQueryId],
      );
      expect(props(app).state.history.selectedConversationId).toBe(firstConversationId);
      expect(props(app).state.history.throughOrdinal).toBe(throughOrdinal);
      expect(props(app).state.history.closed).toBe(closed);
      expect(props(app).state.history.turns.at(-1)).toMatchObject({
        ordinal: throughOrdinal,
        queryId: throughOrdinal === 1 ? firstQueryId : secondQueryId,
        status: latestStatus,
      });
      expect(
        environment.runtimeRequests.filter(
          (item) => item.headers.get("accept") !== "application/json",
        ),
      ).toHaveLength(0);

      const journals = readChatJournals(environment.config, environment.identity);
      if (latestStatus === "in_progress") {
        expect(props(app).state).toMatchObject({
          queryId: secondQueryId,
          queryStatus: "streaming",
        });
        expect(journals.get(firstConversationId)).toMatchObject({
          admitted: true,
          ordinal: 2,
          request: { queryId: secondQueryId },
        });
        expect(journals.get(firstConversationId).request).not.toHaveProperty("text");
      } else {
        expect(props(app).state.queryStatus).toBe(latestStatus);
        expect(journals.has(firstConversationId)).toBe(false);
      }
    },
  );

  it("confirms authoritative closure after recovering a terminal latest turn", async () => {
    let turnsReads = 0;
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Hilo con seguimiento",
              lastOrdinal: 2,
              closed: false,
              activeQueryId: secondQueryId,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) => {
        turnsReads += 1;
        const failed = turnsReads > 1;
        return jsonResponse({
          version: 1,
          conversationId,
          label: "Hilo con seguimiento",
          throughOrdinal: 2,
          closed: failed,
          canContinue: false,
          turns: [
            {
              ordinal: 2,
              queryId: secondQueryId,
              status: failed ? "failed" : "in_progress",
              questionManifest: { count: 1, complete: true },
              answerManifest: { count: 0, complete: false },
              cursor: 0,
              ...(failed ? { failure: { code: "runtime_failed" } } : {}),
            },
          ],
        });
      },
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: secondQueryId,
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: "Pregunta del seguimiento" }],
          complete: true,
        }),
      recoverHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 2,
          status: "failed",
          question: "Pregunta del seguimiento",
          answer: "",
          canContinue: false,
        }),
    });
    writeChatSelection(environment.config, environment.identity, firstConversationId);
    markChatJournalAdmitted(
      environment.config,
      environment.identity,
      {
        version: 2,
        operation: "start",
        conversationId: firstConversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
      },
      1,
    );

    const app = mount(environment);
    await app.flush();

    expect(turnsReads).toBe(2);
    expect(props(app).state).toMatchObject({
      queryId: secondQueryId,
      ordinal: 2,
      queryStatus: "failed",
      canContinue: false,
      history: {
        selectedConversationId: firstConversationId,
        throughOrdinal: 2,
        closed: true,
        canContinue: false,
        turnsError: undefined,
      },
    });
    expect(props(app).state.history.conversations[0]).toMatchObject({
      conversationId: firstConversationId,
      closed: true,
    });
  });

  it("uses authoritative canContinue when it differs from a terminal recovery snapshot", async () => {
    let turnsReads = 0;
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Hilo abierto",
              lastOrdinal: 2,
              closed: false,
              activeQueryId: secondQueryId,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) => {
        turnsReads += 1;
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: turnsReads > 1,
          turns: [
            {
              ordinal: 2,
              queryId: secondQueryId,
              status: turnsReads > 1 ? "failed" : "in_progress",
              questionManifest: { count: 1, complete: true },
              answerManifest: { count: 0, complete: false },
              cursor: 0,
              ...(turnsReads > 1 ? { failure: { code: "runtime_failed" } } : {}),
            },
          ],
        });
      },
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: secondQueryId,
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: "Pregunta del seguimiento" }],
          complete: true,
        }),
      recoverHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 2,
          status: "failed",
          question: "Pregunta del seguimiento",
          answer: "",
          canContinue: false,
        }),
    });
    writeChatSelection(environment.config, environment.identity, firstConversationId);
    markChatJournalAdmitted(
      environment.config,
      environment.identity,
      {
        version: 2,
        operation: "start",
        conversationId: firstConversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
      },
      1,
    );

    const app = mount(environment);
    await app.flush();

    expect(props(app).state).toMatchObject({
      queryStatus: "failed",
      canContinue: true,
      history: { closed: false, canContinue: true },
    });
    expect(props(app).state.history.conversations[0]).toMatchObject({
      conversationId: firstConversationId,
      closed: false,
    });
  });

  it("keeps a terminal recovery visible and reports a transient META read failure", async () => {
    let turnsReads = 0;
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Hilo en recuperación",
              lastOrdinal: 2,
              closed: false,
              activeQueryId: secondQueryId,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) => {
        turnsReads += 1;
        if (turnsReads > 1) return jsonResponse({ code: "TEMPORARY" }, 503);
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: false,
          turns: [
            {
              ordinal: 2,
              queryId: secondQueryId,
              status: "in_progress",
              questionManifest: { count: 1, complete: true },
              answerManifest: { count: 0, complete: false },
              cursor: 0,
            },
          ],
        });
      },
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: secondQueryId,
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: "Pregunta del seguimiento" }],
          complete: true,
        }),
      recoverHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 2,
          status: "failed",
          question: "Pregunta del seguimiento",
          answer: "",
          canContinue: false,
        }),
    });
    writeChatSelection(environment.config, environment.identity, firstConversationId);
    markChatJournalAdmitted(
      environment.config,
      environment.identity,
      {
        version: 2,
        operation: "start",
        conversationId: firstConversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
      },
      1,
    );

    const app = mount(environment);
    await app.flush();

    expect(props(app).state).toMatchObject({
      queryStatus: "failed",
      canContinue: false,
      history: {
        selectedConversationId: firstConversationId,
        closed: false,
        turnsError:
          "No pudimos confirmar si el hilo sigue abierto. Volvé a seleccionarlo en el historial para actualizarlo.",
      },
    });
    expect(props(app).state.history.conversations[0]).toMatchObject({
      conversationId: firstConversationId,
      closed: false,
    });
    expect(props(app).state.history.conversations[0].activeQueryId).toBeUndefined();
    expect(turnsReads).toBe(2);
  });

  it("ignores a terminal META response after selection changes", async () => {
    const terminalMeta = deferred();
    let firstConversationReads = 0;
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Hilo en recuperación",
              lastOrdinal: 2,
              closed: false,
              activeQueryId: secondQueryId,
            },
            {
              conversationId: secondConversationId,
              label: "Otra conversación",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) => {
        if (conversationId === secondConversationId) {
          return jsonResponse({
            version: 1,
            conversationId,
            throughOrdinal: 1,
            closed: false,
            canContinue: true,
            turns: [turn(1, firstQueryId)],
          });
        }
        firstConversationReads += 1;
        if (firstConversationReads > 1) return terminalMeta.promise;
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: false,
          turns: [
            {
              ordinal: 2,
              queryId: secondQueryId,
              status: "in_progress",
              questionManifest: { count: 1, complete: true },
              answerManifest: { count: 0, complete: false },
              cursor: 0,
            },
          ],
        });
      },
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: url.searchParams.get("queryId"),
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: `Pregunta ${conversationId}` }],
          complete: true,
        }),
      recoverHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 2,
          status: "failed",
          question: "Pregunta del seguimiento",
          answer: "",
          canContinue: false,
        }),
    });
    writeChatSelection(environment.config, environment.identity, firstConversationId);
    markChatJournalAdmitted(
      environment.config,
      environment.identity,
      {
        version: 2,
        operation: "start",
        conversationId: firstConversationId,
        queryId: firstQueryId,
        baseOrdinal: 0,
      },
      1,
    );

    const app = mount(environment);
    await app.flush();
    expect(firstConversationReads).toBe(2);

    expect(await props(app).onSelectConversation(secondConversationId)).toBe(true);
    await app.flush();
    terminalMeta.resolve(
      jsonResponse({
        version: 1,
        conversationId: firstConversationId,
        throughOrdinal: 2,
        closed: true,
        canContinue: false,
        turns: [
          {
            ordinal: 2,
            queryId: secondQueryId,
            status: "failed",
            questionManifest: { count: 1, complete: true },
            answerManifest: { count: 0, complete: false },
            cursor: 0,
            failure: { code: "runtime_failed" },
          },
        ],
      }),
    );
    await app.flush();

    expect(props(app).state.history.selectedConversationId).toBe(secondConversationId);
    expect(props(app).state.history).toMatchObject({ closed: false, canContinue: true });
    expect(props(app).state.queryStatus).toBe("completed");
  });

  it("shows a terminal empty-answer integrity error from the text API", async () => {
    const textReads = [];
    let turnsReads = 0;
    const environment = createHistoryEnvironment({
      turnsHandler: ({ conversationId }) => {
        turnsReads += 1;
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: turnsReads === 1,
          canContinue: turnsReads > 1,
          turns: [emptyFailedTurn()],
        });
      },
      textHandler: ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        const throughCursor = url.searchParams.get("throughCursor");
        textReads.push({ role, throughCursor });
        if (role === "assistant" && turnsReads === 1) {
          return jsonResponse({ code: "CONVERSATION_UNAVAILABLE" }, 500);
        }
        return jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: firstQueryId,
          role,
          chunks: role === "user" ? [{ index: 0, text: "Pregunta original" }] : [],
          complete: true,
        });
      },
    });
    registerConversationMeta(environment, {
      label: "Pregunta con respuesta vacía",
      lastOrdinal: 1,
      closed: true,
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(false);
    await app.flush();

    expect(textReads).toContainEqual({ role: "assistant", throughCursor: "0" });
    expect(props(app).state.history).toMatchObject({
      turnsStatus: "error",
      turnsError: "Esta conversación ya no está disponible.",
    });
    props(app).onDraftChange("Seguimiento pendiente de actualizar");
    await app.flush();
    let html = await app.html();
    expect(props(app).state.draft).toBe("Seguimiento pendiente de actualizar");
    expect(html).toContain("Seguimiento pendiente de actualizar");
    const textarea = html.match(/<textarea\b[^>]*>/)?.[0];
    expect(textarea).toContain('id="chat-query"');
    expect(textarea).not.toContain("disabled");
    const sendButton = html.match(/<button\b[^>]*type="submit"[^>]*>Enviar<\/button>/)?.[0];
    expect(sendButton).toContain("disabled");
    expect(props(app).onSubmit("Seguimiento pendiente de actualizar")).toBe(false);
    expect(environment.runtimeRequests).toEqual([]);
    expect(readChatJournals(environment.config, environment.identity).size).toBe(0);

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    expect(turnsReads).toBe(2);
    expect(props(app).state).toMatchObject({
      queryStatus: "failed",
      ordinal: 1,
      canContinue: true,
      history: { throughOrdinal: 1, closed: false, turnsStatus: "ready" },
    });
    expect(props(app).onSubmit("Follow-up from loaded history")).toBe(true);
    await app.flush();
    expect(environment.runtimeRequests.at(-1).request).toMatchObject({
      operation: "message",
      conversationId: firstConversationId,
      baseOrdinal: 1,
      text: "Follow-up from loaded history",
    });
  });

  it("allows the exact preparation retry after a history reopen error", async () => {
    let turnsReads = 0;
    let runtimeCalls = 0;
    const body = "Retry this exact prepared follow-up";
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Hilo abierto",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) => {
        turnsReads += 1;
        if (turnsReads > 1) return jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503);
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, firstQueryId)],
        });
      },
      textHandler: ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        return jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: firstQueryId,
          role,
          chunks: [{ index: 0, text: role === "user" ? "Pregunta original" : "Respuesta" }],
          complete: true,
        });
      },
      runtimeHandler: (request) => {
        runtimeCalls += 1;
        return runtimeCalls === 1
          ? jsonResponse({
              type: "failed",
              code: "context_unavailable",
              message: "No pudimos preparar el contexto.",
              recordStatus: "not_admitted",
              queryId: request.queryId,
            })
          : streamResponse(request);
      },
    });
    const app = mount(environment);
    await app.flush();
    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();

    expect(props(app).onSubmit(body)).toBe(true);
    await app.flush();
    const originalRequest = environment.runtimeRequests.at(-1).request;
    expect(props(app).state).toMatchObject({
      queryStatus: "rejected",
      canRetry: true,
      queryErrorCode: "context_unavailable",
    });

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(false);
    await app.flush();
    expect(turnsReads).toBe(2);
    expect(props(app).state.history.turnsStatus).toBe("error");
    expect(await app.html()).toContain("Reintentar el mismo envío");

    expect(props(app).onSubmit(body)).toBe(true);
    await app.flush();
    expect(environment.runtimeRequests.at(-1).request).toEqual(originalRequest);
  });

  it("keeps a valid empty failed answer partial after checking its terminal boundary", async () => {
    const textReads = [];
    const environment = createHistoryEnvironment({
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: true,
          canContinue: false,
          turns: [emptyFailedTurn()],
        }),
      textHandler: ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        const throughCursor = url.searchParams.get("throughCursor");
        textReads.push({ role, throughCursor });
        return jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: firstQueryId,
          role,
          chunks: role === "user" ? [{ index: 0, text: "Pregunta original" }] : [],
          complete: true,
        });
      },
    });
    registerConversationMeta(environment, {
      label: "Pregunta fallida",
      lastOrdinal: 1,
      closed: true,
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();

    expect(textReads).toContainEqual({ role: "assistant", throughCursor: "0" });
    expect(props(app).state.queryStatus).toBe("failed");
    expect(props(app).state.history).toMatchObject({
      turnsStatus: "ready",
      turns: [
        {
          status: "failed",
          question: "Pregunta original",
          answer: "",
          answerComplete: false,
        },
      ],
    });
  });

  it("keeps an active empty answer prefix partial without treating it as terminal text", async () => {
    const textReads = [];
    const environment = createHistoryEnvironment({
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: false,
          turns: [
            {
              ...emptyFailedTurn(),
              status: "in_progress",
              failure: { code: "unconfirmable" },
            },
          ],
        }),
      textHandler: ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        const throughCursor = url.searchParams.get("throughCursor");
        textReads.push({ role, throughCursor });
        return jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: firstQueryId,
          role,
          chunks: [{ index: 0, text: "Pregunta original" }],
          complete: true,
        });
      },
    });
    registerConversationMeta(environment, {
      label: "Consulta en curso",
      lastOrdinal: 1,
      closed: false,
      activeQueryId: firstQueryId,
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();

    expect(textReads).not.toContainEqual({ role: "assistant", throughCursor: "0" });
    expect(props(app).state).toMatchObject({
      queryStatus: "unconfirmed",
      canContinue: false,
      history: {
        turnsStatus: "ready",
        turns: [
          {
            status: "in_progress",
            answer: "",
            answerComplete: false,
            failure: { code: "unconfirmable" },
          },
        ],
      },
    });
    expect(props(app).state.history.conversations[0]).toMatchObject({
      conversationId: firstConversationId,
      pending: true,
      durable: true,
    });
    expect(await app.html()).toContain("Quitar del historial");
    expect(props(app).onSubmit("no continuar hasta confirmar")).toBe(false);
    expect(environment.runtimeRequests).toEqual([]);
  });

  it.each([
    ["sin chunks", []],
    ["un chunk vacío", [""]],
    ["un chunk whitespace", [" \n"]],
    ["whitespace en dos páginas", [" \n", "   "]],
  ])(
    "rejects a completed answer with %s and keeps the prior base and draft on retry",
    async (_case, answerChunks) => {
      let emptyTurnReads = 0;
      const assistantPageCursors = [];
      const environment = createHistoryEnvironment({
        listHandler: () =>
          jsonResponse({
            version: 1,
            conversations: [
              {
                conversationId: firstConversationId,
                label: "Vacía",
                lastOrdinal: 1,
                closed: false,
              },
              {
                conversationId: secondConversationId,
                label: "Válida",
                lastOrdinal: 2,
                closed: false,
              },
            ],
          }),
        turnsHandler: ({ conversationId }) => {
          if (conversationId === secondConversationId) {
            return jsonResponse({
              version: 1,
              conversationId,
              throughOrdinal: 2,
              closed: false,
              canContinue: true,
              turns: [turn(2, secondQueryId)],
            });
          }
          emptyTurnReads += 1;
          return jsonResponse({
            version: 1,
            conversationId,
            throughOrdinal: 1,
            closed: false,
            canContinue: true,
            turns: [
              {
                ...turn(1, firstQueryId),
                answerManifest: { count: answerChunks.length, complete: true },
                cursor: answerChunks.length,
              },
            ],
          });
        },
        textHandler: ({ conversationId, ordinal, url }) => {
          const role = url.searchParams.get("role");
          const valid = conversationId === secondConversationId;
          const cursor = url.searchParams.get("cursor");
          const assistantPageIndex = cursor ? 1 : 0;
          const answerPage = role === "assistant" && !valid && answerChunks.length === 2;
          if (answerPage) assistantPageCursors.push(cursor);
          return jsonResponse({
            version: 1,
            conversationId,
            ordinal,
            queryId: valid ? secondQueryId : firstQueryId,
            role,
            chunks:
              role === "user"
                ? [{ index: 0, text: valid ? "Pregunta previa" : "Pregunta vacía" }]
                : valid
                  ? [{ index: 0, text: "Respuesta previa" }]
                  : answerChunks.length === 2
                    ? [{ index: assistantPageIndex, text: answerChunks[assistantPageIndex] }]
                    : answerChunks.map((text, index) => ({ index, text })),
            complete: !answerPage || assistantPageIndex === 1,
            ...(answerPage && assistantPageIndex === 0 ? { nextCursor: "assistant-page-2" } : {}),
          });
        },
      });
      const app = mount(environment);
      await app.flush();
      expect(await props(app).onSelectConversation(secondConversationId)).toBe(true);
      await app.flush();
      props(app).onDraftChange("Borrador conservado");
      await app.flush();

      expect(await props(app).onSelectConversation(firstConversationId)).toBe(false);
      await app.flush();
      expect(props(app).state).toMatchObject({
        queryStatus: "completed",
        ordinal: 2,
        canContinue: true,
        draft: "Borrador conservado",
        history: {
          selectedConversationId: secondConversationId,
          turnsStatus: "error",
          canContinue: true,
          throughOrdinal: 2,
          turns: [{ ordinal: 2, answer: "Respuesta previa", answerComplete: true }],
        },
      });
      expect(await app.html()).toContain(
        "No pudimos abrir la conversación. Podés volver a intentarlo.",
      );

      expect(await props(app).onSelectConversation(firstConversationId)).toBe(false);
      await app.flush();
      expect(emptyTurnReads).toBe(2);
      expect(assistantPageCursors).toEqual(
        answerChunks.length === 2 ? [null, "assistant-page-2", null, "assistant-page-2"] : [],
      );
      expect(props(app).state).toMatchObject({
        canContinue: true,
        draft: "Borrador conservado",
        history: { selectedConversationId: secondConversationId, turnsStatus: "error" },
      });
    },
  );

  it.each([
    ["whitespace before text", [" \n", "respuesta"]],
    ["text before whitespace", ["respuesta", " \n"]],
  ])("accepts a completed answer with %s across pages", async (_order, answerChunks) => {
    const assistantPageCursors = [];
    const environment = createHistoryEnvironment({
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [
            {
              ...turn(1, firstQueryId),
              answerManifest: { count: 2, complete: true },
              cursor: 2,
            },
          ],
        }),
      textHandler: ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        const cursor = url.searchParams.get("cursor");
        if (role === "user") {
          return jsonResponse({
            version: 1,
            conversationId,
            ordinal,
            queryId: firstQueryId,
            role,
            chunks: [{ index: 0, text: "Pregunta completa" }],
            complete: true,
          });
        }
        assistantPageCursors.push(cursor);
        return jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: firstQueryId,
          role,
          chunks: [{ index: cursor ? 1 : 0, text: answerChunks[cursor ? 1 : 0] }],
          complete: Boolean(cursor),
          ...(cursor ? {} : { nextCursor: "assistant-page-2" }),
        });
      },
    });
    registerConversationMeta(environment, {
      label: "Respuesta completada",
      lastOrdinal: 1,
      closed: false,
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();

    expect(assistantPageCursors).toEqual([null, "assistant-page-2"]);
    expect(props(app).state).toMatchObject({
      queryStatus: "completed",
      canContinue: true,
      history: {
        turnsStatus: "ready",
        canContinue: true,
        turns: [
          {
            status: "completed",
            answer: answerChunks.join(""),
            answerComplete: true,
            canContinue: true,
          },
        ],
      },
    });
  });

  it("keeps an active whitespace prefix when the server completes after its descriptor was read", async () => {
    let descriptorStatus = "in_progress";
    let descriptorReads = 0;
    const environment = createHistoryEnvironment({
      turnsHandler: ({ conversationId }) => {
        descriptorReads += 1;
        const status = descriptorStatus;
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: false,
          turns: [
            {
              ...turn(1, firstQueryId),
              status,
              answerManifest: { count: 1, complete: true },
              cursor: 1,
              ...(status === "in_progress" ? { failure: { code: "unconfirmable" } } : {}),
            },
          ],
        });
      },
      textHandler: ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        if (role === "assistant") descriptorStatus = "completed";
        return jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: firstQueryId,
          role,
          chunks: [{ index: 0, text: role === "assistant" ? " \n" : "Pregunta" }],
          complete: true,
        });
      },
    });
    registerConversationMeta(environment, {
      label: "Consulta en curso",
      lastOrdinal: 1,
      closed: false,
      activeQueryId: firstQueryId,
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();

    expect(descriptorStatus).toBe("completed");
    expect(descriptorReads).toBe(1);
    expect(props(app).state).toMatchObject({
      queryStatus: "unconfirmed",
      canContinue: false,
      history: {
        turnsStatus: "ready",
        canContinue: false,
        turns: [
          {
            status: "in_progress",
            answer: " \n",
            answerComplete: true,
            canContinue: false,
            failure: { code: "unconfirmable" },
          },
        ],
      },
    });
  });

  it("keeps a failed partial answer instead of treating its prefix as empty completion", async () => {
    const environment = createHistoryEnvironment({
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: true,
          canContinue: false,
          turns: [
            {
              ...turn(1, firstQueryId),
              status: "failed",
              answerManifest: { count: 1, complete: false },
              cursor: 1,
              failure: { code: "runtime_failed" },
            },
          ],
        }),
      textHandler: ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        return jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: firstQueryId,
          role,
          chunks: [{ index: 0, text: role === "assistant" ? "Prefijo parcial" : "Pregunta" }],
          complete: true,
        });
      },
    });
    registerConversationMeta(environment, {
      label: "Respuesta parcialmente fallida",
      lastOrdinal: 1,
      closed: true,
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    expect(props(app).state).toMatchObject({
      queryStatus: "failed",
      canContinue: false,
      history: {
        turnsStatus: "ready",
        turns: [
          {
            status: "failed",
            answer: "Prefijo parcial",
            answerComplete: true,
            failure: { code: "runtime_failed" },
          },
        ],
      },
    });
  });

  it("keeps a selected old conversation visible behind newer activity after refresh", async () => {
    const forgottenConversationId = "7ed06c25-b5c8-40d0-9b04-f93c2f7e8900";
    const selectedUpdatedAt = "2026-10-01T12:00:00.000Z";
    const recentUpdatedAt = new Date(Date.now() - 60_000).toISOString();
    let listCalls = 0;
    const environment = createHistoryEnvironment({
      listHandler: () => {
        listCalls += 1;
        if (listCalls === 1) {
          return jsonResponse({
            version: 1,
            conversations: [
              {
                conversationId: firstConversationId,
                label: "Conversación antigua",
                updatedAt: selectedUpdatedAt,
                lastOrdinal: 1,
                closed: false,
              },
              {
                conversationId: forgottenConversationId,
                label: "Conversación anterior de otra página",
                updatedAt: "2026-09-30T12:00:00.000Z",
                lastOrdinal: 1,
                closed: false,
              },
            ],
          });
        }
        if (listCalls === 2) {
          return jsonResponse({
            version: 1,
            conversations: [
              {
                conversationId: firstConversationId,
                label: "Conversación antigua",
                updatedAt: selectedUpdatedAt,
                lastOrdinal: 1,
                closed: false,
              },
            ],
          });
        }
        if (listCalls === 3) return jsonResponse({ code: "TEMPORARY_UNAVAILABLE" }, 503);
        return jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: secondConversationId,
              label: "Conversación reciente",
              updatedAt: recentUpdatedAt,
              lastOrdinal: 1,
              closed: false,
            },
          ],
        });
      },
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          label: "Conversación antigua",
          updatedAt: selectedUpdatedAt,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, firstQueryId)],
        }),
      textHandler: turnText,
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    expect(
      props(app).state.history.conversations.map(({ conversationId }) => conversationId),
    ).toEqual([firstConversationId, forgottenConversationId]);
    expect(props(app).state.history.selectedConversationId).toBe(firstConversationId);

    await props(app).onRefreshHistory();
    await app.flush();
    expect(
      props(app).state.history.conversations.map(({ conversationId }) => conversationId),
    ).toEqual([firstConversationId]);

    await props(app).onRefreshHistory();
    await app.flush();
    expect(props(app).state.history.status).toBe("error");
    expect(
      props(app).state.history.conversations.map(({ conversationId }) => conversationId),
    ).toEqual([firstConversationId]);

    await props(app).onRefreshHistory();
    await app.flush();

    expect(
      props(app).state.history.conversations.map(({ conversationId }) => conversationId),
    ).toEqual([secondConversationId, firstConversationId]);
    expect(props(app).state.history.selectedConversationId).toBe(firstConversationId);
    expect(props(app).state.history.conversations[1]).toMatchObject({
      conversationId: firstConversationId,
      updatedAt: selectedUpdatedAt,
    });
    expect(
      props(app).state.history.conversations.some(
        ({ conversationId }) => conversationId === forgottenConversationId,
      ),
    ).toBe(false);
    expect(listCalls).toBe(4);
    expect(environment.runtimeRequests).toEqual([]);
    expect(environment.apiRequests.some((item) => item.method !== "GET")).toBe(false);
  });

  it("keeps a known uncertain message visible after navigating away and refreshing without it", async () => {
    const selectedUpdatedAt = "2026-10-01T12:00:00.000Z";
    const recentUpdatedAt = "2026-10-27T12:00:00.000Z";
    let listCalls = 0;
    const environment = createHistoryEnvironment({
      listHandler: () => {
        listCalls += 1;
        return jsonResponse({
          version: 1,
          conversations:
            listCalls <= 2
              ? [
                  {
                    conversationId: secondConversationId,
                    label: "Actividad reciente",
                    updatedAt: recentUpdatedAt,
                    lastOrdinal: 1,
                    closed: false,
                  },
                  {
                    conversationId: firstConversationId,
                    label: "Actividad antigua",
                    updatedAt: selectedUpdatedAt,
                    lastOrdinal: 1,
                    closed: false,
                  },
                ]
              : [
                  {
                    conversationId: secondConversationId,
                    label: "Actividad reciente",
                    updatedAt: recentUpdatedAt,
                    lastOrdinal: 1,
                    closed: false,
                  },
                ],
        });
      },
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          label:
            conversationId === firstConversationId ? "Actividad antigua" : "Actividad reciente",
          updatedAt: conversationId === firstConversationId ? selectedUpdatedAt : recentUpdatedAt,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, firstQueryId)],
        }),
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: firstQueryId,
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: `Texto ${conversationId}` }],
          complete: true,
        }),
      runtimeHandler: (request) => streamResponse(request, { accepted: false }),
    });
    registerConversationMeta(environment, {
      label: "Actividad antigua",
      lastOrdinal: 1,
      closed: false,
      updatedAt: selectedUpdatedAt,
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    await props(app).onRefreshHistory();
    await app.flush();
    const body = "Follow-up con admisión incierta";
    expect(props(app).onSubmit(body)).toBe(true);
    await app.flush();
    expect(props(app).state.queryStatus).toBe("unconfirmed");
    const originalRequest = environment.runtimeRequests.find(
      ({ headers }) => headers.get("accept") !== "application/json",
    ).request;
    expect(originalRequest).toMatchObject({
      operation: "message",
      conversationId: firstConversationId,
      baseOrdinal: 1,
      text: body,
    });

    expect(await props(app).onSelectConversation(secondConversationId)).toBe(true);
    await app.flush();
    await props(app).onRefreshHistory();
    await app.flush();
    expect(props(app).state.history.selectedConversationId).toBe(secondConversationId);
    expect(
      props(app).state.history.conversations.map(({ conversationId }) => conversationId),
    ).toEqual([secondConversationId, firstConversationId]);
    expect(props(app).state.history.conversations[1]).toMatchObject({
      conversationId: firstConversationId,
      updatedAt: selectedUpdatedAt,
    });
    expect(
      readChatJournals(environment.config, environment.identity).get(firstConversationId),
    ).toMatchObject({ admitted: false, request: { queryId: originalRequest.queryId, text: body } });

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(true);
    await app.flush();
    expect(props(app).state).toMatchObject({
      queryStatus: "unconfirmed",
      canRetry: true,
      question: body,
      history: { selectedConversationId: firstConversationId, turnsStatus: "ready" },
    });
    expect(props(app).onSubmit(body)).toBe(true);
    await app.flush();
    const replayedRequest = environment.runtimeRequests
      .filter(({ headers }) => headers.get("accept") !== "application/json")
      .at(-1).request;
    expect(replayedRequest).toEqual(originalRequest);
  });

  it("keeps a newly admitted conversation ahead of the current page while the index catches up", async () => {
    const recentUpdatedAt = new Date(Date.now() - 60_000).toISOString();
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: secondConversationId,
              label: "Actividad anterior",
              updatedAt: recentUpdatedAt,
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      runtimeHandler: (request) => acceptedOnlyStream(request),
    });
    const app = mount(environment);
    await app.flush();

    expect(props(app).onSubmit("Consulta admitida mientras propaga el índice")).toBe(true);
    await app.flush();
    const request = environment.runtimeRequests.find(
      (item) => item.headers.get("accept") !== "application/json",
    ).request;
    expect(props(app).state.queryStatus).toBe("streaming");

    await props(app).onRefreshHistory();
    await app.flush();

    expect(
      props(app).state.history.conversations.map(({ conversationId }) => conversationId),
    ).toEqual([request.conversationId, secondConversationId]);
    expect(props(app).state.history.conversations[0]).toMatchObject({
      conversationId: request.conversationId,
      lastOrdinal: 1,
      activeQueryId: request.queryId,
    });
    expect(
      readChatJournals(environment.config, environment.identity).get(request.conversationId),
    ).toMatchObject({ admitted: true, request: { queryId: request.queryId } });
  });

  it("records activity at SSE admission and terminal events", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const acceptedAt = new Date("2026-10-27T12:00:00.000Z");
    const terminalAt = new Date("2026-10-27T12:01:00.000Z");
    vi.setSystemTime(acceptedAt);
    const encoder = new TextEncoder();
    let finishTerminal;
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: secondConversationId,
              label: "Actividad anterior",
              updatedAt: "2026-10-27T11:00:00.000Z",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      runtimeHandler: (request) =>
        new Response(
          new ReadableStream({
            start(controller) {
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
              finishTerminal = () => {
                controller.enqueue(
                  encoder.encode(
                    `event: text\ndata: ${JSON.stringify({
                      type: "text",
                      queryId: request.queryId,
                      index: 0,
                      text: "Respuesta durable",
                    })}\n\nevent: completed\ndata: ${JSON.stringify({
                      type: "completed",
                      queryId: request.queryId,
                    })}\n\n`,
                  ),
                );
                controller.close();
              };
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const app = mount(environment);

    try {
      await app.flush();
      expect(props(app).onSubmit("Consulta con actividad SSE")).toBe(true);
      await app.flush();
      const acceptedConversation = props(app).state.history.conversations[0];
      expect(props(app).state.queryStatus).toBe("streaming");
      expect(acceptedConversation.updatedAt).toBe(acceptedAt.toISOString());
      expect(acceptedConversation.activeQueryId).toBe(
        readChatJournals(environment.config, environment.identity).get(
          acceptedConversation.conversationId,
        ).request.queryId,
      );

      vi.setSystemTime(terminalAt);
      finishTerminal();
      await app.flush();

      expect(props(app).state.queryStatus).toBe("completed");
      expect(props(app).state.history.conversations[0]).toMatchObject({
        conversationId: acceptedConversation.conversationId,
        updatedAt: terminalAt.toISOString(),
      });
      expect(props(app).state.history.conversations[0].activeQueryId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an uncertain new send selectable after reset and reload without resending it", async () => {
    const body = "Pending body with its original request identity";
    const environment = createHistoryEnvironment({
      runtimeHandler: (request) => streamResponse(request, { accepted: false }),
    });
    const app = mount(environment);
    await app.flush();

    expect(props(app).onSubmit(body)).toBe(true);
    await app.flush();
    const request = environment.runtimeRequests.find(
      (item) => item.headers.get("accept") !== "application/json",
    ).request;
    expect(props(app).state.queryStatus).toBe("unconfirmed");
    expect(
      readChatJournals(environment.config, environment.identity).get(request.conversationId),
    ).toMatchObject({
      admitted: false,
      request: { conversationId: request.conversationId, queryId: request.queryId, text: body },
    });

    props(app).onReset();
    await app.flush();
    expect(await app.html()).toContain("Sin confirmar");
    expect(await app.html()).toContain(body);
    expect(props(app).onSelectConversation(request.conversationId)).toBeTruthy();
    await app.flush();
    expect(props(app).state).toMatchObject({
      queryStatus: "unconfirmed",
      queryId: request.queryId,
      question: body,
      history: { selectedConversationId: request.conversationId },
    });

    const reloaded = mount(environment);
    await reloaded.flush();
    expect(props(reloaded).state).toMatchObject({
      queryStatus: "unconfirmed",
      queryId: request.queryId,
      question: body,
      history: { selectedConversationId: request.conversationId },
    });
    expect(environment.apiRequests.filter((item) => item.path.endsWith("/turns"))).toHaveLength(0);
    expect(
      environment.runtimeRequests.filter(
        (item) => item.headers.get("accept") !== "application/json",
      ),
    ).toHaveLength(1);
  });

  it("removes a start rejected before admission from the history projection", async () => {
    const environment = createHistoryEnvironment({
      runtimeHandler: () =>
        jsonResponse({
          type: "failed",
          code: "capacity_exceeded",
          message: "The request cannot be admitted.",
          recordStatus: "not_admitted",
        }),
    });
    const app = mount(environment);
    await app.flush();

    expect(props(app).onSubmit("Rejected before admission")).toBe(true);
    await app.flush();
    expect(props(app).state.queryStatus).toBe("rejected");
    expect(readChatJournals(environment.config, environment.identity).size).toBe(0);
    expect(props(app).state.history.conversations).toEqual([]);

    props(app).onReset();
    await app.flush();
    await props(app).onRefreshHistory();
    await app.flush();
    expect(props(app).state.history.conversations).toEqual([]);
    expect(await app.html()).not.toContain("Sin confirmar");
  });

  it("preserves the existing conversation projection when a follow-up is rejected", async () => {
    const environment = createHistoryEnvironment({
      listHandler: historyList,
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: true,
          turns: [turn()],
        }),
      textHandler: turnText,
      runtimeHandler: () =>
        jsonResponse({
          type: "failed",
          code: "capacity_exceeded",
          message: "The request cannot be admitted.",
          recordStatus: "not_admitted",
        }),
    });
    const app = mount(environment);
    await app.flush();
    await props(app).onSelectConversation(firstConversationId);
    await app.flush();

    expect(props(app).onSubmit("Rejected follow-up")).toBe(true);
    await app.flush();
    expect(props(app).state.history.conversations[0]).toMatchObject({
      conversationId: firstConversationId,
      label: "Conversación anterior",
      lastOrdinal: 2,
      closed: false,
    });
    expect(props(app).state.history.conversations[0].pending).toBeUndefined();
  });

  it.each(["capacity_exceeded", "storage_capacity_exceeded"])(
    "carries a rejected follow-up draft into a clean new conversation after %s",
    async (code) => {
      const body = `Keep this draft after ${code}`;
      const environment = createHistoryEnvironment({
        listHandler: historyList,
        turnsHandler: ({ conversationId }) =>
          jsonResponse({
            version: 1,
            conversationId,
            throughOrdinal: 2,
            closed: false,
            canContinue: true,
            turns: [turn()],
          }),
        textHandler: turnText,
        runtimeHandler: () =>
          jsonResponse({
            type: "failed",
            code,
            message: "The request cannot be admitted.",
            recordStatus: "not_admitted",
          }),
      });
      const app = mount(environment);
      await app.flush();
      await props(app).onSelectConversation(firstConversationId);
      await app.flush();

      props(app).onDraftChange(body);
      await app.flush();
      expect(props(app).onSubmit(body)).toBe(true);
      await app.flush();
      expect(props(app).state).toMatchObject({ queryStatus: "rejected", draft: body });

      props(app).onReset();
      await app.flush();
      expect(props(app).state).toMatchObject({
        queryStatus: "idle",
        draft: body,
        history: { selectedConversationId: null, turns: [] },
      });
      expect(props(app).state).not.toHaveProperty("queryId");
      expect(props(app).state).not.toHaveProperty("question");
      expect(props(app).state).not.toHaveProperty("answer");
      expect(props(app).state.history.conversations).toMatchObject([
        { conversationId: firstConversationId },
      ]);
    },
  );

  it("keeps a rejected start draft when returning to a clean home chat", async () => {
    const body = "Keep this rejected start draft";
    const environment = createHistoryEnvironment({
      runtimeHandler: () =>
        jsonResponse({
          type: "failed",
          code: "storage_capacity_exceeded",
          message: "The request cannot be admitted.",
          recordStatus: "not_admitted",
        }),
    });
    const app = mount(environment);
    await app.flush();
    props(app).onDraftChange(body);
    await app.flush();
    expect(props(app).onSubmit(body)).toBe(true);
    await app.flush();

    props(app).onReset();
    await app.flush();
    expect(props(app).state).toMatchObject({
      queryStatus: "idle",
      draft: body,
      history: { selectedConversationId: null, turns: [], conversations: [] },
    });
    expect(props(app).state).not.toHaveProperty("queryId");
    expect(props(app).state).not.toHaveProperty("question");
    expect(props(app).state).not.toHaveProperty("answer");
  });

  it("does not restore an older new-chat draft after the rejected draft was explicitly cleared", async () => {
    const environment = createHistoryEnvironment({
      listHandler: historyList,
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: true,
          turns: [turn()],
        }),
      textHandler: turnText,
      runtimeHandler: () =>
        jsonResponse({
          type: "failed",
          code: "capacity_exceeded",
          message: "The request cannot be admitted.",
          recordStatus: "not_admitted",
        }),
    });
    const app = mount(environment);
    await app.flush();
    props(app).onDraftChange("An older, separate new-chat draft");
    await app.flush();
    await props(app).onSelectConversation(firstConversationId);
    await app.flush();

    const rejectedDraft = "A follow-up that cannot fit";
    props(app).onDraftChange(rejectedDraft);
    await app.flush();
    expect(props(app).onSubmit(rejectedDraft)).toBe(true);
    await app.flush();
    expect(props(app).state.queryStatus).toBe("rejected");
    props(app).onDraftChange("");
    await app.flush();

    props(app).onReset();
    await app.flush();
    expect(props(app).state).toMatchObject({
      queryStatus: "idle",
      draft: "",
      history: { selectedConversationId: null, turns: [] },
    });
  });

  it("recovers a selected active turn from a valid in-memory journal when storage reads fail", async () => {
    const environment = createHistoryEnvironment({
      listHandler: historyList,
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: false,
          turns: [
            {
              ...turn(2),
              status: "in_progress",
              answerManifest: { count: 0, complete: true },
              cursor: 0,
            },
          ],
        }),
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: url.searchParams.get("queryId"),
          role: url.searchParams.get("role"),
          chunks: [
            {
              index: 0,
              text: url.searchParams.get("role") === "user" ? "Original question" : "",
            },
          ],
          complete: true,
        }),
      recoverHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 2,
          status: "completed",
          question: "Original question",
          answer: "Recovered final answer",
          canContinue: true,
        }),
    });
    const app = mount(environment);
    await app.flush();
    environment.storage.getItem = () => {
      throw new DOMException("Storage is unavailable", "SecurityError");
    };

    await props(app).onSelectConversation(firstConversationId);
    await app.flush();
    expect(props(app).state).toMatchObject({
      queryStatus: "completed",
      answer: "Recovered final answer",
      history: { selectedConversationId: firstConversationId },
    });
    expect(
      environment.runtimeRequests.filter(
        (item) => item.headers.get("accept") === "application/json",
      ),
    ).toHaveLength(1);
    expect(
      environment.runtimeRequests.filter(
        (item) => item.headers.get("accept") !== "application/json",
      ),
    ).toHaveLength(0);

    const runtimeRequestCount = environment.runtimeRequests.length;
    props(app).onDraftChange("A separate new request");
    await app.flush();
    expect(props(app).onSubmit("A separate new request")).toBe(false);
    await app.flush();
    expect(environment.runtimeRequests).toHaveLength(runtimeRequestCount);
  });

  it("uses selected META presentation metadata instead of a recent turn question", async () => {
    const environment = createHistoryEnvironment({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: secondConversationId,
              label: "Another conversation",
              lastOrdinal: 1,
              closed: false,
            },
            {
              conversationId: firstConversationId,
              label: "Stale index label",
              updatedAt: "2026-10-20T10:00:00.000Z",
              lastOrdinal: 19,
              closed: false,
            },
          ],
        }),
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          label: "Authoritative first question",
          createdAt: "2026-10-18T10:00:00.000Z",
          updatedAt: "2026-10-24T12:00:00.000Z",
          throughOrdinal: 20,
          closed: false,
          canContinue: true,
          turns: [turn(20)],
        }),
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: url.searchParams.get("queryId"),
          role: url.searchParams.get("role"),
          chunks: [
            {
              index: 0,
              text: url.searchParams.get("role") === "user" ? "QUESTION_20" : "ANSWER_20",
            },
          ],
          complete: true,
        }),
    });
    const app = mount(environment);
    await app.flush();

    await props(app).onSelectConversation(firstConversationId);
    await app.flush();

    expect(
      props(app).state.history.conversations.find(
        (conversation) => conversation.conversationId === firstConversationId,
      ),
    ).toMatchObject({
      label: "Authoritative first question",
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-24T12:00:00.000Z",
    });
    expect(
      props(app).state.history.conversations.find(
        (conversation) => conversation.conversationId === secondConversationId,
      ).label,
    ).toBe("Another conversation");
  });

  it.each([
    [
      "preserves a prior label",
      [
        {
          conversationId: firstConversationId,
          label: "Saved label",
          lastOrdinal: 19,
          closed: false,
        },
      ],
      "Saved label",
    ],
    ["uses a clear placeholder when there is no prior label", [], "Conversación seleccionada"],
  ])(
    "does not derive a first-question label from a recent page: %s",
    async (_scenario, listed, expectedLabel) => {
      const environment = createHistoryEnvironment({
        listHandler: () => jsonResponse({ version: 1, conversations: listed }),
        turnsHandler: ({ conversationId }) =>
          jsonResponse({
            version: 1,
            conversationId,
            throughOrdinal: 20,
            closed: false,
            canContinue: true,
            turns: [turn(20)],
          }),
        textHandler: ({ conversationId, ordinal, url }) =>
          jsonResponse({
            version: 1,
            conversationId,
            ordinal,
            queryId: url.searchParams.get("queryId"),
            role: url.searchParams.get("role"),
            chunks: [{ index: 0, text: "QUESTION_20" }],
            complete: true,
          }),
      });
      if (listed.length === 0) {
        registerConversationMeta(environment, {
          label: "Conversación seleccionada",
          lastOrdinal: 20,
          closed: false,
        });
      }
      const app = mount(environment);
      await app.flush();

      await props(app).onSelectConversation(firstConversationId);
      await app.flush();

      expect(
        props(app).state.history.conversations.find(
          (conversation) => conversation.conversationId === firstConversationId,
        ).label,
      ).toBe(expectedLabel);
    },
  );

  it("rejects malformed selected-history presentation metadata", async () => {
    const environment = createHistoryEnvironment({
      listHandler: historyList,
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          label: "Valid label",
          updatedAt: "not-a-date",
          throughOrdinal: 2,
          closed: false,
          canContinue: true,
          turns: [turn()],
        }),
      textHandler: turnText,
    });
    const app = mount(environment);
    await app.flush();

    expect(await props(app).onSelectConversation(firstConversationId)).toBe(false);
    await app.flush();
    expect(props(app).state.history.turnsStatus).toBe("error");
    expect(props(app).state.history.turnsError).toContain("No pudimos abrir");
  });

  it("restarts a cancelled initial list and restores a cancelled refresh on return from profile", async () => {
    const initial = deferred();
    const refresh = deferred();
    let listCalls = 0;
    const environment = createHistoryEnvironment({
      listHandler: () => {
        listCalls += 1;
        if (listCalls === 1) return initial.promise;
        if (listCalls === 3) return refresh.promise;
        return historyList();
      },
    });
    const app = mount(environment);
    await app.flush();
    expect(props(app).state.history.status).toBe("loading");

    await app.setRoute("profile");
    initial.resolve(historyList());
    await app.flush();
    await app.setRoute("chat");
    await app.flush();
    expect(listCalls).toBe(2);
    expect(props(app).state.history).toMatchObject({ status: "ready", loadingMore: false });
    expect(props(app).state.history.conversations[0].conversationId).toBe(firstConversationId);

    const pendingRefresh = props(app).onRefreshHistory();
    await app.flush();
    expect(props(app).state.history).toMatchObject({ status: "loading", loadingMore: true });
    await app.setRoute("profile");
    refresh.resolve(historyList());
    await pendingRefresh;
    await app.setRoute("chat");
    await app.flush();
    expect(props(app).state.history).toMatchObject({ status: "ready", loadingMore: false });
    expect(props(app).state.history.selectedConversationId).toBeNull();
    expect(props(app).state.history.conversations[0].conversationId).toBe(firstConversationId);
    expect(listCalls).toBe(3);

    await props(app).onRefreshHistory();
    await app.flush();
    expect(listCalls).toBe(4);
    expect(props(app).state.history).toMatchObject({ status: "ready", loadingMore: false });
  });

  it("preserves an explicit new-chat selection and its draft when returning from profile", async () => {
    let request;
    const environment = createHistoryEnvironment({
      runtimeHandler: (nextRequest) => {
        request = nextRequest;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: accepted\ndata: ${JSON.stringify({
                    type: "accepted",
                    conversationId: nextRequest.conversationId,
                    queryId: nextRequest.queryId,
                    ordinal: 1,
                  })}\n\n`,
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: false,
          turns: [
            {
              ordinal: 1,
              queryId: request.queryId,
              status: "in_progress",
              questionManifest: { count: 1, complete: true },
              answerManifest: { count: 0, complete: false },
              cursor: 0,
            },
          ],
        }),
      textHandler: ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: request.queryId,
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: request.text }],
          complete: true,
        }),
      recoverHandler: (recoverRequest) =>
        jsonResponse({
          version: 2,
          conversationId: recoverRequest.conversationId,
          queryId: recoverRequest.queryId,
          ordinal: 1,
          status: "in_progress",
          question: request.text,
          answer: "",
          canContinue: false,
        }),
    });
    const app = mount(environment);
    await app.flush();
    expect(props(app).onSubmit("Older active request")).toBe(true);
    await app.flush();
    expect(props(app).state.queryStatus).toBe("streaming");

    props(app).onReset();
    await app.flush();
    props(app).onDraftChange("UNSENT_NEW_DRAFT");
    await app.flush();
    expect(props(app).state.history.selectedConversationId).toBeNull();
    expect(props(app).state.draft).toBe("UNSENT_NEW_DRAFT");

    await app.setRoute("profile");
    await app.setRoute("chat");
    await app.flush();
    expect(props(app).state.history.selectedConversationId).toBeNull();
    expect(props(app).state.question).toBeUndefined();
    expect(props(app).state.draft).toBe("UNSENT_NEW_DRAFT");
  });

  it("keeps a new-chat draft when the original history request completes after reset", async () => {
    const initialList = deferred();
    let request;
    const environment = createHistoryEnvironment({
      listHandler: () => initialList.promise,
      runtimeHandler: (nextRequest) => {
        request = nextRequest;
        return acceptedOnlyStream(nextRequest);
      },
    });
    const app = mount(environment);
    await app.flush();
    expect(props(app).state.history.status).toBe("loading");

    expect(props(app).onSubmit("Accepted request A")).toBe(true);
    await app.flush();
    expect(props(app).state.queryStatus).toBe("streaming");

    props(app).onReset();
    await app.flush();
    props(app).onDraftChange("UNSENT_NEW_DRAFT");
    await app.flush();
    initialList.resolve(historyList());
    await app.flush();

    expect(props(app).state.history.selectedConversationId).toBeNull();
    expect(props(app).state.question).toBeUndefined();
    expect(props(app).state.draft).toBe("UNSENT_NEW_DRAFT");
    expect(
      readChatJournals(environment.config, environment.identity).get(request.conversationId),
    ).toMatchObject({
      admitted: true,
      request: { conversationId: request.conversationId, queryId: request.queryId },
    });
  });

  it("keeps a new-chat draft when the original history request fails after reset", async () => {
    const initialList = deferred();
    const environment = createHistoryEnvironment({
      listHandler: () => initialList.promise,
      runtimeHandler: (request) => acceptedOnlyStream(request),
    });
    const app = mount(environment);
    await app.flush();
    expect(props(app).state.history.status).toBe("loading");

    expect(props(app).onSubmit("Accepted request A")).toBe(true);
    await app.flush();
    props(app).onReset();
    await app.flush();
    props(app).onDraftChange("UNSENT_NEW_DRAFT");
    await app.flush();
    initialList.resolve(jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503));
    await app.flush();

    expect(props(app).state.history).toMatchObject({ status: "error", loadingMore: false });
    expect(props(app).state.history.selectedConversationId).toBeNull();
    expect(props(app).state.question).toBeUndefined();
    expect(props(app).state.draft).toBe("UNSENT_NEW_DRAFT");
  });

  it("does not cold-select an active journal after refresh supersedes initial history loading", async () => {
    const initialList = deferred();
    let listCalls = 0;
    let request;
    const environment = createHistoryEnvironment({
      listHandler: () => {
        listCalls += 1;
        return listCalls === 1 ? initialList.promise : historyList();
      },
      runtimeHandler: (nextRequest) => {
        request = nextRequest;
        return acceptedOnlyStream(nextRequest);
      },
    });
    const app = mount(environment);
    await app.flush();
    expect(props(app).state.history.status).toBe("loading");

    expect(props(app).onSubmit("Accepted request A")).toBe(true);
    await app.flush();
    props(app).onReset();
    await app.flush();
    props(app).onDraftChange("UNSENT_NEW_DRAFT");
    await app.flush();

    await props(app).onRefreshHistory();
    await app.flush();
    expect(listCalls).toBe(2);
    expect(props(app).state.history.selectedConversationId).toBeNull();
    expect(props(app).state.draft).toBe("UNSENT_NEW_DRAFT");

    await app.setRoute("profile");
    await app.setRoute("chat");
    await app.flush();

    expect(listCalls).toBe(2);
    expect(props(app).state.history.selectedConversationId).toBeNull();
    expect(props(app).state.question).toBeUndefined();
    expect(props(app).state.draft).toBe("UNSENT_NEW_DRAFT");
    expect(
      readChatJournals(environment.config, environment.identity).get(request.conversationId),
    ).toMatchObject({ admitted: true });
  });

  it("keeps a cold pending journal selectable when refresh replaces the initial list", async () => {
    const initialList = deferred();
    let listCalls = 0;
    const body = "Original uncertain request";
    const request = {
      version: 2,
      operation: "start",
      conversationId: firstConversationId,
      queryId: firstQueryId,
      baseOrdinal: 0,
      text: body,
    };
    const environment = createHistoryEnvironment({
      listHandler: () => {
        listCalls += 1;
        return listCalls === 1
          ? initialList.promise
          : jsonResponse({ version: 1, conversations: [] });
      },
      runtimeHandler: (nextRequest) => acceptedOnlyStream(nextRequest),
    });
    writePendingChatJournal(environment.config, environment.identity, request);
    const app = mount(environment);
    await app.flush();

    expect(props(app).state.history.conversations).toMatchObject([
      {
        conversationId: firstConversationId,
        pending: true,
      },
    ]);
    expect(props(app).state.history.selectedConversationId).toBe(firstConversationId);
    expect(props(app).state.queryStatus).toBe("unconfirmed");
    expect(await app.html()).not.toContain("Quitar del historial");
    expect(
      environment.runtimeRequests.filter(
        (item) => item.headers.get("accept") !== "application/json",
      ),
    ).toHaveLength(0);

    props(app).onReset();
    await app.flush();
    props(app).onDraftChange("UNSENT_NEW_DRAFT");
    await app.flush();
    await props(app).onRefreshHistory();
    await app.flush();
    await app.setRoute("profile");
    await app.setRoute("chat");
    await app.flush();

    expect(listCalls).toBe(2);
    expect(props(app).state.history.conversations).toMatchObject([
      {
        conversationId: firstConversationId,
        pending: true,
      },
    ]);
    expect(props(app).state.history.selectedConversationId).toBeNull();
    expect(props(app).state.question).toBeUndefined();
    expect(props(app).state.draft).toBe("UNSENT_NEW_DRAFT");
    expect(
      readChatJournals(environment.config, environment.identity).get(firstConversationId),
    ).toMatchObject({
      admitted: false,
      request: { conversationId: firstConversationId, queryId: firstQueryId, text: body },
    });
    expect(
      environment.runtimeRequests.filter(
        (item) => item.headers.get("accept") !== "application/json",
      ),
    ).toHaveLength(0);

    initialList.resolve(jsonResponse({ version: 1, conversations: [] }));
    await app.flush();
    expect(props(app).state.history.selectedConversationId).toBeNull();
    expect(props(app).state.draft).toBe("UNSENT_NEW_DRAFT");
  });

  it("resumes a selected conversation read after leaving chat while its initial open is pending", async () => {
    const firstOpen = deferred();
    let turnsCalls = 0;
    const page = (ordinal) => ({
      version: 1,
      conversationId: firstConversationId,
      throughOrdinal: ordinal,
      closed: false,
      canContinue: true,
      turns: [
        {
          ...turn(ordinal),
          questionManifest: { count: 1, complete: true },
          answerManifest: { count: 1, complete: true },
          cursor: 1,
        },
      ],
    });
    const environment = createHistoryEnvironment({
      listHandler: historyList,
      turnsHandler: () => {
        turnsCalls += 1;
        return turnsCalls === 1 ? firstOpen.promise : jsonResponse(page(1));
      },
      textHandler: ({ ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId: firstConversationId,
          ordinal,
          queryId: firstQueryId,
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: `${url.searchParams.get("role")}-${ordinal}` }],
          complete: true,
        }),
    });
    registerConversationMeta(environment, {
      label: "Conversación anterior",
      lastOrdinal: 2,
      closed: false,
    });
    writeChatSelection(environment.config, environment.identity, firstConversationId);
    const app = mount(environment);
    await app.flush();
    expect(turnsCalls).toBe(1);
    expect(props(app).state.history).toMatchObject({
      selectedConversationId: firstConversationId,
      turnsStatus: "loading",
      openingConversationId: firstConversationId,
    });

    await app.setRoute("profile");
    await app.setRoute("chat");
    await app.flush();
    expect(turnsCalls).toBe(2);
    expect(props(app).state.history.turns).toMatchObject([
      { ordinal: 1, question: "user-1", answer: "assistant-1" },
    ]);

    firstOpen.resolve(jsonResponse(page(2)));
    await app.flush();
    expect(props(app).state.history.turns).toMatchObject([
      { ordinal: 1, question: "user-1", answer: "assistant-1" },
    ]);
    expect(props(app).state.history).toMatchObject({
      selectedConversationId: firstConversationId,
      turnsStatus: "ready",
    });
  });

  it.each([
    ["successful load", () => historyList(), "ready"],
    ["transient error", () => jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503), "error"],
  ])(
    "keeps a new-chat choice across a cancelled initialization retry after %s",
    async (_, makeResponse, status) => {
      const firstList = deferred();
      const returnedList = deferred();
      let listCalls = 0;
      const environment = createHistoryEnvironment({
        listHandler: () => {
          listCalls += 1;
          return listCalls === 1 ? firstList.promise : returnedList.promise;
        },
        runtimeHandler: (request) => acceptedOnlyStream(request),
      });
      registerConversationMeta(environment, {
        conversationId: "33333333-3333-4333-8333-333333333333",
        label: "Accepted request A",
        lastOrdinal: 1,
        closed: false,
        activeQueryId: "44444444-4444-4444-8444-444444444444",
      });
      const app = mount(environment);
      await app.flush();

      expect(props(app).onSubmit("Accepted request A")).toBe(true);
      await app.flush();
      props(app).onReset();
      await app.flush();
      props(app).onDraftChange("UNSENT_NEW_DRAFT");
      await app.flush();

      await app.setRoute("profile");
      await app.setRoute("chat");
      expect(listCalls).toBe(2);
      returnedList.resolve(makeResponse());
      await app.flush();

      expect(props(app).state.history.status).toBe(status);
      expect(props(app).state.history.selectedConversationId).toBeNull();
      expect(props(app).state.question).toBeUndefined();
      expect(props(app).state.draft).toBe("UNSENT_NEW_DRAFT");
    },
  );

  it("shows and retries an earlier-page failure while retaining already loaded turns", async () => {
    let olderCalls = 0;
    const environment = createHistoryEnvironment({
      listHandler: historyList,
      turnsHandler: ({ conversationId, url }) => {
        if (url.searchParams.get("cursor") === "older") {
          olderCalls += 1;
          if (olderCalls === 1) return jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503);
          return jsonResponse({
            version: 1,
            conversationId,
            throughOrdinal: 1,
            closed: false,
            canContinue: true,
            turns: [turn(1, secondQueryId)],
          });
        }
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: true,
          turns: [turn()],
          nextCursor: "older",
        });
      },
      textHandler: turnText,
    });
    const app = mount(environment);
    await app.flush();
    await props(app).onSelectConversation(firstConversationId);
    await app.flush();

    await props(app).onLoadEarlierTurns();
    await app.flush();
    let html = await app.html();
    expect(props(app).state.history).toMatchObject({
      turnsStatus: "ready",
      turnsNextCursor: "older",
    });
    expect(html).toContain("ORIGINAL_TEXT_2");
    expect(html).toContain('role="alert"');
    expect(html).toContain("No pudimos abrir la conversación");
    expect(html).toContain("Reintentar");

    await props(app).onLoadEarlierTurns();
    await app.flush();
    html = await app.html();
    expect(olderCalls).toBe(2);
    expect(props(app).state.history.turns.map((item) => item.ordinal)).toEqual([1, 2]);
    expect(html).toContain("ORIGINAL_TEXT_1");
    expect(html).toContain("ORIGINAL_TEXT_2");
    expect(html).not.toContain("No pudimos abrir la conversación");
  });

  it("shows first-open loading and errors even when the profile is incomplete", async () => {
    const opening = deferred();
    const environment = createHistoryEnvironment({
      profileComplete: false,
      listHandler: historyList,
      turnsHandler: () => opening.promise,
    });
    const app = mount(environment);
    await app.flush();
    const select = props(app).onSelectConversation(firstConversationId);
    await app.flush();
    expect(await app.html()).toContain("Cargando conversación…");

    opening.resolve(jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503));
    await select;
    await app.flush();
    expect(props(app).state.history.turnsStatus).toBe("error");
    expect(await app.html()).toContain("No pudimos abrir la conversación");
  });

  it.each([401, 403])(
    "clears transcript and journals after an earlier-page %s denial",
    async (status) => {
      const environment = createHistoryEnvironment({
        listHandler: historyList,
        turnsHandler: ({ conversationId, url }) =>
          url.searchParams.get("cursor")
            ? jsonResponse({ code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" }, status)
            : jsonResponse({
                version: 1,
                conversationId,
                throughOrdinal: 2,
                closed: false,
                canContinue: true,
                turns: [turn()],
                nextCursor: "older",
              }),
        textHandler: turnText,
      });
      const app = mount(environment);
      await app.flush();
      await props(app).onSelectConversation(firstConversationId);
      await app.flush();
      writePendingChatJournal(environment.config, environment.identity, {
        version: 2,
        operation: "message",
        conversationId: secondConversationId,
        queryId: secondQueryId,
        baseOrdinal: 1,
        text: "another indexed request",
      });
      markChatJournalAdmitted(
        environment.config,
        environment.identity,
        {
          version: 2,
          operation: "message",
          conversationId: secondConversationId,
          queryId: secondQueryId,
          baseOrdinal: 1,
        },
        2,
      );

      await props(app).onLoadEarlierTurns();
      await app.flush();
      expect(await app.html()).not.toContain("ORIGINAL_TEXT_2");
      expect(readChatJournals(environment.config, environment.identity).size).toBe(0);
      expect(props(app).state.view).toBe(status === 401 ? "login" : "denied");
      expect(environment.session.signOut).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    },
  );

  it("indexes an active journal discovered from history so sign-out removes every reference", async () => {
    const environment = createHistoryEnvironment({
      listHandler: historyList,
      turnsHandler: ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: false,
          turns: [
            {
              ...turn(),
              status: "in_progress",
              answerManifest: { count: 1, complete: false },
            },
          ],
        }),
      textHandler: turnText,
      recoverHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 2,
          status: "in_progress",
          question: "original question",
          answer: "durable prefix",
          canContinue: false,
        }),
    });
    const app = mount(environment);
    await app.flush();
    await props(app).onSelectConversation(firstConversationId);
    await app.flush();
    expect(
      readChatJournals(environment.config, environment.identity).get(firstConversationId),
    ).toMatchObject({
      admitted: true,
      request: { queryId: firstQueryId },
    });
    expect(props(app).state.history.conversations[0]).toMatchObject({
      activeQueryId: firstQueryId,
      closed: false,
    });
    expect(props(app).state.history.conversations[0].pending).toBeUndefined();

    props(app).onSignOut();
    await app.flush();
    expect(readChatJournals(environment.config, environment.identity).size).toBe(0);
    expect([...environment.storage.values.keys()].some((key) => key.includes(":entry:"))).toBe(
      false,
    );
  });

  it("labels an in-progress POST snapshot as active instead of closed", async () => {
    const environment = createHistoryEnvironment({
      runtimeHandler: (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 1,
          status: "in_progress",
          question: request.text,
          answer: "prefix",
          canContinue: false,
        }),
    });
    const app = mount(environment);
    await app.flush();
    expect(props(app).onSubmit("A request that is still running")).toBe(true);
    await app.flush();
    const request = environment.runtimeRequests.find(
      (item) => item.headers.get("accept") !== "application/json",
    ).request;
    expect(props(app).state.queryStatus).toBe("streaming");
    expect(props(app).state.history.conversations[0]).toMatchObject({
      conversationId: request.conversationId,
      activeQueryId: request.queryId,
      closed: false,
    });
    expect(await app.html()).toContain("· En curso");
    expect(await app.html()).not.toContain("· Cerrada");
  });

  it("minimizes an accepted journal without rewriting its existing index", () => {
    const environment = createHistoryEnvironment();
    const firstPending = {
      version: 2,
      operation: "message",
      conversationId: firstConversationId,
      queryId: firstQueryId,
      baseOrdinal: 1,
      text: "first pending body",
    };
    const secondPending = {
      version: 2,
      operation: "message",
      conversationId: secondConversationId,
      queryId: secondQueryId,
      baseOrdinal: 1,
      text: "second pending body",
    };
    writePendingChatJournal(environment.config, environment.identity, firstPending);
    writePendingChatJournal(environment.config, environment.identity, secondPending);
    const indexKey = [...environment.storage.values.keys()].find((key) => key.includes(":index:"));
    const previousIndex = environment.storage.getItem(indexKey);
    const originalSetItem = environment.storage.setItem.bind(environment.storage);
    let indexWritten = false;
    environment.storage.setItem = (key, value) => {
      if (String(key) === indexKey) indexWritten = true;
      originalSetItem(key, value);
    };

    markChatJournalAdmitted(environment.config, environment.identity, secondPending, 2);
    expect(indexWritten).toBe(false);
    expect(environment.storage.getItem(indexKey)).toBe(previousIndex);
    expect([...environment.storage.values.values()].join()).not.toContain(secondPending.text);
    const journals = readChatJournals(environment.config, environment.identity);
    expect(journals.size).toBe(2);
    expect(journals.get(firstConversationId)).toMatchObject({ admitted: false });
    expect(journals.get(secondConversationId)).toMatchObject({
      admitted: true,
      request: { queryId: secondQueryId },
    });
    expect(journals.get(secondConversationId).request).not.toHaveProperty("text");
    clearChatJournal(environment.config, environment.identity);
  });

  it("removes a newly discovered entry when index registration fails and keeps other journals", () => {
    const environment = createHistoryEnvironment();
    const firstPending = {
      version: 2,
      operation: "message",
      conversationId: firstConversationId,
      queryId: firstQueryId,
      baseOrdinal: 1,
      text: "preserved pending body",
    };
    const discoveredRequest = {
      version: 2,
      operation: "message",
      conversationId: secondConversationId,
      queryId: secondQueryId,
      baseOrdinal: 1,
    };
    writePendingChatJournal(environment.config, environment.identity, firstPending);
    const indexKey = [...environment.storage.values.keys()].find((key) => key.includes(":index:"));
    const ownerKey = [...environment.storage.values.keys()].find((key) => key.includes(":owner:"));
    const previousIndex = environment.storage.getItem(indexKey);
    const previousOwner = environment.storage.getItem(ownerKey);
    const originalSetItem = environment.storage.setItem.bind(environment.storage);
    let rejectIndexUpdate = true;
    environment.storage.setItem = (key, value) => {
      if (rejectIndexUpdate && String(key) === indexKey) {
        rejectIndexUpdate = false;
        throw new DOMException("Storage is unavailable", "QuotaExceededError");
      }
      originalSetItem(key, value);
    };

    expect(() =>
      markChatJournalAdmitted(environment.config, environment.identity, discoveredRequest, 2),
    ).toThrow();
    expect(environment.storage.getItem(indexKey)).toBe(previousIndex);
    expect(environment.storage.getItem(ownerKey)).toBe(previousOwner);
    expect(
      [...environment.storage.values.keys()].some((key) => key.includes(secondConversationId)),
    ).toBe(false);
    const journals = readChatJournals(environment.config, environment.identity);
    expect(journals.size).toBe(1);
    expect(journals.get(firstConversationId)).toMatchObject({
      admitted: false,
      request: { text: firstPending.text },
    });
    clearChatJournal(environment.config, environment.identity);
  });
});
