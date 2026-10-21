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
const queryId = "550e8400-e29b-41d4-a716-446655440001";
const chatRequest = {
  version: 2,
  operation: "message",
  conversationId,
  queryId,
  baseOrdinal: 1,
  text: "Seguimiento.",
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

function completedStream(request = chatRequest) {
  const encoder = new TextEncoder();
  const content = [
    frame("accepted", {
      conversationId: request.conversationId,
      queryId: request.queryId,
      ordinal: request.baseOrdinal + 1,
    }),
    frame("text", { queryId: request.queryId, index: 0, text: "Respuesta" }),
    frame("completed", { queryId: request.queryId }),
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

function cognitoError(code, status = 400) {
  return new Response(JSON.stringify({ __type: code }), {
    status,
    headers: { "content-type": "application/json" },
  });
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
        return completedStream(JSON.parse(init.body));
      });
    vi.stubGlobal("fetch", runtimeFetch);

    const onEvent = vi.fn();
    const chat = streamChat(config, session, chatRequest, { isActive: () => true, onEvent });
    await refreshStarted.promise;

    const routeInitialization = session.restore();
    expect(
      cognitoRequests.filter(({ body }) => body.AuthFlow === "REFRESH_TOKEN_AUTH"),
    ).toHaveLength(1);

    refreshGate.resolve(cognitoResponse("access-2", "id-2", "refresh-2"));
    const [chatResult, routeTokens] = await Promise.all([chat, routeInitialization]);

    expect(chatResult).toMatchObject({ status: "completed", conversationId, queryId, ordinal: 2 });
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
    const chat = streamChat(config, session, chatRequest, {
      isActive: () => session.accessToken() !== null,
      onEvent: vi.fn(),
    });
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

describe("session restoration across password reset and authentication changes", () => {
  it.each(["during", "after"])(
    "keeps a valid refresh when password reset is rejected and the refresh resolves %s it",
    async (resolution) => {
      const storage = new MemorySessionStorage();
      const refreshGate = deferred();
      const refreshStarted = deferred();
      const resetGate = deferred();
      const resetStarted = deferred();
      const session = createSession({
        clientId: config.clientId,
        region: config.region,
        storage,
        fetch: vi.fn(async (_url, init) => {
          const target = targetOf(init);
          const body = cognitoRequest(init);
          if (target.endsWith("ConfirmForgotPassword")) {
            resetStarted.resolve();
            return resetGate.promise;
          }
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

      const restoration = session.restore();
      await refreshStarted.promise;
      const reset = session.confirmPasswordReset("teacher@example.test", "wrong", "password");
      await resetStarted.promise;
      let restorationSettled = false;
      void restoration.then(() => {
        restorationSettled = true;
      });

      if (resolution === "during") {
        const response = cognitoResponse("access-2", "id-2", "refresh-2");
        const responseRead = deferred();
        const readText = response.text.bind(response);
        response.text = async () => {
          const text = await readText();
          responseRead.resolve();
          return text;
        };
        refreshGate.resolve(response);
        await responseRead.promise;
        await new Promise((resolve) => setImmediate(resolve));
        expect(restorationSettled).toBe(false);
        expect(session.accessToken()).toBe("access-1");
      } else {
        resetGate.resolve(cognitoError("CodeMismatchException"));
      }

      if (resolution === "during") {
        resetGate.resolve(cognitoError("CodeMismatchException"));
      }
      await expect(reset).rejects.toMatchObject({ code: "CodeMismatchException" });
      if (resolution === "after") {
        refreshGate.resolve(cognitoResponse("access-2", "id-2", "refresh-2"));
      }
      await expect(restoration).resolves.toEqual({ accessToken: "access-2", idToken: "id-2" });
      expect(session.accessToken()).toBe("access-2");
      expect(session.idToken()).toBe("id-2");
      expect(storage.getItem("auth-refresh")).toBe("refresh-2");
    },
  );

  it("starts a restore requested during a rejected reset after the reset settles", async () => {
    const storage = new MemorySessionStorage();
    const resetGate = deferred();
    const resetStarted = deferred();
    const refreshStarted = deferred();
    const fetcher = vi.fn(async (_url, init) => {
      const target = targetOf(init);
      const body = cognitoRequest(init);
      if (target.endsWith("ConfirmForgotPassword")) {
        resetStarted.resolve();
        return resetGate.promise;
      }
      if (target.endsWith("InitiateAuth") && body.AuthFlow === "REFRESH_TOKEN_AUTH") {
        refreshStarted.resolve();
        return cognitoResponse("access-restored", "id-restored", "refresh-restored");
      }
      throw new Error(`Unexpected Cognito operation: ${target}`);
    });
    const session = createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch: fetcher,
    });
    storage.setItem("auth-refresh", "refresh-before-reset");

    const reset = session.confirmPasswordReset("teacher@example.test", "wrong", "password");
    await resetStarted.promise;
    const restoration = session.restore();
    expect(fetcher).toHaveBeenCalledTimes(1);
    resetGate.resolve(cognitoError("CodeMismatchException"));

    await expect(reset).rejects.toMatchObject({ code: "CodeMismatchException" });
    await expect(restoration).resolves.toEqual({
      accessToken: "access-restored",
      idToken: "id-restored",
    });
    await refreshStarted.promise;
    expect(storage.getItem("auth-refresh")).toBe("refresh-restored");
  });

  it("shares an existing refresh with a restore that waits through a rejected reset", async () => {
    const storage = new MemorySessionStorage();
    const resetGate = deferred();
    const resetStarted = deferred();
    const refreshGate = deferred();
    const refreshStarted = deferred();
    const fetcher = vi.fn(async (_url, init) => {
      const target = targetOf(init);
      const body = cognitoRequest(init);
      if (target.endsWith("ConfirmForgotPassword")) {
        resetStarted.resolve();
        return resetGate.promise;
      }
      if (target.endsWith("InitiateAuth") && body.AuthFlow === "USER_PASSWORD_AUTH") {
        return cognitoResponse("access-1", "id-1", "refresh-1");
      }
      if (target.endsWith("InitiateAuth") && body.AuthFlow === "REFRESH_TOKEN_AUTH") {
        refreshStarted.resolve();
        return refreshGate.promise;
      }
      throw new Error(`Unexpected Cognito operation: ${target}`);
    });
    const session = createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch: fetcher,
    });
    await session.signIn("teacher@example.test", "password");

    const firstRestore = session.restore();
    await refreshStarted.promise;
    const reset = session.confirmPasswordReset("teacher@example.test", "wrong", "password");
    await resetStarted.promise;
    const restoreDuringReset = session.restore();
    expect(fetcher).toHaveBeenCalledTimes(3);

    resetGate.resolve(cognitoError("CodeMismatchException"));
    await expect(reset).rejects.toMatchObject({ code: "CodeMismatchException" });
    refreshGate.resolve(cognitoResponse("access-2", "id-2", "refresh-2"));

    await expect(Promise.all([firstRestore, restoreDuringReset])).resolves.toEqual([
      { accessToken: "access-2", idToken: "id-2" },
      { accessToken: "access-2", idToken: "id-2" },
    ]);
    expect(
      fetcher.mock.calls.filter(
        ([, init]) => cognitoRequest(init).AuthFlow === "REFRESH_TOKEN_AUTH",
      ),
    ).toHaveLength(1);
  });

  it("does not start a restore waiting on a successful reset or resurrect its old session", async () => {
    const storage = new MemorySessionStorage();
    const resetGate = deferred();
    const resetStarted = deferred();
    const fetcher = vi.fn(async (_url, init) => {
      const target = targetOf(init);
      const body = cognitoRequest(init);
      if (target.endsWith("ConfirmForgotPassword")) {
        resetStarted.resolve();
        return resetGate.promise;
      }
      if (target.endsWith("InitiateAuth") && body.AuthFlow === "USER_PASSWORD_AUTH") {
        return cognitoResponse("access-1", "id-1", "refresh-1");
      }
      if (target.endsWith("InitiateAuth") && body.AuthFlow === "REFRESH_TOKEN_AUTH") {
        return cognitoResponse("late-access", "late-id", "late-refresh");
      }
      throw new Error(`Unexpected Cognito operation: ${target}`);
    });
    const session = createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch: fetcher,
    });
    await session.signIn("teacher@example.test", "password");

    const reset = session.confirmPasswordReset("teacher@example.test", "valid", "password");
    await resetStarted.promise;
    const restoration = session.restore();
    resetGate.resolve(new Response("", { status: 200 }));

    await reset;
    await expect(restoration).resolves.toBeNull();
    expect(session.accessToken()).toBeNull();
    expect(session.idToken()).toBeNull();
    expect(storage.getItem("auth-refresh")).toBeNull();
    expect(
      fetcher.mock.calls.filter(
        ([, init]) => cognitoRequest(init).AuthFlow === "REFRESH_TOKEN_AUTH",
      ),
    ).toHaveLength(0);
  });

  it("rejects a sign-in that was already pending when a reset begins, even if reset is rejected", async () => {
    const storage = new MemorySessionStorage();
    const signInGate = deferred();
    const signInStarted = deferred();
    const resetGate = deferred();
    const resetStarted = deferred();
    const session = createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch: vi.fn(async (_url, init) => {
        const target = targetOf(init);
        if (target.endsWith("InitiateAuth")) {
          signInStarted.resolve();
          return signInGate.promise;
        }
        if (target.endsWith("ConfirmForgotPassword")) {
          resetStarted.resolve();
          return resetGate.promise;
        }
        throw new Error(`Unexpected Cognito operation: ${target}`);
      }),
    });

    const signIn = session.signIn("teacher@example.test", "password");
    await signInStarted.promise;
    const reset = session.confirmPasswordReset("teacher@example.test", "wrong", "password");
    await resetStarted.promise;
    resetGate.resolve(cognitoError("CodeMismatchException"));
    await expect(reset).rejects.toMatchObject({ code: "CodeMismatchException" });
    signInGate.resolve(cognitoResponse("late-access", "late-id", "late-refresh"));

    await expect(signIn).rejects.toMatchObject({ code: "PASSWORD_RESET_IN_PROGRESS" });
    expect(session.accessToken()).toBeNull();
    expect(session.idToken()).toBeNull();
    expect(storage.getItem("auth-refresh")).toBeNull();
  });

  it("rejects a sign-in begun while password reset is pending", async () => {
    const storage = new MemorySessionStorage();
    const resetGate = deferred();
    const resetStarted = deferred();
    const fetcher = vi.fn(async (_url, init) => {
      const target = targetOf(init);
      if (target.endsWith("ConfirmForgotPassword")) {
        resetStarted.resolve();
        return resetGate.promise;
      }
      throw new Error(`Unexpected Cognito operation: ${target}`);
    });
    const session = createSession({
      clientId: config.clientId,
      region: config.region,
      storage,
      fetch: fetcher,
    });

    const reset = session.confirmPasswordReset("teacher@example.test", "wrong", "password");
    await resetStarted.promise;
    await expect(session.signIn("teacher@example.test", "password")).rejects.toMatchObject({
      code: "PASSWORD_RESET_IN_PROGRESS",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    resetGate.resolve(cognitoError("CodeMismatchException"));
    await expect(reset).rejects.toMatchObject({ code: "CodeMismatchException" });
  });

  for (const resetPending of [false, true]) {
    it.each(["success", "failure"])(
      `keeps a newer login after logout ${resetPending ? "during a rejected reset" : ""} when the old refresh returns with %s`,
      async (oldRefreshResult) => {
        const storage = new MemorySessionStorage();
        const refreshGate = deferred();
        const refreshStarted = deferred();
        const resetGate = deferred();
        const resetStarted = deferred();
        const session = createSession({
          clientId: config.clientId,
          region: config.region,
          storage,
          fetch: vi.fn(async (_url, init) => {
            const target = targetOf(init);
            const body = cognitoRequest(init);
            if (target.endsWith("RevokeToken")) return new Response("", { status: 200 });
            if (target.endsWith("ConfirmForgotPassword")) {
              resetStarted.resolve();
              return resetGate.promise;
            }
            if (target.endsWith("InitiateAuth") && body.AuthFlow === "USER_PASSWORD_AUTH") {
              return cognitoResponse(
                body.AuthParameters.USERNAME === "new@example.test" ? "access-new" : "access-old",
                body.AuthParameters.USERNAME === "new@example.test" ? "id-new" : "id-old",
                body.AuthParameters.USERNAME === "new@example.test" ? "refresh-new" : "refresh-old",
              );
            }
            if (target.endsWith("InitiateAuth") && body.AuthFlow === "REFRESH_TOKEN_AUTH") {
              refreshStarted.resolve();
              return refreshGate.promise;
            }
            throw new Error(`Unexpected Cognito operation: ${target}`);
          }),
        });
        await session.signIn("old@example.test", "password");

        const oldRestoration = session.restore();
        await refreshStarted.promise;
        let reset;
        if (resetPending) {
          reset = session.confirmPasswordReset("old@example.test", "wrong", "password");
          await resetStarted.promise;
        }
        await session.signOut();
        if (resetPending) {
          resetGate.resolve(cognitoError("CodeMismatchException"));
          await expect(reset).rejects.toMatchObject({ code: "CodeMismatchException" });
        }
        await session.signIn("new@example.test", "password");
        refreshGate.resolve(
          oldRefreshResult === "success"
            ? cognitoResponse("late-access", "late-id", "late-refresh")
            : cognitoError("NotAuthorizedException"),
        );

        await expect(oldRestoration).resolves.toBeNull();
        expect(session.accessToken()).toBe("access-new");
        expect(session.idToken()).toBe("id-new");
        expect(storage.getItem("auth-refresh")).toBe("refresh-new");
      },
    );
  }
});
