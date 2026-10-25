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
  streamResponse,
} from "../support/history-web-harness.mjs";
import {
  clearChatJournal,
  markChatJournalAdmitted,
  readChatJournals,
  writePendingChatJournal,
} from "../../web/chat-journal.ts";

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

const props = (app) => app.current()?.props;
const mount = (environment) => {
  const app = mountHistoryAccountApp(environment, AccountApp);
  apps.push(app);
  return app;
};

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

describe("phase 7 frontend repair regressions", () => {
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
