import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const sessionPath = path.join(projectRoot, "web/session.ts");

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

function cognitoResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function emptyCognitoResponse() {
  return { ok: true, status: 200, text: async () => "" };
}

function tokens(accessToken, idToken, refreshToken) {
  return cognitoResponse({
    AuthenticationResult: {
      AccessToken: accessToken,
      IdToken: idToken,
      RefreshToken: refreshToken,
    },
  });
}

function targetOf(init) {
  return new Headers(init.headers).get("x-amz-target") || "";
}

function bodyOf(init) {
  return JSON.parse(init.body);
}

async function loadSessionFactory() {
  const { createSession } = await import(pathToFileURL(sessionPath).href);
  return createSession;
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("shared session authentication races", () => {
  it("does not restore an old session after logout", async () => {
    const createSession = await loadSessionFactory();
    const storage = new MemorySessionStorage();
    storage.setItem("auth-refresh", "old-refresh-token");
    const oldRestoreResponse = deferred();
    const fetcher = async (_input, init) => {
      const target = targetOf(init);
      if (target.endsWith("InitiateAuth")) {
        expect(bodyOf(init).AuthFlow).toBe("REFRESH_TOKEN_AUTH");
        return oldRestoreResponse.promise;
      }
      if (target.endsWith("RevokeToken")) return emptyCognitoResponse();
      throw new Error(`Unexpected Cognito operation: ${target}`);
    };
    const session = createSession({
      clientId: "client",
      region: "us-west-2",
      storage,
      fetch: fetcher,
    });

    const oldRestore = session.restore();
    await session.signOut();
    oldRestoreResponse.resolve(
      tokens("old-access-token", "old-id-token", "rotated-old-refresh-token"),
    );

    await expect(oldRestore).resolves.toBeNull();
    expect(session.accessToken()).toBeNull();
    expect(session.idToken()).toBeNull();
    expect(storage.getItem("auth-refresh")).toBeNull();
  });

  it("does not let a pending restore overwrite a later sign-in", async () => {
    const createSession = await loadSessionFactory();
    const storage = new MemorySessionStorage();
    storage.setItem("auth-refresh", "old-refresh-token");
    const oldRestoreResponse = deferred();
    const fetcher = async (_input, init) => {
      const target = targetOf(init);
      if (target.endsWith("InitiateAuth")) {
        if (bodyOf(init).AuthFlow === "REFRESH_TOKEN_AUTH") return oldRestoreResponse.promise;
        return tokens("new-access-token", "new-id-token", "new-refresh-token");
      }
      throw new Error(`Unexpected Cognito operation: ${target}`);
    };
    const session = createSession({
      clientId: "client",
      region: "us-west-2",
      storage,
      fetch: fetcher,
    });

    const oldRestore = session.restore();
    await session.signIn("teacher@example.edu", "new-password");
    oldRestoreResponse.resolve(
      tokens("old-access-token", "old-id-token", "rotated-old-refresh-token"),
    );

    await expect(oldRestore).resolves.toBeNull();
    expect(session.accessToken()).toBe("new-access-token");
    expect(session.idToken()).toBe("new-id-token");
    expect(storage.getItem("auth-refresh")).toBe("new-refresh-token");
  });

  it("preserves the existing session when Cognito rejects password confirmation", async () => {
    const createSession = await loadSessionFactory();
    const storage = new MemorySessionStorage();
    const fetcher = async (_input, init) => {
      const target = targetOf(init);
      if (target.endsWith("InitiateAuth")) {
        return tokens("existing-access-token", "existing-id-token", "existing-refresh-token");
      }
      if (target.endsWith("ConfirmForgotPassword")) {
        return cognitoResponse({ __type: "com.amazonaws.cognito#CodeMismatchException" }, 400);
      }
      throw new Error(`Unexpected Cognito operation: ${target}`);
    };
    const session = createSession({
      clientId: "client",
      region: "us-west-2",
      storage,
      fetch: fetcher,
    });
    await session.signIn("teacher@example.edu", "existing-password");

    await expect(
      session.confirmPasswordReset("teacher@example.edu", "wrong-code", "new-password"),
    ).rejects.toMatchObject({ code: "CodeMismatchException" });

    expect(session.accessToken()).toBe("existing-access-token");
    expect(session.idToken()).toBe("existing-id-token");
    expect(storage.getItem("auth-refresh")).toBe("existing-refresh-token");
  });
});
