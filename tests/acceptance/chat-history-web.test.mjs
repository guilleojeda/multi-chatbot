import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  accessToken,
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

const apps = [];
let AccountApp;
let ChatScreen;
let disposeAccountAppModule;

beforeAll(async () => {
  ({ AccountApp, dispose: disposeAccountAppModule } = await loadHistoryAccountApp());
  ChatScreen = globalThis.__accountScreens?.ChatScreen;
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

function history(app) {
  const value = state(app)?.history;
  expect(value, "AccountApp should expose history state after authorization").toBeDefined();
  return value;
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

async function changeDraft(app, text) {
  const callback = props(app).onDraftChange;
  expect(
    callback,
    "AccountApp should expose onDraftChange for the current conversation",
  ).toBeTypeOf("function");
  if (typeof callback !== "function") return;
  await callback(text);
  await app.flush();
}

function turn(ordinal, queryId, overrides = {}) {
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

function readCalls(environment) {
  return environment.apiRequests.filter(
    ({ path, method }) => method === "GET" && path.startsWith("/chat/conversations"),
  );
}

function renderCurrentChat(app) {
  expect(ChatScreen, "The app hook harness should expose the real ChatScreen").toBeTypeOf(
    "function",
  );
  if (typeof ChatScreen !== "function") return null;
  return renderToStaticMarkup(
    React.createElement(ChatScreen, {
      state: state(app),
      onSubmit: props(app).onSubmit,
      onSignOut: props(app).onSignOut,
      onRetryProfile: props(app).onRetryProfile,
      onReset: props(app).onReset,
      onCopy: () => undefined,
    }),
  );
}

describe("the conversation history in AccountApp", () => {
  it("discovers server history after remount without a journal and opens original text without Runtime work", async () => {
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Actividad de porcentajes",
              createdAt: "2026-10-20T10:00:00.000Z",
              updatedAt: "2026-10-23T10:00:00.000Z",
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
          turns: [turn(1, firstQueryId)],
        }),
      textHandler: async ({ conversationId, ordinal, url }) => {
        const role = url.searchParams.get("role");
        return jsonResponse({
          version: 1,
          conversationId,
          queryId: firstQueryId,
          ordinal,
          role,
          chunks: [
            { index: 0, text: role === "user" ? "Prepará porcentajes." : "Usá descuentos." },
          ],
          complete: true,
        });
      },
    });
    const app = mount(environment);
    await initialize(app);

    expect(history(app)).toMatchObject({
      status: "ready",
      conversations: [
        {
          conversationId: firstConversationId,
          label: "Actividad de porcentajes",
          lastOrdinal: 1,
        },
      ],
      selectedConversationId: null,
    });
    expect(environment.storage.values.size).toBe(0);
    expect(environment.runtimeRequests).toHaveLength(0);
    expect(readCalls(environment)).toHaveLength(1);
    expect(readCalls(environment)[0].headers.get("authorization")).toBe(`Bearer ${accessToken}`);

    await select(app, firstConversationId);

    expect(history(app)).toMatchObject({
      status: "ready",
      selectedConversationId: firstConversationId,
      turnsStatus: "ready",
      turns: [
        {
          ordinal: 1,
          queryId: firstQueryId,
          question: "Prepará porcentajes.",
          answer: "Usá descuentos.",
          questionComplete: true,
          answerComplete: true,
        },
      ],
    });
    expect(environment.runtimeRequests).toHaveLength(0);
    const textReads = readCalls(environment).filter(({ path }) => path.endsWith("/text"));
    expect(textReads).toHaveLength(2);
    expect(textReads.map(({ url }) => url.searchParams.get("role")).sort()).toEqual([
      "assistant",
      "user",
    ]);
    for (const call of textReads) {
      expect(call.url.searchParams.get("queryId")).toBe(firstQueryId);
      expect(call.url.searchParams.get("throughCursor")).toBe("1");
    }
  });

  it("keeps loading, empty, and failed list responses distinct and paginates by the returned cursor", async () => {
    const pendingList = deferred();
    const loadingEnvironment = createHistoryEnvironment({ listHandler: () => pendingList.promise });
    const loadingApp = mount(loadingEnvironment);
    await loadingApp.flush();
    expect(
      readCalls(loadingEnvironment),
      "AccountApp should request history after authorization",
    ).toHaveLength(1);
    expect(history(loadingApp)?.status).toBe("loading");
    pendingList.resolve(jsonResponse({ version: 1, conversations: [], nextCursor: undefined }));
    await loadingApp.flush();
    expect(history(loadingApp)?.status).toBe("empty");
    expect(history(loadingApp)?.conversations).toEqual([]);

    const failedEnvironment = createHistoryEnvironment({
      listHandler: async () => jsonResponse({ code: "SERVICE_UNAVAILABLE" }, 503),
    });
    const failedApp = mount(failedEnvironment);
    await initialize(failedApp);
    expect(history(failedApp)?.status).toBe("error");
    expect(history(failedApp)?.conversations).toEqual([]);
    expect(history(failedApp)?.error).toBeTruthy();

    const cursors = [];
    const pageEnvironment = createHistoryEnvironment({
      listHandler: async ({ url }) => {
        cursors.push(url.searchParams.get("cursor"));
        if (cursors.length === 1) {
          return jsonResponse({
            version: 1,
            conversations: [
              { conversationId: firstConversationId, label: "Uno", lastOrdinal: 1, closed: false },
            ],
            nextCursor: "list-page-2",
          });
        }
        return jsonResponse({
          version: 1,
          conversations: [
            { conversationId: secondConversationId, label: "Dos", lastOrdinal: 2, closed: false },
          ],
        });
      },
    });
    const pageApp = mount(pageEnvironment);
    await initialize(pageApp);
    const loadMore = props(pageApp).onLoadMoreHistory;
    expect(loadMore, "AccountApp should expose onLoadMoreHistory").toBeTypeOf("function");
    if (typeof loadMore === "function") await loadMore();
    await pageApp.flush();

    expect(cursors).toEqual([null, "list-page-2"]);
    expect(history(pageApp)).toMatchObject({
      status: "ready",
      conversations: [
        { conversationId: firstConversationId, label: "Uno" },
        { conversationId: secondConversationId, label: "Dos" },
      ],
      nextCursor: null,
    });
  });

  it("paginates earlier turns with the response cursor and keeps pages in transcript order", async () => {
    const cursors = [];
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            { conversationId: firstConversationId, label: "Hilo", lastOrdinal: 2, closed: false },
          ],
        }),
      turnsHandler: async ({ url, conversationId }) => {
        cursors.push(url.searchParams.get("cursor"));
        return cursors.length === 1
          ? jsonResponse({
              version: 1,
              conversationId,
              throughOrdinal: 2,
              closed: false,
              canContinue: true,
              turns: [turn(2, secondQueryId)],
              nextCursor: "turn-page-1",
            })
          : jsonResponse({
              version: 1,
              conversationId,
              throughOrdinal: 2,
              closed: false,
              canContinue: true,
              turns: [turn(1, firstQueryId)],
            });
      },
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
                ordinal === 1
                  ? url.searchParams.get("role") === "user"
                    ? "Primera pregunta"
                    : "Primera respuesta"
                  : url.searchParams.get("role") === "user"
                    ? "Segunda pregunta"
                    : "Segunda respuesta",
            },
          ],
          complete: true,
        }),
    });
    const app = mount(environment);
    await initialize(app);
    await select(app, firstConversationId);
    expect(history(app)?.turns.map(({ ordinal }) => ordinal)).toEqual([2]);

    const loadEarlier = props(app).onLoadEarlierTurns;
    expect(loadEarlier, "AccountApp should expose onLoadEarlierTurns").toBeTypeOf("function");
    if (typeof loadEarlier === "function") await loadEarlier();
    await app.flush();

    expect(cursors).toEqual([null, "turn-page-1"]);
    expect(history(app)?.turns.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
    expect(history(app)?.turns.map(({ question, answer }) => [question, answer])).toEqual([
      ["Primera pregunta", "Primera respuesta"],
      ["Segunda pregunta", "Segunda respuesta"],
    ]);
  });

  it("continues the selected conversation at its current ordinal and uses its ID as Runtime session", async () => {
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            { conversationId: firstConversationId, label: "Hilo", lastOrdinal: 2, closed: false },
          ],
        }),
      turnsHandler: async ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 2,
          closed: false,
          canContinue: true,
          turns: [turn(1, firstQueryId), turn(2, secondQueryId)],
        }),
      textHandler: async ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: url.searchParams.get("queryId"),
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: "Texto restaurado." }],
          complete: true,
        }),
    });
    const app = mount(environment);
    await initialize(app);
    await select(app, firstConversationId);

    expect(environment.runtimeRequests).toHaveLength(0);
    expect(props(app).onSubmit("Conservá la rúbrica y cambialo a 60 minutos.")).toBe(true);
    await vi.waitFor(() => expect(environment.runtimeRequests).toHaveLength(1));

    const call = environment.runtimeRequests[0];
    expect(call.request).toMatchObject({
      version: 2,
      operation: "message",
      conversationId: firstConversationId,
      baseOrdinal: 2,
      text: "Conservá la rúbrica y cambialo a 60 minutos.",
    });
    expect(call.request.queryId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(call.headers.get("x-amzn-bedrock-agentcore-runtime-session-id")).toBe(
      firstConversationId,
    );
    expect(environment.apiRequests.filter(({ method }) => method === "POST")).toHaveLength(0);
  });

  it("keeps history readable with an incomplete profile and still blocks a new Runtime submission", async () => {
    const environment = createHistoryEnvironment({
      profileComplete: false,
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Hilo anterior",
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
          turns: [turn(1, firstQueryId)],
        }),
      textHandler: async ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: url.searchParams.get("queryId"),
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: "Texto anterior." }],
          complete: true,
        }),
    });
    const app = mount(environment);
    await initialize(app);
    await select(app, firstConversationId);

    expect(state(app)?.profileStatus).toBe("incomplete");
    expect(history(app)?.turns).toHaveLength(1);
    expect(history(app)?.selectedConversationId).toBe(firstConversationId);
    expect(props(app).onSubmit("Consulta nueva con perfil incompleto.")).toBe(false);
    expect(environment.runtimeRequests).toHaveLength(0);
  });

  it("preserves a stale-base draft until explicit refresh and never retries it automatically", async () => {
    let turnReadCount = 0;
    let messageCount = 0;
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Hilo compartido",
              lastOrdinal: 2,
              closed: false,
            },
          ],
        }),
      turnsHandler: async ({ conversationId }) => {
        turnReadCount += 1;
        const throughOrdinal = turnReadCount === 1 ? 2 : 3;
        return jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal,
          closed: false,
          canContinue: true,
          turns: [turn(throughOrdinal, secondQueryId)],
        });
      },
      textHandler: async ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: url.searchParams.get("queryId"),
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: `Texto ${ordinal}.` }],
          complete: true,
        }),
      runtimeHandler: async (request) => {
        messageCount += 1;
        if (messageCount === 1) {
          const encoder = new TextEncoder();
          const event = {
            type: "failed",
            code: "stale_base",
            message: "Otra pestaña avanzó esta conversación. Actualizala antes de continuar.",
            recordStatus: "not_admitted",
            queryId: request.queryId,
            canContinue: true,
          };
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(`event: failed\ndata: ${JSON.stringify(event)}\n\n`),
                );
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return streamResponse(request, { text: "Seguimiento enviado después de actualizar." });
      },
    });
    const app = mount(environment);
    await initialize(app);
    await select(app, firstConversationId);

    const draft = "Mantené la rúbrica y agregá una adaptación.";
    expect(props(app).onSubmit(draft)).toBe(true);
    await vi.waitFor(async () => {
      await app.flush();
      expect(state(app)?.queryErrorCode).toBe("stale_base");
    });
    await app.flush();

    expect(messageCount).toBe(1);
    expect(state(app)?.draft).toBe(draft);
    expect(history(app)?.refreshRequired).toBe(true);
    expect(turnReadCount).toBe(1);
    const rejectedMarkup = renderCurrentChat(app);
    expect(rejectedMarkup).toContain(`>${draft}</textarea>`);

    await select(app, firstConversationId);
    expect(turnReadCount).toBe(2);
    expect(state(app)?.ordinal).toBe(3);
    expect(state(app)?.draft).toBe(draft);
    expect(messageCount).toBe(1);
    expect(
      environment.runtimeRequests.filter(({ request }) => request.operation === "message"),
    ).toHaveLength(1);

    expect(props(app).onSubmit(draft)).toBe(true);
    await vi.waitFor(() => expect(messageCount).toBe(2));
    const retry = environment.runtimeRequests.filter(
      ({ request }) => request.operation === "message",
    )[1];
    expect(retry.request).toMatchObject({
      conversationId: firstConversationId,
      baseOrdinal: 3,
      text: draft,
    });
    expect(retry.request.queryId).not.toBe(environment.runtimeRequests[0].request.queryId);
  });

  it("resets to an empty new conversation without inheriting a selected transcript", async () => {
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: secondConversationId,
              label: "Otro hilo",
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
          turns: [turn(1, secondQueryId)],
        }),
      textHandler: async ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: url.searchParams.get("queryId"),
          role: url.searchParams.get("role"),
          chunks: [{ index: 0, text: "Contexto de otro hilo" }],
          complete: true,
        }),
    });
    const app = mount(environment);
    await initialize(app);
    await select(app, secondConversationId);

    const reset = props(app).onReset;
    expect(reset, "onReset should start a new conversation").toBeTypeOf("function");
    if (typeof reset === "function") reset();
    await app.flush();

    expect(history(app)).toMatchObject({ selectedConversationId: null, turns: [] });
    expect(state(app)?.previousTurns || []).toEqual([]);
    expect(state(app)?.question).toBeUndefined();
    expect(state(app)?.answer).toBeUndefined();
    expect(props(app).onSubmit("Pedido de un hilo nuevo.")).toBe(true);
    await vi.waitFor(() => expect(environment.runtimeRequests).toHaveLength(1));
    expect(environment.runtimeRequests[0].request).toMatchObject({
      version: 2,
      operation: "start",
      baseOrdinal: 0,
      text: "Pedido de un hilo nuevo.",
    });
    expect(environment.runtimeRequests[0].request.conversationId).not.toBe(secondConversationId);
  });

  it("keeps per-thread drafts only in memory and preserves the selected draft when opening another thread fails", async () => {
    let secondConversationReads = 0;
    const listHandler = async () =>
      jsonResponse({
        version: 1,
        conversations: [
          { conversationId: firstConversationId, label: "A", lastOrdinal: 1, closed: false },
          { conversationId: secondConversationId, label: "B", lastOrdinal: 1, closed: false },
        ],
      });
    const turnsHandler = async ({ conversationId }) => {
      if (conversationId === secondConversationId) {
        secondConversationReads += 1;
        if (secondConversationReads === 2) {
          return jsonResponse({ code: "SERVICE_UNAVAILABLE" }, 503);
        }
      }
      return jsonResponse({
        version: 1,
        conversationId,
        throughOrdinal: 1,
        closed: false,
        canContinue: true,
        turns: [turn(1, conversationId === firstConversationId ? firstQueryId : secondQueryId)],
      });
    };
    const textHandler = async ({ conversationId, ordinal, url }) =>
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
              url.searchParams.get("role") === "user"
                ? "Pregunta guardada."
                : "Respuesta guardada.",
          },
        ],
        complete: true,
      });
    const environment = createHistoryEnvironment({ listHandler, turnsHandler, textHandler });
    const app = mount(environment);
    await initialize(app);
    await select(app, firstConversationId);
    const draftA = "Borrador privado del hilo A.";
    await changeDraft(app, draftA);

    expect(state(app)?.draft).toBe(draftA);
    await select(app, secondConversationId);
    expect(history(app)?.selectedConversationId).toBe(secondConversationId);
    expect(state(app)?.draft).not.toBe(draftA);
    const draftB = "Borrador privado del hilo B.";
    await changeDraft(app, draftB);

    await select(app, firstConversationId);
    expect(history(app)?.selectedConversationId).toBe(firstConversationId);
    expect(state(app)?.draft).toBe(draftA);
    const turnsBeforeFailure = history(app)?.turns;

    await select(app, secondConversationId);
    expect(history(app)?.selectedConversationId).toBe(firstConversationId);
    expect(history(app)?.turns).toEqual(turnsBeforeFailure);
    expect(state(app)?.draft).toBe(draftA);
    expect(environment.runtimeRequests).toHaveLength(0);

    await select(app, secondConversationId);
    expect(history(app)?.selectedConversationId).toBe(secondConversationId);
    expect(state(app)?.draft).toBe(draftB);
    expect(environment.runtimeRequests).toHaveLength(0);
    expect([...environment.storage.values.values()].join("\n")).not.toContain(draftA);
    expect([...environment.storage.values.values()].join("\n")).not.toContain(draftB);

    app.dispose();
    const remountedEnvironment = createHistoryEnvironment({
      storage: environment.storage,
      listHandler,
      turnsHandler,
      textHandler,
    });
    const remountedApp = mount(remountedEnvironment);
    await initialize(remountedApp);
    history(remountedApp);
    expect(state(remountedApp)?.draft).not.toBe(draftA);
    expect(state(remountedApp)?.draft).not.toBe(draftB);
    expect([...remountedEnvironment.storage.values.values()].join("\n")).not.toContain(draftA);
    expect([...remountedEnvironment.storage.values.values()].join("\n")).not.toContain(draftB);
    expect(remountedEnvironment.runtimeRequests).toHaveLength(0);
  });

  it("reconciles after switching away and back without showing late text on the other conversation", async () => {
    let continueStream;
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Generando",
              lastOrdinal: 1,
              closed: false,
            },
            { conversationId: secondConversationId, label: "Otro", lastOrdinal: 1, closed: false },
          ],
        }),
      turnsHandler: async ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [turn(1, firstQueryId)],
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
                url.searchParams.get("role") === "assistant"
                  ? "Prefijo persistido"
                  : "Pregunta guardada",
            },
          ],
          complete: true,
        }),
      runtimeHandler: async (request) => {
        let controller;
        const response = new Response(
          new ReadableStream({
            start(value) {
              controller = value;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
        const encoder = new TextEncoder();
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
        controller.enqueue(
          encoder.encode(
            `event: text\ndata: ${JSON.stringify({ type: "text", queryId: request.queryId, index: 0, text: "Visible only in first." })}\n\n`,
          ),
        );
        continueStream = () => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: text\ndata: ${JSON.stringify({ type: "text", queryId: request.queryId, index: 1, text: "Late answer." })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `event: completed\ndata: ${JSON.stringify({ type: "completed", queryId: request.queryId })}\n\n`,
              ),
            );
            controller.close();
          } catch {
            // A switched-away observer can be canceled while server work finishes.
          }
        };
        return response;
      },
      recoverHandler: async (request) =>
        jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 2,
          status: "completed",
          question: "Pedido que ya se admitió.",
          answer: "Resultado durable recuperado.",
          canContinue: true,
        }),
    });
    const app = mount(environment);
    await initialize(app);
    await select(app, firstConversationId);
    expect(props(app).onSubmit("Pedido que ya se admitió.")).toBe(true);
    await vi.waitFor(() => expect(environment.runtimeRequests).toHaveLength(1));
    await app.flush();
    expect(state(app)?.answer).toContain("Visible only in first.");

    await select(app, secondConversationId);
    continueStream?.();
    await app.flush();
    expect(history(app)?.selectedConversationId).toBe(secondConversationId);
    expect(JSON.stringify(state(app))).not.toContain("Late answer.");
    expect(environment.runtimeRequests[0].signal.aborted).toBe(true);
    expect(environment.runtimeRequests.map(({ request }) => request.operation)).toEqual([
      "message",
    ]);

    const recoverCountBeforeReturn = environment.runtimeRequests.filter(
      ({ request }) => request.operation === "recover",
    ).length;
    await select(app, firstConversationId);
    await vi.waitFor(() =>
      expect(
        environment.runtimeRequests.filter(({ request }) => request.operation === "recover"),
      ).toHaveLength(recoverCountBeforeReturn + 1),
    );
    await app.flush();

    expect(
      environment.runtimeRequests.filter(({ request }) => request.operation === "message"),
    ).toHaveLength(1);
    expect(environment.runtimeRequests.at(-1)?.request).toMatchObject({
      version: 2,
      operation: "recover",
      conversationId: firstConversationId,
      queryId: expect.any(String),
    });
    expect(state(app)?.answer).toBe("Resultado durable recuperado.");
    expect(JSON.stringify(state(app))).not.toContain("Late answer.");
  });

  it("keeps an uncertain request by identity across selection and discards a delayed recovery callback", async () => {
    const firstRecovery = deferred();
    let recoveryCalls = 0;
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Incierta",
              lastOrdinal: 1,
              closed: false,
            },
            { conversationId: secondConversationId, label: "Otra", lastOrdinal: 1, closed: false },
          ],
        }),
      turnsHandler: async ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: true,
          turns: [],
        }),
      runtimeHandler: async (request) => streamResponse(request, { accepted: false }),
      recoverHandler: async (request) => {
        recoveryCalls += 1;
        if (recoveryCalls === 1) return firstRecovery.promise;
        return jsonResponse({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 2,
          status: "completed",
          question: "Pedido incierto.",
          answer: "Respuesta confirmada al volver.",
          canContinue: true,
        });
      },
    });
    const app = mount(environment);
    await initialize(app);
    await select(app, firstConversationId);
    expect(props(app).onSubmit("Pedido incierto.")).toBe(true);
    await vi.waitFor(() =>
      expect(
        environment.runtimeRequests.some(({ request }) => request.operation === "message"),
      ).toBe(true),
    );
    const uncertainRequest = environment.runtimeRequests.find(
      ({ request }) => request.operation === "message",
    ).request;
    await vi.waitFor(async () => {
      await app.flush();
      expect(
        environment.runtimeRequests.some(({ request }) => request.operation === "recover"),
      ).toBe(true);
    });

    await select(app, secondConversationId);
    const firstRecoveryCall = environment.runtimeRequests.find(
      ({ request }) => request.operation === "recover",
    );
    expect(firstRecoveryCall?.signal.aborted).toBe(true);
    firstRecovery.resolve(
      jsonResponse({
        version: 2,
        conversationId: firstConversationId,
        queryId: uncertainRequest.queryId,
        ordinal: 2,
        status: "completed",
        question: "Pedido incierto.",
        answer: "Respuesta tardía de otro hilo.",
        canContinue: true,
      }),
    );
    await app.flush();
    expect(history(app)?.selectedConversationId).toBe(secondConversationId);
    expect(JSON.stringify(state(app))).not.toContain("Respuesta tardía de otro hilo.");

    const recoverCount = recoveryCalls;
    await select(app, firstConversationId);
    await vi.waitFor(() => expect(recoveryCalls).toBeGreaterThan(recoverCount));
    await app.flush();
    const recoverCallsForFirstConversation = environment.runtimeRequests.filter(
      ({ request }) =>
        request.operation === "recover" && request.conversationId === firstConversationId,
    );
    expect(recoverCallsForFirstConversation).toHaveLength(2);
    expect(recoverCallsForFirstConversation[1].signal.aborted).toBe(false);
    expect(
      environment.runtimeRequests.filter(
        ({ request }) =>
          request.operation === "recover" && request.conversationId === secondConversationId,
      ),
    ).toHaveLength(0);
    expect(
      environment.runtimeRequests.filter(({ request }) => request.operation === "message"),
    ).toHaveLength(1);
    expect(
      environment.runtimeRequests.filter(({ request }) => request.operation === "start"),
    ).toHaveLength(0);
    expect(state(app)?.question).toBe("Pedido incierto.");
    expect(state(app)?.answer).toBe("Respuesta confirmada al volver.");
  });

  it("does not present incomplete text as a complete answer or offer copy", async () => {
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Respuesta parcial",
              lastOrdinal: 1,
              closed: true,
            },
          ],
        }),
      turnsHandler: async ({ conversationId }) =>
        jsonResponse({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: true,
          canContinue: false,
          turns: [
            turn(1, firstQueryId, {
              status: "failed",
              questionManifest: { count: 1, complete: true },
              answerManifest: { count: 2, complete: false },
              cursor: 1,
            }),
          ],
        }),
      textHandler: async ({ conversationId, ordinal, url }) =>
        jsonResponse({
          version: 1,
          conversationId,
          ordinal,
          queryId: firstQueryId,
          role: url.searchParams.get("role"),
          chunks: [
            {
              index: 0,
              text:
                url.searchParams.get("role") === "assistant"
                  ? "Solo este fragmento."
                  : "Pregunta previa.",
            },
          ],
          complete: url.searchParams.get("role") === "user",
          ...(url.searchParams.get("role") === "assistant"
            ? { nextCursor: "missing-answer-part" }
            : {}),
        }),
    });
    const app = mount(environment);
    await initialize(app);
    await select(app, firstConversationId);

    const partialTurn = history(app)?.turns?.[0];
    expect(partialTurn).toMatchObject({
      status: "failed",
      answer: "Solo este fragmento.",
      answerComplete: false,
    });
    const markup = renderCurrentChat(app);
    expect(markup).not.toBeNull();
    if (markup === null) return;
    expect(markup).toContain("Solo este fragmento.");
    expect(markup).not.toMatch(/Copiar respuesta/i);
    expect(markup).not.toMatch(/Respuesta completa/i);
    expect(environment.runtimeRequests).toHaveLength(0);
  });
});
