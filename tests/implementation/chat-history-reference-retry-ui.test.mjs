import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountApp } from "../../web/AccountApp.tsx";
import {
  createHistoryEnvironment,
  jsonResponse,
  firstConversationId as A,
  secondConversationId as B,
  firstQueryId as QA,
  secondQueryId as QB,
} from "../support/history-web-harness.mjs";

const summary = (conversationId, label) => ({
  conversationId,
  label,
  createdAt: "2026-10-27T10:00:00.000Z",
  updatedAt: "2026-10-27T10:00:00.000Z",
  lastOrdinal: 1,
  closed: false,
});

const rowA = summary(A, "Hilo A");
const rowB = summary(B, "Hilo B");
const rows = [rowA, rowB];

function turns(conversationId) {
  return jsonResponse({
    version: 1,
    ...rows.find((row) => row.conversationId === conversationId),
    throughOrdinal: 1,
    canContinue: true,
    turns: [
      {
        ordinal: 1,
        queryId: conversationId === A ? QA : QB,
        status: "completed",
        questionManifest: { count: 1, complete: true },
        answerManifest: { count: 1, complete: true },
        cursor: 1,
      },
    ],
  });
}

function text({ conversationId, url }) {
  const role = url.searchParams.get("role");
  return jsonResponse({
    version: 1,
    conversationId,
    queryId: conversationId === A ? QA : QB,
    ordinal: 1,
    role,
    chunks: [{ index: 0, text: `${conversationId === A ? "A" : "B"} ${role}` }],
    complete: true,
  });
}

async function mount({ listHandler, metaHandler, session, identityHandler, profileHandler }) {
  const environment = createHistoryEnvironment({
    listHandler,
    metaHandler,
    ...(session ? { session } : {}),
    turnsHandler: ({ conversationId }) => turns(conversationId),
    textHandler: text,
  });
  if (identityHandler || profileHandler) {
    const fetchDefault = environment.fetch.getMockImplementation();
    environment.fetch.mockImplementation(async (input, init = {}) => {
      const url = String(input);
      if (url === "/api/account/me" && identityHandler) return identityHandler();
      if (url === "/api/profile" && profileHandler) return profileHandler();
      return fetchDefault(input, init);
    });
  }
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://localhost/#/chat",
    pretendToBeVisual: true,
  });
  const document = dom.window.document;
  Object.defineProperty(dom.window, "sessionStorage", { value: environment.storage });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("FormData", dom.window.FormData);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const root = createRoot(document.getElementById("root"));
  const settle = async () => {
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
  };
  const render = () =>
    act(async () => {
      root.render(
        React.createElement(AccountApp, {
          route: { kind: "chat" },
          projectName: "Prueba",
          getSession: () => environment.session,
        }),
      );
      await settle();
    });
  const click = (selector) =>
    act(async () => {
      const element = typeof selector === "string" ? document.querySelector(selector) : selector;
      expect(element, `expected a real DOM control for ${selector}`).toBeTruthy();
      element.click();
      await settle();
    });

  await render();
  return {
    environment,
    document,
    async refresh() {
      await click('[aria-label="Actualizar historial"]');
    },
    async select(conversationId) {
      const element = [...document.querySelectorAll(".chat-history__item")].find((button) =>
        button.textContent.includes(conversationId === A ? "Hilo A" : "Hilo B"),
      );
      await click(element);
    },
    async signOut() {
      await click(document.querySelector(".chat-account-actions button"));
    },
    async signIn(email, password) {
      const form = document.querySelector(".account-form");
      form.querySelector('[name="email"]').value = email;
      form.querySelector('[name="password"]').value = password;
      await act(async () => {
        form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        await settle();
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      dom.window.close();
      vi.unstubAllGlobals();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reference verification retry in the real AccountApp DOM", () => {
  it("rechecks a failed unselected reference and restores it only after visible META", async () => {
    let lists = 0;
    let metas = 0;
    const app = await mount({
      listHandler: () => jsonResponse({ version: 1, conversations: ++lists === 1 ? [rowA] : [] }),
      metaHandler: () =>
        ++metas === 1
          ? jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503)
          : jsonResponse({ version: 1, ...rowA }),
    });
    const { document } = app;

    try {
      expect(document.body.textContent).toContain("Hilo A");
      await app.refresh();
      expect(metas).toBe(1);
      expect(document.body.textContent).toContain("No pudimos verificar una referencia");
      expect(document.body.textContent).not.toContain("Todavía no hay conversaciones guardadas");
      expect(document.querySelectorAll(".chat-history__item")).toHaveLength(0);

      await app.refresh();

      expect(metas).toBe(2);
      expect(document.querySelectorAll(".chat-history__item")).toHaveLength(1);
      expect(document.body.textContent).toContain("Hilo A");
      expect(document.body.textContent).not.toContain("Todavía no hay conversaciones guardadas");
      expect(app.environment.runtimeRequests).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  it("rechecks a failed reference and retires it after hidden META", async () => {
    let lists = 0;
    let metas = 0;
    const app = await mount({
      listHandler: () => jsonResponse({ version: 1, conversations: ++lists === 1 ? [rowA] : [] }),
      metaHandler: () =>
        ++metas === 1
          ? jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503)
          : jsonResponse({ code: "CONVERSATION_HIDDEN" }, 404),
    });
    const { document } = app;

    try {
      await app.refresh();
      expect(metas).toBe(1);
      expect(document.body.textContent).toContain("No pudimos verificar una referencia");

      await app.refresh();

      expect(metas).toBe(2);
      expect(document.querySelectorAll(".chat-history__item")).toHaveLength(0);
      expect(document.body.textContent).toContain("Todavía no hay conversaciones guardadas");
      expect(document.body.textContent).not.toContain("No pudimos verificar una referencia");
      expect(app.environment.runtimeRequests).toHaveLength(0);

      await app.refresh();
      expect(metas).toBe(2);
      expect(document.querySelectorAll(".chat-history__item")).toHaveLength(0);
      expect(document.body.textContent).toContain("Todavía no hay conversaciones guardadas");
    } finally {
      await app.dispose();
    }
  });

  it("keeps the selected conversation usable when another reference check fails", async () => {
    let lists = 0;
    const app = await mount({
      listHandler: () =>
        jsonResponse({
          version: 1,
          conversations: ++lists === 1 ? rows : [rowB],
        }),
      metaHandler: () => jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503),
    });
    const { document } = app;

    try {
      await app.select(B);
      expect(document.body.textContent).toContain("B assistant");
      await app.refresh();

      expect(document.querySelector('[aria-current="page"]')?.textContent).toContain("Hilo B");
      expect(document.body.textContent).toContain("B assistant");
      expect(document.body.textContent).toContain("No pudimos verificar una referencia");
      expect(document.body.textContent).not.toContain("Todavía no hay conversaciones guardadas");
      expect(document.querySelectorAll(".chat-history__item")).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  });

  it("keeps the error visible instead of claiming empty when the retry also fails", async () => {
    let lists = 0;
    let metas = 0;
    const app = await mount({
      listHandler: () => jsonResponse({ version: 1, conversations: ++lists === 1 ? [rowA] : [] }),
      metaHandler: () => {
        metas += 1;
        return jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503);
      },
    });
    const { document } = app;

    try {
      await app.refresh();
      expect(metas).toBe(1);
      await app.refresh();

      expect(metas).toBe(2);
      expect(document.body.textContent).toContain("No pudimos verificar una referencia");
      expect(document.body.textContent).not.toContain("Todavía no hay conversaciones guardadas");
      expect(document.querySelectorAll(".chat-history__item")).toHaveLength(0);
      expect(app.environment.runtimeRequests).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  it("does not carry a failed reference across sign-out and a different identity", async () => {
    let token = "owner-a-token";
    let ownerSub = "teacher-a";
    const session = {
      accessToken: () => token,
      idToken: () => (token ? `${token}-id` : null),
      restore: async () => (token ? { accessToken: token, idToken: `${token}-id` } : null),
      signOut: async () => {
        token = null;
      },
      signIn: async () => {
        token = "owner-b-token";
        ownerSub = "teacher-b";
        return { accessToken: token, idToken: `${token}-id` };
      },
      requestPasswordReset: async () => undefined,
      confirmPasswordReset: async () => undefined,
    };
    let lists = 0;
    const metaOwners = [];
    const app = await mount({
      session,
      identityHandler: () => jsonResponse({ sub: ownerSub, botId: "docentes" }),
      profileHandler: () =>
        jsonResponse({
          sub: ownerSub,
          botId: "docentes",
          profile: {
            sub: ownerSub,
            botId: "docentes",
            updatedAt: "2026-10-27T10:00:00.000Z",
            fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
            responsePreferenceIds: [],
          },
        }),
      listHandler: () => jsonResponse({ version: 1, conversations: ++lists === 1 ? [rowA] : [] }),
      metaHandler: ({ conversationId }) => {
        metaOwners.push({ conversationId, ownerSub });
        return ownerSub === "teacher-a"
          ? jsonResponse({ code: "HISTORY_UNAVAILABLE" }, 503)
          : jsonResponse({ code: "CONVERSATION_UNAVAILABLE" }, 404);
      },
    });
    const { document } = app;

    try {
      await app.refresh();
      expect(metaOwners).toEqual([{ conversationId: A, ownerSub: "teacher-a" }]);
      expect(document.body.textContent).toContain("No pudimos verificar una referencia");

      await app.signOut();
      expect(document.querySelector(".account-form")).toBeTruthy();
      await app.signIn("teacher-b@example.test", "Example-password-1!");

      expect(metaOwners).toEqual([{ conversationId: A, ownerSub: "teacher-a" }]);
      expect(document.body.textContent).not.toContain("Hilo A");
      expect(document.body.textContent).toContain("Todavía no hay conversaciones guardadas");
    } finally {
      await app.dispose();
    }
  });
});
