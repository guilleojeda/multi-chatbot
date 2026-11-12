import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountApp } from "../../web/AccountApp.tsx";
import {
  accountButton,
  accountControl,
  accountConversationId,
  accountJson,
  accountQueryId,
  accountText,
  createPhase9AccountWebHarness,
  deferred,
  teacherIdentity,
} from "../support/phase9-account-web-harness.mjs";

const mounted = [];
const query = {
  ordinal: 1,
  queryId: accountQueryId,
  status: "completed",
  questionManifest: { count: 1, complete: true },
  answerManifest: { count: 1, complete: true },
  cursor: 1,
};

function completeProfile() {
  return accountJson({
    sub: teacherIdentity.sub,
    botId: teacherIdentity.botId,
    profile: {
      sub: teacherIdentity.sub,
      botId: teacherIdentity.botId,
      updatedAt: "2026-11-10T12:00:00.000Z",
      fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
      responsePreferenceIds: ["step-by-step"],
    },
  });
}

function historyHandlers({ visible = true, turns = [query], canContinue = true, hide } = {}) {
  let hidden = !visible;
  const summary = {
    conversationId: accountConversationId,
    label: "Actividad de porcentajes",
    createdAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T11:00:00.000Z",
    lastOrdinal: turns.at(-1)?.ordinal ?? 0,
    closed: false,
  };
  return {
    listHandler: async () => accountJson({ version: 1, conversations: hidden ? [] : [summary] }),
    metaHandler: async ({ conversationId }) =>
      hidden
        ? accountJson({ code: "CONVERSATION_HIDDEN" }, 404)
        : accountJson({ version: 1, ...summary, conversationId }),
    turnsHandler: async ({ conversationId }) =>
      accountJson({
        version: 1,
        conversationId,
        throughOrdinal: summary.lastOrdinal,
        closed: false,
        canContinue,
        turns,
      }),
    textHandler: async ({ conversationId, ordinal, url }) =>
      accountJson({
        version: 1,
        conversationId,
        queryId: url.searchParams.get("queryId"),
        ordinal,
        role: url.searchParams.get("role"),
        chunks: [
          {
            index: 0,
            text:
              url.searchParams.get("role") === "user"
                ? "Prepará una actividad de porcentajes."
                : "Usá descuentos y precios de ejemplo.",
          },
        ],
        complete: true,
      }),
    hideHandler: async ({ conversationId }) => {
      hide?.(conversationId);
      hidden = true;
      return accountJson({ conversationId, hiddenAt: "2026-11-12T15:00:00.000Z" });
    },
  };
}

function findButtonContaining(document, text) {
  return [...document.querySelectorAll("button")].find((button) =>
    button.textContent.includes(text),
  );
}

async function createMounted(options = {}) {
  const harness = await createPhase9AccountWebHarness(AccountApp, options);
  mounted.push(harness);
  await harness.mount();
  await harness.settle();
  return harness;
}

async function waitForPage(harness, text) {
  await vi.waitFor(() => {
    const currentText = accountText(harness.document);
    if (!currentText.includes(text)) {
      throw new Error(`Expected page text ${JSON.stringify(text)}; rendered: ${currentText}`);
    }
  });
  await harness.settle();
}

async function waitForButton(harness, name) {
  await vi.waitFor(() => {
    if (!accountButton(harness.document, name)) {
      throw new Error(
        `Expected button ${JSON.stringify(name)}; rendered: ${accountText(harness.document)}`,
      );
    }
  });
}

async function openConversation(harness, label = "Actividad de porcentajes") {
  await harness.click(findButtonContaining(harness.document, label));
  await waitForPage(harness, "Prepará una actividad de porcentajes.");
}

function currentChatForm(harness) {
  return harness.document.querySelector("form.chat-form");
}

function sendIsBlocked(document) {
  const send = accountButton(document, "Enviar");
  return !send || send.disabled;
}

function runtimeFailure(request, code = "access_revoked") {
  return accountJson({
    type: "failed",
    code,
    message: "Tu acceso a nuevas consultas está revocado.",
    recordStatus: "not_admitted",
    queryId: request.queryId,
    canContinue: true,
  });
}

function sse(type, value) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function heldAcceptedStream(request) {
  const completed = deferred();
  const started = deferred();
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          sse("accepted", {
            conversationId: request.conversationId,
            queryId: request.queryId,
            ordinal: request.baseOrdinal + 1,
          }) + sse("text", { queryId: request.queryId, index: 0, text: "Respuesta durable" }),
        ),
      );
      started.resolve();
      await completed.promise;
      if (!cancelled) {
        controller.enqueue(encoder.encode(sse("completed", { queryId: request.queryId })));
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
      completed.resolve();
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    started: started.promise,
    complete: () => completed.resolve(),
  };
}

function completedStream(request, answer) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          sse("accepted", {
            conversationId: request.conversationId,
            queryId: request.queryId,
            ordinal: request.baseOrdinal + 1,
          }) +
            sse("text", { queryId: request.queryId, index: 0, text: answer }) +
            sse("completed", { queryId: request.queryId }),
        ),
      );
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

afterEach(async () => {
  for (const harness of mounted.splice(0).reverse()) await harness.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("docente web access after revocation", () => {
  it("keeps the signed-in session and lets a revoked teacher without a profile read, copy, and hide history after reload", async () => {
    let hiddenConversation = false;
    const handlers = historyHandlers({ hide: () => (hiddenConversation = true) });
    const harness = await createMounted({
      profileHandler: async () =>
        accountJson({ sub: teacherIdentity.sub, botId: teacherIdentity.botId, profile: null }),
      accountHandler: async () =>
        accountJson({
          ...teacherIdentity,
          access: { state: "revoked", revision: 8 },
        }),
      ...handlers,
    });

    await waitForPage(harness, "Historial");
    expect(accountText(harness.document)).toContain("Completá tu perfil");
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");
    expect(harness.runtimeRequests).toHaveLength(0);

    await harness.reload();
    await waitForPage(harness, "Actividad de porcentajes");
    expect(harness.session().accessToken()).toBe("controlled-teacher-access-token");
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");
    await openConversation(harness);
    expect(accountText(harness.document)).toContain("Usá descuentos y precios de ejemplo.");

    const copyButton = [...harness.document.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith("Copiar respuesta"),
    );
    await harness.click(copyButton);
    expect(harness.dom.window.navigator.clipboard.writeText).toHaveBeenCalledWith(
      "Usá descuentos y precios de ejemplo.",
    );

    await harness.click(
      accountButton(harness.document, "Quitar del historial: Actividad de porcentajes"),
    );
    expect(accountText(harness.document)).toContain("No vas a poder volver a abrirla");
    await harness.click(accountButton(harness.document, "Quitar del historial"));
    await vi.waitFor(() => expect(hiddenConversation).toBe(true));
    await harness.settle();
    expect(hiddenConversation).toBe(true);
    expect(harness.runtimeRequests).toHaveLength(0);

    await harness.reload();
    await waitForPage(harness, "Todavía no hay conversaciones guardadas.");
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");
  });

  it("denies a none access state and never presents it as an empty history", async () => {
    const handlers = historyHandlers();
    const harness = await createMounted({
      accountHandler: async () =>
        accountJson({ ...teacherIdentity, access: { state: "none", revision: 1 } }),
      ...handlers,
    });

    await waitForPage(harness, "acceso");
    expect(harness.accountRequests).toHaveLength(1);
    expect(harness.apiRequests.some(({ path }) => path === "/chat/conversations")).toBe(false);
    expect(accountText(harness.document)).not.toContain("Todavía no hay conversaciones guardadas.");
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");
  });

  it("blocks starting and continuing after an active thread is rechecked as revoked, even when it canContinue", async () => {
    let access = { state: "active", revision: 12 };
    const handlers = historyHandlers({ canContinue: true });
    const harness = await createMounted({
      profileHandler: completeProfile,
      accountHandler: async () => accountJson({ ...teacherIdentity, access }),
      runtimeHandler: async ({ request }) =>
        completedStream(request, "Respuesta del seguimiento admitido."),
      ...handlers,
    });
    await waitForPage(harness, "Actividad de porcentajes");
    await openConversation(harness);
    await waitForButton(harness, "Enviar");

    const admittedFollowUp = "Agregá una segunda actividad.";
    await harness.setValue(
      accountControl(harness.document, "Escribí tu consulta"),
      admittedFollowUp,
    );
    expect(accountButton(harness.document, "Enviar").disabled).toBe(false);
    await harness.click(accountButton(harness.document, "Enviar"));
    await waitForPage(harness, "Respuesta del seguimiento admitido.");
    expect(harness.runtimeRequests).toHaveLength(1);
    expect(harness.runtimeRequests[0].request).toMatchObject({
      operation: "message",
      conversationId: accountConversationId,
      baseOrdinal: 1,
      text: admittedFollowUp,
    });

    access = { state: "revoked", revision: 13 };
    await harness.setRoute({ kind: "profile" });
    await waitForPage(harness, "Mi perfil");
    await harness.setRoute({ kind: "chat" });
    await waitForPage(harness, "Respuesta del seguimiento admitido.");
    expect(sendIsBlocked(harness.document)).toBe(true);

    await harness.click(accountButton(harness.document, "Nueva conversación"));
    expect(sendIsBlocked(harness.document)).toBe(true);
    const form = currentChatForm(harness);
    if (form) {
      const newQuestion = "Prepará una consulta inicial.";
      await harness.setValue(accountControl(harness.document, "Escribí tu consulta"), newQuestion);
      expect(sendIsBlocked(harness.document)).toBe(true);
      await harness.submit(form);
      expect(accountControl(harness.document, "Escribí tu consulta").value).toBe(newQuestion);
    }
    expect(harness.runtimeRequests).toHaveLength(1);
    expect(accountText(harness.document)).toContain("Actividad de porcentajes");
  });

  it("treats a new access_revoked result as a send restriction while retaining the transcript, draft, and history controls", async () => {
    let access = { state: "active", revision: 4 };
    const handlers = historyHandlers({ canContinue: true });
    const harness = await createMounted({
      profileHandler: completeProfile,
      accountHandler: async () => accountJson({ ...teacherIdentity, access }),
      runtimeHandler: async ({ request }) => {
        access = { state: "revoked", revision: 5 };
        return runtimeFailure(request);
      },
      ...handlers,
    });
    await openConversation(harness);
    await waitForButton(harness, "Enviar");

    const draft = "Conservá la pregunta si se revoca el acceso.";
    await harness.setValue(accountControl(harness.document, "Escribí tu consulta"), draft);
    await harness.click(accountButton(harness.document, "Enviar"));
    await waitForPage(harness, "Tu acceso a nuevas consultas está revocado.");

    expect(harness.runtimeRequests).toHaveLength(1);
    expect(harness.runtimeRequests[0].request).toMatchObject({
      operation: "message",
      conversationId: accountConversationId,
      baseOrdinal: 1,
      text: draft,
    });
    expect(harness.runtimeRequests[0].request.queryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(accountText(harness.document)).toContain("Prepará una actividad de porcentajes.");
    expect(accountText(harness.document)).toContain("Usá descuentos y precios de ejemplo.");
    expect(
      harness.document.querySelector('[aria-label="Historial de conversaciones"]'),
    ).not.toBeNull();
    expect(accountText(harness.document)).not.toContain("Iniciá sesión");
    const retainedDraft = accountControl(harness.document, "Escribí tu consulta");
    expect(
      accountText(harness.document),
      "An access_revoked response must keep the rejected question accessible",
    ).toContain(draft);
    if (retainedDraft) expect(retainedDraft.value).toBe(draft);
    expect(sendIsBlocked(harness.document)).toBe(true);
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");

    // The access restriction must also survive leaving the failed thread.
    const newConversation = accountButton(harness.document, "Nueva conversación");
    expect(newConversation).toBeDefined();
    if (newConversation && !newConversation.disabled) {
      await harness.click(newConversation);
      const nextDraft = accountControl(harness.document, "Escribí tu consulta");
      if (nextDraft) await harness.setValue(nextDraft, "Otra pregunta con el acceso revocado.");
      expect(sendIsBlocked(harness.document)).toBe(true);
    }
    expect(harness.runtimeRequests).toHaveLength(1);
  });

  it("keeps new sends paused after an access rejection if the current status read fails, then resumes on a newer active read", async () => {
    let access = { state: "active", revision: 4 };
    let accountReads = 0;
    const handlers = historyHandlers({ canContinue: true });
    const harness = await createMounted({
      profileHandler: completeProfile,
      accountHandler: async () => {
        accountReads += 1;
        if (accountReads === 2) return accountJson({ code: "SERVICE_UNAVAILABLE" }, 503);
        return accountJson({ ...teacherIdentity, access });
      },
      runtimeHandler: async ({ request }) => runtimeFailure(request),
      ...handlers,
    });
    await openConversation(harness);
    await waitForButton(harness, "Enviar");

    await harness.setValue(
      accountControl(harness.document, "Escribí tu consulta"),
      "El Runtime rechaza el envío, pero el estado no se pudo leer.",
    );
    await harness.click(accountButton(harness.document, "Enviar"));
    await waitForPage(harness, "No pudimos comprobar el estado actual de tu acceso.");
    expect(accountText(harness.document)).not.toContain(
      "Tu acceso a nuevas consultas está revocado.",
    );
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");

    await harness.click(accountButton(harness.document, "Nueva conversación"));
    const nextQuestion = "Una pregunta posterior a la lectura transitoria.";
    await harness.setValue(accountControl(harness.document, "Escribí tu consulta"), nextQuestion);
    expect(accountButton(harness.document, "Enviar").disabled).toBe(true);
    await harness.submit(currentChatForm(harness));
    expect(harness.runtimeRequests).toHaveLength(1);

    access = { state: "active", revision: 6 };
    await harness.setRoute({ kind: "profile" });
    await waitForPage(harness, "Mi perfil");
    await harness.setRoute({ kind: "chat" });
    await waitForButton(harness, "Enviar");
    expect(accountButton(harness.document, "Enviar").disabled).toBe(false);
    expect(accountControl(harness.document, "Escribí tu consulta").value).toBe(nextQuestion);
    expect(harness.accountRequests).toHaveLength(4);
    expect(harness.runtimeRequests).toHaveLength(1);
  });

  it("does not turn an earlier uncertain request into a confirmed rejection or change its IDs", async () => {
    let access = { state: "active", revision: 2 };
    const handlers = historyHandlers({ visible: false });
    const harness = await createMounted({
      profileHandler: completeProfile,
      accountHandler: async () => accountJson({ ...teacherIdentity, access }),
      runtimeHandler: async ({ request }) => {
        if (harness.runtimeRequests.length === 1) throw new TypeError("connection lost");
        access = { state: "revoked", revision: 3 };
        return runtimeFailure(request);
      },
      ...handlers,
    });

    const draft = "Un único envío conserva su identidad.";
    await harness.setValue(accountControl(harness.document, "Escribí tu consulta"), draft);
    await harness.click(accountButton(harness.document, "Enviar"));
    await waitForPage(harness, "Reintentar el mismo envío");
    const firstRequest = harness.runtimeRequests[0].request;
    expect(accountButton(harness.document, "Reintentar el mismo envío")).toBeDefined();

    await harness.click(accountButton(harness.document, "Reintentar el mismo envío"));
    await waitForPage(harness, "Tu acceso a nuevas consultas está revocado.");
    expect(harness.runtimeRequests.length).toBeGreaterThanOrEqual(3);
    expect(harness.runtimeRequests[1].request).toMatchObject({
      version: 2,
      operation: "recover",
      conversationId: firstRequest.conversationId,
      queryId: firstRequest.queryId,
    });
    expect(harness.runtimeRequests[2].request).toEqual(firstRequest);
    const retries = harness.runtimeRequests.map(({ request }) => request);
    expect(retries.filter(({ operation }) => operation !== "recover")).toEqual([
      firstRequest,
      firstRequest,
    ]);
    for (const request of retries.filter(({ operation }) => operation === "recover")) {
      expect(request).toMatchObject({
        operation: "recover",
        conversationId: firstRequest.conversationId,
        queryId: firstRequest.queryId,
      });
    }
    expect(accountButton(harness.document, "Reintentar el mismo envío")).toBeDefined();
    expect(accountText(harness.document)).not.toContain("Iniciá sesión");
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");
  });

  it("finishes an already admitted stream after revocation", async () => {
    let access = { state: "active", revision: 1 };
    let stream;
    const handlers = historyHandlers({ visible: false });
    const harness = await createMounted({
      profileHandler: completeProfile,
      accountHandler: async () => accountJson({ ...teacherIdentity, access }),
      runtimeHandler: async ({ request }) => {
        stream = heldAcceptedStream(request);
        return stream.response;
      },
      ...handlers,
    });

    await harness.setValue(
      accountControl(harness.document, "Escribí tu consulta"),
      "Explicá descuentos.",
    );
    await harness.click(accountButton(harness.document, "Enviar"));
    await vi.waitFor(() => expect(stream).toBeDefined());
    await stream.started;
    await waitForPage(harness, "Respuesta durable");
    access = { state: "revoked", revision: 2 };
    stream.complete();
    await waitForPage(harness, "La respuesta está completa.");

    expect(accountText(harness.document)).toContain("Explicá descuentos.");
    expect(accountText(harness.document)).toContain("Respuesta durable");
    expect(accountButton(harness.document, "Copiar respuesta")).toBeDefined();
    expect(harness.runtimeRequests).toHaveLength(1);
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");
  });

  it("recovers a completed admitted send after reload while access is revoked", async () => {
    let access = { state: "active", revision: 6 };
    let stream;
    let latestRequest;
    let recovered = false;
    const conversation = {
      ...query,
      status: "in_progress",
      answerManifest: { count: 1, complete: false },
    };
    const harness = await createMounted({
      profileHandler: completeProfile,
      accountHandler: async () => accountJson({ ...teacherIdentity, access }),
      listHandler: async () =>
        accountJson({
          version: 1,
          conversations: latestRequest
            ? [
                {
                  conversationId: latestRequest.conversationId,
                  label: "Explicá los porcentajes.",
                  lastOrdinal: 1,
                  closed: false,
                  activeQueryId: latestRequest.queryId,
                },
              ]
            : [],
        }),
      metaHandler: async () => {
        if (!latestRequest) return accountJson({ code: "NOT_FOUND" }, 404);
        return accountJson({
          version: 1,
          conversationId: latestRequest.conversationId,
          label: "Explicá los porcentajes.",
          lastOrdinal: 1,
          closed: false,
          activeQueryId: latestRequest.queryId,
        });
      },
      turnsHandler: async ({ conversationId }) =>
        accountJson({
          version: 1,
          conversationId,
          throughOrdinal: 1,
          closed: false,
          canContinue: false,
          turns: [
            {
              ...conversation,
              queryId: latestRequest.queryId,
              status: recovered ? "completed" : "in_progress",
              answerManifest: { count: 1, complete: recovered },
            },
          ],
        }),
      textHandler: async ({ conversationId, ordinal, url }) =>
        accountJson({
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
                  ? "Explicá los porcentajes."
                  : "Respuesta parcial durable.",
            },
          ],
          complete: true,
        }),
      runtimeHandler: async ({ request }) => {
        latestRequest = request;
        stream = heldAcceptedStream(request);
        return stream.response;
      },
      recoverHandler: async ({ request }) => {
        recovered = true;
        return accountJson({
          version: 2,
          conversationId: request.conversationId,
          queryId: request.queryId,
          ordinal: 1,
          status: "completed",
          question: "Explicá los porcentajes.",
          answer: "Respuesta recuperada completa.",
          canContinue: true,
        });
      },
    });

    await harness.setValue(
      accountControl(harness.document, "Escribí tu consulta"),
      "Explicá los porcentajes.",
    );
    await harness.click(accountButton(harness.document, "Enviar"));
    await vi.waitFor(() => expect(stream).toBeDefined());
    await stream.started;
    await waitForPage(harness, "Respuesta durable");
    expect(harness.runtimeRequests[0].request).toMatchObject({
      operation: "start",
      baseOrdinal: 0,
      text: "Explicá los porcentajes.",
    });
    access = { state: "revoked", revision: 7 };

    await harness.reload();
    await waitForPage(harness, "Respuesta recuperada completa.");
    expect(accountText(harness.document)).toContain("Explicá los porcentajes.");
    expect(harness.runtimeRequests).toHaveLength(2);
    expect(harness.runtimeRequests[1].request).toEqual({
      version: 2,
      operation: "recover",
      conversationId: harness.runtimeRequests[0].request.conversationId,
      queryId: harness.runtimeRequests[0].request.queryId,
    });
    expect(harness.runtimeRequests[1].headers.get("accept")).toBe("application/json");
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");
  });

  it("does not let an unversioned old Runtime rejection override a newer active account status", async () => {
    const oldRuntimeResponse = deferred();
    const states = [
      { ...teacherIdentity, access: { state: "active", revision: 8 } },
      { ...teacherIdentity, access: { state: "revoked", revision: 9 } },
      { ...teacherIdentity, access: { state: "active", revision: 10 } },
    ];
    let requestIndex = 0;
    const harness = await createMounted({
      profileHandler: completeProfile,
      accountHandler: async () => accountJson(states[Math.min(requestIndex++, states.length - 1)]),
      listHandler: async () => accountJson({ version: 1, conversations: [] }),
      runtimeHandler: async () => oldRuntimeResponse.promise,
    });
    const originalDraft = "La llamada vieja todavía no respondió.";
    await harness.setValue(accountControl(harness.document, "Escribí tu consulta"), originalDraft);
    await harness.click(accountButton(harness.document, "Enviar"));
    await vi.waitFor(() => expect(harness.runtimeRequests).toHaveLength(1));

    await harness.setRoute({ kind: "profile" });
    await waitForPage(harness, "Mi perfil");
    await harness.setRoute({ kind: "chat" });
    await waitForPage(harness, "Nueva conversación");
    await harness.click(accountButton(harness.document, "Nueva conversación"));
    await waitForButton(harness, "Enviar");
    await harness.setValue(
      accountControl(harness.document, "Escribí tu consulta"),
      "Una consulta nueva después de restituir el acceso.",
    );
    expect(accountButton(harness.document, "Enviar").disabled).toBe(false);

    oldRuntimeResponse.resolve(
      accountJson({
        type: "failed",
        code: "access_revoked",
        message: "Tu acceso a nuevas consultas está revocado.",
        recordStatus: "not_admitted",
        queryId: harness.runtimeRequests[0].request.queryId,
        canContinue: true,
      }),
    );
    await harness.settle();

    expect(harness.runtimeRequests[0].init.signal.aborted).toBe(true);
    expect(harness.accountRequests).toHaveLength(3);
    expect(accountButton(harness.document, "Enviar").disabled).toBe(false);
    expect(accountText(harness.document)).not.toContain("Iniciá sesión");
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");
  });

  it("ignores a delayed Runtime revocation for global sending after the same conversation was rechecked active", async () => {
    const oldRuntimeResponse = deferred();
    let accountReads = 0;
    let releaseOldRuntime = false;
    const handlers = historyHandlers({ visible: false });
    const harness = await createMounted({
      profileHandler: completeProfile,
      accountHandler: async () => {
        if (releaseOldRuntime) return accountJson({ code: "SERVICE_UNAVAILABLE" }, 503);
        accountReads += 1;
        return accountJson({
          ...teacherIdentity,
          access: { state: "active", revision: 3 + accountReads },
        });
      },
      runtimeHandler: async ({ request }) => {
        if (harness.runtimeRequests.length === 1) return oldRuntimeResponse.promise;
        return completedStream(request, "Respuesta de la consulta nueva.");
      },
      ...handlers,
    });

    const originalQuestion = "La consulta iniciada antes de volver al chat.";
    await harness.setValue(
      accountControl(harness.document, "Escribí tu consulta"),
      originalQuestion,
    );
    await harness.click(accountButton(harness.document, "Enviar"));
    await vi.waitFor(() => expect(harness.runtimeRequests).toHaveLength(1));

    await harness.setRoute({ kind: "profile" });
    await waitForPage(harness, "Mi perfil");
    await harness.setRoute({ kind: "chat" });
    await waitForPage(harness, "Nueva conversación");
    expect(harness.runtimeRequests[0].init.signal.aborted).toBe(false);
    expect(harness.accountRequests).toHaveLength(3);

    releaseOldRuntime = true;
    oldRuntimeResponse.resolve(runtimeFailure(harness.runtimeRequests[0].request));
    await waitForPage(harness, "El estado actual del acceso ya se confirmó.");
    expect(harness.accountRequests).toHaveLength(3);
    expect(harness.runtimeRequests[0].request.text).toBe(originalQuestion);
    expect(accountControl(harness.document, "Escribí tu consulta").value).toBe(originalQuestion);
    expect(accountText(harness.document)).toContain("No se admitió esta consulta.");
    expect(accountText(harness.document)).not.toContain(
      "Tu acceso a nuevas consultas está revocado.",
    );
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");

    await harness.click(accountButton(harness.document, "Nueva conversación"));
    const nextQuestion = "Una consulta nueva tras confirmar el acceso activo.";
    await harness.setValue(accountControl(harness.document, "Escribí tu consulta"), nextQuestion);
    expect(accountButton(harness.document, "Enviar").disabled).toBe(false);
    await harness.click(accountButton(harness.document, "Enviar"));
    await waitForPage(harness, "Respuesta de la consulta nueva.");
    expect(harness.runtimeRequests).toHaveLength(2);
    expect(harness.runtimeRequests[1].request).toMatchObject({
      operation: "start",
      text: nextQuestion,
    });
  });

  it("ignores an older access revision and stale owner or bot state, then accepts the current same-owner state", async () => {
    const states = [
      { ...teacherIdentity, access: { state: "revoked", revision: 10 } },
      { ...teacherIdentity, access: { state: "active", revision: 9 } },
      { sub: "teacher-b", botId: "docentes", access: { state: "active", revision: 11 } },
      { sub: teacherIdentity.sub, botId: "otro", access: { state: "active", revision: 12 } },
      { ...teacherIdentity, access: { state: "active", revision: 11 } },
    ];
    let requestIndex = 0;
    const handlers = historyHandlers();
    const harness = await createMounted({
      profileHandler: completeProfile,
      accountHandler: async () => accountJson(states[Math.min(requestIndex++, states.length - 1)]),
      ...handlers,
    });
    await waitForPage(harness, "Actividad de porcentajes");
    expect(sendIsBlocked(harness.document)).toBe(true);

    await harness.setRoute({ kind: "profile" });
    await waitForPage(harness, "Mi perfil");
    await harness.setRoute({ kind: "chat" });
    await waitForPage(harness, "Actividad de porcentajes");
    expect(sendIsBlocked(harness.document)).toBe(true);

    await harness.setRoute({ kind: "profile" });
    await waitForPage(harness, "Mi perfil");
    await harness.setRoute({ kind: "chat" });
    await waitForPage(harness, "Actividad de porcentajes");
    await waitForButton(harness, "Enviar");
    await harness.setValue(
      accountControl(harness.document, "Escribí tu consulta"),
      "Una pregunta con el permiso restituido.",
    );
    expect(accountButton(harness.document, "Enviar").disabled).toBe(false);
    expect(harness.accountRequests).toHaveLength(5);
    expect(harness.runtimeRequests).toHaveLength(0);
    expect(accountText(harness.document)).toContain("Actividad de porcentajes");
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");
  });

  it("keeps a temporary account-status failure distinct from revocation and preserves history on retry", async () => {
    let calls = 0;
    const handlers = historyHandlers();
    const harness = await createMounted({
      accountHandler: async () => {
        calls += 1;
        if (calls === 2) return accountJson({ code: "SERVICE_UNAVAILABLE" }, 503);
        return accountJson({ ...teacherIdentity, access: { state: "revoked", revision: 3 } });
      },
      ...handlers,
    });
    await waitForPage(harness, "Actividad de porcentajes");

    await harness.setRoute({ kind: "profile" });
    await waitForPage(harness, "No se pudo confirmar");
    expect(accountText(harness.document)).not.toContain("no tiene acceso");
    expect(harness.storage.getItem("auth-refresh")).toBe("controlled-refresh-token");

    await harness.click(accountButton(harness.document, "Reintentar"));
    await waitForPage(harness, "Completá tu perfil");
    await harness.setRoute({ kind: "chat" });
    await waitForPage(harness, "Actividad de porcentajes");
    expect(accountText(harness.document)).not.toContain("Todavía no hay conversaciones guardadas.");
    expect(harness.runtimeRequests).toHaveLength(0);
  });

  it("clears the shared web session on explicit logout", async () => {
    const harness = await createMounted({
      accountHandler: async () =>
        accountJson({ ...teacherIdentity, access: { state: "revoked", revision: 2 } }),
      ...historyHandlers(),
    });
    await waitForPage(harness, "Historial");

    await harness.click(accountButton(harness.document, "Cerrar sesión"));
    await waitForPage(harness, "Iniciá sesión");
    expect(harness.storage.getItem("auth-refresh")).toBeNull();
    expect(harness.session().accessToken()).toBeNull();
    expect(harness.runtimeRequests).toHaveLength(0);
  });
});
