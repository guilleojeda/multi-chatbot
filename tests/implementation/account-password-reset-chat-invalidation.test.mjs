import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountScreen } from "../../web/AccountScreen.tsx";
import { ChatScreen } from "../../web/ChatScreen.tsx";

const root = process.cwd();
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const queryId = "reset-chat-query";
const identity = { sub: "teacher-a", botId: "docentes" };
const config = {
  region: "us-east-1",
  userPoolId: "us-east-1_example",
  clientId: "web-client",
  apiBaseUrl: "/api",
  botId: identity.botId,
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
  runtimeQualifier: "DEFAULT",
};

let tempDirectory;
let AccountApp;
let createSession;

beforeAll(async () => {
  globalThis.__accountScreens = {
    AccountScreen,
    ChatScreen,
    ProfileApp: () =>
      React.createElement("main", { "aria-label": "Perfil docente" }, "Perfil docente autorizado"),
  };
  tempDirectory = await mkdtemp(join(tmpdir(), "account-reset-chat-"));
  const outputFile = join(tempDirectory, "account-app.mjs");
  const hookModule = `
    export const useState = (...args) => globalThis.__accountHooks.useState(...args);
    export const useRef = (...args) => globalThis.__accountHooks.useRef(...args);
    export const useEffect = (...args) => globalThis.__accountHooks.useEffect(...args);
    export const useCallback = (...args) => globalThis.__accountHooks.useCallback(...args);
  `;
  await build({
    stdin: {
      contents:
        'export { AccountApp } from "./web/AccountApp.tsx"; export { createSession } from "./web/session.ts";',
      resolveDir: root,
      sourcefile: "account-app-entry.tsx",
      loader: "tsx",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "transform",
    outfile: outputFile,
    plugins: [
      {
        name: "account-hook-runtime",
        setup(esbuild) {
          esbuild.onResolve({ filter: /^react$/ }, () => ({
            path: "react-hooks",
            namespace: "test",
          }));
          esbuild.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: hookModule,
            loader: "js",
          }));
          esbuild.onLoad({ filter: /\/(AccountScreen|ChatScreen|ProfileApp)\.tsx$/ }, (args) => {
            const exportName = args.path.match(
              /\/(AccountScreen|ChatScreen|ProfileApp)\.tsx$/,
            )?.[1];
            if (!exportName) return;
            return {
              contents: `export const ${exportName} = globalThis.__accountScreens.${exportName};`,
              loader: "js",
            };
          });
        },
      },
    ],
  });
  ({ AccountApp, createSession } = await import(pathToFileURL(outputFile).href));
});

afterAll(async () => {
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.__accountHooks;
  delete globalThis.__accountScreens;
  delete globalThis.__accountSession;
});

class MemorySessionStorage {
  values = new Map([["auth-refresh", "refresh-before-reset"]]);

  getItem(key) {
    return this.values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function cognitoResponse(tokens, status = 200) {
  if (!tokens) {
    return new Response(JSON.stringify({ __type: "CodeMismatchException" }), {
      status,
      headers: { "content-type": "application/x-amz-json-1.1" },
    });
  }
  return new Response(
    JSON.stringify({
      AuthenticationResult: {
        AccessToken: tokens.accessToken,
        IdToken: tokens.idToken,
        RefreshToken: tokens.refreshToken,
      },
    }),
    { status, headers: { "content-type": "application/x-amz-json-1.1" } },
  );
}

function frame(type, fields) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function sameDependencies(left, right) {
  return (
    left &&
    right &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}

// Drive AccountApp's public callbacks without a DOM; render its real screens to HTML below.
function createHookRuntime() {
  const slots = [];
  let cursor = 0;
  let dirty = true;
  let effects = [];
  let output;
  let route = { kind: "chat" };
  const getSession = () => globalThis.__accountSession;

  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = { value: typeof initial === "function" ? initial() : initial };
        slot.set = (next) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
          dirty = true;
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].set];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !sameDependencies(slots[index].dependencies, dependencies)) {
        slots[index] = { callback, dependencies };
      }
      return slots[index].callback;
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !sameDependencies(previous.dependencies, dependencies)) {
        const next = { dependencies, cleanup: previous?.cleanup };
        slots[index] = next;
        effects.push(() => {
          previous?.cleanup?.();
          next.cleanup = callback();
        });
      }
    },
  };

  function render() {
    dirty = false;
    cursor = 0;
    output = AccountApp({
      route,
      projectName: "Docentes",
      getSession,
    });
    const pending = effects;
    effects = [];
    for (const runEffect of pending) runEffect();
  }

  globalThis.__accountHooks = hooks;
  vi.stubGlobal("React", React);
  render();

  return {
    current() {
      return output;
    },
    async flush() {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await Promise.resolve();
        if (dirty || effects.length) render();
        await new Promise((resolve) => setImmediate(resolve));
        if (!dirty && effects.length === 0) {
          await Promise.resolve();
          if (!dirty && effects.length === 0) return;
        }
      }
      throw new Error("AccountApp did not settle");
    },
    async setRoute(kind) {
      route = { kind };
      globalThis.window.location.hash = `#/${kind}`;
      dirty = true;
      await this.flush();
    },
    async html() {
      await this.flush();
      return renderToStaticMarkup(output);
    },
  };
}

function createEnvironment(confirmSucceeds, holdConfirmation = false) {
  const storage = new MemorySessionStorage();
  let tokenSequence = 0;
  let confirmationOutcome = confirmSucceeds;
  let streamController;
  let streamSignal;
  let streamWasCancelled = false;
  let nextConversation = -1;
  const runtimeRequests = [];
  const membershipRequests = [];
  const streamStarted = deferred();
  const confirmationStarted = deferred();
  const confirmationGate = deferred();
  const session = createSession({
    clientId: config.clientId,
    region: config.region,
    storage,
    fetch: async (_input, init) => {
      const target = new Headers(init?.headers).get("x-amz-target") || "";
      if (target.endsWith("InitiateAuth")) {
        tokenSequence += 1;
        return cognitoResponse({
          accessToken: `access-${tokenSequence}`,
          idToken: `id-${tokenSequence}`,
          refreshToken: `refresh-${tokenSequence}`,
        });
      }
      if (target.endsWith("ConfirmForgotPassword")) {
        if (holdConfirmation) {
          confirmationStarted.resolve();
          await confirmationGate.promise;
        }
        return confirmationOutcome ? new Response("", { status: 200 }) : cognitoResponse(null, 400);
      }
      if (target.endsWith("ForgotPassword")) return new Response("", { status: 200 });
      throw new Error(`Unexpected Cognito operation: ${target}`);
    },
  });
  globalThis.__accountSession = session;

  vi.stubGlobal("window", {
    location: { hash: "#/chat", pathname: "/", search: "" },
    history: { replaceState() {} },
    crypto: {
      randomUUID: () =>
        `550e8400-e29b-41d4-a716-44665544${String(++nextConversation).padStart(4, "0")}`,
    },
  });

  const fetch = vi.fn(async (input, init = {}) => {
    const url = String(input);
    if (url === "/public-config.json") return Response.json(config);
    if (url === "/api/account/me") {
      membershipRequests.push(url);
      return Response.json(identity);
    }
    if (url === "/api/profile") {
      return Response.json({
        sub: identity.sub,
        botId: identity.botId,
        profile: {
          sub: identity.sub,
          botId: identity.botId,
          updatedAt: "2026-10-20T00:00:00.000Z",
          fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
          responsePreferenceIds: [],
        },
      });
    }
    const runtimeUrl =
      `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/` +
      `${encodeURIComponent(config.runtimeArn)}/invocations?qualifier=${encodeURIComponent(config.runtimeQualifier)}`;
    if (url === runtimeUrl) {
      const request = JSON.parse(String(init.body));
      runtimeRequests.push(request);
      if (runtimeRequests.length > 1) {
        const query = "after-reset-query";
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                [
                  frame("accepted", {
                    conversationId: request.conversationId,
                    queryId: query,
                    ordinal: request.operation === "message" ? 2 : 1,
                  }),
                  frame("text", { queryId: query, index: 0, text: "Respuesta nueva" }),
                  frame("completed", { queryId: query }),
                ].join(""),
              ),
            );
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      streamSignal = init.signal;
      const body = new ReadableStream({
        start(controller) {
          streamController = controller;
          controller.enqueue(
            new TextEncoder().encode(
              [
                frame("accepted", { conversationId: request.conversationId, queryId, ordinal: 1 }),
                frame("text", { queryId, index: 0, text: "Respuesta inicial del hilo" }),
              ].join(""),
            ),
          );
          streamStarted.resolve();
        },
        cancel() {
          streamWasCancelled = true;
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`Unexpected web request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);

  return {
    session,
    storage,
    runtimeRequests,
    streamStarted: streamStarted.promise,
    confirmationStarted: confirmationStarted.promise,
    releaseConfirmation(succeeds) {
      confirmationOutcome = succeeds;
      confirmationGate.resolve();
    },
    streamSignal: () => streamSignal,
    streamWasCancelled: () => streamWasCancelled,
    membershipRequests,
    sendLateChunk() {
      streamController.enqueue(
        new TextEncoder().encode(
          frame("text", { queryId, index: 1, text: "; fragmento posterior al reset" }),
        ),
      );
    },
    finishStream() {
      try {
        streamController.enqueue(new TextEncoder().encode(frame("completed", { queryId })));
        streamController.close();
      } catch {
        // A canceled response has no remaining stream to close.
      }
    },
  };
}

async function initializeChat(app) {
  await vi.waitFor(async () => {
    await app.flush();
    expect(await app.html()).toContain('id="chat-query"');
  });
}

async function startStream(app, environment) {
  await initializeChat(app);
  app.current().props.onSubmit("Prepará una actividad para la clase.");
  await environment.streamStarted;
  await vi.waitFor(async () => {
    expect(await app.html()).toContain("Respuesta inicial del hilo");
  });
}

async function resetPassword(app, confirmationCode = "123456") {
  await app.setRoute("recover");
  expect(await app.html()).toContain("Recuperá tu contraseña");
  await app.current().props.onSubmit({
    action: "request-password-reset",
    email: "teacher@example.test",
  });
  await vi.waitFor(async () => {
    expect(await app.html()).toContain('id="recovery-code"');
  });
  await app.current().props.onSubmit({
    action: "confirm-password-reset",
    email: "teacher@example.test",
    code: confirmationCode,
    password: "ValidPassword1!",
  });
  await app.flush();
}

async function beginPasswordReset(app, environment) {
  await app.setRoute("recover");
  expect(await app.html()).toContain("Recuperá tu contraseña");
  await app.current().props.onSubmit({
    action: "request-password-reset",
    email: "teacher@example.test",
  });
  await vi.waitFor(async () => {
    expect(await app.html()).toContain('id="recovery-code"');
  });
  const operation = app.current().props.onSubmit({
    action: "confirm-password-reset",
    email: "teacher@example.test",
    code: "123456",
    password: "ValidPassword1!",
  });
  await environment.confirmationStarted;
  await app.flush();
  return { operation };
}

describe("password reset and the in-memory chat", () => {
  it("retires the active thread and ignores a late stream chunk after a successful reset", async () => {
    const environment = createEnvironment(true);
    const app = createHookRuntime();
    await startStream(app, environment);
    await resetPassword(app);

    expect(environment.session.accessToken()).toBeNull();
    expect(environment.storage.getItem("auth-refresh")).toBeNull();
    expect(environment.streamSignal()?.aborted).toBe(true);

    await app.setRoute("login");
    await vi.waitFor(async () => expect(await app.html()).toContain("Iniciá sesión"));
    await app.current().props.onSubmit({
      action: "sign-in",
      email: "teacher@example.test",
      password: "ValidPassword1!",
    });
    await app.setRoute("chat");
    await initializeChat(app);

    environment.sendLateChunk();
    await vi.waitFor(async () => {
      const html = await app.html();
      expect(
        environment.streamWasCancelled() || html.includes("fragmento posterior al reset"),
      ).toBe(true);
    });
    environment.finishStream();
    const html = await app.html();
    expect(html).not.toContain("Prepará una actividad para la clase.");
    expect(html).not.toContain("Respuesta inicial del hilo");
    expect(html).not.toContain("fragmento posterior al reset");
    expect(html).toContain('id="chat-query"');

    app.current().props.onSubmit("Una consulta nueva después del cambio.");
    await vi.waitFor(() => expect(environment.runtimeRequests).toHaveLength(2));
    await vi.waitFor(async () => expect(await app.html()).toContain("Respuesta nueva"));
    expect(environment.runtimeRequests[0]).toMatchObject({
      operation: "start",
      conversationId,
    });
    expect(environment.runtimeRequests[1]).toMatchObject({ operation: "start" });
    expect(environment.runtimeRequests[1].conversationId).not.toBe(
      environment.runtimeRequests[0].conversationId,
    );
  });

  it("keeps the signed-in thread and stream when Cognito rejects the reset", async () => {
    const environment = createEnvironment(false);
    const app = createHookRuntime();
    await startStream(app, environment);
    await resetPassword(app);

    expect(environment.session.accessToken()).not.toBeNull();
    expect(environment.storage.getItem("auth-refresh")).not.toBeNull();
    expect(environment.streamSignal()?.aborted).toBe(false);
    expect(await app.html()).toContain("El código no es correcto.");

    await app.setRoute("chat");
    await initializeChat(app);
    environment.sendLateChunk();
    await vi.waitFor(async () => {
      const html = await app.html();
      expect(html).toContain("Prepará una actividad para la clase.");
      expect(html).toContain("fragmento posterior al reset");
    });
    environment.finishStream();
    expect(environment.streamSignal()?.aborted).toBe(false);
  });

  for (const destination of ["chat", "profile"]) {
    it(`redirects to usable login after reset succeeds while ${destination} is current`, async () => {
      const environment = createEnvironment(true, true);
      const app = createHookRuntime();
      await startStream(app, environment);
      const { operation: confirmation } = await beginPasswordReset(app, environment);
      await app.setRoute(destination);
      expect(await app.html()).toContain("Comprobando tu acceso…");

      environment.releaseConfirmation(true);
      await confirmation;
      await app.flush();
      expect(globalThis.window.location.hash).toBe("/login");
      await app.setRoute("login");

      const html = await app.html();
      expect(html).toContain('role="status"');
      expect(html).toContain("La contraseña se cambió. Iniciá sesión con la nueva contraseña.");
      expect(html).toContain('id="account-password"');
      expect(html).not.toContain("Comprobando tu acceso…");
      expect(environment.session.accessToken()).toBeNull();
      expect(environment.storage.getItem("auth-refresh")).toBeNull();
      expect(environment.streamSignal()?.aborted).toBe(true);

      environment.sendLateChunk();
      expect(await app.html()).not.toContain("fragmento posterior al reset");
      await app.current().props.onSubmit({
        action: "sign-in",
        email: "teacher@example.test",
        password: "ValidPassword1!",
      });
      await app.setRoute("chat");
      await initializeChat(app);
      expect(await app.html()).not.toContain("Respuesta inicial del hilo");

      app.current().props.onSubmit("Una consulta nueva después del cambio.");
      await vi.waitFor(() => expect(environment.runtimeRequests).toHaveLength(2));
      expect(environment.runtimeRequests[0]).toMatchObject({
        operation: "start",
        conversationId,
      });
      expect(environment.runtimeRequests[1]).toMatchObject({ operation: "start" });
      expect(environment.runtimeRequests[1].conversationId).not.toBe(conversationId);
    });

    it(`reauthorizes ${destination} and preserves its thread and active stream after a rejected reset`, async () => {
      const environment = createEnvironment(false, true);
      const app = createHookRuntime();
      await startStream(app, environment);
      const { operation: confirmation } = await beginPasswordReset(app, environment);
      await app.setRoute(destination);
      expect(await app.html()).toContain("Comprobando tu acceso…");
      const membershipRequestsBefore = environment.membershipRequests.length;

      environment.releaseConfirmation(false);
      await confirmation;
      await vi.waitFor(async () => {
        const html = await app.html();
        if (destination === "chat") expect(html).toContain("Respuesta inicial del hilo");
        else expect(html).toContain('aria-label="Perfil docente"');
      });

      expect(environment.session.accessToken()).not.toBeNull();
      expect(environment.storage.getItem("auth-refresh")).not.toBeNull();
      expect(environment.streamSignal()?.aborted).toBe(false);
      expect(environment.membershipRequests).toHaveLength(membershipRequestsBefore + 1);
      expect(environment.runtimeRequests).toHaveLength(1);

      await app.setRoute("chat");
      await vi.waitFor(async () => {
        const html = await app.html();
        expect(html).toContain("Prepará una actividad para la clase.");
        expect(html).toContain("Respuesta inicial del hilo");
      });
      environment.sendLateChunk();
      await vi.waitFor(async () => {
        expect(await app.html()).toContain("fragmento posterior al reset");
      });
      environment.finishStream();
      await vi.waitFor(async () => {
        expect(await app.html()).toContain("La respuesta está completa.");
      });
      app.current().props.onSubmit("Un seguimiento en el mismo hilo.");
      await vi.waitFor(() => expect(environment.runtimeRequests).toHaveLength(2));
      expect(environment.runtimeRequests[1]).toMatchObject({
        operation: "message",
        conversationId,
      });
    });
  }
});
