import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const accountScreenPath = path.join(projectRoot, "web/AccountScreen.tsx");
const sessionPath = path.join(projectRoot, "web/session.ts");

async function renderAccountScreen(state) {
  const [{ AccountScreen }, ReactModule, server] = await Promise.all([
    import(pathToFileURL(accountScreenPath).href),
    import("react"),
    import("react-dom/server"),
  ]);
  expect(typeof AccountScreen, "Expected AccountScreen to be a named component export").toBe(
    "function",
  );

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

function controlsIn(html) {
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

function expectAccountShell(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  expect(main, "Expected account content inside a main landmark").not.toBeNull();
  if (!main) return false;

  const heading = main[1].match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  expect(heading, "Expected each account screen to have a main heading").not.toBeNull();
  expect(heading?.[1].replace(/<[^>]*>/g, " ").trim().length).toBeGreaterThan(0);
  return true;
}

class MemorySessionStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
    this.writes = [];
  }

  get length() {
    return this.values.size;
  }

  getItem(key) {
    return this.values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
    this.writes.push([String(key), String(value)]);
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

function cognitoResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function emptyCognitoResponse() {
  return { ok: true, status: 200, text: async () => "" };
}

function malformedCognitoResponse() {
  return { ok: true, status: 200, text: async () => "not-json" };
}

function cognitoTokens() {
  return cognitoResponse({
    AuthenticationResult: {
      AccessToken: "existing-access-token",
      IdToken: "existing-id-token",
      RefreshToken: "existing-refresh-token",
    },
  });
}

function cognitoOperation(call) {
  return new Headers(call.init?.headers).get("x-amz-target") || "";
}

function requestBody(call) {
  return JSON.parse(call.init.body);
}

async function loadSessionFactory() {
  const { createSession } = await import(pathToFileURL(sessionPath).href);
  expect(typeof createSession, "Expected createSession to be a named export").toBe("function");
  return createSession;
}

describe("password recovery screens", () => {
  it("offers recovery from login and renders a labelled email request form", async () => {
    const login = await renderAccountScreen({ view: "login", email: "teacher@example.edu" });
    expectAccountShell(login);
    expect(
      controlsIn(login).some(
        ({ kind, href, name }) =>
          kind === "link" && href === "/#/recover" && /recover|reset|recuper|restablec/i.test(name),
      ),
      "Expected login to link to the recovery request screen",
    ).toBe(true);

    const recovery = await renderAccountScreen({
      view: "recover-request",
      email: "teacher@example.edu",
    });
    expectAccountShell(recovery);
    expectLabeledInput(recovery, { type: "email", label: /email|correo/i });
    expect(
      controlsIn(recovery).some(
        ({ kind, name }) =>
          kind === "button" && /code|código|correo|email|envi|solicit/i.test(name),
      ),
      "Expected a submit action that requests an email code",
    ).toBe(true);
  });

  it("renders accessible confirmation controls and a way to resend or correct the email", async () => {
    const html = await renderAccountScreen({
      view: "recover-confirm",
      email: "teacher@example.edu",
    });
    expectAccountShell(html);

    const email = expectLabeledInput(html, { type: "email", label: /email|correo/i });
    expect(email?.tag).toMatch(/\sreadonly(?:\s|=|>)/i);
    const code = expectLabeledInput(html, { type: "text", label: /code|código/i });
    expect(attribute(code?.tag || "", "autocomplete")).toBe("one-time-code");

    const passwords = inputsIn(html).filter(({ type }) => type === "password");
    expect(passwords.length).toBeGreaterThanOrEqual(2);
    expect(
      passwords.some(
        (input) =>
          labelsForInput(html, input).some((label) => /new|nueva|elegí/i.test(label)) &&
          attribute(input.tag, "autocomplete") === "new-password",
      ),
      "Expected an accessible new-password control",
    ).toBe(true);
    expect(
      passwords.some((input) =>
        labelsForInput(html, input).some((label) => /confirm|repeat|repet|confirmá/i.test(label)),
      ),
      "Expected a password confirmation control",
    ).toBe(true);
    expect(plainText(html)).toMatch(
      /contraseñ.*(requisit|mínim|mayúsc|númer)|password.*(requirement|minimum)/i,
    );

    const controls = controlsIn(html);
    expect(
      controls.some(
        ({ kind, name }) => kind === "button" && /resend|reenvi|volver a envi/i.test(name),
      ),
      "Expected an explicit resend-code action",
    ).toBe(true);
    expect(
      controls.some(
        ({ href, name }) =>
          href === "/#/recover" ||
          (/change|edit|correct|another|different|cambiar|corregir|otra/i.test(name) &&
            /email|address|correo|dirección/i.test(name)),
      ),
      "Expected a way to correct the recovery email",
    ).toBe(true);
    expect(
      controls.some(
        ({ href, name }) =>
          href === "/#/login" || /sign in|log in|iniciar sesión|ingresar/i.test(name),
      ),
      "Expected a way back to sign-in",
    ).toBe(true);
  });

  it.each(["recover-request", "recover-confirm"])(
    "disables recovery form controls while %s is pending",
    async (view) => {
      const html = await renderAccountScreen({ view, email: "teacher@example.edu", pending: true });
      expectAccountShell(html);
      const inputs = inputsIn(html);
      const buttons = controlsIn(html).filter(({ kind }) => kind === "button");
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.every(({ tag }) => /\sdisabled(?:\s|=|>)/i.test(tag))).toBe(true);
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.every(({ attributes }) => /\sdisabled(?:\s|=|>)/i.test(attributes))).toBe(
        true,
      );
    },
  );

  it("renders recovery failures as accessible alerts", async () => {
    const message = "The recovery request could not be completed.";
    const html = await renderAccountScreen({
      view: "recover-confirm",
      email: "teacher@example.edu",
      error: message,
    });
    expectAccountShell(html);
    expect(html).toMatch(/role="alert"/i);
    expect(plainText(html)).toContain(message);
  });
});

describe("direct Cognito password recovery", () => {
  it("requests a code with the public client and preserves an existing browser session", async () => {
    const createSession = await loadSessionFactory();
    const calls = [];
    const storage = new MemorySessionStorage([["unrelated", "keep-me"]]);
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? cognitoTokens()
        : cognitoResponse({
            CodeDeliveryDetails: {
              AttributeName: "email",
              DeliveryMedium: "EMAIL",
              Destination: "t***@example.edu",
            },
          });
    };
    const session = createSession({
      clientId: "public-web-client",
      region: "us-east-1",
      storage,
      fetch,
    });

    await session.signIn("teacher@example.edu", "existing-password");
    const accessToken = session.accessToken();
    const idToken = session.idToken();
    const storedValues = [...storage.values.entries()];
    const result = await session.requestPasswordReset("  Teacher@Example.Edu  ");

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(cognitoOperation(calls[1])).toBe("AWSCognitoIdentityProviderService.ForgotPassword");
    expect(calls[1].url).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
    expect(new Headers(calls[1].init.headers).has("authorization")).toBe(false);
    expect(requestBody(calls[1])).toEqual({
      ClientId: "public-web-client",
      Username: "teacher@example.edu",
    });
    expect(session.accessToken()).toBe(accessToken);
    expect(session.idToken()).toBe(idToken);
    expect([...storage.values.entries()]).toEqual(storedValues);
    expect(storage.getItem("unrelated")).toBe("keep-me");
  });

  it("confirms the new password without signing in and clears only its refresh entry on success", async () => {
    const createSession = await loadSessionFactory();
    const calls = [];
    const storage = new MemorySessionStorage([["unrelated", "keep-me"]]);
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return cognitoTokens();
      return emptyCognitoResponse();
    };
    const session = createSession({
      clientId: "public-web-client",
      region: "us-east-1",
      storage,
      fetch,
    });

    await session.signIn("teacher@example.edu", "old-password");
    await session.confirmPasswordReset(" Teacher@Example.Edu ", "123456", " leading-Valid9! ");

    expect(calls).toHaveLength(2);
    expect(cognitoOperation(calls[1])).toBe(
      "AWSCognitoIdentityProviderService.ConfirmForgotPassword",
    );
    expect(new Headers(calls[1].init.headers).has("authorization")).toBe(false);
    expect(requestBody(calls[1])).toEqual({
      ClientId: "public-web-client",
      Username: "teacher@example.edu",
      ConfirmationCode: "123456",
      Password: " leading-Valid9! ",
    });
    expect(session.accessToken()).toBeNull();
    expect(session.idToken()).toBeNull();
    expect(storage.getItem("auth-refresh")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep-me");
    expect([...storage.values.values()].join(" ")).not.toMatch(/123456|leading-Valid9/);
    expect(
      storage.writes.some(
        ([, value]) => value.includes("123456") || value.includes("leading-Valid9"),
      ),
    ).toBe(false);
  });

  it.each([
    ["CodeMismatchException", 400],
    ["ExpiredCodeException", 400],
    ["InvalidPasswordException", 400],
    ["LimitExceededException", 400],
  ])("preserves Cognito's %s error for the recovery UI", async (code, status) => {
    const createSession = await loadSessionFactory();
    const calls = [];
    const storage = new MemorySessionStorage([["unrelated", "keep-me"]]);
    const session = createSession({
      clientId: "public-web-client",
      region: "us-east-1",
      storage,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return calls.length === 1 ? cognitoTokens() : cognitoResponse({ __type: code }, status);
      },
    });

    await session.signIn("teacher@example.edu", "old-password");
    const accessToken = session.accessToken();
    const idToken = session.idToken();
    const refreshToken = storage.getItem("auth-refresh");
    await expect(
      session.confirmPasswordReset("teacher@example.edu", "123456", "new-password"),
    ).rejects.toMatchObject({ name: "SessionError", code });
    expect(calls).toHaveLength(2);
    expect(cognitoOperation(calls[1])).toBe(
      "AWSCognitoIdentityProviderService.ConfirmForgotPassword",
    );
    expect(session.accessToken()).toBe(accessToken);
    expect(session.idToken()).toBe(idToken);
    expect(storage.getItem("auth-refresh")).toBe(refreshToken);
    expect(storage.getItem("unrelated")).toBe("keep-me");
  });

  it("retries the same reset request after a network failure without changing storage", async () => {
    const createSession = await loadSessionFactory();
    const calls = [];
    const storage = new MemorySessionStorage([
      ["auth-refresh", "existing-refresh-token"],
      ["unrelated", "keep-me"],
    ]);
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) throw new Error("Cognito unavailable");
      return emptyCognitoResponse();
    };
    const session = createSession({
      clientId: "public-web-client",
      region: "us-east-1",
      storage,
      fetch,
    });
    const reset = () =>
      session.confirmPasswordReset("teacher@example.edu", "123456", "new-password");

    await expect(reset()).rejects.toMatchObject({ name: "SessionError", code: "NETWORK_ERROR" });
    expect(storage.getItem("auth-refresh")).toBe("existing-refresh-token");
    expect(storage.getItem("unrelated")).toBe("keep-me");
    expect(session.accessToken()).toBeNull();

    await reset();

    expect(calls).toHaveLength(2);
    expect(cognitoOperation(calls[0])).toBe(
      "AWSCognitoIdentityProviderService.ConfirmForgotPassword",
    );
    expect(cognitoOperation(calls[1])).toBe(
      "AWSCognitoIdentityProviderService.ConfirmForgotPassword",
    );
    expect(requestBody(calls[0])).toEqual(requestBody(calls[1]));
    expect(storage.getItem("auth-refresh")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep-me");
  });

  it("rejects an invalid Cognito response without creating or clearing a session", async () => {
    const createSession = await loadSessionFactory();
    const storage = new MemorySessionStorage([
      ["auth-refresh", "existing-refresh-token"],
      ["unrelated", "keep-me"],
    ]);
    const session = createSession({
      clientId: "public-web-client",
      region: "us-east-1",
      storage,
      fetch: async () => malformedCognitoResponse(),
    });

    await expect(session.requestPasswordReset("teacher@example.edu")).rejects.toMatchObject({
      name: "SessionError",
      code: "INVALID_RESPONSE",
    });
    expect(session.accessToken()).toBeNull();
    expect(session.idToken()).toBeNull();
    expect(storage.getItem("auth-refresh")).toBe("existing-refresh-token");
    expect(storage.getItem("unrelated")).toBe("keep-me");
  });
});
