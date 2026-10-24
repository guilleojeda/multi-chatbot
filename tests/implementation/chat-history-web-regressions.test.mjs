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

describe("AccountApp history text cursor regressions", () => {
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
});
