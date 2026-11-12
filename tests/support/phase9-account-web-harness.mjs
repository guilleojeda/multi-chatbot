import React, { act } from "react";
import { JSDOM } from "jsdom";
import { vi } from "vitest";
import { createSession } from "../../web/session.ts";

export const accountWebConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_example",
  clientId: "teacher-web-client",
  apiBaseUrl: "/api",
  botId: "docentes",
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/docentes",
  runtimeQualifier: "DEFAULT",
};

export const teacherIdentity = { sub: "teacher-a", botId: "docentes" };
export const teacherAccessToken = "controlled-teacher-access-token";
export const accountConversationId = "550e8400-e29b-41d4-a716-446655440000";
export const accountQueryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";

export class AccountWebStorage {
  values = new Map();

  constructor(entries = [["auth-refresh", "controlled-refresh-token"]]) {
    this.values = new Map(entries);
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

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

export function accountJson(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function accountRuntimeUrl(config = accountWebConfig) {
  return (
    `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/` +
    `${encodeURIComponent(config.runtimeArn)}/invocations?qualifier=${encodeURIComponent(config.runtimeQualifier)}`
  );
}

function responseFrom(handler, call, fallback) {
  return typeof handler === "function" ? handler(call) : (handler ?? fallback);
}

export async function createPhase9AccountWebHarness(
  AccountApp,
  {
    config = accountWebConfig,
    identity = teacherIdentity,
    storage = new AccountWebStorage(),
    accountHandler,
    profileHandler = async () =>
      accountJson({ sub: identity.sub, botId: identity.botId, profile: null }),
    listHandler = async () => accountJson({ version: 1, conversations: [] }),
    metaHandler,
    turnsHandler,
    textHandler,
    hideHandler,
    runtimeHandler,
    recoverHandler,
  } = {},
) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/#/chat",
    pretendToBeVisual: true,
  });
  const { document } = dom.window;
  const apiRequests = [];
  const accountRequests = [];
  const runtimeRequests = [];
  const cognitoRequests = [];
  let nextUuid = 0;

  Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(dom.window.crypto, "randomUUID", {
    configurable: true,
    value: () => `c1111111-1111-4111-8111-${String(++nextUuid).padStart(12, "0")}`,
  });
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });

  const fetch = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input), dom.window.location.href);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (url.pathname === "/public-config.json" && method === "GET") {
      return accountJson(config);
    }

    if (url.hostname === `cognito-idp.${config.region}.amazonaws.com`) {
      const target = headers.get("x-amz-target") ?? "";
      const call = {
        operation: target.split(".").at(-1) ?? "",
        target,
        headers,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      cognitoRequests.push(call);
      if (call.operation === "InitiateAuth") {
        return accountJson({
          AuthenticationResult: {
            AccessToken: teacherAccessToken,
            IdToken: "controlled-teacher-id-token",
          },
        });
      }
      return accountJson({});
    }

    if (url.pathname === new URL(accountRuntimeUrl(config)).pathname) {
      const request = JSON.parse(String(init.body));
      const call = { request, url, method, headers, init, body: String(init.body) };
      runtimeRequests.push(call);
      const handler =
        headers.get("accept") === "application/json" ? recoverHandler : runtimeHandler;
      return responseFrom(handler, call, accountJson({ code: "UNEXPECTED_RUNTIME_REQUEST" }, 500));
    }

    if (url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice("/api".length);
      const call = { path, url, method, headers, init, body: init.body };
      apiRequests.push(call);

      if (path === "/account/me" && method === "GET") {
        accountRequests.push(call);
        return responseFrom(
          accountHandler,
          call,
          accountJson({
            ...identity,
            access: { state: "active", revision: 1 },
          }),
        );
      }
      if (path === "/profile")
        return responseFrom(profileHandler, call, accountJson({ profile: null }));
      if (path === "/chat/conversations" && method === "GET") {
        return responseFrom(listHandler, call, accountJson({ version: 1, conversations: [] }));
      }
      const hideMatch = path.match(/^\/chat\/conversations\/([^/]+)\/hide$/);
      if (hideMatch && method === "POST") {
        return responseFrom(
          hideHandler,
          { ...call, conversationId: decodeURIComponent(hideMatch[1]) },
          accountJson({ code: "NOT_FOUND" }, 404),
        );
      }
      const textMatch = path.match(/^\/chat\/conversations\/([^/]+)\/turns\/(\d+)\/text$/);
      if (textMatch) {
        return responseFrom(
          textHandler,
          {
            ...call,
            conversationId: decodeURIComponent(textMatch[1]),
            ordinal: Number(textMatch[2]),
          },
          accountJson({ code: "NOT_FOUND" }, 404),
        );
      }
      const turnsMatch = path.match(/^\/chat\/conversations\/([^/]+)\/turns$/);
      if (turnsMatch) {
        return responseFrom(
          turnsHandler,
          { ...call, conversationId: decodeURIComponent(turnsMatch[1]) },
          accountJson({ code: "NOT_FOUND" }, 404),
        );
      }
      const metaMatch = path.match(/^\/chat\/conversations\/([^/]+)$/);
      if (metaMatch && method === "GET") {
        return responseFrom(
          metaHandler,
          { ...call, conversationId: decodeURIComponent(metaMatch[1]) },
          accountJson({ code: "NOT_FOUND" }, 404),
        );
      }
      return accountJson({ code: "UNEXPECTED_REQUEST" }, 500);
    }

    throw new Error(`Unexpected account web request: ${url}`);
  });

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("FormData", dom.window.FormData);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("fetch", fetch);

  const { createRoot } = await import("react-dom/client");

  function createTeacherSession() {
    return createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch,
    });
  }

  let session = createTeacherSession();
  let root = null;
  let route = { kind: "chat" };
  const rootElement = document.getElementById("root");

  async function settle() {
    await act(async () => {
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
  }

  async function mount(nextRoute = { kind: "chat" }) {
    route = nextRoute;
    dom.window.location.hash = `#/${route.kind}`;
    root = createRoot(rootElement);
    await act(async () => {
      root.render(
        React.createElement(AccountApp, {
          route,
          projectName: "Asistente para docentes",
          getSession: () => session,
        }),
      );
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
  }

  async function setRoute(nextRoute) {
    route = nextRoute;
    dom.window.location.hash = `#/${route.kind}`;
    await act(async () => {
      root.render(
        React.createElement(AccountApp, {
          route,
          projectName: "Asistente para docentes",
          getSession: () => session,
        }),
      );
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
  }

  async function reload(nextRoute = route) {
    await act(async () => root.unmount());
    session = createTeacherSession();
    await mount(nextRoute);
  }

  async function click(element) {
    if (!element) throw new Error("Expected a visible UI control");
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
  }

  async function setValue(element, value) {
    if (!element) throw new Error("Expected a visible form control");
    const prototype =
      element instanceof dom.window.HTMLTextAreaElement
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    await act(async () => {
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    });
  }

  async function submit(form) {
    if (!form) throw new Error("Expected a visible form");
    await act(async () => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
  }

  async function dispose() {
    if (root) await act(async () => root.unmount());
    dom.window.close();
  }

  return {
    dom,
    document,
    storage,
    config,
    fetch,
    session: () => session,
    apiRequests,
    accountRequests,
    runtimeRequests,
    cognitoRequests,
    mount,
    setRoute,
    reload,
    settle,
    click,
    setValue,
    submit,
    dispose,
  };
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

export function accountButton(document, name) {
  return [...document.querySelectorAll("button")].find(
    (candidate) => accessibleName(candidate) === name,
  );
}

export function accountControl(document, name, selector = "input, textarea") {
  return [...document.querySelectorAll(selector)].find(
    (candidate) => accessibleName(candidate) === name,
  );
}

export function accountText(document) {
  return normalize(document.body.textContent);
}
