import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markChatJournalAdmitted,
  readChatJournals,
  readChatSelection,
  writeChatSelection,
  writePendingChatJournal,
} from "../../web/chat-journal.ts";
import {
  accessToken,
  createHistoryEnvironment,
  deferred,
  firstConversationId,
  firstQueryId,
  historyIdentity,
  jsonResponse,
  secondConversationId,
  secondQueryId,
} from "../support/history-web-harness.mjs";
import {
  allButtons,
  buttonByText,
  clearPhase8Root,
  clickPhase8,
  componentProps,
  conversationRow,
  createPhase8Dom,
  hideButtonFor,
  installPhase8Routes,
  mountPhase8AccountApp,
  renderPhase8AccountApp,
  statusText,
  visibleHistoryState,
} from "../support/phase8-web-harness.mjs";

const firstLabel = "Actividad de porcentajes";
const secondLabel = "Rúbrica de lectura";
const hiddenAt = "2026-10-27T13:45:00.000Z";
const thirdConversationId = "e367c7d4-6d1e-4a6b-a55f-42cab0d35b4f";
const thirdQueryId = "d266b6c3-5c0d-4b45-a9da-77b675bed25b";

let AccountApp;
let disposeAccountAppModule;
let domState;
const apps = [];

function summary(conversationId, label, overrides = {}) {
  return {
    conversationId,
    label,
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    lastOrdinal: 1,
    closed: false,
    ...overrides,
  };
}

function visibleMetadata(conversation) {
  return { version: 1, ...conversation };
}

function makeEnvironment({
  conversations = [],
  listHandler,
  turnsHandler,
  textHandler,
  runtimeHandler,
  recoverHandler,
  hideHandler = async ({ conversationId }) =>
    jsonResponse({ version: 1, conversationId, hiddenAt }),
  metaHandler,
  storage,
  membershipStatus,
} = {}) {
  const env = createHistoryEnvironment({
    storage,
    listHandler:
      listHandler ??
      (async () => jsonResponse({ version: 1, conversations, nextCursor: undefined })),
    turnsHandler,
    textHandler,
    runtimeHandler,
    recoverHandler,
    membershipStatus,
  });
  const byId = new Map(conversations.map((entry) => [entry.conversationId, entry]));
  installPhase8Routes(env, {
    hideHandler,
    metaHandler:
      metaHandler ??
      (async ({ conversationId }) => {
        const value = byId.get(conversationId);
        return value
          ? jsonResponse(visibleMetadata(value))
          : jsonResponse({ code: "CONVERSATION_NOT_FOUND" }, 404);
      }),
  });
  return env;
}

function turnsPage(conversationId, label, overrides = {}) {
  return jsonResponse({
    version: 1,
    conversationId,
    label,
    throughOrdinal: 1,
    closed: false,
    canContinue: true,
    turns: [
      {
        ordinal: 1,
        queryId: conversationId === firstConversationId ? firstQueryId : secondQueryId,
        status: "completed",
        questionManifest: { count: 1, complete: true },
        answerManifest: { count: 1, complete: true },
        cursor: 1,
      },
    ],
    ...overrides,
  });
}

function textPage(conversationId, ordinal, role) {
  return jsonResponse({
    version: 1,
    conversationId,
    queryId:
      conversationId === firstConversationId
        ? firstQueryId
        : conversationId === secondConversationId
          ? secondQueryId
          : thirdQueryId,
    ordinal,
    role,
    chunks: [
      {
        index: 0,
        text:
          conversationId === firstConversationId
            ? role === "user"
              ? "Prepará porcentajes."
              : "Usá descuentos."
            : role === "user"
              ? "Armá una rúbrica."
              : "Definí criterios claros.",
      },
    ],
    complete: true,
  });
}

function historyRows(first = firstLabel, second = secondLabel) {
  return [summary(firstConversationId, first), summary(secondConversationId, second)];
}

function listCalls(env) {
  return env.apiRequests.filter(
    ({ method, path }) => method === "GET" && path === "/chat/conversations",
  );
}

function hideCalls(env) {
  return env.apiRequests.filter(({ method, path }) => method === "POST" && path.endsWith("/hide"));
}

function selectButton(document, label) {
  return [...document.querySelectorAll(".chat-history__item")].find((button) =>
    button.textContent?.includes(label),
  );
}

function actionButton(document, label) {
  const row = conversationRow(document, label);
  const hide = hideButtonFor(document, label);
  if (!row || !hide) throw new Error(`Expected a separate hide control for ${label}`);
  return hide;
}

async function mount(env) {
  const app = await mountPhase8AccountApp(env, AccountApp, domState);
  apps.push(app);
  return app;
}

async function render(app) {
  await renderPhase8AccountApp(app, domState);
}

async function clickHideFor(app, env, label) {
  await clickPhase8(actionButton(domState.document, label), app, domState);
  expect(hideCalls(env)).toHaveLength(0);
}

async function confirmHide(app) {
  const button = buttonByText(domState.document, "Quitar del historial");
  expect(button, "the confirmation must expose the explicit action").toBeDefined();
  await clickPhase8(button, app, domState);
}

async function clickText(app, text) {
  const button = buttonByText(domState.document, text);
  expect(button, `expected a real button named ${text}`).toBeDefined();
  await clickPhase8(button, app, domState);
}

async function selectConversation(app, label) {
  const button = selectButton(domState.document, label);
  expect(button, `expected a real history row for ${label}`).toBeDefined();
  await clickPhase8(button, app, domState);
}

function writeJournal(env, conversationId, { admitted = false, text = "borrador" } = {}) {
  const request = {
    version: 2,
    operation: "start",
    conversationId,
    queryId:
      conversationId === firstConversationId
        ? firstQueryId
        : conversationId === secondConversationId
          ? secondQueryId
          : thirdQueryId,
    baseOrdinal: 0,
    text,
  };
  if (admitted) {
    markChatJournalAdmitted(env.config, historyIdentity, request, 1);
  } else {
    writePendingChatJournal(env.config, historyIdentity, request);
  }
  return request;
}

beforeAll(async () => {
  const loaded = await (await import("../support/history-web-harness.mjs")).loadHistoryAccountApp();
  AccountApp = loaded.AccountApp;
  disposeAccountAppModule = loaded.dispose;
});

beforeEach(async () => {
  domState = await createPhase8Dom();
});

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) app.dispose();
  await domState?.dispose();
  domState = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete globalThis.__accountHooks;
  delete globalThis.__accountScreens;
  delete globalThis.__accountSession;
});

afterAll(async () => {
  await disposeAccountAppModule?.();
});

describe("chat history removal in AccountApp and ChatScreen", () => {
  it("requires an explicit confirmation, shows the required disclosure, and cancellation returns focus", async () => {
    const rows = historyRows();
    const env = makeEnvironment({ conversations: rows });
    const app = await mount(env);
    const trigger = actionButton(domState.document, secondLabel);

    await clickHideFor(app, env, secondLabel);

    expect(domState.document.body.textContent).toContain(
      "Esta conversación dejará de aparecer en tu historial. Su contenido seguirá disponible para el equipo administrador y el análisis de consultas",
    );
    expect(domState.document.body.textContent).toContain(
      "No vas a poder volver a abrirla ni continuarla. Quitarla no devuelve cupo",
    );
    expect(hideCalls(env)).toHaveLength(0);
    expect(visibleHistoryState(app).selectedConversationId).toBeNull();
    expect(domState.document.activeElement).toBe(buttonByText(domState.document, "Cancelar"));

    await clickText(app, "Cancelar");

    expect(hideCalls(env)).toHaveLength(0);
    expect(conversationRow(domState.document, secondLabel)).toBeDefined();
    expect(domState.document.activeElement).toBe(trigger);
  });

  it("hides an unselected row without changing the selected chat, its draft, or another journal", async () => {
    const rows = historyRows();
    const env = makeEnvironment({
      conversations: rows,
      turnsHandler: async ({ conversationId }) =>
        turnsPage(
          conversationId,
          conversationId === firstConversationId ? firstLabel : secondLabel,
        ),
      textHandler: async ({ conversationId, ordinal, url }) =>
        textPage(conversationId, ordinal, url.searchParams.get("role")),
    });
    const app = await mount(env);

    await selectConversation(app, firstLabel);
    const currentProps = componentProps(app);
    expect(
      currentProps.onDraftChange,
      "AccountApp should expose the live draft callback",
    ).toBeTypeOf("function");
    currentProps.onDraftChange("borrador de la conversación elegida");
    await render(app);
    writeJournal(env, secondConversationId, { text: "journal del hilo quitado" });
    writeJournal(env, thirdConversationId, { text: "journal de otro hilo" });

    await clickHideFor(app, env, secondLabel);
    await confirmHide(app);

    expect(hideCalls(env)).toHaveLength(1);
    expect(hideCalls(env)[0].conversationId).toBe(secondConversationId);
    expect(hideCalls(env)[0].body).toBeUndefined();
    expect(hideCalls(env)[0].headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(visibleHistoryState(app).selectedConversationId).toBe(firstConversationId);
    expect(visibleHistoryState(app).status).toBe("ready");
    expect(conversationRow(domState.document, firstLabel)).toBeDefined();
    expect(conversationRow(domState.document, secondLabel)).toBeUndefined();
    expect(domState.document.body.textContent).toContain("Usá descuentos.");
    expect(domState.document.querySelector("textarea")?.value).toBe(
      "borrador de la conversación elegida",
    );
    const remainingJournals = readChatJournals(env.config, historyIdentity);
    expect(remainingJournals.has(secondConversationId)).toBe(false);
    expect(remainingJournals.has(thirdConversationId)).toBe(true);
  });

  it("blocks duplicate and same-thread sends while hiding, then retries explicitly after an ambiguous ACK loss", async () => {
    const pending = deferred();
    let attempts = 0;
    const env = makeEnvironment({
      conversations: [summary(firstConversationId, firstLabel)],
      hideHandler: async ({ conversationId }) => {
        attempts += 1;
        if (attempts === 1) return pending.promise;
        return jsonResponse({ version: 1, conversationId, hiddenAt });
      },
      turnsHandler: async () => turnsPage(firstConversationId, firstLabel),
      textHandler: async ({ conversationId, ordinal, url }) =>
        textPage(conversationId, ordinal, url.searchParams.get("role")),
    });
    const app = await mount(env);
    await selectConversation(app, firstLabel);
    componentProps(app).onDraftChange("seguimiento que no debe enviarse");
    await render(app);
    await clickHideFor(app, env, firstLabel);
    await confirmHide(app);

    expect(attempts).toBe(1);
    expect(hideCalls(env)).toHaveLength(1);
    expect(visibleHistoryState(app).removal).toMatchObject({
      conversationId: firstConversationId,
      status: "hiding",
    });
    const pendingConfirm = buttonByText(domState.document, "Quitando…");
    expect(pendingConfirm).toBeDefined();
    expect(pendingConfirm.disabled).toBe(true);
    await clickPhase8(pendingConfirm, app, domState);
    expect(attempts).toBe(1);
    expect(
      componentProps(app).onSubmit("No enviar"),
      "a hidden thread cannot start a new send",
    ).toBe(false);
    expect(env.runtimeRequests).toHaveLength(0);

    pending.reject(new TypeError("connection lost after the server may have committed"));
    await render(app);
    expect(attempts).toBe(1);
    expect(visibleHistoryState(app).removal?.status).toBe("unconfirmed");
    expect(statusText(domState.document, "confirm")).toBeDefined();
    expect(conversationRow(domState.document, firstLabel)).toBeDefined();

    await confirmHide(app);

    expect(attempts).toBe(2);
    expect(hideCalls(env)).toHaveLength(2);
    expect(conversationRow(domState.document, firstLabel)).toBeUndefined();
    expect(visibleHistoryState(app).selectedConversationId).toBeNull();
    expect(env.runtimeRequests).toHaveLength(0);
  });

  it("does not let late opening or list responses resurrect a removed row or replace another selection", async () => {
    const lateTurns = deferred();
    const staleList = deferred();
    const hideRequest = deferred();
    let listNumber = 0;
    const rows = historyRows();
    const env = makeEnvironment({
      conversations: rows,
      listHandler: async () => {
        listNumber += 1;
        return listNumber === 1
          ? jsonResponse({ version: 1, conversations: rows })
          : staleList.promise;
      },
      turnsHandler: async ({ conversationId }) =>
        conversationId === firstConversationId
          ? lateTurns.promise
          : turnsPage(secondConversationId, secondLabel),
      textHandler: async ({ conversationId, ordinal, url }) =>
        textPage(conversationId, ordinal, url.searchParams.get("role")),
      hideHandler: () => hideRequest.promise,
    });
    const app = await mount(env);

    await clickPhase8(selectButton(domState.document, firstLabel), app, domState);
    await clickHideFor(app, env, firstLabel);
    await confirmHide(app);
    expect(visibleHistoryState(app).removal?.status).toBe("hiding");

    await selectConversation(app, secondLabel);
    await clickText(app, "Actualizar");
    expect(listNumber).toBe(2);

    hideRequest.resolve(
      jsonResponse({ version: 1, conversationId: firstConversationId, hiddenAt }),
    );
    await render(app);
    lateTurns.resolve(turnsPage(firstConversationId, firstLabel));
    staleList.resolve(jsonResponse({ version: 1, conversations: rows }));
    await render(app);

    expect(conversationRow(domState.document, firstLabel)).toBeUndefined();
    expect(visibleHistoryState(app).selectedConversationId).toBe(secondConversationId);
    expect(domState.document.querySelector('[aria-current="page"]')?.textContent).toContain(
      secondLabel,
    );
    expect(domState.document.body.textContent).toContain("Definí criterios claros.");
    expect(domState.document.body.textContent).not.toContain("Usá descuentos.");
  });

  it("detaches the selected active consumer and ignores a late Runtime recovery after removal", async () => {
    const lateRecovery = deferred();
    const activeSummary = summary(firstConversationId, firstLabel, {
      activeQueryId: firstQueryId,
    });
    const env = makeEnvironment({
      conversations: [activeSummary],
      turnsHandler: async () =>
        jsonResponse({
          version: 1,
          conversationId: firstConversationId,
          label: firstLabel,
          throughOrdinal: 1,
          closed: false,
          canContinue: false,
          turns: [
            {
              ordinal: 1,
              queryId: firstQueryId,
              status: "in_progress",
              questionManifest: { count: 1, complete: true },
              answerManifest: { count: 1, complete: false },
              cursor: 1,
            },
          ],
        }),
      textHandler: async ({ conversationId, ordinal, url }) =>
        textPage(conversationId, ordinal, url.searchParams.get("role")),
      recoverHandler: () => lateRecovery.promise,
    });
    const app = await mount(env);

    await selectConversation(app, firstLabel);
    expect(env.runtimeRequests).toHaveLength(1);
    const runtimeCall = env.runtimeRequests[0];
    expect(runtimeCall.request.operation).toBe("recover");

    await clickHideFor(app, env, firstLabel);
    await confirmHide(app);

    expect(runtimeCall.signal.aborted).toBe(true);
    expect(env.runtimeRequests).toHaveLength(1);
    expect(conversationRow(domState.document, firstLabel)).toBeUndefined();
    lateRecovery.resolve(
      jsonResponse({
        version: 2,
        conversationId: firstConversationId,
        queryId: firstQueryId,
        ordinal: 1,
        status: "completed",
        question: "Prepará porcentajes.",
        answer: "Respuesta tardía que no debe reaparecer.",
        canContinue: true,
      }),
    );
    await render(app);

    expect(visibleHistoryState(app).selectedConversationId).toBeNull();
    expect(conversationRow(domState.document, firstLabel)).toBeUndefined();
    expect(domState.document.body.textContent).not.toContain(
      "Respuesta tardía que no debe reaparecer.",
    );
    expect(env.runtimeRequests).toHaveLength(1);
  });

  it("ignores SSE text that arrives after hiding an admitted active conversation", async () => {
    let streamController;
    let runtimeCall;
    const encoder = new TextEncoder();
    const env = makeEnvironment({
      conversations: [summary(firstConversationId, firstLabel)],
      turnsHandler: async () => turnsPage(firstConversationId, firstLabel),
      textHandler: async ({ conversationId, ordinal, url }) =>
        textPage(conversationId, ordinal, url.searchParams.get("role")),
      runtimeHandler: async (request, call) => {
        runtimeCall = call;
        const response = new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
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
        return response;
      },
    });
    const app = await mount(env);

    await selectConversation(app, firstLabel);
    expect(componentProps(app).onSubmit("Seguí con porcentajes.")).toBe(true);
    await vi.waitFor(async () => {
      await app.flush();
      expect(visibleHistoryState(app).conversations[0]?.activeQueryId).toBeTruthy();
      expect(componentProps(app).state?.queryStatus).toBe("streaming");
    });
    expect(runtimeCall.request.operation).toBe("message");
    expect(env.runtimeRequests).toHaveLength(1);

    await clickHideFor(app, env, firstLabel);
    await confirmHide(app);

    expect(runtimeCall.signal.aborted).toBe(true);
    expect(env.runtimeRequests).toHaveLength(1);
    expect(conversationRow(domState.document, firstLabel)).toBeUndefined();
    streamController.enqueue(
      encoder.encode(
        `event: text\ndata: ${JSON.stringify({
          type: "text",
          queryId: runtimeCall.request.queryId,
          index: 0,
          text: "Texto SSE tardío que no debe reaparecer.",
        })}\n\n`,
      ),
    );
    await render(app);

    expect(visibleHistoryState(app).selectedConversationId).toBeNull();
    expect(conversationRow(domState.document, firstLabel)).toBeUndefined();
    expect(domState.document.body.textContent).not.toContain(
      "Texto SSE tardío que no debe reaparecer.",
    );
    expect(env.runtimeRequests).toHaveLength(1);
  });

  it("keeps the signed-out view after an old hide response returns", async () => {
    const request = deferred();
    const env = makeEnvironment({
      conversations: [summary(firstConversationId, firstLabel)],
      hideHandler: () => request.promise,
    });
    const app = await mount(env);

    await clickHideFor(app, env, firstLabel);
    await confirmHide(app);
    componentProps(app).onSignOut();
    await render(app);
    request.resolve(jsonResponse({ version: 1, conversationId: firstConversationId, hiddenAt }));
    await render(app);

    expect(app.current()?.props?.state?.view).toBe("login");
    expect(env.session.signOut).toHaveBeenCalledTimes(1);
    expect(domState.document.querySelector(".chat-history")).toBeNull();
  });

  it("does not apply an old hide callback to a different identity", async () => {
    const request = deferred();
    const rows = [summary(firstConversationId, firstLabel)];
    const otherIdentityRow = summary(thirdConversationId, "Conversación de teacher-b");
    let env;
    env = makeEnvironment({
      conversations: rows,
      listHandler: async () =>
        jsonResponse({
          version: 1,
          conversations: env.identity.sub === "teacher-a" ? rows : [otherIdentityRow],
        }),
      hideHandler: () => request.promise,
    });
    const app = await mount(env);

    await clickHideFor(app, env, firstLabel);
    await confirmHide(app);
    env.identity.sub = "teacher-b";
    await app.setRoute("login");
    await render(app);
    await app.setRoute("chat");
    await render(app);

    expect(visibleHistoryState(app).conversations).toEqual([otherIdentityRow]);
    request.resolve(jsonResponse({ version: 1, conversationId: firstConversationId, hiddenAt }));
    await render(app);

    expect(visibleHistoryState(app).conversations).toEqual([otherIdentityRow]);
    expect(env.session.signOut).not.toHaveBeenCalled();
    expect(domState.document.querySelector(".chat-history")).not.toBeNull();
  });

  it("removes a hidden journal reference on metadata 404 without logging out or retaining its row", async () => {
    const rows = historyRows();
    const turnsRead = [];
    const env = makeEnvironment({
      conversations: [rows[1]],
      metaHandler: async ({ conversationId }) =>
        conversationId === firstConversationId
          ? jsonResponse({ code: "CONVERSATION_HIDDEN" }, 404)
          : jsonResponse(visibleMetadata(rows[1])),
      turnsHandler: async ({ conversationId }) => {
        turnsRead.push(conversationId);
        return turnsPage(
          conversationId,
          conversationId === firstConversationId ? firstLabel : secondLabel,
        );
      },
    });
    writeJournal(env, firstConversationId, {
      admitted: true,
      text: "no mostrar después de ocultar",
    });
    writeChatSelection(env.config, historyIdentity, firstConversationId);
    const app = await mount(env);

    expect(
      env.apiRequests.some(
        ({ method, conversationId }) => method === "GET" && conversationId === firstConversationId,
      ),
    ).toBe(true);
    expect(env.session.signOut).not.toHaveBeenCalled();
    expect(env.session.accessToken()).toBe(accessToken);
    expect(app.current()?.type?.name).toBe("ChatScreen");
    expect(domState.document.querySelector(".chat-history")).not.toBeNull();
    expect(visibleHistoryState(app).status).not.toBe("empty");
    expect(conversationRow(domState.document, firstLabel)).toBeUndefined();
    expect(conversationRow(domState.document, secondLabel)).toBeDefined();
    expect(readChatJournals(env.config, historyIdentity).has(firstConversationId)).toBe(false);
    expect(readChatSelection(env.config, historyIdentity)).toBeNull();
    expect(turnsRead).not.toContain(firstConversationId);
    expect(listCalls(env)).toHaveLength(1);
  });

  it("checks recovered journal references before showing their text and tolerates storage removal failure", async () => {
    const hiddenMeta = deferred();
    const env = makeEnvironment({
      conversations: [],
      metaHandler: () => hiddenMeta.promise,
    });
    writeJournal(env, firstConversationId, { admitted: true, text: "respuesta privada guardada" });
    writeChatSelection(env.config, historyIdentity, firstConversationId);
    const originalRemove = env.storage.removeItem.bind(env.storage);
    env.storage.removeItem = () => {
      throw new DOMException("Storage is unavailable", "QuotaExceededError");
    };
    const app = await mount(env);

    expect(
      env.apiRequests.some(
        ({ method, conversationId }) => method === "GET" && conversationId === firstConversationId,
      ),
    ).toBe(true);
    expect(domState.document.body.textContent).not.toContain("respuesta privada guardada");
    expect(domState.document.body.textContent).not.toContain("Usá descuentos.");
    expect(env.runtimeRequests).toHaveLength(0);

    hiddenMeta.resolve(jsonResponse({ code: "CONVERSATION_HIDDEN" }, 404));
    await render(app);

    expect(domState.document.body.textContent).not.toContain("respuesta privada guardada");
    expect(domState.document.body.textContent).not.toContain("Usá descuentos.");
    expect(visibleHistoryState(app).conversations).toEqual([]);
    expect(env.runtimeRequests).toHaveLength(0);
    expect(readChatJournals(env.config, historyIdentity).has(firstConversationId)).toBe(true);

    env.storage.removeItem = originalRemove;
    app.dispose();
    apps.splice(apps.indexOf(app), 1);
    const reentered = await mount(env);
    expect(domState.document.body.textContent).not.toContain("respuesta privada guardada");
    expect(visibleHistoryState(reentered).conversations).toEqual([]);
    expect(env.runtimeRequests).toHaveLength(0);
  });

  it("preserves an unadmitted start when brief verification finds no META, but does not restore an admitted journal with missing META", async () => {
    const pendingMeta = deferred();
    const env = makeEnvironment({
      conversations: [],
      metaHandler: () => pendingMeta.promise,
    });
    writeJournal(env, firstConversationId, { text: "consulta aún no admitida" });
    const app = await mount(env);

    expect(
      env.apiRequests.some(
        ({ method, conversationId }) => method === "GET" && conversationId === firstConversationId,
      ),
    ).toBe(true);
    expect(domState.document.body.textContent).not.toContain("consulta aún no admitida");
    pendingMeta.resolve(jsonResponse({ code: "CONVERSATION_NOT_FOUND" }, 404));
    await render(app);

    expect(readChatJournals(env.config, historyIdentity).has(firstConversationId)).toBe(true);
    expect(visibleHistoryState(app).selectedConversationId).toBe(firstConversationId);
    expect(visibleHistoryState(app).queryStatus).toBe("unconfirmed");
    expect(env.runtimeRequests.length).toBeLessThanOrEqual(1);

    app.dispose();
    apps.splice(apps.indexOf(app), 1);
    await clearPhase8Root(domState);
    const admittedMeta = deferred();
    const admittedEnv = makeEnvironment({
      conversations: [],
      metaHandler: () => admittedMeta.promise,
    });
    writeJournal(admittedEnv, firstConversationId, {
      admitted: true,
      text: "texto no restaurable",
    });
    writeChatSelection(admittedEnv.config, historyIdentity, firstConversationId);
    const admittedApp = await mount(admittedEnv);

    expect(domState.document.body.textContent).not.toContain("texto no restaurable");
    admittedMeta.resolve(jsonResponse({ code: "CONVERSATION_NOT_FOUND" }, 404));
    await render(admittedApp);

    expect(domState.document.body.textContent).not.toContain("texto no restaurable");
    expect(domState.document.body.textContent).not.toContain("Usá descuentos.");
    expect(visibleHistoryState(admittedApp).turns).toEqual([]);
    expect(visibleHistoryState(admittedApp).turnsStatus).not.toBe("ready");
  });

  it("uses real keyboard-capable controls and keeps the history pane open in the mobile view", async () => {
    const rows = historyRows();
    const env = makeEnvironment({
      conversations: rows,
      turnsHandler: async ({ conversationId }) =>
        turnsPage(
          conversationId,
          conversationId === firstConversationId ? firstLabel : secondLabel,
        ),
      textHandler: async ({ conversationId, ordinal, url }) =>
        textPage(conversationId, ordinal, url.searchParams.get("role")),
    });
    const app = await mount(env);
    await selectConversation(app, firstLabel);
    await clickText(app, "Volver al historial");
    const trigger = actionButton(domState.document, firstLabel);
    expect(trigger.type).toBe("button");
    trigger.focus();
    expect(domState.document.activeElement).toBe(trigger);
    await clickHideFor(app, env, firstLabel);
    expect(domState.document.activeElement).toBe(buttonByText(domState.document, "Cancelar"));
    await confirmHide(app);

    expect(domState.document.querySelector(".chat-history--mobile-visible")).not.toBeNull();
    expect(domState.document.querySelector(".chat-main__content--mobile-hidden")).not.toBeNull();
    expect(domState.document.activeElement?.closest("li")?.textContent).toContain(secondLabel);
    expect(allButtons(domState.document).length).toBeGreaterThan(0);
    expect(env.apiRequests.some(({ path }) => path === "/chat/conversations")).toBe(true);
    expect(
      env.apiRequests.filter(({ method, path }) => method === "POST" && path.endsWith("/hide")),
    ).toHaveLength(1);
  });
});
