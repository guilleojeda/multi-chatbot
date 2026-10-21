import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAccountAppHookHarness,
  loadAccountAppForHookTests,
} from "../support/account-app-hook-harness.mjs";

const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const identity = { sub: "teacher-a", botId: "docentes" };
const secondIdentity = { sub: "teacher-b", botId: "docentes" };
const config = {
  region: "us-east-1",
  userPoolId: "us-east-1_example",
  clientId: "web-client",
  apiBaseUrl: "/api",
  botId: identity.botId,
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
  runtimeQualifier: "DEFAULT",
};

let AccountApp;
let createSession;
let disposeAccountApp;

beforeAll(async () => {
  ({ AccountApp, createSession, dispose: disposeAccountApp } = await loadAccountAppForHookTests());
});

afterAll(async () => {
  await disposeAccountApp?.();
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

// Drive AccountApp's public callbacks without a DOM; render its real screens to HTML below.
function createHookRuntime() {
  return createAccountAppHookHarness({ AccountApp });
}

function createEnvironment(confirmSucceeds, holdConfirmation = false, authOptions = {}) {
  const storage = new MemorySessionStorage();
  let tokenSequence = 0;
  let confirmationOutcome = confirmSucceeds;
  let currentIdentity = authOptions.initialIdentity || identity;
  let refreshCount = 0;
  let streamController;
  let streamSignal;
  let streamQueryId;
  let streamWasCancelled = false;
  let nextConversation = -1;
  const runtimeRequests = [];
  const membershipRequests = [];
  const streamStarted = deferred();
  const confirmationStarted = deferred();
  const confirmationGate = deferred();
  const refreshStarted = deferred();
  const refreshGate = deferred();
  const loginStarted = deferred();
  const loginGate = deferred();
  const session = createSession({
    clientId: config.clientId,
    region: config.region,
    storage,
    fetch: async (_input, init) => {
      const target = new Headers(init?.headers).get("x-amz-target") || "";
      if (target.endsWith("InitiateAuth")) {
        const body = JSON.parse(init.body);
        if (body.AuthFlow === "REFRESH_TOKEN_AUTH") {
          refreshCount += 1;
          if (refreshCount === 2 && authOptions.holdRefresh) {
            refreshStarted.resolve();
            await refreshGate.promise;
            if (authOptions.refreshSucceeds === false) {
              return new Response(JSON.stringify({ __type: "NotAuthorizedException" }), {
                status: 400,
                headers: { "content-type": "application/json" },
              });
            }
          }
        } else {
          loginStarted.resolve();
          currentIdentity = authOptions.loginIdentity || currentIdentity;
          if (authOptions.holdSignIn) await loginGate.promise;
        }
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
      return Response.json(currentIdentity);
    }
    if (url === "/api/account/invitations/inspect") {
      return Response.json({
        kind: "existing",
        email: authOptions.loginEmail || "teacher@example.test",
      });
    }
    if (url === "/api/account/invitations/accept") {
      return Response.json({ status: "accepted" });
    }
    if (url === "/api/profile") {
      return Response.json({
        sub: currentIdentity.sub,
        botId: currentIdentity.botId,
        profile: {
          sub: currentIdentity.sub,
          botId: currentIdentity.botId,
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
      if (authOptions.runtimeUnauthorizedFirst && runtimeRequests.length === 1) {
        return new Response("{}", { status: 401 });
      }
      if (runtimeRequests.length > 1) {
        const query = request.queryId;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                [
                  frame("accepted", {
                    conversationId: request.conversationId,
                    queryId: query,
                    ordinal: request.baseOrdinal + 1,
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
      streamQueryId = request.queryId;
      const body = new ReadableStream({
        start(controller) {
          streamController = controller;
          controller.enqueue(
            new TextEncoder().encode(
              [
                frame("accepted", {
                  conversationId: request.conversationId,
                  queryId: request.queryId,
                  ordinal: request.baseOrdinal + 1,
                }),
                frame("text", {
                  queryId: request.queryId,
                  index: 0,
                  text: "Respuesta inicial del hilo",
                }),
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
    refreshStarted: refreshStarted.promise,
    loginStarted: loginStarted.promise,
    confirmationStarted: confirmationStarted.promise,
    releaseConfirmation(succeeds) {
      confirmationOutcome = succeeds;
      confirmationGate.resolve();
    },
    releaseRefresh() {
      refreshGate.resolve();
    },
    releaseSignIn() {
      loginGate.resolve();
    },
    streamSignal: () => streamSignal,
    streamWasCancelled: () => streamWasCancelled,
    membershipRequests,
    sendLateChunk() {
      streamController.enqueue(
        new TextEncoder().encode(
          frame("text", {
            queryId: streamQueryId,
            index: 1,
            text: "; fragmento posterior al reset",
          }),
        ),
      );
    },
    finishStream() {
      try {
        streamController.enqueue(
          new TextEncoder().encode(frame("completed", { queryId: streamQueryId })),
        );
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
  expect(environment.runtimeRequests[0]).toMatchObject({
    version: 2,
    operation: "start",
    conversationId,
    baseOrdinal: 0,
    text: "Prepará una actividad para la clase.",
  });
  expect(environment.runtimeRequests[0].queryId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
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
        version: 2,
        operation: "message",
        conversationId,
        queryId: expect.any(String),
        baseOrdinal: 1,
        text: "Un seguimiento en el mismo hilo.",
      });
      expect(environment.runtimeRequests[1].queryId).not.toBe(
        environment.runtimeRequests[0].queryId,
      );
    });
  }
});

describe("chat consumers during invitation sign-in", () => {
  for (const targetIdentity of [identity, secondIdentity]) {
    for (const signInPhase of ["during sign-in", "after membership"]) {
      for (const oldRefreshResult of ["success", "failure"]) {
        it(`keeps ${targetIdentity.sub} signed in when the old chat refresh returns ${oldRefreshResult} ${signInPhase}`, async () => {
          const holdSignIn = signInPhase === "during sign-in";
          const invitedEmail =
            targetIdentity.sub === secondIdentity.sub
              ? "teacher-b@example.test"
              : "teacher@example.test";
          const environment = createEnvironment(false, false, {
            holdRefresh: true,
            holdSignIn,
            refreshSucceeds: oldRefreshResult === "success",
            runtimeUnauthorizedFirst: true,
            loginIdentity: targetIdentity,
            loginEmail: invitedEmail,
          });
          const app = createHookRuntime();
          await initializeChat(app);
          app.current().props.onSubmit("Consulta anterior durante la renovación.");
          await environment.refreshStarted;
          expect(environment.runtimeRequests).toHaveLength(1);
          const oldConversationId = environment.runtimeRequests[0].conversationId;

          await app.setRoute("invite");
          await vi.waitFor(async () => expect(await app.html()).toContain("Aceptá la invitación"));
          const signIn = app.current().props.onSubmit({
            action: "accept-existing",
            email: invitedEmail,
            password: "ValidPassword1!",
          });

          if (holdSignIn) {
            await environment.loginStarted;
            environment.releaseRefresh();
            await app.flush();
            environment.releaseSignIn();
          }
          await signIn;
          await app.flush();
          expect(await app.html()).toContain("Tu acceso está activo");
          expect(environment.session.accessToken()).not.toBeNull();

          if (!holdSignIn) {
            environment.releaseRefresh();
            await app.flush();
          }

          expect(environment.session.accessToken()).not.toBeNull();
          await app.setRoute("chat");
          await initializeChat(app);
          const emptyChat = await app.html();
          expect(emptyChat).not.toContain("Consulta anterior durante la renovación.");
          expect(environment.runtimeRequests).toHaveLength(1);

          app.current().props.onSubmit("Consulta nueva de la sesión invitada.");
          await vi.waitFor(() => expect(environment.runtimeRequests).toHaveLength(2));
          expect(environment.runtimeRequests[1]).toMatchObject({
            operation: "start",
            text: "Consulta nueva de la sesión invitada.",
          });
          expect(environment.runtimeRequests[1].conversationId).not.toBe(oldConversationId);
          await vi.waitFor(async () => expect(await app.html()).toContain("Respuesta nueva"));
        });
      }
    }
  }
});
