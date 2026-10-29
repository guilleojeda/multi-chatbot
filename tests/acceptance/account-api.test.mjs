import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const handlerPath = path.join(projectRoot, "api/account.ts");
const fixedNow = Date.parse("2026-10-16T12:00:00.000Z");
const defaultToken = "acceptance-invitation-token";
const defaultAccessToken = "matching-access-token";

let createAccountHandler;

function invitationHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function responseBody(response) {
  if (typeof response.body === "string") return JSON.parse(response.body);
  return response.body ?? {};
}

function createEvent(method, route, body, bearerToken, claims) {
  const headers = { "content-type": "application/json" };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

  const requestContext = { http: { method, path: route } };
  if (claims) requestContext.authorizer = { jwt: { claims } };

  return {
    version: "2.0",
    routeKey: `${method} ${route}`,
    rawPath: route,
    headers,
    requestContext,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

async function request(handler, method, route, body, bearerToken, claims) {
  return handler(createEvent(method, route, body, bearerToken, claims));
}

function makeHarness({
  botId = "bot-aurora",
  invitationToken = defaultToken,
  invitationBotId = botId,
  invitationSub = "user-123",
  invitationEmail = "teacher@example.test",
  expiresAt = fixedNow + 60_000,
  usedAt = null,
  reservation = false,
  user = {
    sub: invitationSub,
    email: invitationEmail,
    emailVerified: false,
    status: "FORCE_CHANGE_PASSWORD",
  },
  members = [],
  callers = {
    [defaultAccessToken]: {
      sub: "user-123",
      email: "teacher@example.test",
      token_use: "access",
    },
  },
  passwordFailure,
  verificationFailure,
} = {}) {
  const state = {
    invitation: {
      id: "invite-1",
      botId: invitationBotId,
      sub: invitationSub,
      email: invitationEmail,
      expiresAt,
      usedAt,
      reserved: reservation,
    },
    user: { ...user },
    members: new Set(members.map(({ sub, botId: memberBotId }) => `${sub}:${memberBotId}`)),
    callers: new Map(Object.entries(callers)),
    passwordFailure,
    verificationFailure,
    calls: [],
  };

  const identity = {
    async getUserByEmail(email) {
      state.calls.push(["getUserByEmail", email]);
      if (email.toLowerCase() !== state.user.email.toLowerCase()) return null;
      return { ...state.user };
    },
    async getCaller(accessToken) {
      state.calls.push(["getCaller", accessToken]);
      const caller = state.callers.get(accessToken);
      return caller ? { ...caller } : null;
    },
    async setPermanentPassword({ sub, password }) {
      state.calls.push(["setPermanentPassword", sub, password]);
      if (state.passwordFailure) {
        const failure = state.passwordFailure;
        state.passwordFailure = undefined;
        throw failure;
      }
      if (state.user.sub !== sub) throw new Error("Unexpected user sub");
      state.user.status = "CONFIRMED";
      state.user.password = password;
    },
    async markEmailVerified({ sub, email }) {
      state.calls.push(["markEmailVerified", sub, email]);
      if (state.user.sub !== sub) throw new Error("Unexpected user sub");
      if (state.verificationFailure) {
        const failure = state.verificationFailure;
        state.verificationFailure = undefined;
        throw failure;
      }
      state.user.email = email;
      state.user.emailVerified = true;
    },
  };

  const store = {
    async getInvitation(tokenHash) {
      state.calls.push(["getInvitation", tokenHash]);
      if (tokenHash !== invitationHash(invitationToken)) return null;
      return { ...state.invitation };
    },
    async reserveInvitation({ invitationId, sub, botId: requestedBotId }) {
      state.calls.push(["reserveInvitation", invitationId, sub, requestedBotId]);
      if (
        state.invitation.id !== invitationId ||
        state.invitation.sub !== sub ||
        state.invitation.botId !== requestedBotId ||
        state.invitation.usedAt ||
        state.invitation.reserved
      ) {
        return false;
      }
      state.invitation.reserved = true;
      return true;
    },
    async releaseInvitation({ invitationId, sub, botId: requestedBotId }) {
      state.calls.push(["releaseInvitation", invitationId, sub, requestedBotId]);
      if (
        state.invitation.id === invitationId &&
        state.invitation.sub === sub &&
        state.invitation.botId === requestedBotId &&
        !state.invitation.usedAt
      ) {
        state.invitation.reserved = false;
      }
    },
    async useInvitationAndAddMember({ invitationId, sub, botId: requestedBotId }) {
      state.calls.push(["useInvitationAndAddMember", invitationId, sub, requestedBotId]);
      if (
        state.invitation.id !== invitationId ||
        state.invitation.sub !== sub ||
        state.invitation.botId !== requestedBotId ||
        state.invitation.usedAt ||
        !state.invitation.reserved
      ) {
        return false;
      }
      state.invitation.usedAt = new Date(fixedNow).toISOString();
      state.invitation.reserved = false;
      state.members.add(`${sub}:${requestedBotId}`);
      return true;
    },
    async hasMember({ sub, botId: requestedBotId }) {
      state.calls.push(["hasMember", sub, requestedBotId]);
      return state.members.has(`${sub}:${requestedBotId}`);
    },
  };

  const handler =
    typeof createAccountHandler === "function"
      ? createAccountHandler({ config: { botId }, identity, store, now: () => fixedNow })
      : null;

  return { handler, state };
}

async function inspect(handler, token = defaultToken, extra = {}) {
  return request(handler, "POST", "/api/account/invitations/inspect", { token, ...extra });
}

async function accept(handler, token = defaultToken, extra = {}, bearerToken) {
  return request(
    handler,
    "POST",
    "/api/account/invitations/accept",
    { token, ...extra },
    bearerToken,
  );
}

describe("the public account API", () => {
  const apiIt = it.skipIf(!existsSync(handlerPath));

  beforeAll(async () => {
    // Keep a missing product module as a normal product assertion below, rather than a Vitest
    // static-import resolution error during collection.
    if (existsSync(handlerPath)) {
      const module = await import(pathToFileURL(handlerPath).href);
      createAccountHandler = module.createAccountHandler;
    }
  });

  it("exports the account HTTP handler from the product API module", () => {
    expect(existsSync(handlerPath), "Expected the account API at api/account.ts").toBe(true);
    expect(typeof createAccountHandler, "Expected exported createAccountHandler").toBe("function");
  });

  apiIt("inspects a valid invitation and identifies a new account", async () => {
    const { handler } = makeHarness();

    const response = await inspect(handler);

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toMatchObject({
      kind: "new",
      email: "teacher@example.test",
    });
  });

  apiIt("inspects a valid invitation for an existing account", async () => {
    const { handler } = makeHarness({
      user: {
        sub: "user-123",
        email: "teacher@example.test",
        emailVerified: true,
        status: "CONFIRMED",
      },
    });

    const response = await inspect(handler);

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toMatchObject({
      kind: "existing",
      email: "teacher@example.test",
    });
  });

  apiIt.each([
    ["inspect", () => inspect],
    ["accept", () => accept],
  ])("rejects an invalid token during %s without changing account state", async (_, operation) => {
    const { handler, state } = makeHarness();

    const response = await operation()(handler, "not-a-valid-invitation");

    expect(response.statusCode).toBe(400);
    expect(responseBody(response).code).toBe("INVALID_INVITATION");
    expect(state.user.status).toBe("FORCE_CHANGE_PASSWORD");
    expect(state.members.size).toBe(0);
    expect(state.calls).not.toContainEqual(expect.arrayContaining(["setPermanentPassword"]));
  });

  apiIt.each([
    ["inspect", "/api/account/invitations/inspect", {}],
    ["inspect", "/api/account/invitations/inspect", { token: "" }],
    ["inspect", "/api/account/invitations/inspect", "{malformed json"],
    ["accept", "/api/account/invitations/accept", {}],
    ["accept", "/api/account/invitations/accept", { token: "" }],
    ["accept", "/api/account/invitations/accept", "{malformed json"],
  ])(
    "rejects %s input %j as an invalid invitation without side effects",
    async (_, route, body) => {
      const { handler, state } = makeHarness();

      const response = await request(handler, "POST", route, body);

      expect(response.statusCode).toBe(400);
      expect(responseBody(response).code).toBe("INVALID_INVITATION");
      expect(state.user.status).toBe("FORCE_CHANGE_PASSWORD");
      expect(state.user.emailVerified).toBe(false);
      expect(state.invitation.reserved).toBe(false);
      expect(state.members.size).toBe(0);
      expect(state.calls.map(([name]) => name)).not.toContain("setPermanentPassword");
      expect(state.calls.map(([name]) => name)).not.toContain("markEmailVerified");
    },
  );

  apiIt.each([
    ["inspect", () => inspect],
    ["accept", () => accept],
  ])("rejects an expired token during %s", async (_, operation) => {
    const { handler, state } = makeHarness({ expiresAt: fixedNow - 1 });

    const response = await operation()(handler);

    expect(response.statusCode).toBe(410);
    expect(responseBody(response).code).toBe("INVITATION_EXPIRED");
    expect(state.members.size).toBe(0);
    expect(state.calls).not.toContainEqual(expect.arrayContaining(["setPermanentPassword"]));
  });

  apiIt.each([
    ["inspect", () => inspect],
    ["accept", () => accept],
  ])("rejects a consumed token during %s", async (_, operation) => {
    const { handler, state } = makeHarness({ usedAt: new Date(fixedNow - 1).toISOString() });

    const response = await operation()(handler);

    expect(response.statusCode).toBe(409);
    expect(responseBody(response).code).toBe("INVITATION_USED");
    expect(state.members.size).toBe(0);
    expect(state.calls).not.toContainEqual(expect.arrayContaining(["setPermanentPassword"]));
  });

  apiIt(
    "sets a new user's password, verifies the invited email, and grants only the bound membership",
    async () => {
      const { handler, state } = makeHarness();

      const response = await accept(handler, defaultToken, { password: "Correct-Horse-42!" });

      expect(response.statusCode).toBe(200);
      expect(responseBody(response)).toMatchObject({ status: "accepted" });
      expect(state.user.status).toBe("CONFIRMED");
      expect(state.user.password).toBe("Correct-Horse-42!");
      expect(state.user.emailVerified).toBe(true);
      expect(state.members).toEqual(new Set(["user-123:bot-aurora"]));
      expect(state.calls).toContainEqual(["setPermanentPassword", "user-123", "Correct-Horse-42!"]);
      expect(state.calls).toContainEqual(["markEmailVerified", "user-123", "teacher@example.test"]);
      expect(state.calls).toContainEqual([
        "useInvitationAndAddMember",
        "invite-1",
        "user-123",
        "bot-aurora",
      ]);
    },
  );

  apiIt(
    "does not grant membership when Cognito rejects the proposed password and permits a corrected retry",
    async () => {
      const passwordPolicyError = new Error("Password does not meet policy");
      passwordPolicyError.name = "InvalidPasswordException";
      const { handler, state } = makeHarness({ passwordFailure: passwordPolicyError });

      const rejected = await accept(handler, defaultToken, { password: "weak" });

      expect(rejected.statusCode).toBe(400);
      expect(responseBody(rejected).code).toBe("INVALID_PASSWORD");
      expect(state.user.status).toBe("FORCE_CHANGE_PASSWORD");
      expect(state.user.emailVerified).toBe(false);
      expect(state.members.size).toBe(0);
      expect(state.invitation.reserved).toBe(false);

      const retried = await accept(handler, defaultToken, { password: "Correct-Horse-42!" });

      expect(retried.statusCode).toBe(200);
      expect(state.members).toEqual(new Set(["user-123:bot-aurora"]));
    },
  );

  apiIt(
    "keeps a partial activation reserved after email-verification failure and lets only its owner finish",
    async () => {
      const emailVerificationFailure = new Error(
        `Cognito diagnostic exposed password secret-value and token ${defaultToken}`,
      );
      const { handler, state } = makeHarness({ verificationFailure: emailVerificationFailure });

      const failed = await accept(handler, defaultToken, { password: "secret-value" });

      expect(failed.statusCode).toBe(503);
      expect(responseBody(failed).code).toBe("TRY_AGAIN");
      expect(JSON.stringify(responseBody(failed))).not.toContain("Cognito");
      expect(JSON.stringify(responseBody(failed))).not.toContain("secret-value");
      expect(JSON.stringify(responseBody(failed))).not.toContain(defaultToken);
      expect(state.user.status).toBe("CONFIRMED");
      expect(state.user.password).toBe("secret-value");
      expect(state.user.emailVerified).toBe(false);
      expect(state.invitation.reserved).toBe(true);
      expect(state.members.size).toBe(0);

      const unauthenticatedRetry = await accept(handler, defaultToken, {
        password: "attacker-secret",
      });

      expect(unauthenticatedRetry.statusCode).toBe(409);
      expect(responseBody(unauthenticatedRetry).code).toBe("SIGN_IN_REQUIRED");
      expect(state.user.password).toBe("secret-value");
      expect(state.calls.filter(([name]) => name === "setPermanentPassword")).toHaveLength(1);

      const authenticatedRetry = await accept(handler, defaultToken, {}, defaultAccessToken);

      expect(authenticatedRetry.statusCode).toBe(200);
      expect(state.user.emailVerified).toBe(true);
      expect(state.user.password).toBe("secret-value");
      expect(state.members).toEqual(new Set(["user-123:bot-aurora"]));
      expect(state.calls.filter(([name]) => name === "setPermanentPassword")).toHaveLength(1);
    },
  );

  apiIt(
    "requires the matching signed-in account for an existing user and never resets its password",
    async () => {
      const { handler, state } = makeHarness({
        user: {
          sub: "user-123",
          email: "teacher@example.test",
          emailVerified: true,
          status: "CONFIRMED",
          password: "existing-secret",
        },
      });

      const unauthenticated = await accept(handler, defaultToken, { password: "attacker-secret" });
      expect(unauthenticated.statusCode).toBe(409);
      expect(responseBody(unauthenticated).code).toBe("SIGN_IN_REQUIRED");
      expect(state.members.size).toBe(0);
      expect(state.calls.map(([name]) => name)).not.toContain("setPermanentPassword");

      const accepted = await accept(
        handler,
        defaultToken,
        { password: "attacker-secret" },
        defaultAccessToken,
      );

      expect(accepted.statusCode).toBe(200);
      expect(state.members).toEqual(new Set(["user-123:bot-aurora"]));
      expect(state.user.password).toBe("existing-secret");
      expect(state.calls.map(([name]) => name)).not.toContain("setPermanentPassword");
    },
  );

  apiIt(
    "accepts matching email claims without case sensitivity and verifies email by invitation",
    async () => {
      const existingUser = {
        sub: "user-123",
        email: "Teacher@Example.Test",
        emailVerified: false,
        status: "CONFIRMED",
        password: "existing-secret",
      };
      const { handler, state } = makeHarness({
        invitationEmail: "teacher@example.test",
        user: existingUser,
        callers: {
          [defaultAccessToken]: {
            sub: "user-123",
            email: "TEACHER@example.test",
            token_use: "access",
          },
        },
      });

      const response = await accept(handler, defaultToken, {}, defaultAccessToken);

      expect(response.statusCode).toBe(200);
      expect(state.user.emailVerified).toBe(true);
      expect(state.user.password).toBe("existing-secret");
      expect(state.members).toEqual(new Set(["user-123:bot-aurora"]));
      expect(state.calls.map(([name]) => name)).not.toContain("setPermanentPassword");
    },
  );

  apiIt(
    "rejects a different identity before changing password, verification, or membership",
    async () => {
      const { handler, state } = makeHarness({
        callers: {
          [defaultAccessToken]: {
            sub: "different-sub",
            email: "teacher@example.test",
            token_use: "access",
          },
        },
      });

      const response = await accept(
        handler,
        defaultToken,
        { password: "Correct-Horse-42!" },
        defaultAccessToken,
      );

      expect(response.statusCode).toBe(403);
      expect(state.user.status).toBe("FORCE_CHANGE_PASSWORD");
      expect(state.user.emailVerified).toBe(false);
      expect(state.members.size).toBe(0);
      expect(state.calls.map(([name]) => name)).not.toContain("setPermanentPassword");
    },
  );

  apiIt("rejects an authenticated sub whose email differs from the invitation", async () => {
    const { handler, state } = makeHarness({
      callers: {
        [defaultAccessToken]: {
          sub: "user-123",
          email: "attacker@example.test",
          token_use: "access",
        },
      },
    });

    const response = await accept(
      handler,
      defaultToken,
      { password: "Correct-Horse-42!" },
      defaultAccessToken,
    );

    expect(response.statusCode).toBe(403);
    expect(responseBody(response).code).toBe("FORBIDDEN");
    expect(state.user.status).toBe("FORCE_CHANGE_PASSWORD");
    expect(state.user.emailVerified).toBe(false);
    expect(state.members.size).toBe(0);
    expect(state.calls.map(([name]) => name)).not.toContain("setPermanentPassword");
  });

  apiIt("rejects a Cognito email lookup whose sub differs from the invitation", async () => {
    const { handler, state } = makeHarness({
      user: {
        sub: "different-sub",
        email: "teacher@example.test",
        emailVerified: false,
        status: "FORCE_CHANGE_PASSWORD",
      },
    });

    const response = await accept(handler, defaultToken, { password: "Correct-Horse-42!" });

    expect(response.statusCode).toBe(403);
    expect(state.user.status).toBe("FORCE_CHANGE_PASSWORD");
    expect(state.members.size).toBe(0);
    expect(state.calls.map(([name]) => name)).not.toContain("setPermanentPassword");
  });

  apiIt(
    "requires a matching login to finish a reserved invitation after account activation",
    async () => {
      const { handler, state } = makeHarness({
        reservation: true,
        user: {
          sub: "user-123",
          email: "teacher@example.test",
          emailVerified: true,
          status: "CONFIRMED",
          password: "already-set-secret",
        },
      });

      const unauthenticated = await accept(handler, defaultToken, {
        password: "new-attacker-secret",
      });

      expect(unauthenticated.statusCode).toBe(409);
      expect(state.members.size).toBe(0);
      expect(state.user.password).toBe("already-set-secret");
      expect(state.calls.map(([name]) => name)).not.toContain("setPermanentPassword");

      const retried = await accept(handler, defaultToken, {}, defaultAccessToken);

      expect(retried.statusCode).toBe(200);
      expect(state.members).toEqual(new Set(["user-123:bot-aurora"]));
      expect(state.user.password).toBe("already-set-secret");
    },
  );

  apiIt(
    "serializes concurrent redemption so one request sets the password and membership",
    async () => {
      const { handler, state } = makeHarness();

      const responses = await Promise.all([
        accept(handler, defaultToken, { password: "First-Password-42!" }),
        accept(handler, defaultToken, { password: "Second-Password-42!" }),
      ]);

      expect(responses.filter(({ statusCode }) => statusCode === 200)).toHaveLength(1);
      expect(responses.filter(({ statusCode }) => statusCode !== 200)).toHaveLength(1);
      expect(state.calls.filter(([name]) => name === "setPermanentPassword")).toHaveLength(1);
      expect(state.members).toEqual(new Set(["user-123:bot-aurora"]));
      expect(state.user.password).toMatch(/^(First|Second)-Password-42!$/);
    },
  );

  apiIt(
    "rejects replay after successful redemption without changing an active password",
    async () => {
      const { handler, state } = makeHarness();
      const first = await accept(handler, defaultToken, { password: "First-Password-42!" });
      const passwordAfterFirstUse = state.user.password;

      const replay = await accept(handler, defaultToken, { password: "Replay-Password-42!" });

      expect(first.statusCode).toBe(200);
      expect(replay.statusCode).toBe(409);
      expect(state.calls.filter(([name]) => name === "setPermanentPassword")).toHaveLength(1);
      expect(state.user.password).toBe(passwordAfterFirstUse);
      expect(state.members).toEqual(new Set(["user-123:bot-aurora"]));
    },
  );

  apiIt(
    "forbids an authenticated caller whose supplied identity fields conflict with the invitation",
    async () => {
      const attackerToken = "attacker-access-token";
      const { handler, state } = makeHarness({
        user: {
          sub: "user-123",
          email: "teacher@example.test",
          emailVerified: true,
          status: "CONFIRMED",
          password: "existing-secret",
        },
        callers: {
          [attackerToken]: {
            sub: "attacker-sub",
            email: "attacker@example.test",
            token_use: "access",
          },
        },
      });

      const response = await accept(
        handler,
        defaultToken,
        {
          password: "Correct-Horse-42!",
          sub: "attacker-sub",
          email: "attacker@example.test",
          botId: "bot-other",
        },
        attackerToken,
      );

      expect(response.statusCode).toBe(403);
      expect(responseBody(response).code).toBe("FORBIDDEN");
      expect(state.members.size).toBe(0);
      expect(state.calls.map(([name]) => name)).not.toContain("setPermanentPassword");
    },
  );

  apiIt("rejects an invitation bound to a different chatbot", async () => {
    const { handler, state } = makeHarness({ invitationBotId: "bot-brisa" });

    const response = await accept(handler, defaultToken, { password: "Correct-Horse-42!" });

    expect(response.statusCode).toBe(403);
    expect(responseBody(response).code).toBe("FORBIDDEN");
    expect(state.members.size).toBe(0);
    expect(state.calls.map(([name]) => name)).not.toContain("setPermanentPassword");
  });

  apiIt.each([
    ["missing authorizer claims", "arbitrary-header-token", undefined],
    ["an ID token", "matching-access-token", { sub: "user-123", token_use: "id" }],
    ["claims without a subject", "matching-access-token", { token_use: "access" }],
  ])("protects /account/me from %s", async (_, bearerToken, claims) => {
    const { handler, state } = makeHarness();

    const response = await request(
      handler,
      "GET",
      "/api/account/me",
      undefined,
      bearerToken,
      claims,
    );

    expect(response.statusCode).toBe(401);
    expect(responseBody(response).code).toBe("UNAUTHORIZED");
    expect(state.calls.map(([name]) => name)).not.toContain("hasMember");
    expect(state.calls.map(([name]) => name)).not.toContain("getCaller");
  });

  apiIt(
    "returns the authorized member using access-token claims and server-side membership",
    async () => {
      const { handler, state } = makeHarness({
        members: [{ sub: "user-123", botId: "bot-aurora" }],
      });

      const response = await request(handler, "GET", "/api/account/me", undefined, undefined, {
        sub: "user-123",
        token_use: "access",
      });

      expect(response.statusCode).toBe(200);
      expect(responseBody(response)).toMatchObject({
        sub: "user-123",
        botId: "bot-aurora",
      });
      expect(state.calls.map(([name]) => name)).not.toContain("getCaller");
    },
  );

  apiIt("denies /account/me when the identity has membership only in another chatbot", async () => {
    const { handler, state } = makeHarness({
      members: [{ sub: "user-123", botId: "bot-brisa" }],
    });

    const response = await request(handler, "GET", "/api/account/me", undefined, undefined, {
      sub: "user-123",
      token_use: "access",
    });

    expect(response.statusCode).toBe(403);
    expect(state.calls).toContainEqual(["hasMember", "user-123", "bot-aurora"]);
  });
});
