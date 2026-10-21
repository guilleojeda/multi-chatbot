import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestWithRefresh } from "../../web/api.ts";
import { streamChat } from "../../web/chat-api.ts";
import { ChatScreen } from "../../web/ChatScreen.tsx";
import { createSession } from "../../web/session.ts";

const config = {
  region: "us-east-1",
  userPoolId: "us-east-1_example",
  clientId: "web-client",
  apiBaseUrl: "/api",
  botId: "docentes",
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
  runtimeQualifier: "DEFAULT",
};
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const queryId = "550e8400-e29b-41d4-a716-446655440001";
const request = {
  version: 2,
  operation: "start",
  conversationId,
  queryId,
  baseOrdinal: 0,
  text: "Prepará una actividad.",
};

afterEach(() => vi.unstubAllGlobals());

class MemorySessionStorage {
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
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function cognitoSuccess(accessToken, idToken, refreshToken) {
  return new Response(
    JSON.stringify({
      AuthenticationResult: {
        AccessToken: accessToken,
        IdToken: idToken,
        RefreshToken: refreshToken,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function cognitoFailure(code = "NotAuthorizedException") {
  return new Response(JSON.stringify({ __type: code }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function frame(type, fields) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function completedStream(chatRequest = request) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          [
            frame("accepted", {
              conversationId: chatRequest.conversationId,
              queryId: chatRequest.queryId,
              ordinal: chatRequest.baseOrdinal + 1,
            }),
            frame("text", {
              queryId: chatRequest.queryId,
              index: 0,
              text: "Respuesta progresiva",
            }),
            frame("completed", { queryId: chatRequest.queryId }),
          ].join(""),
        ),
      );
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function cognitoTarget(init) {
  return new Headers(init.headers).get("x-amz-target") || "";
}

function cognitoBody(init) {
  return JSON.parse(init.body);
}

function makeChatScreen(state) {
  return renderToStaticMarkup(
    React.createElement(ChatScreen, {
      state,
      onSubmit: vi.fn(),
      onSignOut: vi.fn(),
      onRetryProfile: vi.fn(),
      onReset: vi.fn(),
      onCopy: vi.fn(),
    }),
  );
}

describe("profile and chat state remain independent while a turn resolves", () => {
  it.each(["failed", "completed"])(
    "keeps the profile retry visible after a %s stream terminal",
    (queryStatus) => {
      const html = makeChatScreen({
        profileStatus: "error",
        profileError: "No pudimos cargar tu perfil. Podés reintentar.",
        queryStatus,
        queryError: queryStatus === "failed" ? "La generación terminó con un error." : undefined,
        question: "Prepará una actividad.",
        answer: "Prefijo de respuesta.",
      });

      expect(html).toContain("No pudimos cargar tu perfil. Podés reintentar.");
      expect(html).toContain("Reintentar");
      expect(html).not.toContain('id="chat-query"');
      if (queryStatus === "failed") {
        expect(html).toContain("La generación terminó con un error.");
        expect(html).toContain("Este intercambio incompleto no se incluirá");
      } else {
        expect(html).toContain("Copiar respuesta");
      }
    },
  );

  it("keeps profile-required admission incomplete and the composer absent", () => {
    const html = makeChatScreen({
      profileStatus: "incomplete",
      queryStatus: "rejected",
      queryError: "Completá tu perfil para iniciar esta consulta.",
      question: "Prepará una actividad.",
    });

    expect(html).toContain("Completá tu perfil para conversar.");
    expect(html).toContain("Completá tu perfil para iniciar esta consulta.");
    expect(html).not.toContain('id="chat-query"');
  });
});

describe("a real session refresh shared by Runtime and profile API", () => {
  it("keeps profile save active while a Runtime 401 owns the pending refresh", async () => {
    const storage = new MemorySessionStorage();
    const runtime401 = deferred();
    const runtimeStarted = deferred();
    const refreshResponse = deferred();
    const refreshStarted = deferred();
    const cognitoRequests = [];
    const session = createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch: vi.fn(async (_url, init) => {
        const target = cognitoTarget(init);
        const body = cognitoBody(init);
        cognitoRequests.push({ target, body });
        if (target.endsWith("InitiateAuth") && body.AuthFlow === "USER_PASSWORD_AUTH") {
          return cognitoSuccess("access-1", "id-1", "refresh-1");
        }
        if (target.endsWith("InitiateAuth") && body.AuthFlow === "REFRESH_TOKEN_AUTH") {
          refreshStarted.resolve();
          return refreshResponse.promise;
        }
        throw new Error(`Unexpected Cognito operation: ${target}`);
      }),
    });
    await session.signIn("teacher@example.test", "password");
    const restoreSpy = vi.spyOn(session, "restore");

    const profile401Started = deferred();
    const runtimeCalls = [];
    const profileCalls = [];
    const fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const token = new Headers(init.headers).get("authorization")?.replace("Bearer ", "");
      if (url.includes("bedrock-agentcore.us-east-1.amazonaws.com")) {
        runtimeCalls.push(token);
        if (runtimeCalls.length === 1) {
          runtimeStarted.resolve();
          return runtime401.promise;
        }
        return completedStream(JSON.parse(init.body));
      }
      if (url === "/api/profile") {
        profileCalls.push({ token, body: JSON.parse(init.body) });
        if (profileCalls.length === 1) {
          profile401Started.resolve();
          return new Response(JSON.stringify({ code: "UNAUTHORIZED" }), { status: 401 });
        }
        return new Response(JSON.stringify({ saved: true }), { status: 200 });
      }
      throw new Error(`Unexpected web request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const chat = streamChat(config, session, request, { isActive: () => true, onEvent: vi.fn() });
    await runtimeStarted.promise;
    runtime401.resolve(new Response("{}", { status: 401 }));
    await refreshStarted.promise;

    expect(session.accessToken()).toBe("access-1");
    const profileSave = requestWithRefresh(
      config,
      session,
      "/profile",
      { method: "PUT", body: { fields: { subjects: ["Matemática"] } } },
      () => true,
    );
    await profile401Started.promise;
    await vi.waitFor(() => expect(restoreSpy).toHaveBeenCalledTimes(2));
    expect(
      cognitoRequests.filter(({ body }) => body.AuthFlow === "REFRESH_TOKEN_AUTH"),
    ).toHaveLength(1);

    refreshResponse.resolve(cognitoSuccess("access-2", "id-2", "refresh-2"));
    const [chatResult, profileResult] = await Promise.all([chat, profileSave]);

    expect(chatResult).toMatchObject({ status: "completed", conversationId, queryId, ordinal: 1 });
    expect(profileResult).toEqual({ saved: true });
    expect(runtimeCalls).toEqual(["access-1", "access-2"]);
    expect(profileCalls.map(({ token }) => token)).toEqual(["access-1", "access-2"]);
    expect(profileCalls[0].body).toEqual(profileCalls[1].body);
    expect(
      cognitoRequests.filter(({ body }) => body.AuthFlow === "REFRESH_TOKEN_AUTH"),
    ).toHaveLength(1);
    expect(session.accessToken()).toBe("access-2");
  });

  it("does not retry Runtime or profile requests after the shared refresh fails", async () => {
    const storage = new MemorySessionStorage();
    const refreshResponse = deferred();
    const refreshStarted = deferred();
    const session = createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch: vi.fn(async (_url, init) => {
        const target = cognitoTarget(init);
        const body = cognitoBody(init);
        if (target.endsWith("InitiateAuth") && body.AuthFlow === "USER_PASSWORD_AUTH") {
          return cognitoSuccess("access-1", "id-1", "refresh-1");
        }
        if (target.endsWith("InitiateAuth") && body.AuthFlow === "REFRESH_TOKEN_AUTH") {
          refreshStarted.resolve();
          return refreshResponse.promise;
        }
        throw new Error(`Unexpected Cognito operation: ${target}`);
      }),
    });
    await session.signIn("teacher@example.test", "password");
    const restoreSpy = vi.spyOn(session, "restore");
    const profile401Started = deferred();
    const runtimeFetch = vi.fn(async () => new Response("{}", { status: 401 }));
    const profileFetch = vi.fn(async () => {
      profile401Started.resolve();
      return new Response(JSON.stringify({ code: "UNAUTHORIZED" }), { status: 401 });
    });
    const fetch = vi.fn(async (input, init) =>
      String(input) === "/api/profile" ? profileFetch(input, init) : runtimeFetch(input, init),
    );
    vi.stubGlobal("fetch", fetch);

    const chat = streamChat(config, session, request, { isActive: () => true, onEvent: vi.fn() });
    await refreshStarted.promise;
    const profileSave = requestWithRefresh(
      config,
      session,
      "/profile",
      { method: "PUT", body: { fields: { subjects: ["Matemática"] } } },
      () => true,
    );
    await profile401Started.promise;
    await vi.waitFor(() => expect(restoreSpy).toHaveBeenCalledTimes(2));

    refreshResponse.resolve(cognitoFailure());
    await expect(chat).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    await expect(profileSave).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(profileFetch).toHaveBeenCalledTimes(1);
    expect(session.accessToken()).toBeNull();
    expect(session.idToken()).toBeNull();
    expect(storage.getItem("auth-refresh")).toBeNull();
  });

  it("discards the pending renewal on logout and makes no later API or Runtime call", async () => {
    const storage = new MemorySessionStorage();
    const refreshResponse = deferred();
    const refreshStarted = deferred();
    const session = createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch: vi.fn(async (_url, init) => {
        const target = cognitoTarget(init);
        const body = cognitoBody(init);
        if (target.endsWith("RevokeToken")) return new Response("", { status: 200 });
        if (target.endsWith("InitiateAuth") && body.AuthFlow === "USER_PASSWORD_AUTH") {
          return cognitoSuccess("access-1", "id-1", "refresh-1");
        }
        if (target.endsWith("InitiateAuth") && body.AuthFlow === "REFRESH_TOKEN_AUTH") {
          refreshStarted.resolve();
          return refreshResponse.promise;
        }
        throw new Error(`Unexpected Cognito operation: ${target}`);
      }),
    });
    await session.signIn("teacher@example.test", "password");
    const restoreSpy = vi.spyOn(session, "restore");
    const profile401Started = deferred();
    const runtimeFetch = vi.fn(async () => new Response("{}", { status: 401 }));
    const profileFetch = vi.fn(async () => {
      profile401Started.resolve();
      return new Response(JSON.stringify({ code: "UNAUTHORIZED" }), { status: 401 });
    });
    const fetch = vi.fn(async (input, init) =>
      String(input) === "/api/profile" ? profileFetch(input, init) : runtimeFetch(input, init),
    );
    vi.stubGlobal("fetch", fetch);

    let active = true;
    const isActive = () => active;
    const chat = streamChat(config, session, request, { isActive, onEvent: vi.fn() });
    await refreshStarted.promise;
    const profileSave = requestWithRefresh(
      config,
      session,
      "/profile",
      { method: "PUT", body: { fields: { subjects: ["Matemática"] } } },
      isActive,
    );
    await profile401Started.promise;
    await vi.waitFor(() => expect(restoreSpy).toHaveBeenCalledTimes(2));

    active = false;
    await session.signOut();
    refreshResponse.resolve(cognitoSuccess("late-access", "late-id", "late-refresh"));
    await expect(chat).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    await expect(profileSave).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(profileFetch).toHaveBeenCalledTimes(1);
    expect(session.accessToken()).toBeNull();
    expect(session.idToken()).toBeNull();
    expect(storage.getItem("auth-refresh")).toBeNull();
  });

  it("returns 401 without a protected API or Runtime fetch when there is no session", async () => {
    const storage = new MemorySessionStorage();
    const cognitoFetch = vi.fn();
    const session = createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch: cognitoFetch,
    });
    const webFetch = vi.fn();
    vi.stubGlobal("fetch", webFetch);

    await expect(
      requestWithRefresh(config, session, "/profile", {}, () => true),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    await expect(
      streamChat(config, session, request, { isActive: () => true, onEvent: vi.fn() }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    expect(cognitoFetch).not.toHaveBeenCalled();
    expect(webFetch).not.toHaveBeenCalled();
  });
});
