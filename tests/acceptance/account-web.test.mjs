import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const accountScreenPath = path.join(projectRoot, "web/AccountScreen.tsx");
const sessionPath = path.join(projectRoot, "web/session.ts");

async function renderAccountScreen(state) {
  const screenExists = existsSync(accountScreenPath);
  expect(screenExists, "Expected the account UI at web/AccountScreen.tsx").toBe(true);
  if (!screenExists) return null;

  const [{ AccountScreen }, ReactModule, server] = await Promise.all([
    import(pathToFileURL(accountScreenPath).href),
    import("react"),
    import("react-dom/server"),
  ]);
  expect(typeof AccountScreen, "Expected AccountScreen to be a named component export").toBe(
    "function",
  );
  if (typeof AccountScreen !== "function") return null;

  const React = ReactModule.default || ReactModule;
  const renderToStaticMarkup = server.renderToStaticMarkup || server.default?.renderToStaticMarkup;
  return renderToStaticMarkup(
    React.createElement(AccountScreen, {
      state,
      onSubmit: () => undefined,
      onSignOut: () => undefined,
    }),
  );
}

function assertAccountShell(html) {
  expect(html).not.toBeNull();
  if (html === null) return false;

  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  expect(main, "Expected account content inside a main landmark").not.toBeNull();
  if (!main) return false;

  const heading = main[1].match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  expect(heading, "Expected each account screen to have a main heading").not.toBeNull();
  expect(heading?.[1].replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
  return true;
}

function attribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function plainText(markup) {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inputsIn(html) {
  return [...html.matchAll(/<input\b[^>]*>/gi)].map(([tag]) => ({
    tag,
    type: (attribute(tag, "type") || "text").toLowerCase(),
    id: attribute(tag, "id"),
  }));
}

function labelsForInput(html, input) {
  if (!input.id) return [];
  return [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)]
    .filter(([, attributes, contents]) => {
      const labelFor = attribute(attributes, "for");
      const containsInput = [...contents.matchAll(/<input\b[^>]*>/gi)].some(
        ([tag]) => attribute(tag, "id") === input.id,
      );
      return labelFor === input.id || containsInput;
    })
    .map(([, , contents]) => plainText(contents));
}

function expectLabeledInput(html, { type, label }) {
  const input = inputsIn(html).find((entry) => entry.type === type);
  expect(input, `Expected an input with type=${type}`).toBeDefined();
  if (!input) return null;

  const accessibleLabel = attribute(input.tag, "aria-label") || "";
  const associatedLabels = labelsForInput(html, input);
  expect(
    [...associatedLabels, accessibleLabel].some((text) => label.test(text)),
    `Expected the ${type} input to have a matching accessible label`,
  ).toBe(true);
  return input;
}

function interactiveControls(html) {
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map(
    ([, attributes, contents]) => ({
      kind: "button",
      attributes,
      name: attribute(attributes, "aria-label") || plainText(contents),
      href: null,
    }),
  );
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(
    ([, attributes, contents]) => ({
      kind: "link",
      attributes,
      name: attribute(attributes, "aria-label") || plainText(contents),
      href: attribute(attributes, "href"),
    }),
  );
  return [...buttons, ...links];
}

function expectCognitoOperation(call, name) {
  const headers = new Headers(call.init?.headers);
  expect(headers.get("x-amz-target") || "").toContain(name);
}

function requestBody(call) {
  expect(typeof call.init?.body).toBe("string");
  return JSON.parse(call.init.body);
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function cognitoTokens({ accessToken, idToken, refreshToken }) {
  return jsonResponse({
    AuthenticationResult: {
      AccessToken: accessToken,
      ...(idToken ? { IdToken: idToken } : {}),
      ...(refreshToken ? { RefreshToken: refreshToken } : {}),
    },
  });
}

class MemorySessionStorage {
  constructor(entries = []) {
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

async function loadSessionFactory() {
  const moduleExists = existsSync(sessionPath);
  expect(moduleExists, "Expected the account session module at web/session.ts").toBe(true);
  if (!moduleExists) return null;

  const { createSession } = await import(pathToFileURL(sessionPath).href);
  expect(typeof createSession, "Expected createSession to be a named export").toBe("function");
  return typeof createSession === "function" ? createSession : null;
}

describe("the account screens", () => {
  it("renders login with labelled email and password controls", async () => {
    const html = await renderAccountScreen({ view: "login", email: "teacher@example.edu" });
    if (!assertAccountShell(html)) return;

    expectLabeledInput(html, { type: "email", label: /email|correo/i });
    expectLabeledInput(html, { type: "password", label: /password|contraseñ/i });
  });

  it("lets a newly invited person choose and confirm a password", async () => {
    const html = await renderAccountScreen({
      view: "invite-new",
      email: "teacher@example.edu",
    });
    if (!assertAccountShell(html)) return;

    expectLabeledInput(html, { type: "email", label: /email|correo/i });
    const passwordInputs = inputsIn(html).filter((input) => input.type === "password");
    expect(passwordInputs.length).toBeGreaterThanOrEqual(2);
    expect(
      passwordInputs.some((input) =>
        labelsForInput(html, input).some((text) => /confirm|repeat|repet|confirmá/i.test(text)),
      ),
      "Expected a labelled password confirmation control",
    ).toBe(true);
  });

  it("offers an existing account a sign-in action while accepting an invitation", async () => {
    const email = "teacher@example.edu";
    const html = await renderAccountScreen({
      view: "invite-existing",
      email,
    });
    if (!assertAccountShell(html)) return;

    expect(plainText(html)).toContain(email);
    expect(
      interactiveControls(html).some(({ name }) =>
        /sign\s*in|log\s*in|login|iniciar sesión|ingresar/i.test(name),
      ),
      "Expected a sign-in action for an existing account",
    ).toBe(true);
  });

  it("shows the authorized account and sign-out without offering chat or profile actions", async () => {
    const email = "teacher@example.edu";
    const html = await renderAccountScreen({ view: "ready", email });
    if (!assertAccountShell(html)) return;

    expect(plainText(html)).toContain(email);
    expect(
      interactiveControls(html).some(({ name }) =>
        /sign\s*out|log\s*out|cerrar sesión|salir/i.test(name),
      ),
      "Expected the signed-in account to have a sign-out action",
    ).toBe(true);
    for (const { name, href } of interactiveControls(html)) {
      expect(`${name} ${href || ""}`).not.toMatch(/chat|profile|perfil/i);
    }
  });

  it("renders a useful denied message", async () => {
    const message = "This invitation is invalid or has expired.";
    const html = await renderAccountScreen({ view: "denied", error: message });
    if (!assertAccountShell(html)) return;

    expect(plainText(html)).toContain(message);
  });

  it("disables login controls while a request is pending", async () => {
    const html = await renderAccountScreen({
      view: "login",
      email: "teacher@example.edu",
      pending: true,
    });
    if (!assertAccountShell(html)) return;

    expect(inputsIn(html).some(({ tag }) => /\sdisabled(?:\s|=|>)/i.test(tag))).toBe(true);
    expect(
      [...html.matchAll(/<button\b[^>]*>/gi)].some(([tag]) => /\sdisabled(?:\s|=|>)/i.test(tag)),
    ).toBe(true);
  });

  it("shows a useful authentication error", async () => {
    const message = "The email or password was not accepted.";
    const html = await renderAccountScreen({
      view: "login",
      email: "teacher@example.edu",
      error: message,
    });
    if (!assertAccountShell(html)) return;

    expect(plainText(html)).toContain(message);
  });
});

describe("the tab-scoped Cognito session", () => {
  it("keeps access and ID tokens in memory and stores only the refresh token in tab storage", async () => {
    const createSession = await loadSessionFactory();
    if (!createSession) return;

    const calls = [];
    const storage = new MemorySessionStorage();
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return cognitoTokens({
        accessToken: "access-token-value",
        idToken: "id-token-value",
        refreshToken: "refresh-token-value",
      });
    };
    const session = createSession({
      clientId: "web-client-id",
      region: "us-east-1",
      storage,
      fetch,
    });

    const result = await session.signIn("teacher@example.edu", "correct-horse-battery-staple");

    expect(result).toMatchObject({
      accessToken: "access-token-value",
      idToken: "id-token-value",
    });
    expect(session.accessToken()).toBe("access-token-value");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("cognito-idp.us-east-1.amazonaws.com");
    expectCognitoOperation(calls[0], "InitiateAuth");
    const body = requestBody(calls[0]);
    expect(JSON.stringify(body)).toContain("teacher@example.edu");
    expect(JSON.stringify(body)).toContain("correct-horse-battery-staple");
    expect(JSON.stringify(body)).toContain("web-client-id");

    const storedValues = [...storage.values.values()];
    expect(storedValues.some((value) => value.includes("refresh-token-value"))).toBe(true);
    expect(storage.getItem("auth-refresh")).toContain("refresh-token-value");
    const storedText = storedValues.join(" ");
    expect(storedText).not.toContain("access-token-value");
    expect(storedText).not.toContain("id-token-value");
    expect(storedText).not.toContain("correct-horse-battery-staple");
  });

  it.each([
    ["rejects sign-in", async () => jsonResponse({ __type: "NotAuthorizedException" }, 400)],
    [
      "requires a new password",
      async () =>
        jsonResponse({
          ChallengeName: "NEW_PASSWORD_REQUIRED",
          Session: "challenge-session",
        }),
    ],
  ])("does not create a session when Cognito %s", async (_case, response) => {
    const createSession = await loadSessionFactory();
    if (!createSession) return;

    const storage = new MemorySessionStorage();
    const fetch = async () => response();
    const session = createSession({
      clientId: "web-client-id",
      region: "us-east-1",
      storage,
      fetch,
    });

    await expect(session.signIn("teacher@example.edu", "incorrect-password")).rejects.toThrow();

    expect(session.accessToken()).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("restores from the refresh token in tab storage using Cognito JSON", async () => {
    const createSession = await loadSessionFactory();
    if (!createSession) return;

    const calls = [];
    const storage = new MemorySessionStorage([["auth-refresh", "refresh-token-value"]]);
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return cognitoTokens({
        accessToken: "renewed-access-token",
        idToken: "renewed-id-token",
      });
    };
    const session = createSession({
      clientId: "web-client-id",
      region: "us-east-1",
      storage,
      fetch,
    });

    const result = await session.restore();

    expect(result).toMatchObject({
      accessToken: "renewed-access-token",
      idToken: "renewed-id-token",
    });
    expect(session.accessToken()).toBe("renewed-access-token");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("cognito-idp.us-east-1.amazonaws.com");
    expect(
      ["InitiateAuth", "GetTokensFromRefreshToken"].some((operation) => {
        const headers = new Headers(calls[0].init?.headers);
        return (headers.get("x-amz-target") || "").includes(operation);
      }),
      "Expected a Cognito refresh-token operation",
    ).toBe(true);
    expect(JSON.stringify(requestBody(calls[0]))).toContain("refresh-token-value");
    expect([...storage.values.values()].join(" ")).toContain("refresh-token-value");
  });

  it.each([
    [
      "Cognito rejects the refresh token",
      async () => jsonResponse({ __type: "NotAuthorizedException" }, 400),
    ],
    [
      "the network request fails",
      async () => {
        throw new Error("Cognito unavailable");
      },
    ],
  ])("clears tab and memory state and returns sign-in-required when %s", async (_case, fetch) => {
    const createSession = await loadSessionFactory();
    if (!createSession) return;

    const storage = new MemorySessionStorage([
      ["unrelated", "keep-me"],
      ["auth-refresh", "expired-refresh-token"],
    ]);
    const session = createSession({
      clientId: "web-client-id",
      region: "us-east-1",
      storage,
      fetch,
    });

    const result = await session.restore();

    expect(result).toBeNull();
    expect(session.accessToken()).toBeNull();
    expect(storage.getItem("auth-refresh")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep-me");
  });

  it("revokes the refresh token on sign-out and clears the session even if revocation fails", async () => {
    const createSession = await loadSessionFactory();
    if (!createSession) return;

    const calls = [];
    const storage = new MemorySessionStorage([["unrelated", "keep-me"]]);
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return cognitoTokens({
          accessToken: "access-token-value",
          idToken: "id-token-value",
          refreshToken: "refresh-token-value",
        });
      }
      throw new Error("Cognito revocation unavailable");
    };
    const session = createSession({
      clientId: "web-client-id",
      region: "us-east-1",
      storage,
      fetch,
    });

    await session.signIn("teacher@example.edu", "correct-horse-battery-staple");
    await session.signOut();

    expect(calls).toHaveLength(2);
    expectCognitoOperation(calls[1], "RevokeToken");
    expect(JSON.stringify(requestBody(calls[1]))).toContain("refresh-token-value");
    expect(storage.getItem("auth-refresh")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep-me");
    expect(session.accessToken()).toBeNull();
  });
});
