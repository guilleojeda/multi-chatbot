import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat } from "../../web/chat-api.ts";
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
const queryId = "query-001";

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

function cognitoResponse(accessToken, idToken, refreshToken) {
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

function frame(type, fields) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function completedStream() {
  const encoder = new TextEncoder();
  const content = [
    frame("accepted", { conversationId, queryId, ordinal: 1 }),
    frame("text", { queryId, index: 0, text: "Respuesta" }),
    frame("completed", { queryId }),
  ].join("");
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(content));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function targetOf(init) {
  return new Headers(init.headers).get("x-amz-target") || "";
}

function cognitoRequest(init) {
  return JSON.parse(init.body);
}

describe("shared session refresh during a streamed chat request", () => {
  it("shares the runtime 401 renewal with route initialization and retries with the renewed identity", async () => {
    const storage = new MemorySessionStorage();
    const refreshGate = deferred();
    const refreshStarted = deferred();
    const cognitoRequests = [];
    const session = createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch: vi.fn(async (_url, init) => {
        const target = targetOf(init);
        const body = cognitoRequest(init);
        cognitoRequests.push({ target, body });
        if (target.endsWith("InitiateAuth") && body.AuthFlow === "USER_PASSWORD_AUTH") {
          return cognitoResponse("access-1", "id-1", "refresh-1");
        }
        if (target.endsWith("InitiateAuth") && body.AuthFlow === "REFRESH_TOKEN_AUTH") {
          refreshStarted.resolve();
          return refreshGate.promise;
        }
        throw new Error(`Unexpected Cognito operation: ${target}`);
      }),
    });
    await session.signIn("teacher@example.test", "password");

    const runtimeFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockImplementationOnce(async (_url, init) => {
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-2");
        return completedStream();
      });
    vi.stubGlobal("fetch", runtimeFetch);

    const onEvent = vi.fn();
    const chat = streamChat(
      config,
      session,
      { operation: "message", conversationId, text: "Seguimiento." },
      { isActive: () => true, onEvent },
    );
    await refreshStarted.promise;

    const routeInitialization = session.restore();
    expect(
      cognitoRequests.filter(({ body }) => body.AuthFlow === "REFRESH_TOKEN_AUTH"),
    ).toHaveLength(1);

    refreshGate.resolve(cognitoResponse("access-2", "id-2", "refresh-2"));
    const [chatResult, routeTokens] = await Promise.all([chat, routeInitialization]);

    expect(chatResult).toMatchObject({ status: "completed", conversationId, queryId, ordinal: 1 });
    expect(routeTokens).toEqual({ accessToken: "access-2", idToken: "id-2" });
    expect(session.accessToken()).toBe("access-2");
    expect(session.idToken()).toBe("id-2");
    expect(storage.getItem("auth-refresh")).toBe("refresh-2");
    expect(runtimeFetch).toHaveBeenCalledTimes(2);
    expect(
      cognitoRequests.filter(({ body }) => body.AuthFlow === "REFRESH_TOKEN_AUTH"),
    ).toHaveLength(1);
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "accepted",
      "text",
      "completed",
    ]);
  });

  it("does not retry a 401 after sign-out invalidates the pending real session refresh", async () => {
    const storage = new MemorySessionStorage();
    const refreshGate = deferred();
    const refreshStarted = deferred();
    const session = createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch: vi.fn(async (_url, init) => {
        const target = targetOf(init);
        const body = cognitoRequest(init);
        if (target.endsWith("RevokeToken")) return new Response("", { status: 200 });
        if (target.endsWith("InitiateAuth") && body.AuthFlow === "USER_PASSWORD_AUTH") {
          return cognitoResponse("access-1", "id-1", "refresh-1");
        }
        if (target.endsWith("InitiateAuth") && body.AuthFlow === "REFRESH_TOKEN_AUTH") {
          refreshStarted.resolve();
          return refreshGate.promise;
        }
        throw new Error(`Unexpected Cognito operation: ${target}`);
      }),
    });
    await session.signIn("teacher@example.test", "password");

    const runtimeFetch = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", runtimeFetch);
    const chat = streamChat(
      config,
      session,
      { operation: "message", conversationId, text: "Seguimiento." },
      { isActive: () => session.accessToken() !== null, onEvent: vi.fn() },
    );
    await refreshStarted.promise;

    await session.signOut();
    refreshGate.resolve(cognitoResponse("late-access", "late-id", "late-refresh"));
    await expect(chat).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(session.accessToken()).toBeNull();
    expect(session.idToken()).toBeNull();
    expect(storage.getItem("auth-refresh")).toBeNull();
  });
});
