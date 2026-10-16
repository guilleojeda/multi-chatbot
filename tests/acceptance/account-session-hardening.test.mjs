import { describe, expect, it } from "vitest";
import { invitationAcceptFailureState } from "../../web/AccountApp.tsx";
import { createSession } from "../../web/session.ts";

class MemorySessionStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
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
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("session boundary hardening", () => {
  it("moves a partially activated invitation to sign-in and reinspects uncertain accepts", () => {
    const signInRequired = invitationAcceptFailureState({
      kind: "new",
      code: "SIGN_IN_REQUIRED",
      status: 409,
      email: "teacher@example.edu",
      projectName: "Asistente para docentes",
    });
    expect(signInRequired).toMatchObject({
      view: "invite-existing",
      email: "teacher@example.edu",
    });

    const uncertain = invitationAcceptFailureState({
      kind: "new",
      code: "TRY_AGAIN",
      status: 503,
      email: "teacher@example.edu",
      projectName: "Asistente para docentes",
    });
    expect(uncertain).toMatchObject({
      view: "denied",
      email: "teacher@example.edu",
      retryable: true,
    });
  });

  it("does not restore a prior identity after a failed sign-in", async () => {
    const storage = new MemorySessionStorage([
      ["unrelated", "keep-me"],
      ["auth-refresh", "previous-user-refresh-token"],
    ]);
    const session = createSession({
      clientId: "public-client",
      region: "us-east-1",
      storage,
      fetch: async () => jsonResponse({ __type: "NotAuthorizedException" }, 400),
    });

    await expect(session.signIn("teacher@example.edu", "wrong-password")).rejects.toThrow();

    expect(session.accessToken()).toBeNull();
    expect(storage.getItem("auth-refresh")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep-me");
  });

  it("sends password whitespace to Cognito unchanged", async () => {
    const storage = new MemorySessionStorage();
    let requestBody;
    const session = createSession({
      clientId: "public-client",
      region: "us-east-1",
      storage,
      fetch: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return jsonResponse({
          AuthenticationResult: {
            AccessToken: "access-token",
            IdToken: "id-token",
            RefreshToken: "refresh-token",
          },
        });
      },
    });

    await session.signIn("teacher@example.edu", " leading-space ");

    expect(requestBody.AuthParameters.PASSWORD).toBe(" leading-space ");
  });

  it("rejects malformed Cognito token fields instead of creating a session", async () => {
    const storage = new MemorySessionStorage();
    const session = createSession({
      clientId: "public-client",
      region: "us-east-1",
      storage,
      fetch: async () =>
        jsonResponse({
          AuthenticationResult: {
            AccessToken: 42,
            IdToken: "id-token",
            RefreshToken: "refresh-token",
          },
        }),
    });

    await expect(session.signIn("teacher@example.edu", "password")).rejects.toThrow();

    expect(session.accessToken()).toBeNull();
    expect(session.idToken()).toBeNull();
    expect(storage.getItem("auth-refresh")).toBeNull();
  });
});
