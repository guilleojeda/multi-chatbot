import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createHistoryEnvironment,
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
  markChatJournalAdmitted,
  readChatJournals,
  writePendingChatJournal,
} from "../../web/chat-journal.ts";

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

function failedContextStream(request) {
  const encoder = new TextEncoder();
  const event = {
    type: "failed",
    code: "context_unavailable",
    message: "INTERNAL_CONTEXT_DETAILS_DO_NOT_DISPLAY requestId=summary-secret-42 prompt=private",
    recordStatus: "not_admitted",
    queryId: request.queryId,
    canContinue: request.operation === "message",
  };
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`event: failed\ndata: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function renderCurrentChat(app) {
  expect(ChatScreen, "AccountApp hook harness should expose the real ChatScreen").toBeTypeOf(
    "function",
  );
  if (typeof ChatScreen !== "function") return "";
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

function terminalTurn(conversationId, ordinal, queryId) {
  return {
    version: 1,
    conversationId,
    throughOrdinal: ordinal,
    closed: false,
    canContinue: true,
    turns: [
      {
        ordinal,
        queryId,
        status: "completed",
        questionManifest: { count: 1, complete: true },
        answerManifest: { count: 1, complete: true },
        cursor: 1,
      },
    ],
  };
}

async function waitForContextFailure(app) {
  await vi.waitFor(async () => {
    await app.flush();
    expect(state(app)?.queryErrorCode).toBe("context_unavailable");
  });
}

describe("conversation summary presentation and preparation failures", () => {
  it("explains summaries briefly while keeping original messages available in the real chat view", async () => {
    const environment = createHistoryEnvironment({
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: [
            {
              conversationId: firstConversationId,
              label: "Actividad original",
              lastOrdinal: 1,
              closed: false,
            },
          ],
        }),
      turnsHandler: async ({ conversationId }) =>
        jsonResponse(terminalTurn(conversationId, 1, firstQueryId)),
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
                url.searchParams.get("role") === "user"
                  ? "Pregunta original de matemática."
                  : "Respuesta original completa.",
            },
          ],
          complete: true,
        }),
    });
    const app = mount(environment);
    await app.flush();
    await props(app).onSelectConversation?.(firstConversationId);
    await app.flush();

    const markup = renderCurrentChat(app);
    expect(markup).toContain(
      "En conversaciones largas usamos un resumen para continuar. Los mensajes originales siguen disponibles en el historial",
    );
    expect(markup).toContain("Pregunta original de matemática.");
    expect(markup).toContain("Respuesta original completa.");
    expect(markup).not.toMatch(
      /SUMMARY_(?:TRIGGER_TOKENS|RECENT_PAIRS|PREPARATION_TIMEOUT_MS)|summaryId|countRequestId|128000|3600000|64000|Bedrock/i,
    );
    expect(markup).not.toMatch(/<(?:button|input)\b[^>]*(?:resumen|summary)/i);
    expect(environment.runtimeRequests).toEqual([]);
  });

  it.each([
    { name: "a new conversation", operation: "start" },
    { name: "a follow-up", operation: "message" },
  ])(
    "keeps the original draft and request identity after context failure for $name until explicit retry",
    async ({ operation }) => {
      let attempt = 0;
      const environment = createHistoryEnvironment({
        listHandler: async () =>
          jsonResponse({
            version: 1,
            conversations:
              operation === "message"
                ? [
                    {
                      conversationId: firstConversationId,
                      label: "Hilo para seguimiento",
                      lastOrdinal: 1,
                      closed: false,
                    },
                  ]
                : [],
          }),
        turnsHandler: async ({ conversationId }) =>
          jsonResponse(terminalTurn(conversationId, 1, firstQueryId)),
        textHandler: async ({ conversationId, ordinal, url }) =>
          jsonResponse({
            version: 1,
            conversationId,
            ordinal,
            queryId: firstQueryId,
            role: url.searchParams.get("role"),
            chunks: [{ index: 0, text: `Original ${url.searchParams.get("role")}.` }],
            complete: true,
          }),
        runtimeHandler: async (request) => {
          attempt += 1;
          return attempt === 1
            ? failedContextStream(request)
            : streamResponse(request, { text: "Respuesta después del reintento." });
        },
      });
      const app = mount(environment);
      await app.flush();
      if (operation === "message") {
        await props(app).onSelectConversation?.(firstConversationId);
        await app.flush();
      }

      const originalText = `Conservá el texto de ${operation}.`;
      props(app).onDraftChange?.(originalText);
      await app.flush();
      expect(props(app).onSubmit?.(originalText)).toBe(true);
      await waitForContextFailure(app);

      const firstRequest = environment.runtimeRequests[0]?.request;
      expect(environment.runtimeRequests).toHaveLength(1);
      expect(firstRequest).toMatchObject({
        version: 2,
        operation,
        baseOrdinal: operation === "message" ? 1 : 0,
        text: originalText,
      });
      expect(state(app)?.draft).toBe(originalText);
      expect(state(app)?.queryError).not.toContain("INTERNAL_CONTEXT_DETAILS_DO_NOT_DISPLAY");
      expect(state(app)?.queryError).not.toContain("summary-secret-42");
      expect(renderCurrentChat(app)).not.toContain("INTERNAL_CONTEXT_DETAILS_DO_NOT_DISPLAY");

      const pending = readChatJournals(environment.config, environment.identity).get(
        firstRequest.conversationId,
      );
      expect(pending).toMatchObject({
        admitted: false,
        request: {
          operation,
          conversationId: firstRequest.conversationId,
          queryId: firstRequest.queryId,
          baseOrdinal: firstRequest.baseOrdinal,
          text: originalText,
        },
      });
      await app.flush();
      expect(environment.runtimeRequests).toHaveLength(1);

      expect(props(app).onSubmit?.(originalText)).toBe(true);
      await vi.waitFor(async () => {
        await app.flush();
        expect(state(app)?.queryStatus).toBe("completed");
      });
      expect(environment.runtimeRequests).toHaveLength(2);
      expect(environment.runtimeRequests[1]?.request).toEqual(firstRequest);
      expect(
        readChatJournals(environment.config, environment.identity).has(firstRequest.conversationId),
      ).toBe(false);
    },
  );

  it("preserves other conversation references when storage rejects a pending write or a new-conversation switch", async () => {
    let attempts = 0;
    const environment = createHistoryEnvironment({
      runtimeHandler: async (request) => {
        attempts += 1;
        return failedContextStream(request);
      },
    });
    const app = mount(environment);
    await app.flush();

    const otherRequest = {
      version: 2,
      operation: "message",
      conversationId: secondConversationId,
      queryId: secondQueryId,
      baseOrdinal: 1,
    };
    writePendingChatJournal(environment.config, environment.identity, {
      ...otherRequest,
      text: "Otro hilo original que no debe alterarse.",
    });
    markChatJournalAdmitted(environment.config, environment.identity, otherRequest, 2);

    const draft = "Conservá este borrador ante falta de almacenamiento.";
    props(app).onDraftChange?.(draft);
    await app.flush();
    environment.storage.denyWrites = true;
    expect(props(app).onSubmit?.(draft)).toBe(false);
    await app.flush();
    expect(state(app)?.draft).toBe(draft);
    expect(environment.runtimeRequests).toHaveLength(0);
    expect(
      readChatJournals(environment.config, environment.identity).get(secondConversationId),
    ).toMatchObject({
      admitted: true,
      ordinal: 2,
    });

    environment.storage.denyWrites = false;
    expect(props(app).onSubmit?.(draft)).toBe(true);
    await waitForContextFailure(app);
    const failedRequest = environment.runtimeRequests[0]?.request;
    expect(attempts).toBe(1);
    expect(state(app)?.draft).toBe(draft);
    expect(
      readChatJournals(environment.config, environment.identity).get(secondConversationId),
    ).toMatchObject({
      admitted: true,
      ordinal: 2,
    });
    expect(
      readChatJournals(environment.config, environment.identity).get(failedRequest.conversationId),
    ).toMatchObject({
      admitted: false,
      request: { queryId: failedRequest.queryId, text: draft },
    });

    props(app).onReset?.();
    await app.flush();
    expect(
      readChatJournals(environment.config, environment.identity).get(secondConversationId),
    ).toMatchObject({
      admitted: true,
      ordinal: 2,
    });
    expect(
      readChatJournals(environment.config, environment.identity).get(failedRequest.conversationId),
    ).toMatchObject({
      admitted: false,
      request: { queryId: failedRequest.queryId, text: draft },
    });
    expect(environment.runtimeRequests).toHaveLength(1);
  });
});
