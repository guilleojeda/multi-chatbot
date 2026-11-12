import React, { act } from "react";
import { JSDOM } from "jsdom";
import { vi } from "vitest";

const publicConfig = {
  environment: "dev",
  region: "us-east-1",
  userPoolId: "us-east-1_testPool",
  clientId: "admin-client",
  apiBaseUrl: "/api",
};

export class AdminMemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }

  clear() {
    this.values.clear();
  }
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function makeSession({
  restoreResults = [null],
  signInResult = { accessToken: "admin-access", idToken: "admin-id" },
  storage,
} = {}) {
  let tokens = null;
  const nextRestoreResult = () => {
    const next = restoreResults.length ? restoreResults.shift() : null;
    tokens = next;
    return next;
  };

  const session = {
    signIn: vi.fn(async () => {
      tokens = signInResult;
      return signInResult;
    }),
    requestPasswordReset: vi.fn(async () => undefined),
    confirmPasswordReset: vi.fn(async () => undefined),
    restore: vi.fn(async () => nextRestoreResult()),
    accessToken: vi.fn(() => tokens?.accessToken ?? null),
    idToken: vi.fn(() => tokens?.idToken ?? null),
    signOut: vi.fn(async () => {
      tokens = null;
      storage.removeItem("auth-refresh");
    }),
  };
  return session;
}

export async function createAdminWebHarness(AdminApp, { restoreResults, signInResult } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const document = dom.window.document;
  const adminStorage = new AdminMemoryStorage();
  adminStorage.setItem("auth-refresh", "admin-refresh-token");
  Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: adminStorage });
  const session = makeSession({ restoreResults, signInResult, storage: adminStorage });
  const getSession = vi.fn(() => session);
  const apiRequests = [];
  const routes = [];

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("sessionStorage", adminStorage);

  const fetch = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input), dom.window.location.href);
    if (url.pathname === "/public-config.json" && (init.method ?? "GET") === "GET") {
      return jsonResponse(publicConfig);
    }

    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const request = {
      method,
      path: url.pathname,
      url,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    apiRequests.push(request);
    const route = routes.find(
      (candidate) =>
        candidate.method === method &&
        (typeof candidate.path === "string"
          ? candidate.path === request.path
          : candidate.path.test(request.path)),
    );
    if (!route) return jsonResponse({ code: "UNEXPECTED_REQUEST" }, 500);
    return route.handler(request);
  });
  vi.stubGlobal("fetch", fetch);

  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));

  const harness = {
    dom,
    document,
    root,
    session,
    getSession,
    fetch,
    apiRequests,
    adminStorage,
    route(method, path, handler) {
      routes.push({ method: method.toUpperCase(), path, handler });
    },
    async settle() {
      await act(async () => {
        for (let step = 0; step < 10; step += 1) await Promise.resolve();
      });
    },
    async mount() {
      await act(async () => {
        root.render(React.createElement(AdminApp, { getSession }));
        for (let step = 0; step < 10; step += 1) await Promise.resolve();
      });
    },
    async click(element) {
      if (!element) throw new Error("Expected a visible, accessible control");
      await act(async () => {
        element.click();
        for (let step = 0; step < 10; step += 1) await Promise.resolve();
      });
    },
    async setValue(element, value) {
      if (!element) throw new Error("Expected a visible, accessible input");
      const prototype =
        element instanceof dom.window.HTMLSelectElement
          ? dom.window.HTMLSelectElement.prototype
          : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
      await act(async () => {
        element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        for (let step = 0; step < 2; step += 1) await Promise.resolve();
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };

  return harness;
}

function normalize(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function accessibleName(element) {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return normalize(ariaLabel);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return normalize(
      labelledBy
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
  }
  const label = [...element.ownerDocument.querySelectorAll("label")].find(
    (candidate) => candidate.control === element || candidate.htmlFor === element.id,
  );
  return normalize(label?.textContent ?? element.textContent);
}

export function button(document, name) {
  return [...document.querySelectorAll("button")].find(
    (candidate) => accessibleName(candidate) === name,
  );
}

export function input(document, name, tagName = "input") {
  return [...document.querySelectorAll(tagName)].find(
    (candidate) => accessibleName(candidate) === name,
  );
}

export function bodyText(document) {
  return normalize(document.body.textContent);
}

export function status(document) {
  return [...document.querySelectorAll('[role="status"], [role="alert"]')].map((node) =>
    normalize(node.textContent),
  );
}
