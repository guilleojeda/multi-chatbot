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
  markChatJournalAdmitted,
  readChatJournals,
  writeChatSelection,
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete globalThis.__accountHooks;
  delete globalThis.__accountScreens;
  delete globalThis.__accountSession;
});

describe("AccountApp history text cursor regressions", () => {
  it("loads a large turn page without bursting the text API into 503 responses", async () => {
    let activeTextReads = 0;
    let maximumTextReads = 0;
    let totalTextReads = 0;
    const turns = Array.from({ length: 7 }, (_, index) => {
      const ordinal = index + 16;
      return {
        ordinal,
        queryId: `550e8400-e29b-41d4-a716-${String(ordinal).padStart(12, "0")}`,
        status: "completed",
        questionManifest: { count: 1, complete: true },
        answerManifest: { count: 1, complete: true },
        cursor: 1,
      };
    });
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Página de siete",
              lastOrdinal: 22,
              closed: false,
            },
          ],
        }),
      turnsHandler: async ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 22,
          closed: false,
          canContinue: true,
          turns,
          nextCursor: "earlier-turns",
        }),
      textHandler: async ({ conversationId, ordinal, url }) => {
        activeTextReads += 1;
        totalTextReads += 1;
        maximumTextReads = Math.max(maximumTextReads, activeTextReads);
        await new Promise((resolve) => setImmediate(resolve));
        const overloaded = activeTextReads > 4;
        activeTextReads -= 1;
        if (overloaded) return jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503);
        const role = url.searchParams.get("role");
        return jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: turns.find((turn) => turn.ordinal === ordinal)?.queryId,
          role,
          chunks: [{ index: 0, text: `${ordinal}-${role}` }],
          complete: true,
        });
      },
    });
    const app = mountHistoryAccountApp(environment, AccountApp);
    apps.push(app);
    await app.flush();

    expect(await app.current()?.props?.onSelectConversation?.(firstConversationId)).toBe(true);
    await app.flush();
    expect(maximumTextReads).toBeLessThanOrEqual(4);
    expect(totalTextReads).toBe(14);
    expect(app.current()?.props?.state?.history).toMatchObject({
      selectedConversationId: firstConversationId,
      turnsStatus: "ready",
      turns: turns.map(({ ordinal, queryId }) => ({ ordinal, queryId })),
    });
    expect(environment.runtimeRequests).toEqual([]);
  });

  it("skips empty turn pages during open and earlier-page load without starting Runtime", async () => {
    const cursors = [];
    const descriptor = (ordinal, queryId) => ({
      ordinal,
      queryId,
      status: "completed",
      questionManifest: { count: 1, complete: true },
      answerManifest: { count: 1, complete: true },
      cursor: 1,
    });
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Historial paginado",
              lastOrdinal: 2,
              closed: true,
            },
          ],
        }),
      turnsHandler: async ({ conversationId, url }) => {
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor);
        const metadata = (throughOrdinal, closed, canContinue) => ({
          version: 1,
          conversationId,
          throughOrdinal,
          closed,
          canContinue,
        });
        if (cursor === null) {
          return jsonResponse({
            ...metadata(2, false, true),
            turns: [],
            nextCursor: "latest",
          });
        }
        if (cursor === "latest") {
          return jsonResponse({
            ...metadata(3, true, false),
            turns: [descriptor(2, secondQueryId)],
            nextCursor: "older-empty",
          });
        }
        if (cursor === "older-empty") {
          return jsonResponse({ ...metadata(3, true, false), turns: [], nextCursor: "older" });
        }
        if (cursor === "older") {
          return jsonResponse({
            ...metadata(3, true, false),
            turns: [descriptor(1, firstQueryId)],
          });
        }
        throw new Error(`Unexpected turns cursor: ${cursor}`);
      },
      textHandler: async ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        return jsonResponse({
          version: 1,
          conversationId,
          queryId: ordinal === 1 ? firstQueryId : secondQueryId,
          ordinal,
          role,
          chunks: [{ index: 0, text: `${ordinal}-${role}` }],
          complete: true,
        });
      },
    });
    const app = mountHistoryAccountApp(environment, AccountApp);
    apps.push(app);
    await app.flush();

    expect(await app.current()?.props?.onSelectConversation?.(firstConversationId)).toBe(true);
    await app.flush();
    expect(cursors).toEqual([null, "latest"]);
    expect(app.current()?.props?.state?.history).toMatchObject({
      selectedConversationId: firstConversationId,
      throughOrdinal: 2,
      closed: true,
      canContinue: false,
      turns: [{ ordinal: 2, queryId: secondQueryId }],
      turnsNextCursor: "older-empty",
    });

    await app.current()?.props?.onLoadEarlierTurns?.();
    await app.flush();
    expect(cursors).toEqual([null, "latest", "older-empty", "older"]);
    expect(app.current()?.props?.state?.history?.turns.map(({ ordinal }) => ordinal)).toEqual([
      1, 2,
    ]);
    expect(app.current()?.props?.state?.history?.throughOrdinal).toBe(2);
    expect(environment.runtimeRequests).toEqual([]);
  });

  it("stops when the turns API repeats a page cursor", async () => {
    const cursors = [];
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Repetido",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      turnsHandler: async ({ conversationId, url }) => {
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor);
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [],
          nextCursor: "repeat",
        });
      },
    });
    const app = mountHistoryAccountApp(environment, AccountApp);
    apps.push(app);
    await app.flush();

    expect(await app.current()?.props?.onSelectConversation?.(firstConversationId)).toBe(false);
    await app.flush();
    expect(cursors).toEqual([null, "repeat"]);
    expect(app.current()?.props?.state?.history).toMatchObject({
      selectedConversationId: null,
      turnsStatus: "error",
    });
    expect(environment.runtimeRequests).toEqual([]);
  });

  it("reads a question through its manifest count and an answer through its Runtime cursor", async () => {
    const textReads = [];
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Hilo con prefijos distintos",
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
            {
              ordinal: 1,
              queryId: firstQueryId,
              status: "completed",
              questionManifest: { count: 2, complete: true },
              answerManifest: { count: 4, complete: true },
              cursor: 4,
            },
          ],
        }),
      textHandler: async ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        const throughCursor = Number(url.searchParams.get("throughCursor"));
        textReads.push({ role, throughCursor });
        const count = role === "user" ? 2 : 4;
        return jsonResponse({
          version: 1,
          conversationId,
          queryId: firstQueryId,
          ordinal,
          role,
          chunks: Array.from({ length: count }, (_, index) => ({
            index,
            text: `${role}-${index + 1} `,
          })),
          complete: true,
        });
      },
    });
    const app = mountHistoryAccountApp(environment, AccountApp);
    apps.push(app);
    await app.flush();

    const onSelectConversation = app.current()?.props?.onSelectConversation;
    expect(onSelectConversation, "AccountApp should expose history selection").toBeTypeOf(
      "function",
    );
    if (typeof onSelectConversation === "function") {
      await onSelectConversation(firstConversationId);
      await app.flush();
    }

    expect(app.current()?.props?.state?.history?.turns).toMatchObject([
      {
        ordinal: 1,
        question: "user-1 user-2 ",
        answer: "assistant-1 assistant-2 assistant-3 assistant-4 ",
        questionComplete: true,
        answerComplete: true,
      },
    ]);
    expect(textReads).toEqual([
      { role: "user", throughCursor: 2 },
      { role: "assistant", throughCursor: 4 },
    ]);
  });

  it("keeps a completed follow-up in the authoritative transcript when the next one starts", async () => {
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Hilo A",
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
            {
              ordinal: 1,
              queryId: firstQueryId,
              status: "completed",
              questionManifest: { count: 1, complete: true },
              answerManifest: { count: 1, complete: true },
              cursor: 1,
            },
          ],
        }),
      textHandler: async ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        return jsonResponse({
          version: 1,
          conversationId,
          queryId: firstQueryId,
          ordinal,
          role,
          chunks: [{ index: 0, text: role === "user" ? "A_question" : "A_answer" }],
          complete: true,
        });
      },
      runtimeHandler: async (request) =>
        streamResponse(request, {
          text: request.text === "follow_B" ? "B_answer_unique" : "C_answer_unique",
        }),
    });
    const app = mountHistoryAccountApp(environment, AccountApp);
    apps.push(app);
    await app.flush();
    await app.current()?.props?.onSelectConversation?.(firstConversationId);
    await app.flush();

    expect(app.current()?.props?.onSubmit("follow_B")).toBe(true);
    await app.flush();
    expect(app.current()?.props?.state?.history?.turns).toMatchObject([
      { ordinal: 1, answer: "A_answer" },
      { ordinal: 2, question: "follow_B", answer: "B_answer_unique", status: "completed" },
    ]);

    expect(app.current()?.props?.onSubmit("follow_C")).toBe(true);
    await app.flush();
    const markup = await app.html();
    expect(markup.match(/B_answer_unique/g)).toHaveLength(1);
    expect(markup).toContain("A_answer");
    expect(app.current()?.props?.state?.history?.turns).toHaveLength(3);
  });

  it("blocks sends while another thread is opening and ignores callbacks after selection moves", async () => {
    const opening = deferred();
    let secondConversationReads = 0;
    let streamController;
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            { conversationId: firstConversationId, label: "A", lastOrdinal: 1, closed: false },
            { conversationId: secondConversationId, label: "B", lastOrdinal: 1, closed: false },
          ],
        }),
      turnsHandler: async ({ conversationId }) => {
        if (conversationId === secondConversationId && secondConversationReads++ === 0) {
          return opening.promise;
        }
        const queryId = conversationId === firstConversationId ? firstQueryId : secondQueryId;
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [
            {
              ordinal: 1,
              queryId,
              status: "completed",
              questionManifest: { count: 1, complete: true },
              answerManifest: { count: 1, complete: true },
              cursor: 1,
            },
          ],
        });
      },
      textHandler: async ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        return jsonResponse({
          version: 1,
          conversationId,
          queryId: conversationId === firstConversationId ? firstQueryId : secondQueryId,
          ordinal,
          role,
          chunks: [
            {
              index: 0,
              text: conversationId === firstConversationId ? "A_original" : "B_original",
            },
          ],
          complete: true,
        });
      },
      runtimeHandler: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const app = mountHistoryAccountApp(environment, AccountApp);
    apps.push(app);
    await app.flush();
    await app.current()?.props?.onSelectConversation?.(firstConversationId);
    await app.flush();

    const openingConversation = app.current()?.props?.onSelectConversation?.(secondConversationId);
    await app.flush();
    expect(app.current()?.props?.state?.history).toMatchObject({
      selectedConversationId: firstConversationId,
      openingConversationId: secondConversationId,
      turnsStatus: "loading",
    });
    expect(app.current()?.props?.onSubmit("must-not-start-on-A")).toBe(false);
    expect(environment.runtimeRequests).toHaveLength(0);

    opening.resolve(
      jsonResponse({
        version: 1,
        conversationId: secondConversationId,
        throughOrdinal: 1,
        closed: false,
        canContinue: true,
        turns: [
          {
            ordinal: 1,
            queryId: secondQueryId,
            status: "completed",
            questionManifest: { count: 1, complete: true },
            answerManifest: { count: 1, complete: true },
            cursor: 1,
          },
        ],
      }),
    );
    await openingConversation;
    await app.flush();
    expect(app.current()?.props?.state?.history?.selectedConversationId).toBe(secondConversationId);

    const selectingA = app.current()?.props?.onSelectConversation?.(firstConversationId);
    await app.flush();
    await selectingA;
    await app.flush();
    expect(app.current()?.props?.onSubmit("A_request_before_switch")).toBe(true);
    await app.flush();
    expect(environment.runtimeRequests).toHaveLength(1);
    const request = environment.runtimeRequests[0].request;

    await app.current()?.props?.onSelectConversation?.(secondConversationId);
    await app.flush();
    const encoder = new TextEncoder();
    streamController.enqueue(
      encoder.encode(
        `event: accepted\ndata: ${JSON.stringify({
          type: "accepted",
          conversationId: firstConversationId,
          queryId: request.queryId,
          ordinal: 2,
        })}\n\n`,
      ),
    );
    streamController.enqueue(
      encoder.encode(
        `event: text\ndata: ${JSON.stringify({
          type: "text",
          queryId: request.queryId,
          index: 0,
          text: "A_late_answer",
        })}\n\n`,
      ),
    );
    await app.flush();

    expect(app.current()?.props?.state?.history?.selectedConversationId).toBe(secondConversationId);
    expect(app.current()?.props?.state?.history?.turns).toMatchObject([
      { queryId: secondQueryId, question: "B_original", answer: "B_original" },
    ]);
    expect(app.current()?.props?.state?.answer).not.toBe("A_late_answer");
  });

  it("preserves server activity order when refreshing locally created conversations", async () => {
    let listCalls = 0;
    const environment = createHistoryEnvironment({
      listHandler: async () => {
        listCalls += 1;
        if (listCalls === 1) return jsonResponse({ version: 1, conversations: [] });
        const [first, second] = environment.runtimeRequests.map(({ request }) => request);
        return jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: second.conversationId,
              label: "B reciente",
              lastOrdinal: 1,
              closed: false,
              updatedAt: "2026-10-24T12:00:00.000Z",
            },
            {
              conversationId: first.conversationId,
              label: "A anterior",
              lastOrdinal: 1,
              closed: false,
              updatedAt: "2026-10-24T11:00:00.000Z",
            },
          ],
        });
      },
      runtimeHandler: async (request) =>
        streamResponse(request, { text: `${request.text}_answer` }),
    });
    const app = mountHistoryAccountApp(environment, AccountApp);
    apps.push(app);
    await app.flush();

    expect(app.current()?.props?.onSubmit("A")).toBe(true);
    await app.flush();
    const conversationA = environment.runtimeRequests[0].request.conversationId;
    app.current()?.props?.onReset?.();
    await app.flush();
    expect(app.current()?.props?.onSubmit("B")).toBe(true);
    await app.flush();
    const conversationB = environment.runtimeRequests[1].request.conversationId;
    expect(conversationA).not.toBe(conversationB);

    await app.current()?.props?.onRefreshHistory?.();
    await app.flush();
    expect(
      app.current()?.props?.state?.history?.conversations.map((item) => item.conversationId),
    ).toEqual([conversationB, conversationA]);
  });

  it("lets an indexed terminal turn supersede its stale admitted journal on remount", async () => {
    let listCalls = 0;
    const environment = createHistoryEnvironment({
      listHandler: async () => {
        listCalls += 1;
        if (listCalls === 2) {
          return jsonResponse({ version: 1, conversations: [], nextCursor: "overlap-page" });
        }
        const conversations =
          listCalls === 3
            ? [
                {
                  conversationId: secondConversationId,
                  label: "B2 estado previo activo",
                  lastOrdinal: 2,
                  closed: false,
                  activeQueryId: secondQueryId,
                  updatedAt: "2026-10-24T18:22:35.424Z",
                },
              ]
            : [
                {
                  conversationId: firstConversationId,
                  label: "A3 reciente",
                  lastOrdinal: 3,
                  closed: false,
                  updatedAt: "2026-10-24T18:26:34.210Z",
                },
                {
                  conversationId: secondConversationId,
                  label: "B2 terminal",
                  lastOrdinal: 2,
                  closed: false,
                  updatedAt: "2026-10-24T18:22:35.424Z",
                },
              ];
        return jsonResponse({
          version: 1,
          conversations,
          ...(listCalls === 1 ? { nextCursor: "empty-page" } : {}),
        });
      },
      turnsHandler: async ({ conversationId }) => {
        const turns =
          conversationId === secondConversationId
            ? [
                { ordinal: 1, queryId: firstQueryId },
                { ordinal: 2, queryId: secondQueryId },
              ]
            : [{ ordinal: 3, queryId: thirdQueryId }];
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: turns.at(-1).ordinal,
          closed: false,
          canContinue: true,
          turns: turns.map(({ ordinal, queryId }) => ({
            ordinal,
            queryId,
            status: "completed",
            questionManifest: { count: 1, complete: true },
            answerManifest: { count: 1, complete: true },
            cursor: 1,
          })),
        });
      },
      textHandler: async ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          queryId:
            conversationId === secondConversationId
              ? ordinal === 1
                ? firstQueryId
                : secondQueryId
              : thirdQueryId,
          ordinal,
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: `turn-${ordinal}` }],
          complete: true,
        }),
    });
    const admittedRequest = {
      version: 2,
      operation: "message",
      conversationId: secondConversationId,
      queryId: secondQueryId,
      baseOrdinal: 1,
    };
    writePendingChatJournal(environment.config, environment.identity, {
      ...admittedRequest,
      text: "B2 original request",
    });
    markChatJournalAdmitted(environment.config, environment.identity, admittedRequest, 2);
    writeChatSelection(environment.config, environment.identity, firstConversationId);

    const app = mountHistoryAccountApp(environment, AccountApp);
    apps.push(app);
    await app.flush();

    expect(
      app.current()?.props?.state?.history?.conversations.map((item) => item.conversationId),
    ).toEqual([firstConversationId, secondConversationId]);
    expect(app.current()?.props?.state?.history?.conversations[1]).toMatchObject({
      lastOrdinal: 2,
      label: "B2 terminal",
    });
    expect(app.current()?.props?.state?.history?.conversations[1]).not.toHaveProperty(
      "activeQueryId",
    );
    expect(
      readChatJournals(environment.config, environment.identity).get(secondConversationId),
    ).toMatchObject({
      admitted: true,
      ordinal: 2,
    });
    expect(environment.runtimeRequests).toEqual([]);

    await app.current()?.props?.onLoadMoreHistory?.();
    await app.flush();
    expect(
      app.current()?.props?.state?.history?.conversations.map((item) => item.conversationId),
    ).toEqual([firstConversationId, secondConversationId]);
    expect(app.current()?.props?.state?.history?.conversations[1]).toMatchObject({
      lastOrdinal: 2,
      label: "B2 terminal",
    });
    expect(app.current()?.props?.state?.history?.conversations[1]).not.toHaveProperty(
      "activeQueryId",
    );
    expect(
      readChatJournals(environment.config, environment.identity).has(secondConversationId),
    ).toBe(true);

    await app.current()?.props?.onLoadMoreHistory?.();
    await app.flush();
    const conversations = app.current()?.props?.state?.history?.conversations;
    expect(
      conversations?.filter((item) => item.conversationId === secondConversationId),
    ).toHaveLength(1);
    expect(new Set(conversations?.map((item) => item.conversationId)).size).toBe(
      conversations?.length,
    );
    expect(
      conversations?.find((item) => item.conversationId === secondConversationId),
    ).toMatchObject({
      lastOrdinal: 2,
      label: "B2 estado previo activo",
      activeQueryId: secondQueryId,
    });

    await app.current()?.props?.onSelectConversation?.(secondConversationId);
    await app.flush();
    expect(app.current()?.props?.state).toMatchObject({
      queryStatus: "completed",
      history: { selectedConversationId: secondConversationId, turnsStatus: "ready" },
    });
    const selectedConversation = app
      .current()
      ?.props?.state?.history?.conversations.find(
        (item) => item.conversationId === secondConversationId,
      );
    expect(selectedConversation).toMatchObject({
      lastOrdinal: 2,
      label: "B2 estado previo activo",
      closed: false,
    });
    expect(selectedConversation?.activeQueryId).toBeUndefined();
    expect(listCalls).toBe(3);
    expect(environment.runtimeRequests).toEqual([]);
    expect(
      readChatJournals(environment.config, environment.identity).has(secondConversationId),
    ).toBe(false);
  });
});

function createControlledHistoryStreamEnvironment({ listHandler }) {
  let controller;
  let request;
  const encoder = new TextEncoder();
  const emit = (event) =>
    controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  const environment = createHistoryEnvironment({
    listHandler,
    runtimeHandler: (nextRequest) => {
      request = nextRequest;
      return new Response(
        new ReadableStream({
          start(nextController) {
            controller = nextController;
            emit({
              type: "accepted",
              conversationId: nextRequest.conversationId,
              queryId: nextRequest.queryId,
              ordinal: 1,
            });
            emit({ type: "text", queryId: nextRequest.queryId, index: 0, text: "Respuesta." });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    environment,
    request: () => request,
    emit,
    close: () => controller.close(),
  };
}

describe("AccountApp history transition and pending-label regressions", () => {
  it("keeps a local completion over a delayed active page, then accepts same-ordinal terminal catch-up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.parse("2026-10-27T12:00:00.000Z");
    vi.setSystemTime(base);
    const delayedActivePage = deferred();
    const pages = [];
    let listCalls = 0;
    const stream = createControlledHistoryStreamEnvironment({
      listHandler: () => {
        listCalls += 1;
        if (listCalls === 1) return jsonResponse({ version: 1, conversations: [] });
        return pages.shift();
      },
    });
    const app = mountHistoryAccountApp(stream.environment, AccountApp);
    apps.push(app);
    await app.flush();

    expect(app.current()?.props?.onSubmit("FIRST QUESTION")).toBe(true);
    await app.flush();
    const conversationId = stream.request().conversationId;
    vi.setSystemTime(base + 30_000);
    pages.push(delayedActivePage.promise);
    const refresh = app.current()?.props?.onRefreshHistory?.();
    await app.flush();

    vi.setSystemTime(base + 60_000);
    stream.emit({ type: "completed", queryId: stream.request().queryId });
    stream.close();
    await app.flush();
    expect(app.current()?.props?.state?.queryStatus).toBe("completed");

    delayedActivePage.resolve(
      jsonResponse({
        version: 1,
        conversations: [
          {
            conversationId,
            label: "STALE SERVER LABEL",
            updatedAt: new Date(base).toISOString(),
            lastOrdinal: 1,
            closed: false,
            activeQueryId: stream.request().queryId,
          },
          {
            conversationId: secondConversationId,
            label: "OTHER CONVERSATION",
            updatedAt: new Date(base + 15_000).toISOString(),
            lastOrdinal: 1,
            closed: false,
          },
        ],
      }),
    );
    await refresh;
    await app.flush();

    let history = app.current()?.props?.state?.history;
    expect(history?.conversations.map(({ conversationId: id }) => id)).toEqual([
      conversationId,
      secondConversationId,
    ]);
    expect(history?.conversations[0]?.label).toBe("FIRST QUESTION");
    expect(history?.conversations[0]).not.toHaveProperty("activeQueryId");
    expect(history?.conversations[0]?.updatedAt).toBe(new Date(base + 60_000).toISOString());
    expect(await app.html()).toContain("La respuesta está completa");
    expect(await app.html()).not.toContain("· En curso");

    pages.push(
      jsonResponse({
        version: 1,
        conversations: [
          {
            conversationId: secondConversationId,
            label: "OTHER CONVERSATION",
            updatedAt: new Date(base + 55_000).toISOString(),
            lastOrdinal: 1,
            closed: false,
          },
          {
            conversationId,
            label: "FIRST QUESTION FROM SERVER",
            updatedAt: new Date(base + 45_000).toISOString(),
            lastOrdinal: 1,
            closed: false,
          },
        ],
      }),
    );
    await app.current()?.props?.onRefreshHistory?.();
    await app.flush();

    history = app.current()?.props?.state?.history;
    expect(history?.conversations.map(({ conversationId: id }) => id)).toEqual([
      secondConversationId,
      conversationId,
    ]);
    expect(history?.conversations[1]).toMatchObject({
      label: "FIRST QUESTION FROM SERVER",
      updatedAt: new Date(base + 45_000).toISOString(),
      lastOrdinal: 1,
      closed: false,
    });
    expect(history?.conversations[1]).not.toHaveProperty("activeQueryId");
  });

  it("keeps a local closed failure over a delayed open page and accepts closed server catch-up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.parse("2026-10-27T13:00:00.000Z");
    vi.setSystemTime(base);
    const delayedOpenPage = deferred();
    const pages = [];
    let listCalls = 0;
    const stream = createControlledHistoryStreamEnvironment({
      listHandler: () => {
        listCalls += 1;
        if (listCalls === 1) return jsonResponse({ version: 1, conversations: [] });
        return pages.shift();
      },
    });
    const app = mountHistoryAccountApp(stream.environment, AccountApp);
    apps.push(app);
    await app.flush();

    expect(app.current()?.props?.onSubmit("FAILED QUESTION")).toBe(true);
    await app.flush();
    const conversationId = stream.request().conversationId;
    vi.setSystemTime(base + 30_000);
    pages.push(delayedOpenPage.promise);
    const refresh = app.current()?.props?.onRefreshHistory?.();
    await app.flush();

    vi.setSystemTime(base + 60_000);
    stream.emit({
      type: "failed",
      queryId: stream.request().queryId,
      code: "PROVIDER_FAILURE",
      message: "No se pudo completar.",
      recordStatus: "failed",
      canContinue: false,
    });
    stream.close();
    await app.flush();
    expect(app.current()?.props?.state?.queryStatus).toBe("failed");

    delayedOpenPage.resolve(
      jsonResponse({
        version: 1,
        conversations: [
          {
            conversationId,
            label: "STALE SERVER LABEL",
            updatedAt: new Date(base).toISOString(),
            lastOrdinal: 1,
            closed: false,
            activeQueryId: stream.request().queryId,
          },
        ],
      }),
    );
    await refresh;
    await app.flush();

    let history = app.current()?.props?.state?.history;
    expect(history?.conversations[0]).toMatchObject({
      label: "FAILED QUESTION",
      lastOrdinal: 1,
      closed: true,
    });
    expect(history?.conversations[0]).not.toHaveProperty("activeQueryId");
    expect(await app.html()).toContain("· Cerrada");

    pages.push(
      jsonResponse({
        version: 1,
        conversations: [
          {
            conversationId,
            label: "FAILED QUESTION FROM SERVER",
            updatedAt: new Date(base + 45_000).toISOString(),
            lastOrdinal: 1,
            closed: true,
          },
        ],
      }),
    );
    await app.current()?.props?.onRefreshHistory?.();
    await app.flush();

    history = app.current()?.props?.state?.history;
    expect(history?.conversations[0]).toMatchObject({
      label: "FAILED QUESTION FROM SERVER",
      updatedAt: new Date(base + 45_000).toISOString(),
      lastOrdinal: 1,
      closed: true,
    });
  });

  it("lets a higher server ordinal supersede local terminal state even with an earlier timestamp", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.parse("2026-10-27T14:00:00.000Z");
    vi.setSystemTime(base);
    const delayedProgressPage = deferred();
    const pages = [];
    let listCalls = 0;
    const stream = createControlledHistoryStreamEnvironment({
      listHandler: () => {
        listCalls += 1;
        if (listCalls === 1) return jsonResponse({ version: 1, conversations: [] });
        return pages.shift();
      },
    });
    const app = mountHistoryAccountApp(stream.environment, AccountApp);
    apps.push(app);
    await app.flush();

    expect(app.current()?.props?.onSubmit("FIRST QUESTION")).toBe(true);
    await app.flush();
    const conversationId = stream.request().conversationId;
    vi.setSystemTime(base + 30_000);
    pages.push(delayedProgressPage.promise);
    const refresh = app.current()?.props?.onRefreshHistory?.();
    await app.flush();
    vi.setSystemTime(base + 60_000);
    stream.emit({ type: "completed", queryId: stream.request().queryId });
    stream.close();
    await app.flush();

    delayedProgressPage.resolve(
      jsonResponse({
        version: 1,
        conversations: [
          {
            conversationId,
            label: "SECOND QUESTION FROM SERVER",
            updatedAt: new Date(base + 45_000).toISOString(),
            lastOrdinal: 2,
            closed: false,
            activeQueryId: secondQueryId,
          },
        ],
      }),
    );
    await refresh;
    await app.flush();

    const conversation = app
      .current()
      ?.props?.state?.history?.conversations.find((item) => item.conversationId === conversationId);
    expect(conversation).toMatchObject({
      label: "SECOND QUESTION FROM SERVER",
      updatedAt: new Date(base + 45_000).toISOString(),
      lastOrdinal: 2,
      closed: false,
      activeQueryId: secondQueryId,
    });
  });

  it("uses a provisional label for a cold pending follow-up while list and open return 503", async () => {
    const text = "REPLACE THE LAST THREE CRITERIA WITH ONLY TWO";
    const environment = createHistoryEnvironment({
      listHandler: () => jsonResponse({ code: "TEMPORARY_UNAVAILABLE" }, 503),
      turnsHandler: () => jsonResponse({ code: "TEMPORARY_UNAVAILABLE" }, 503),
    });
    writePendingChatJournal(environment.config, environment.identity, {
      version: 2,
      operation: "message",
      conversationId: firstConversationId,
      queryId: firstQueryId,
      baseOrdinal: 12,
      text,
    });

    const app = mountHistoryAccountApp(environment, AccountApp);
    apps.push(app);
    await app.flush();

    const history = app.current()?.props?.state?.history;
    expect(history?.status).toBe("error");
    expect(history?.turnsStatus).toBe("error");
    expect(history?.conversations[0]).toMatchObject({
      conversationId: firstConversationId,
      label: "Conversación pendiente",
      lastOrdinal: 12,
      pending: true,
    });
    expect(await app.html()).toContain("Conversación pendiente");
    expect(await app.html()).not.toContain(`chat-history__label">${text}`);
  });

  it("keeps the first text as the label for a cold pending start", async () => {
    const text = "FIRST QUESTION FOR A NEW THREAD";
    const environment = createHistoryEnvironment({
      listHandler: () => jsonResponse({ code: "TEMPORARY_UNAVAILABLE" }, 503),
      turnsHandler: () => jsonResponse({ code: "TEMPORARY_UNAVAILABLE" }, 503),
    });
    writePendingChatJournal(environment.config, environment.identity, {
      version: 2,
      operation: "start",
      conversationId: firstConversationId,
      queryId: firstQueryId,
      baseOrdinal: 0,
      text,
    });

    const app = mountHistoryAccountApp(environment, AccountApp);
    apps.push(app);
    await app.flush();

    expect(app.current()?.props?.state?.history?.conversations[0]).toMatchObject({
      label: text,
      lastOrdinal: 0,
      pending: true,
    });
    expect(await app.html()).toContain(text);
  });

  it("replaces a provisional follow-up label after authoritative history reads recover", async () => {
    const text = "CHANGE THE LAST STEP";
    let listCalls = 0;
    let turnCalls = 0;
    const environment = createHistoryEnvironment({
      listHandler: () => {
        listCalls += 1;
        if (listCalls === 1) return jsonResponse({ code: "TEMPORARY_UNAVAILABLE" }, 503);
        return jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "FIRST QUESTION",
              updatedAt: "2026-10-27T11:00:00.000Z",
              lastOrdinal: 12,
              closed: false,
            },
          ],
        });
      },
      turnsHandler: ({ conversationId }) => {
        turnCalls += 1;
        if (turnCalls === 1) return jsonResponse({ code: "TEMPORARY_UNAVAILABLE" }, 503);
        return jsonResponse({
          version: 1,
          conversationId,
          label: "FIRST QUESTION",
          updatedAt: "2026-10-27T11:00:00.000Z",
          throughOrdinal: 12,
          closed: false,
          canContinue: true,
          turns: [],
        });
      },
    });
    writePendingChatJournal(environment.config, environment.identity, {
      version: 2,
      operation: "message",
      conversationId: firstConversationId,
      queryId: firstQueryId,
      baseOrdinal: 12,
      text,
    });

    const app = mountHistoryAccountApp(environment, AccountApp);
    apps.push(app);
    await app.flush();
    expect(app.current()?.props?.state?.history?.conversations[0]?.label).toBe(
      "Conversación pendiente",
    );
    expect(turnCalls).toBe(1);

    await app.current()?.props?.onRefreshHistory?.();
    await app.flush();
    expect(app.current()?.props?.state?.history?.conversations[0]?.label).toBe("FIRST QUESTION");

    expect(await app.current()?.props?.onSelectConversation?.(firstConversationId)).toBe(true);
    await app.flush();
    expect(app.current()?.props?.state?.history?.turnsStatus).toBe("ready");
    expect(app.current()?.props?.state?.history?.conversations[0]?.label).toBe("FIRST QUESTION");
    expect(await app.html()).toContain("FIRST QUESTION");
    expect(await app.html()).not.toContain(`chat-history__label">${text}`);
    expect(
      environment.runtimeRequests.every(({ request }) => request.operation === "recover"),
    ).toBe(true);
  });
});
