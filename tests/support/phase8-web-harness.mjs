import React, { act } from "react";
import { JSDOM } from "jsdom";
import { vi } from "vitest";
import { mountHistoryAccountApp } from "./history-web-harness.mjs";

export async function createPhase8Dom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const document = dom.window.document;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("navigator", dom.window.navigator);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));

  return {
    dom,
    document,
    root,
    async dispose() {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

export function installPhase8Routes(environment, { hideHandler, metaHandler }) {
  const defaultFetch = environment.fetch.getMockImplementation();
  environment.fetch.mockImplementation(async (input, init = {}) => {
    const url = String(input);
    const parsed = new URL(url, "https://app.invalid");
    const path = parsed.pathname.slice("/api".length);
    const method = init.method || "GET";
    const call = {
      path,
      url: parsed,
      method,
      headers: new Headers(init.headers),
      init,
      body: init.body,
    };
    const hideMatch = path.match(/^\/chat\/conversations\/([^/]+)\/hide$/);
    if (hideMatch && method === "POST") {
      call.conversationId = decodeURIComponent(hideMatch[1]);
      environment.apiRequests.push(call);
      return hideHandler(call);
    }
    const metaMatch = path.match(/^\/chat\/conversations\/([^/]+)$/);
    if (metaMatch && method === "GET") {
      call.conversationId = decodeURIComponent(metaMatch[1]);
      environment.apiRequests.push(call);
      return metaHandler(call);
    }
    return defaultFetch(input, init);
  });
}

export async function mountPhase8AccountApp(environment, AccountApp, domState) {
  const app = mountHistoryAccountApp(environment, AccountApp);
  await renderPhase8AccountApp(app, domState);
  return app;
}

export async function renderPhase8AccountApp(app, { root }) {
  await act(async () => {
    await app.flush();
    root.render(app.current());
    await Promise.resolve();
  });
}

export async function clickPhase8(element, app, domState) {
  if (!element) throw new Error("Expected a real DOM control to click");
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await renderPhase8AccountApp(app, domState);
}

export async function clearPhase8Root(domState) {
  await act(async () => domState.root.render(null));
}

export function allButtons(document) {
  return [...document.querySelectorAll("button")];
}

export function buttonByText(document, text, { exact = true } = {}) {
  const matches = allButtons(document).filter((button) => {
    const accessibleText = button.getAttribute("aria-label") || button.textContent || "";
    const normalized = accessibleText.trim().replace(/\s+/g, " ");
    return exact ? normalized === text : normalized.includes(text);
  });
  return matches.at(-1);
}

export function conversationRow(document, label) {
  return [...document.querySelectorAll(".chat-history__list > li")].find((row) =>
    row.textContent?.includes(label),
  );
}

export function hideButtonFor(document, label) {
  return [...(conversationRow(document, label)?.querySelectorAll("button") ?? [])].find(
    (button) => {
      const accessibleText = button.getAttribute("aria-label") || button.textContent || "";
      return accessibleText.toLowerCase().includes("quitar");
    },
  );
}

export function waitForText(document, text) {
  const body = document.body.textContent || "";
  if (!body.includes(text)) {
    throw new Error(`Expected visible UI text: ${text}`);
  }
}

export function statusText(document, text) {
  return [...document.querySelectorAll('[role="status"], [role="alert"]')].find((node) =>
    node.textContent?.includes(text),
  );
}

export function componentProps(app) {
  return app.current()?.props ?? {};
}

export function visibleHistoryState(app) {
  const history = componentProps(app).state?.history;
  if (!history) throw new Error("Expected AccountApp to render the authorized history state");
  return history;
}

export function trackedConversationIds(environment, method) {
  return environment.apiRequests
    .filter(
      ({ method: requestMethod, path }) =>
        requestMethod === method && path.includes("/chat/conversations/"),
    )
    .map(({ conversationId }) => conversationId)
    .filter(Boolean);
}

export { React, act };
