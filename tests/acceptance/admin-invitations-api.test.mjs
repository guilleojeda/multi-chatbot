import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createAccountHandler } from "../../api/account.ts";
import { createAccountStoreAdapter } from "../../api/aws-adapters.ts";
import { provisionInvitation } from "../../api/invitations.ts";
import { createPhase9AccountTransport } from "../support/phase9-account-transport.mjs";

const now = Date.parse("2026-11-11T15:00:00.000Z");
const ttl = 7 * 24 * 60 * 60 * 1000;
const botId = "docentes";
const tableName = "account-docentes";
const adminClientId = "admin-client";
const adminGroup = "global-admin";
const adminSub = "admin-sub";
const adminToken = "valid-admin-access-token";
const accountToken = "valid-account-access-token";
const invitedEmail = "teacher@example.test";

let createAdminHandler;

beforeAll(async () => {
  ({ createAdminHandler } = await import("../../api/admin.ts"));
  expect(typeof createAdminHandler, "Expected the public admin HTTP factory").toBe("function");
  expect(typeof provisionInvitation, "Expected the production invitation orchestrator").toBe(
    "function",
  );
});

function bodyOf(response) {
  return typeof response.body === "string" ? JSON.parse(response.body) : (response.body ?? {});
}

function claims({
  sub = adminSub,
  tokenUse = "access",
  clientId = adminClientId,
  groups = [adminGroup],
} = {}) {
  return {
    sub,
    token_use: tokenUse,
    client_id: clientId,
    "cognito:groups": groups,
  };
}

function event(method, path, body, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? adminToken}`;
  const requestContext = { http: { method, path } };
  if (options.claims !== null) {
    requestContext.authorizer = { jwt: { claims: options.claims ?? claims() } };
  }
  return {
    version: "2.0",
    rawPath: path,
    headers,
    requestContext,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function adminRequest(handler, method, path, body, options) {
  return handler(event(method, path, body, options));
}

function makeAccess(sub, state = "none", revision = 0, currentInvitation, projectId = botId) {
  return {
    sub,
    botId: projectId,
    access: state,
    revision,
    ...(currentInvitation ? { currentInvitation } : {}),
  };
}

function invitationKey(hash) {
  return { pk: `INVITE#${hash}`, sk: "INVITATION" };
}

function makeInvitation({
  sub = "teacher-sub",
  email = invitedEmail,
  hash = "a".repeat(64),
  expiresAt = now + ttl,
  operationId = "operation-1",
  delivery = { status: "unconfirmed" },
  projectId = botId,
} = {}) {
  return {
    id: hash,
    tokenHash: hash,
    sub,
    botId: projectId,
    email,
    expiresAt,
    operationId,
    delivery,
  };
}

function makeStore(overrides = {}, projectId = botId) {
  const invitation = makeInvitation();
  const store = {
    getAccess: vi.fn(async () => makeAccess("teacher-sub", "none", 0, undefined, projectId)),
    getInvitation: vi.fn(async () => invitation),
    registerInvitation: vi.fn(async (input) => ({
      access: makeAccess(
        input.sub,
        "none",
        input.expectedRevision + 1,
        { hash: input.tokenHash, expiresAt: input.expiresAt },
        input.botId,
      ),
      invitation: makeInvitation({
        ...input,
        hash: input.tokenHash,
        projectId: input.botId,
        delivery: { status: "unconfirmed" },
      }),
      created: true,
    })),
    revokeAccess: vi.fn(async (input) => ({
      access: makeAccess(input.sub, "revoked", input.expectedRevision + 1),
      created: true,
    })),
    recordInvitationDelivery: vi.fn(async () => undefined),
    reserveActivation: vi.fn(async () => true),
    releaseActivation: vi.fn(async () => undefined),
    consumeInvitation: vi.fn(async () => true),
  };
  return Object.assign(store, overrides);
}

function makeIdentity({ caller = { sub: adminSub, token_use: "access" }, user = null } = {}) {
  const state = { user: user ? { ...user } : null, calls: [] };
  const identity = {
    getCaller: vi.fn(async (token) => {
      state.calls.push(["getCaller", token]);
      if (token === adminToken) return caller;
      if (token === accountToken && state.user) {
        return {
          sub: state.user.sub,
          email: state.user.email,
          token_use: "access",
        };
      }
      return null;
    }),
    getUserByEmail: vi.fn(async (email) => {
      state.calls.push(["getUserByEmail", email]);
      return state.user?.email.toLowerCase() === email.toLowerCase() ? { ...state.user } : null;
    }),
    createUser: vi.fn(async ({ email, messageAction }) => {
      state.calls.push(["createUser", email, messageAction]);
      state.user = {
        sub: "teacher-sub",
        email,
        emailVerified: false,
        status: "FORCE_CHANGE_PASSWORD",
      };
      return { ...state.user };
    }),
    setPermanentPassword: vi.fn(async ({ sub, password }) => {
      state.calls.push(["setPermanentPassword", sub]);
      if (state.user?.sub !== sub) throw new Error("Unexpected invited identity");
      state.user.status = "CONFIRMED";
      state.user.password = password;
    }),
    markEmailVerified: vi.fn(async ({ sub, email }) => {
      state.calls.push(["markEmailVerified", sub]);
      if (state.user?.sub !== sub) throw new Error("Unexpected invited identity");
      state.user.email = email;
      state.user.emailVerified = true;
    }),
  };
  return { identity, state };
}

function makeApi({
  identity = makeIdentity().identity,
  store = makeStore(),
  mail = { sendInvitation: vi.fn(async () => ({ messageId: "ses-message-1" })) },
  nowFn = () => now,
  randomBytes = vi.fn(() => Buffer.alloc(32, 1)),
  bots = [{ botId, projectName: "Docentes", siteUrl: "https://docentes.example.test/" }],
  stores,
} = {}) {
  const config = {
    clientId: adminClientId,
    adminGroup,
    sender: "verified-sender@example.test",
    invitationTtlMs: ttl,
    bots,
  };
  const handler = createAdminHandler({
    config,
    stores: stores || { [botId]: store },
    identity,
    mail,
    now: nowFn,
    randomBytes,
  });
  return { handler, config, identity, store, mail, randomBytes };
}

function makeRealFlow({ user = null, randomBytes, passwordFailureAfterEffect = null } = {}) {
  const transport = createPhase9AccountTransport();
  const store = createAccountStoreAdapter({
    documentClient: transport.documentClient,
    tableName,
    now: () => now,
  });
  const identityState = { user: user ? { ...user } : null, calls: [] };
  const identity = {
    async getCaller(token) {
      identityState.calls.push(["getCaller", token]);
      if (token === adminToken) return { sub: adminSub, token_use: "access" };
      if (token === accountToken && identityState.user) {
        return {
          sub: identityState.user.sub,
          email: identityState.user.email,
          token_use: "access",
        };
      }
      return null;
    },
    async getUserByEmail(email) {
      identityState.calls.push(["getUserByEmail", email]);
      return identityState.user?.email.toLowerCase() === email.toLowerCase()
        ? { ...identityState.user }
        : null;
    },
    async createUser({ email, messageAction }) {
      identityState.calls.push(["createUser", email, messageAction]);
      identityState.user = {
        sub: "teacher-sub",
        email,
        emailVerified: false,
        status: "FORCE_CHANGE_PASSWORD",
      };
      return { ...identityState.user };
    },
    async setPermanentPassword({ sub, password }) {
      identityState.calls.push(["setPermanentPassword", sub]);
      if (identityState.user?.sub !== sub) throw new Error("Unexpected invited identity");
      identityState.user.status = "CONFIRMED";
      identityState.user.password = password;
      if (passwordFailureAfterEffect) {
        const failure = passwordFailureAfterEffect;
        passwordFailureAfterEffect = null;
        throw failure;
      }
    },
    async markEmailVerified({ sub, email }) {
      identityState.calls.push(["markEmailVerified", sub]);
      if (identityState.user?.sub !== sub) throw new Error("Unexpected invited identity");
      identityState.user.email = email;
      identityState.user.emailVerified = true;
    },
  };
  const sent = [];
  const mail = {
    async sendInvitation(input) {
      sent.push(input);
      return { messageId: `ses-message-${sent.length}` };
    },
  };
  const api = makeApi({
    identity,
    store,
    mail,
    randomBytes: randomBytes || vi.fn(() => Buffer.alloc(32, 1)),
  });
  const account = createAccountHandler({
    config: { botId },
    identity,
    store,
    now: () => now,
  });
  return { ...api, account, identityState, sent, store, transport };
}

function accountEvent(method, path, body, token = accountToken, sub = "teacher-sub") {
  return event(method, path, body, {
    token,
    claims: claims({ sub, clientId: "chat-client", groups: [] }),
  });
}

async function invite(
  handler,
  {
    email = invitedEmail,
    expectedSub = null,
    expectedRevision = 0,
    operationId = "operation-1",
    bot = botId,
  } = {},
) {
  return handler(
    event("POST", `/api/admin/bots/${bot}/invitations`, {
      email,
      expectedSub,
      expectedRevision,
      operationId,
    }),
  );
}

async function revoke(
  handler,
  {
    email = invitedEmail,
    expectedSub = "teacher-sub",
    expectedRevision = 0,
    operationId = "revoke-operation-1",
    bot = botId,
  } = {},
) {
  return handler(
    event("POST", `/api/admin/bots/${bot}/access/revoke`, {
      email,
      expectedSub,
      expectedRevision,
      operationId,
    }),
  );
}

function invitationToken(url) {
  const parsed = new URL(url);
  const query = parsed.hash.split("?")[1] || "";
  return new URLSearchParams(query).get("token");
}

function isLegacyAccessItem(item) {
  return (
    item.pk.includes("MEMBER#") || item.sk.startsWith("MEMBER#") || item.sk === "PENDING_INVITATION"
  );
}

describe("the public global-admin invitation API", () => {
  it("returns the authenticated admin subject from the session route", async () => {
    const api = makeApi();

    const response = await adminRequest(api.handler, "GET", "/api/admin/me");

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({ sub: adminSub });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it.each([
    ["a missing access identity", { token: null, claims: null }, 401],
    ["a token for another app client", { claims: claims({ clientId: "chat-client" }) }, 403],
    ["a token without the global-admin group", { claims: claims({ groups: [] }) }, 403],
    ["a similar group name", { claims: claims({ groups: [`${adminGroup}-other`] }) }, 403],
    ["an ID token", { claims: claims({ tokenUse: "id" }) }, 403],
  ])("rejects %s before person, store, or email operations", async (_label, options, status) => {
    const store = makeStore();
    const { identity } = makeIdentity();
    const api = makeApi({ identity, store });

    const response = await adminRequest(
      api.handler,
      "POST",
      `/api/admin/bots/${botId}/invitations`,
      {
        email: invitedEmail,
        expectedSub: null,
        expectedRevision: 0,
        operationId: "unauthorized-operation",
        role: adminGroup,
        groups: [adminGroup],
      },
      options,
    );

    expect(response.statusCode).toBe(status);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(identity.getUserByEmail).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(store.getAccess).not.toHaveBeenCalled();
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(api.mail.sendInvitation).not.toHaveBeenCalled();
  });

  it("rejects or ignores client-supplied destinations instead of changing the server catalog", async () => {
    const api = makeApi();
    const response = await adminRequest(
      api.handler,
      "POST",
      `/api/admin/bots/${botId}/invitations`,
      {
        email: invitedEmail,
        expectedSub: null,
        expectedRevision: 0,
        operationId: "configured-destination-only",
        botId: "unconfigured-bot",
        tableName: "unconfigured-account-table",
        siteUrl: "https://unconfigured.example.test",
        sender: "unconfigured@example.test",
      },
    );

    expect([200, 400]).toContain(response.statusCode);
    if (response.statusCode === 400) {
      expect(api.identity.createUser).not.toHaveBeenCalled();
      expect(api.store.registerInvitation).not.toHaveBeenCalled();
      expect(api.mail.sendInvitation).not.toHaveBeenCalled();
      return;
    }
    expect(api.store.registerInvitation).toHaveBeenCalledOnce();
    expect(api.store.registerInvitation.mock.calls[0][0].botId).toBe(botId);
    expect(api.mail.sendInvitation).toHaveBeenCalledOnce();
    const sent = api.mail.sendInvitation.mock.calls[0][0];
    expect(sent.from).toBe("verified-sender@example.test");
    expect(new URL(sent.url).origin).toBe("https://docentes.example.test");
    expect(bodyOf(response).botId).toBe(botId);
  });

  it("returns only the configured catalog and refuses an arbitrary bot before store access", async () => {
    const store = makeStore();
    const api = makeApi({ store });

    const catalog = await adminRequest(api.handler, "GET", "/api/admin/bots");
    const unknown = await adminRequest(
      api.handler,
      "POST",
      "/api/admin/bots/attacker-selected/people/lookup",
      { email: invitedEmail },
    );

    expect(catalog.statusCode).toBe(200);
    expect(bodyOf(catalog)).toEqual({ bots: [{ botId, projectName: "Docentes" }] });
    expect(JSON.stringify(bodyOf(catalog))).not.toMatch(/table|pool|siteUrl|sender|secret|token/i);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers["cache-control"]).toBe("no-store");
    expect(store.getAccess).not.toHaveBeenCalled();
    expect(store.getInvitation).not.toHaveBeenCalled();
  });

  it.each([
    ["email", { email: "not-an-email" }],
    ["operation ID", { operationId: " " }],
    ["observed revision", { expectedRevision: -1 }],
    ["expected subject", { expectedSub: { sub: "teacher-sub" } }],
  ])("rejects invalid %s input before identity or write operations", async (_field, change) => {
    const store = makeStore();
    const { identity } = makeIdentity();
    const randomBytes = vi.fn(() => Buffer.alloc(32, 1));
    const mail = { sendInvitation: vi.fn() };
    const api = makeApi({ identity, store, mail, randomBytes });
    const response = await adminRequest(
      api.handler,
      "POST",
      `/api/admin/bots/${botId}/invitations`,
      {
        email: invitedEmail,
        expectedSub: null,
        expectedRevision: 0,
        operationId: "valid-operation",
        ...change,
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(identity.getUserByEmail).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(mail.sendInvitation).not.toHaveBeenCalled();
    expect(randomBytes).not.toHaveBeenCalled();
  });

  it("looks up an unknown email without creating it, and keeps lookup failures distinct from absence", async () => {
    const { identity } = makeIdentity();
    const store = makeStore();
    const api = makeApi({ identity, store });

    const absent = await adminRequest(
      api.handler,
      "POST",
      `/api/admin/bots/${botId}/people/lookup`,
      { email: ` ${invitedEmail.toUpperCase()} ` },
    );
    identity.getUserByEmail.mockRejectedValueOnce(new Error("Cognito unavailable"));
    const unavailable = await adminRequest(
      api.handler,
      "POST",
      `/api/admin/bots/${botId}/people/lookup`,
      { email: invitedEmail },
    );

    expect(absent.statusCode).toBe(200);
    expect(bodyOf(absent)).toMatchObject({
      botId,
      person: null,
      access: { state: "none", revision: 0 },
    });
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(store.getAccess).not.toHaveBeenCalled();
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.headers["cache-control"]).toBe("no-store");
    expect(bodyOf(unavailable)).toMatchObject({ code: "TRY_AGAIN" });
    expect(bodyOf(unavailable)).not.toHaveProperty("person", null);
  });

  it("returns a known person's invitation delivery without exposing its hash or link", async () => {
    const invitation = makeInvitation({
      hash: "d".repeat(64),
      delivery: { status: "accepted", messageId: "ses-known" },
    });
    const { identity } = makeIdentity({
      user: {
        sub: "teacher-sub",
        email: invitedEmail,
        emailVerified: false,
        status: "FORCE_CHANGE_PASSWORD",
      },
    });
    const store = makeStore({
      getAccess: vi.fn(async () =>
        makeAccess("teacher-sub", "none", 1, {
          hash: invitation.tokenHash,
          expiresAt: invitation.expiresAt,
        }),
      ),
      getInvitation: vi.fn(async (hash) => (hash === invitation.tokenHash ? invitation : null)),
    });
    const api = makeApi({ identity, store });

    const response = await adminRequest(
      api.handler,
      "POST",
      `/api/admin/bots/${botId}/people/lookup`,
      { email: invitedEmail },
    );

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      botId,
      person: { sub: "teacher-sub", email: invitedEmail },
      access: { state: "none", revision: 1 },
      invitation: {
        expiresAt: invitation.expiresAt,
        delivery: { status: "accepted", messageId: "ses-known" },
      },
    });
    expect(store.getInvitation).toHaveBeenCalledExactlyOnceWith(invitation.tokenHash);
    expect(JSON.stringify(bodyOf(response))).not.toContain(invitation.tokenHash);
    expect(JSON.stringify(bodyOf(response))).not.toMatch(/https:\/\//i);
  });

  it("does not apply a stale or mismatched identity to a new invitation", async () => {
    const { identity } = makeIdentity({
      user: {
        sub: "different-sub",
        email: invitedEmail,
        emailVerified: true,
        status: "CONFIRMED",
      },
    });
    const store = makeStore();
    const api = makeApi({ identity, store });

    const response = await invite(api.handler, {
      expectedSub: "observed-sub",
      expectedRevision: 4,
    });

    expect(response.statusCode).toBe(409);
    expect(bodyOf(response)).toMatchObject({ code: "STATE_CHANGED" });
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(api.mail.sendInvitation).not.toHaveBeenCalled();
  });

  it("treats a Cognito email mismatch as changed state rather than as a new person", async () => {
    const { identity } = makeIdentity({
      user: {
        sub: "teacher-sub",
        email: "renamed@example.test",
        emailVerified: true,
        status: "CONFIRMED",
      },
    });
    identity.getUserByEmail.mockResolvedValue({
      sub: "teacher-sub",
      email: "renamed@example.test",
      emailVerified: true,
      status: "CONFIRMED",
    });
    const store = makeStore();
    const api = makeApi({ identity, store });

    const response = await invite(api.handler, { expectedSub: null });

    expect(response.statusCode).toBe(409);
    expect(bodyOf(response)).toMatchObject({ code: "STATE_CHANGED" });
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(api.mail.sendInvitation).not.toHaveBeenCalled();
  });

  it("invites a new Cognito identity through the configured bot and exposes no token or destination", async () => {
    const { identity } = makeIdentity();
    const store = makeStore();
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
    const randomBytes = vi.fn(() => bytes);
    const mail = { sendInvitation: vi.fn(async () => ({ messageId: "ses-accepted-1" })) };
    const api = makeApi({ identity, store, mail, randomBytes });

    const response = await invite(api.handler);

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      botId,
      person: { sub: "teacher-sub", email: invitedEmail },
      access: { state: "none", revision: 1 },
      invitation: {
        expiresAt: now + ttl,
        delivery: { status: "accepted", messageId: "ses-accepted-1" },
      },
      operation: { id: "operation-1", status: "recorded" },
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(identity.createUser).toHaveBeenCalledExactlyOnceWith({
      email: invitedEmail,
      messageAction: "SUPPRESS",
    });
    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(store.registerInvitation).toHaveBeenCalledOnce();
    const registered = store.registerInvitation.mock.calls[0][0];
    const token = bytes.toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    expect(registered).toMatchObject({
      botId,
      sub: "teacher-sub",
      email: invitedEmail,
      tokenHash: hash,
      expiresAt: now + ttl,
      expectedRevision: 0,
      operationId: "operation-1",
    });
    expect(mail.sendInvitation).toHaveBeenCalledOnce();
    expect(mail.sendInvitation.mock.calls[0][0]).toMatchObject({
      from: "verified-sender@example.test",
      to: invitedEmail,
      projectName: "Docentes",
      expiresAt: now + ttl,
    });
    expect(new URL(mail.sendInvitation.mock.calls[0][0].url).origin).toBe(
      "https://docentes.example.test",
    );
    expect(JSON.stringify(registered)).not.toContain(token);
    expect(JSON.stringify(bodyOf(response))).not.toContain(token);
    expect(JSON.stringify(bodyOf(response))).not.toContain(hash);
    expect(JSON.stringify(bodyOf(response))).not.toContain("https://docentes.example.test");
    expect(JSON.stringify(bodyOf(response))).not.toMatch(/tableName|poolId|sender|siteUrl/i);
  });

  it("uses the selected configured bot's store and invitation URL without mixing its data", async () => {
    const secondBotId = "fixture-second-bot";
    const docentStore = makeStore();
    const secondStore = makeStore({}, secondBotId);
    const { identity } = makeIdentity();
    const mail = { sendInvitation: vi.fn(async () => ({ messageId: "ses-second-bot" })) };
    const api = makeApi({
      identity,
      store: docentStore,
      stores: { [botId]: docentStore, [secondBotId]: secondStore },
      bots: [
        { botId, projectName: "Docentes", siteUrl: "https://docentes.example.test/" },
        {
          botId: secondBotId,
          projectName: "Proyecto de fixture",
          siteUrl: "https://fixture.example.test/",
        },
      ],
      mail,
    });

    const response = await invite(api.handler, {
      bot: secondBotId,
      operationId: "second-bot-operation",
    });

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      botId: secondBotId,
      operation: { id: "second-bot-operation", status: "recorded" },
    });
    expect(docentStore.registerInvitation).not.toHaveBeenCalled();
    expect(secondStore.registerInvitation).toHaveBeenCalledOnce();
    expect(secondStore.registerInvitation.mock.calls[0][0].botId).toBe(secondBotId);
    expect(mail.sendInvitation).toHaveBeenCalledOnce();
    expect(mail.sendInvitation.mock.calls[0][0]).toMatchObject({
      projectName: "Proyecto de fixture",
      to: invitedEmail,
    });
    expect(new URL(mail.sendInvitation.mock.calls[0][0].url).origin).toBe(
      "https://fixture.example.test",
    );
  });

  it("reuses an existing common Cognito account without creating or changing its password", async () => {
    const initialPassword = "existing-password-secret";
    const { identity, state } = makeIdentity({
      user: {
        sub: "teacher-sub",
        email: invitedEmail,
        emailVerified: true,
        status: "CONFIRMED",
        password: initialPassword,
      },
    });
    const store = makeStore();
    const mail = { sendInvitation: vi.fn(async () => ({ messageId: "ses-existing" })) };
    const api = makeApi({ identity, store, mail });

    const response = await invite(api.handler, {
      expectedSub: "teacher-sub",
      expectedRevision: 0,
      operationId: "existing-account-operation",
    });

    expect(response.statusCode).toBe(200);
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(identity.setPermanentPassword).not.toHaveBeenCalled();
    expect(state.user.password).toBe(initialPassword);
    expect(store.registerInvitation.mock.calls[0][0]).toMatchObject({
      sub: "teacher-sub",
      expectedRevision: 0,
      operationId: "existing-account-operation",
    });
    expect(mail.sendInvitation.mock.calls[0][0].url).toContain(
      "https://docentes.example.test/#/invite?token=",
    );
  });

  it("returns a confirmed operation replay without issuing or mailing another link", async () => {
    const existingInvitation = makeInvitation({
      hash: "b".repeat(64),
      operationId: "same-operation",
      delivery: { status: "accepted", messageId: "first-message" },
    });
    const store = makeStore({
      registerInvitation: vi.fn(async (input) => ({
        access: makeAccess(input.sub, "none", 1, {
          hash: existingInvitation.tokenHash,
          expiresAt: existingInvitation.expiresAt,
        }),
        invitation: existingInvitation,
        created: false,
      })),
    });
    const { identity } = makeIdentity({
      user: {
        sub: "teacher-sub",
        email: invitedEmail,
        emailVerified: false,
        status: "FORCE_CHANGE_PASSWORD",
      },
    });
    const mail = { sendInvitation: vi.fn() };
    const api = makeApi({ identity, store, mail });

    const response = await invite(api.handler, { operationId: "same-operation" });

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      operation: { id: "same-operation", status: "already_recorded" },
      invitation: { delivery: { status: "accepted", messageId: "first-message" } },
    });
    expect(store.registerInvitation).toHaveBeenCalledOnce();
    expect(store.recordInvitationDelivery).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(mail.sendInvitation).not.toHaveBeenCalled();
  });

  it("reports a revision conflict without retrying the same operation against newer state", async () => {
    const conflict = Object.assign(new Error("Revision changed"), {
      name: "STATE_CHANGED",
      code: "STATE_CHANGED",
    });
    const store = makeStore({
      registerInvitation: vi.fn(async () => {
        throw conflict;
      }),
    });
    const mail = { sendInvitation: vi.fn() };
    const api = makeApi({ store, mail });

    const response = await invite(api.handler, {
      expectedRevision: 7,
      operationId: "stale-operation",
    });

    expect(response.statusCode).toBe(409);
    expect(bodyOf(response)).toMatchObject({ code: "STATE_CHANGED" });
    expect(store.registerInvitation).toHaveBeenCalledOnce();
    expect(store.registerInvitation.mock.calls[0][0]).toMatchObject({
      expectedRevision: 7,
      operationId: "stale-operation",
    });
    expect(mail.sendInvitation).not.toHaveBeenCalled();
  });

  it.each([
    ["a definite rejection", "MessageRejected", "failed"],
    ["a transport timeout", "TimeoutError", "unconfirmed"],
  ])("records %s distinctly and returns it on lookup", async (_label, errorName, status) => {
    const transport = createPhase9AccountTransport();
    const store = createAccountStoreAdapter({
      documentClient: transport.documentClient,
      tableName,
      now: () => now,
    });
    const { identity } = makeIdentity();
    const failure = Object.assign(new Error("Email operation did not confirm"), {
      name: errorName,
    });
    const mail = {
      sendInvitation: vi.fn(async () => {
        throw failure;
      }),
    };
    const api = makeApi({ identity, store, mail });

    const sent = await invite(api.handler);
    const lookedUp = await adminRequest(
      api.handler,
      "POST",
      `/api/admin/bots/${botId}/people/lookup`,
      { email: invitedEmail },
    );

    expect(sent.statusCode).toBe(200);
    expect(bodyOf(sent)).toMatchObject({ invitation: { delivery: { status } } });
    expect(lookedUp.statusCode).toBe(200);
    expect(bodyOf(lookedUp)).toMatchObject({ invitation: { delivery: { status } } });
    expect(mail.sendInvitation).toHaveBeenCalledOnce();
    expect(transport.items()).toHaveLength(2);
    expect(transport.items().some(isLegacyAccessItem)).toBe(false);
  });

  it("keeps active access unchanged when a delayed SES acknowledgement is recorded", async () => {
    const transport = createPhase9AccountTransport();
    const store = createAccountStoreAdapter({
      documentClient: transport.documentClient,
      tableName,
      now: () => now,
    });
    transport.setItem(tableName, {
      pk: `BOT#${botId}#USER#teacher-sub`,
      sk: "ACCESS",
      sub: "teacher-sub",
      botId,
      access: "active",
      revision: 5,
    });
    const currentUser = {
      sub: "teacher-sub",
      email: invitedEmail,
      emailVerified: true,
      status: "CONFIRMED",
    };
    const { identity } = makeIdentity({ user: currentUser });
    let acknowledge;
    const mail = {
      sendInvitation: vi.fn(
        () =>
          new Promise((resolve) => {
            acknowledge = resolve;
          }),
      ),
    };
    const api = makeApi({ identity, store, mail });

    const pendingResponse = invite(api.handler, {
      expectedSub: "teacher-sub",
      expectedRevision: 5,
      operationId: "late-ack-operation",
    });
    await vi.waitFor(() => expect(mail.sendInvitation).toHaveBeenCalledOnce());
    const accessWhileMailIsPending = await store.getAccess({ sub: "teacher-sub", botId });
    acknowledge({ messageId: "late-message" });
    const response = await pendingResponse;
    const accessAfterAck = await store.getAccess({ sub: "teacher-sub", botId });

    expect(response.statusCode).toBe(200);
    expect(accessWhileMailIsPending).toMatchObject({ access: "active", revision: 6 });
    expect(accessAfterAck).toEqual(accessWhileMailIsPending);
    expect(bodyOf(response)).toMatchObject({
      invitation: { delivery: { status: "accepted", messageId: "late-message" } },
    });
  });

  it("runs the real invitation, Dynamo adapter, and acceptance handler through account/me", async () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
    const flow = makeRealFlow({ randomBytes: vi.fn(() => bytes) });

    const issued = await invite(flow.handler, {
      expectedSub: null,
      expectedRevision: 0,
      operationId: "full-new-account-flow",
    });
    const issuedBody = bodyOf(issued);
    const email = flow.sent[0];
    const token = invitationToken(email.url);
    const inspected = await flow.account(
      event(
        "POST",
        "/api/account/invitations/inspect",
        { token },
        {
          token: null,
          claims: null,
        },
      ),
    );
    const accessBeforeAcceptance = await flow.store.getAccess({ sub: "teacher-sub", botId });
    const accepted = await flow.account(
      accountEvent(
        "POST",
        "/api/account/invitations/accept",
        { token, password: "Correct-Horse-42!" },
        accountToken,
        "teacher-sub",
      ),
    );
    const me = await flow.account(
      event("GET", "/api/account/me", undefined, {
        token: accountToken,
        claims: claims({ sub: "teacher-sub", clientId: "chat-client", groups: [] }),
      }),
    );
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const accessItem = flow.transport.getItem(tableName, {
      pk: `BOT#${botId}#USER#teacher-sub`,
      sk: "ACCESS",
    });
    const invitationItem = flow.transport.getItem(tableName, {
      pk: `INVITE#${tokenHash}`,
      sk: "INVITATION",
    });

    expect(issued.statusCode).toBe(200);
    expect(issuedBody.operation).toEqual({ id: "full-new-account-flow", status: "recorded" });
    expect(flow.identityState.calls).toContainEqual(["createUser", invitedEmail, "SUPPRESS"]);
    expect(email.url).toContain("https://docentes.example.test/#/invite?token=");
    expect(token).toHaveLength(43);
    expect(inspected.statusCode).toBe(200);
    expect(bodyOf(inspected)).toMatchObject({ kind: "new", email: invitedEmail });
    expect(accepted.statusCode).toBe(200);
    expect(bodyOf(accepted)).toMatchObject({ status: "accepted" });
    expect(flow.identityState.user).toMatchObject({
      sub: "teacher-sub",
      email: invitedEmail,
      emailVerified: true,
      status: "CONFIRMED",
    });
    expect(bodyOf(me)).toMatchObject({
      sub: "teacher-sub",
      botId,
      access: { state: "active" },
    });
    expect(bodyOf(me).access.revision).toBeGreaterThan(accessBeforeAcceptance.revision);
    expect(accessItem).toMatchObject({
      access: "active",
      revision: bodyOf(me).access.revision,
    });
    expect(accessItem).not.toHaveProperty("currentInvitation");
    expect(accessItem).not.toHaveProperty("activationClaim");
    expect(invitationItem).toMatchObject({ tokenHash, usedAt: new Date(now).toISOString() });
    expect(invitationItem).not.toHaveProperty("token");
    expect(invitationItem).not.toHaveProperty("password");
    expect(flow.transport.items()).toHaveLength(2);
    expect(flow.transport.items().some(isLegacyAccessItem)).toBe(false);
    expect(
      flow.identityState.calls.filter(([name]) => name === "setPermanentPassword"),
    ).toHaveLength(1);
  });

  it("reuses an already confirmed common account in the real acceptance flow without setting its password", async () => {
    const flow = makeRealFlow({
      user: {
        sub: "teacher-sub",
        email: invitedEmail,
        emailVerified: true,
        status: "CONFIRMED",
        password: "unchanged-password",
      },
    });

    const issued = await invite(flow.handler, {
      expectedSub: "teacher-sub",
      expectedRevision: 0,
      operationId: "existing-common-account",
    });
    const token = invitationToken(flow.sent[0].url);
    const accepted = await flow.account(
      accountEvent(
        "POST",
        "/api/account/invitations/accept",
        { token },
        accountToken,
        "teacher-sub",
      ),
    );
    const me = await flow.account(
      event("GET", "/api/account/me", undefined, {
        token: accountToken,
        claims: claims({ sub: "teacher-sub", clientId: "chat-client", groups: [] }),
      }),
    );

    expect(issued.statusCode).toBe(200);
    expect(flow.identityState.calls.some(([name]) => name === "createUser")).toBe(false);
    expect(flow.identityState.calls.some(([name]) => name === "setPermanentPassword")).toBe(false);
    expect(flow.identityState.user.password).toBe("unchanged-password");
    expect(accepted.statusCode).toBe(200);
    expect(bodyOf(me)).toMatchObject({ access: { state: "active" } });
  });

  it("preserves an uncertain password claim across reissue and accepts a new link without resetting it", async () => {
    const timeoutAfterPasswordChange = Object.assign(
      new Error("Cognito did not confirm the password response"),
      { name: "TimeoutError" },
    );
    let generated = 0;
    const flow = makeRealFlow({
      randomBytes: vi.fn(() => Buffer.alloc(32, ++generated)),
      passwordFailureAfterEffect: timeoutAfterPasswordChange,
    });

    const firstInvite = await invite(flow.handler, {
      expectedSub: null,
      expectedRevision: 0,
      operationId: "uncertain-first-activation",
    });
    const firstToken = invitationToken(flow.sent[0].url);
    const firstHash = createHash("sha256").update(firstToken).digest("hex");
    const uncertain = await flow.account(
      event(
        "POST",
        "/api/account/invitations/accept",
        { token: firstToken, password: "Keep-this-password-42!" },
        { token: null, claims: null },
      ),
    );
    const identityAfterUncertain = { ...flow.identityState.user };
    const reservedAccess = await flow.store.getAccess({ sub: "teacher-sub", botId });

    const replacement = await invite(flow.handler, {
      expectedSub: "teacher-sub",
      expectedRevision: reservedAccess.revision,
      operationId: "new-link-after-uncertain-password",
    });
    const replacementToken = invitationToken(flow.sent[1].url);
    const accessAfterReissue = await flow.store.getAccess({ sub: "teacher-sub", botId });
    const accepted = await flow.account(
      accountEvent(
        "POST",
        "/api/account/invitations/accept",
        { token: replacementToken },
        accountToken,
        "teacher-sub",
      ),
    );
    const finalAccess = await flow.store.getAccess({ sub: "teacher-sub", botId });

    expect(firstInvite.statusCode).toBe(200);
    expect(uncertain.statusCode).toBe(503);
    expect(bodyOf(uncertain)).toMatchObject({ code: "TRY_AGAIN" });
    expect(identityAfterUncertain).toMatchObject({
      status: "CONFIRMED",
      password: "Keep-this-password-42!",
      emailVerified: false,
    });
    expect(reservedAccess.activationClaim).toMatchObject({ invitationHash: firstHash });
    expect(replacement.statusCode).toBe(200);
    expect(accessAfterReissue.activationClaim).toEqual(reservedAccess.activationClaim);
    expect(accessAfterReissue.currentInvitation.hash).toBe(
      createHash("sha256").update(replacementToken).digest("hex"),
    );
    expect(accepted.statusCode).toBe(200);
    expect(
      flow.identityState.calls.filter(([name]) => name === "setPermanentPassword"),
    ).toHaveLength(1);
    expect(flow.identityState.user.password).toBe("Keep-this-password-42!");
    expect(flow.identityState.user.emailVerified).toBe(true);
    expect(finalAccess).toMatchObject({ access: "active" });
    expect(finalAccess.revision).toBeGreaterThan(accessAfterReissue.revision);
    expect(finalAccess.activationClaim).toEqual(reservedAccess.activationClaim);
  });

  it("invalidates a previously issued token when a later invitation replaces the current pointer", async () => {
    let generated = 0;
    const flow = makeRealFlow({
      randomBytes: vi.fn(() => Buffer.alloc(32, ++generated)),
    });
    const first = await invite(flow.handler, {
      expectedSub: null,
      expectedRevision: 0,
      operationId: "first-link",
    });
    const oldToken = invitationToken(flow.sent[0].url);
    const second = await invite(flow.handler, {
      expectedSub: "teacher-sub",
      expectedRevision: 1,
      operationId: "replacement-link",
    });
    const newToken = invitationToken(flow.sent[1].url);
    const oldInspection = await flow.account(
      event(
        "POST",
        "/api/account/invitations/inspect",
        { token: oldToken },
        {
          token: null,
          claims: null,
        },
      ),
    );
    const currentAccess = await flow.store.getAccess({ sub: "teacher-sub", botId });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(oldToken).not.toBe(newToken);
    expect(oldInspection.statusCode).not.toBe(200);
    expect(flow.identityState.calls.some(([name]) => name === "setPermanentPassword")).toBe(false);
    expect(currentAccess.currentInvitation).toMatchObject({
      hash: createHash("sha256").update(newToken).digest("hex"),
    });
  });

  it.each([
    ["a missing access identity", { token: null, claims: null }, 401],
    ["a token for another app client", { claims: claims({ clientId: "chat-client" }) }, 403],
    ["a token without the global-admin group", { claims: claims({ groups: [] }) }, 403],
    ["an ID token", { claims: claims({ tokenUse: "id" }) }, 403],
  ])("rejects %s before looking up or revoking a person", async (_label, options, status) => {
    const store = makeStore();
    const { identity } = makeIdentity();
    const api = makeApi({ identity, store });

    const response = await adminRequest(
      api.handler,
      "POST",
      `/api/admin/bots/${botId}/access/revoke`,
      {
        email: invitedEmail,
        expectedSub: "teacher-sub",
        expectedRevision: 3,
        operationId: "unauthorized-revoke",
      },
      options,
    );

    expect(response.statusCode).toBe(status);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(identity.getUserByEmail).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(identity.setPermanentPassword).not.toHaveBeenCalled();
    expect(identity.markEmailVerified).not.toHaveBeenCalled();
    expect(store.getAccess).not.toHaveBeenCalled();
    expect(store.revokeAccess).not.toHaveBeenCalled();
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(api.mail.sendInvitation).not.toHaveBeenCalled();
  });

  it.each([
    ["an invalid email", { email: "not-an-email" }],
    ["a missing expected subject", { expectedSub: null }],
    ["an invalid expected subject", { expectedSub: { sub: "teacher-sub" } }],
    ["a negative observed revision", { expectedRevision: -1 }],
    ["a non-integer observed revision", { expectedRevision: 1.5 }],
    ["a blank operation ID", { operationId: " " }],
    ["an overlong operation ID", { operationId: "x".repeat(129) }],
  ])("rejects %s before identity, store, or email operations", async (_label, change) => {
    const store = makeStore();
    const { identity } = makeIdentity();
    const randomBytes = vi.fn(() => Buffer.alloc(32, 1));
    const mail = { sendInvitation: vi.fn() };
    const api = makeApi({ identity, store, mail, randomBytes });

    const response = await revoke(api.handler, {
      ...change,
      expectedSub: "teacher-sub",
      expectedRevision: 3,
      operationId: "valid-revoke",
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(identity.getUserByEmail).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(identity.setPermanentPassword).not.toHaveBeenCalled();
    expect(identity.markEmailVerified).not.toHaveBeenCalled();
    expect(store.getAccess).not.toHaveBeenCalled();
    expect(store.revokeAccess).not.toHaveBeenCalled();
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(mail.sendInvitation).not.toHaveBeenCalled();
    expect(randomBytes).not.toHaveBeenCalled();
  });

  it("rejects an unconfigured bot before Cognito or account-store access", async () => {
    const store = makeStore();
    const { identity } = makeIdentity();
    const api = makeApi({ identity, store });

    const response = await revoke(api.handler, { bot: "attacker-selected" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(identity.getUserByEmail).not.toHaveBeenCalled();
    expect(store.getAccess).not.toHaveBeenCalled();
    expect(store.revokeAccess).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing Cognito person", null],
    [
      "a changed Cognito subject",
      {
        sub: "different-sub",
        email: invitedEmail,
        emailVerified: true,
        status: "CONFIRMED",
      },
    ],
  ])(
    "rejects revocation for %s without creating or changing a Cognito identity",
    async (_label, user) => {
      const { identity } = makeIdentity({ user });
      const store = makeStore();
      const api = makeApi({ identity, store });

      const response = await revoke(api.handler, {
        expectedSub: "teacher-sub",
        expectedRevision: 3,
        operationId: "identity-mismatch",
      });

      expect(response.statusCode).toBe(409);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(bodyOf(response)).toMatchObject({ code: "STATE_CHANGED" });
      expect(identity.getUserByEmail).toHaveBeenCalledExactlyOnceWith(invitedEmail);
      expect(identity.createUser).not.toHaveBeenCalled();
      expect(identity.setPermanentPassword).not.toHaveBeenCalled();
      expect(identity.markEmailVerified).not.toHaveBeenCalled();
      expect(store.revokeAccess).not.toHaveBeenCalled();
      expect(api.mail.sendInvitation).not.toHaveBeenCalled();
    },
  );

  it("rejects a Cognito email that no longer matches the requested identity", async () => {
    const { identity } = makeIdentity({
      user: {
        sub: "teacher-sub",
        email: "renamed@example.test",
        emailVerified: true,
        status: "CONFIRMED",
      },
    });
    identity.getUserByEmail.mockResolvedValue({
      sub: "teacher-sub",
      email: "renamed@example.test",
      emailVerified: true,
      status: "CONFIRMED",
    });
    const store = makeStore();
    const api = makeApi({ identity, store });

    const response = await revoke(api.handler, { operationId: "email-changed" });

    expect(response.statusCode).toBe(409);
    expect(bodyOf(response)).toMatchObject({ code: "STATE_CHANGED" });
    expect(store.revokeAccess).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(identity.setPermanentPassword).not.toHaveBeenCalled();
    expect(identity.markEmailVerified).not.toHaveBeenCalled();
  });

  it("revokes the observed Cognito subject through the selected bot store without external side effects", async () => {
    const existingPassword = "do-not-change-this-password";
    const { identity, state } = makeIdentity({
      user: {
        sub: "teacher-sub",
        email: invitedEmail,
        emailVerified: true,
        status: "CONFIRMED",
        password: existingPassword,
      },
    });
    const store = makeStore({
      getAccess: vi.fn(async () => makeAccess("teacher-sub", "active", 9)),
      revokeAccess: vi.fn(async ({ sub, botId: selectedBot, expectedRevision, operationId }) => ({
        access: makeAccess(sub, "revoked", expectedRevision + 1, undefined, selectedBot),
        created: true,
        operationId,
      })),
    });
    const randomBytes = vi.fn(() => Buffer.alloc(32, 2));
    const mail = { sendInvitation: vi.fn() };
    const api = makeApi({ identity, store, mail, randomBytes });

    const response = await revoke(api.handler, {
      expectedSub: "teacher-sub",
      expectedRevision: 9,
      operationId: "revoke-observed-teacher",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(bodyOf(response)).toMatchObject({
      botId,
      person: { sub: "teacher-sub", email: invitedEmail },
      access: { state: "revoked", revision: 10 },
      operation: { id: "revoke-observed-teacher", status: "recorded" },
    });
    expect(JSON.stringify(bodyOf(response))).not.toMatch(/token|hash|tableName|poolId|secret/i);
    expect(store.revokeAccess).toHaveBeenCalledExactlyOnceWith({
      sub: "teacher-sub",
      botId,
      expectedRevision: 9,
      operationId: "revoke-observed-teacher",
    });
    expect(state.user.password).toBe(existingPassword);
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(identity.setPermanentPassword).not.toHaveBeenCalled();
    expect(identity.markEmailVerified).not.toHaveBeenCalled();
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(store.recordInvitationDelivery).not.toHaveBeenCalled();
    expect(mail.sendInvitation).not.toHaveBeenCalled();
    expect(randomBytes).not.toHaveBeenCalled();
  });

  it("can revoke access while the invitation sender is unconfigured", async () => {
    const { identity } = makeIdentity({
      user: { sub: "teacher-sub", email: invitedEmail, status: "CONFIRMED" },
    });
    const store = makeStore({
      getAccess: vi.fn(async () => makeAccess("teacher-sub", "active", 3)),
    });
    const api = makeApi({ identity, store });
    api.config.sender = null;

    const response = await revoke(api.handler, { expectedRevision: 3 });

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({ access: { state: "revoked", revision: 4 } });
    expect(store.revokeAccess).toHaveBeenCalledOnce();
    expect(api.mail.sendInvitation).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
  });

  it("returns a revision conflict without adapting the revoke to newer ACCESS", async () => {
    const conflict = Object.assign(new Error("ACCESS revision changed"), {
      name: "StateChangedError",
      code: "STATE_CHANGED",
    });
    const store = makeStore({
      revokeAccess: vi.fn(async () => {
        throw conflict;
      }),
    });
    const { identity } = makeIdentity({
      user: {
        sub: "teacher-sub",
        email: invitedEmail,
        emailVerified: true,
        status: "CONFIRMED",
      },
    });
    const api = makeApi({ identity, store });

    const response = await revoke(api.handler, {
      expectedRevision: 6,
      operationId: "stale-revoke",
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(bodyOf(response)).toMatchObject({ code: "STATE_CHANGED" });
    expect(store.revokeAccess).toHaveBeenCalledOnce();
    expect(store.revokeAccess.mock.calls[0][0]).toMatchObject({
      expectedRevision: 6,
      operationId: "stale-revoke",
    });
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(api.mail.sendInvitation).not.toHaveBeenCalled();
  });

  it("returns 503 when a revoke ACK is lost and a reread cannot confirm the operation", async () => {
    const transport = createPhase9AccountTransport();
    transport.setItem(tableName, {
      pk: `BOT#${botId}#USER#teacher-sub`,
      sk: "ACCESS",
      sub: "teacher-sub",
      botId,
      access: "active",
      revision: 9,
    });
    const timeout = Object.assign(new Error("DynamoDB response timed out"), {
      name: "TimeoutError",
    });
    const documentClient = {
      send: vi.fn(async (command) => {
        if (command instanceof UpdateCommand) throw timeout;
        return transport.documentClient.send(command);
      }),
    };
    const store = createAccountStoreAdapter({ documentClient, tableName, now: () => now });
    const { identity } = makeIdentity({
      user: {
        sub: "teacher-sub",
        email: invitedEmail,
        emailVerified: true,
        status: "CONFIRMED",
      },
    });
    const mail = { sendInvitation: vi.fn() };
    const api = makeApi({ identity, store, mail });

    const response = await revoke(api.handler, {
      expectedRevision: 9,
      operationId: "ambiguous-revoke",
    });
    const current = await store.getAccess({ sub: "teacher-sub", botId });

    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(bodyOf(response)).toMatchObject({ code: "TRY_AGAIN" });
    expect(current).toMatchObject({ access: "active", revision: 9 });
    expect(
      documentClient.send.mock.calls.filter(([command]) => command instanceof UpdateCommand),
    ).toHaveLength(1);
    expect(mail.sendInvitation).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(identity.setPermanentPassword).not.toHaveBeenCalled();
    expect(identity.markEmailVerified).not.toHaveBeenCalled();
  });

  it("returns an existing revoke operation without sending mail or repeating identity effects", async () => {
    const { identity } = makeIdentity({
      user: {
        sub: "teacher-sub",
        email: invitedEmail,
        emailVerified: true,
        status: "CONFIRMED",
      },
    });
    const store = makeStore({
      revokeAccess: vi.fn(async ({ sub, botId: selectedBot }) => ({
        access: makeAccess(sub, "revoked", 11, undefined, selectedBot),
        created: false,
      })),
    });
    const mail = { sendInvitation: vi.fn() };
    const api = makeApi({ identity, store, mail });

    const response = await revoke(api.handler, {
      expectedRevision: 10,
      operationId: "same-revoke-id",
    });

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      access: { state: "revoked", revision: 11 },
      operation: { id: "same-revoke-id", status: "already_recorded" },
    });
    expect(store.revokeAccess).toHaveBeenCalledOnce();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(identity.setPermanentPassword).not.toHaveBeenCalled();
    expect(identity.markEmailVerified).not.toHaveBeenCalled();
    expect(mail.sendInvitation).not.toHaveBeenCalled();
  });

  it("rejects an overlong invitation operation ID before Cognito, storage, SES, or token generation", async () => {
    const { identity } = makeIdentity();
    const store = makeStore();
    const randomBytes = vi.fn(() => Buffer.alloc(32, 4));
    const mail = { sendInvitation: vi.fn() };
    const api = makeApi({ identity, store, randomBytes, mail });

    const response = await invite(api.handler, {
      expectedSub: null,
      expectedRevision: 0,
      operationId: "x".repeat(129),
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(identity.getUserByEmail).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(store.getAccess).not.toHaveBeenCalled();
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(mail.sendInvitation).not.toHaveBeenCalled();
    expect(randomBytes).not.toHaveBeenCalled();
  });

  it("rejects an overlong operation ID in the production invitation orchestrator without effects", async () => {
    const store = makeStore();
    const { identity } = makeIdentity();
    const mail = { sendInvitation: vi.fn() };
    const randomBytes = vi.fn(() => Buffer.alloc(32, 3));

    await expect(
      provisionInvitation(
        {
          config: {
            botId,
            projectName: "Docentes",
            siteUrl: "https://docentes.example.test/",
            sender: "verified-sender@example.test",
            invitationTtlMs: ttl,
          },
          identity,
          store,
          mail,
          now: () => now,
          randomBytes,
        },
        {
          email: invitedEmail,
          expectedSub: null,
          expectedRevision: 0,
          operationId: "x".repeat(129),
        },
      ),
    ).rejects.toThrow();

    expect(identity.getUserByEmail).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(store.getAccess).not.toHaveBeenCalled();
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(store.recordInvitationDelivery).not.toHaveBeenCalled();
    expect(mail.sendInvitation).not.toHaveBeenCalled();
    expect(randomBytes).not.toHaveBeenCalled();
  });

  it("cancels a pending invitation without granting access history or letting its link activate", async () => {
    // This exercises the real admin/account handlers and store adapter. The transport persists
    // writes but does not evaluate DynamoDB condition expressions.
    const flow = makeRealFlow({ randomBytes: vi.fn(() => Buffer.alloc(32, 5)) });

    const issued = await invite(flow.handler, {
      expectedSub: null,
      expectedRevision: 0,
      operationId: "pending-before-cancel",
    });
    const oldToken = invitationToken(flow.sent[0].url);
    const beforeCancel = await flow.store.getAccess({ sub: "teacher-sub", botId });
    const cancelled = await revoke(flow.handler, {
      expectedSub: "teacher-sub",
      expectedRevision: beforeCancel.revision,
      operationId: "cancel-first-invitation",
    });
    const lookup = await adminRequest(
      flow.handler,
      "POST",
      `/api/admin/bots/${botId}/people/lookup`,
      { email: invitedEmail },
    );
    const rejectedInspect = await flow.account(
      event(
        "POST",
        "/api/account/invitations/inspect",
        { token: oldToken },
        { token: null, claims: null },
      ),
    );
    const rejectedActivation = await flow.account(
      event(
        "POST",
        "/api/account/invitations/accept",
        { token: oldToken, password: "Unaccepted-Password-42!" },
        { token: null, claims: null },
      ),
    );
    const afterCancel = await flow.store.getAccess({ sub: "teacher-sub", botId });

    expect(issued.statusCode).toBe(200);
    expect(cancelled.statusCode).toBe(200);
    expect(bodyOf(cancelled)).toMatchObject({ access: { state: "none", revision: 2 } });
    expect(lookup.statusCode).toBe(200);
    expect(bodyOf(lookup)).toMatchObject({ access: { state: "none", revision: 2 } });
    expect(bodyOf(lookup)).not.toHaveProperty("invitation");
    expect(rejectedInspect.statusCode).not.toBe(200);
    expect(rejectedActivation.statusCode).not.toBe(200);
    expect(afterCancel).toMatchObject({ access: "none", revision: 2 });
    expect(afterCancel).not.toHaveProperty("currentInvitation");
    expect(afterCancel).not.toHaveProperty("activationClaim");
    expect(flow.identityState.user).toMatchObject({ status: "FORCE_CHANGE_PASSWORD" });
    expect(flow.identityState.calls.some(([name]) => name === "setPermanentPassword")).toBe(false);
    expect(flow.identityState.calls.some(([name]) => name === "markEmailVerified")).toBe(false);
    expect(flow.sent).toHaveLength(1);
  });

  it("revokes, re-invites, and restores a confirmed account only after the new link is accepted", async () => {
    const initialPassword = "preserve-existing-password";
    let generated = 0;
    const flow = makeRealFlow({
      user: {
        sub: "teacher-sub",
        email: invitedEmail,
        emailVerified: true,
        status: "CONFIRMED",
        password: initialPassword,
      },
      randomBytes: vi.fn(() => Buffer.alloc(32, ++generated)),
    });
    const issued = await invite(flow.handler, {
      expectedSub: "teacher-sub",
      expectedRevision: 0,
      operationId: "initial-access-invitation",
    });
    const oldToken = invitationToken(flow.sent[0].url);
    const initialAcceptance = await flow.account(
      accountEvent(
        "POST",
        "/api/account/invitations/accept",
        { token: oldToken },
        accountToken,
        "teacher-sub",
      ),
    );
    const active = await flow.store.getAccess({ sub: "teacher-sub", botId });
    const revoked = await revoke(flow.handler, {
      expectedSub: "teacher-sub",
      expectedRevision: active.revision,
      operationId: "revoke-before-reinvite",
    });
    const revokedAccess = await flow.store.getAccess({ sub: "teacher-sub", botId });
    const oldLinkReplay = await flow.account(
      accountEvent(
        "POST",
        "/api/account/invitations/accept",
        { token: oldToken },
        accountToken,
        "teacher-sub",
      ),
    );
    const afterOldLinkReplay = await flow.store.getAccess({ sub: "teacher-sub", botId });
    const lookupWhileRevoked = await adminRequest(
      flow.handler,
      "POST",
      `/api/admin/bots/${botId}/people/lookup`,
      { email: invitedEmail },
    );
    const replacement = await invite(flow.handler, {
      expectedSub: "teacher-sub",
      expectedRevision: revokedAccess.revision,
      operationId: "restore-with-new-invitation",
    });
    const newToken = invitationToken(flow.sent[1].url);
    const accessBeforeNewAcceptance = await flow.store.getAccess({ sub: "teacher-sub", botId });
    const lookupWithPendingRestoration = await adminRequest(
      flow.handler,
      "POST",
      `/api/admin/bots/${botId}/people/lookup`,
      { email: invitedEmail },
    );
    const restored = await flow.account(
      accountEvent(
        "POST",
        "/api/account/invitations/accept",
        { token: newToken },
        accountToken,
        "teacher-sub",
      ),
    );
    const me = await flow.account(
      event("GET", "/api/account/me", undefined, {
        token: accountToken,
        claims: claims({ sub: "teacher-sub", clientId: "chat-client", groups: [] }),
      }),
    );
    const finalAccess = await flow.store.getAccess({ sub: "teacher-sub", botId });
    const oldHash = createHash("sha256").update(oldToken).digest("hex");
    const newHash = createHash("sha256").update(newToken).digest("hex");
    const oldInvitation = flow.transport.getItem(tableName, invitationKey(oldHash));
    const newInvitation = flow.transport.getItem(tableName, invitationKey(newHash));

    expect(issued.statusCode).toBe(200);
    expect(initialAcceptance.statusCode).toBe(200);
    expect(bodyOf(initialAcceptance)).toMatchObject({ status: "accepted" });
    expect(active).toMatchObject({ access: "active" });
    expect(revoked.statusCode).toBe(200);
    expect(bodyOf(revoked)).toMatchObject({ access: { state: "revoked" } });
    expect(revokedAccess).toMatchObject({ access: "revoked" });
    expect(revokedAccess).not.toHaveProperty("currentInvitation");
    expect(oldLinkReplay.statusCode).not.toBe(200);
    expect(afterOldLinkReplay).toEqual(revokedAccess);
    expect(bodyOf(lookupWhileRevoked)).toMatchObject({ access: { state: "revoked" } });
    expect(bodyOf(lookupWhileRevoked)).not.toHaveProperty("invitation");
    expect(replacement.statusCode).toBe(200);
    expect(accessBeforeNewAcceptance).toMatchObject({ access: "revoked" });
    expect(accessBeforeNewAcceptance.currentInvitation).toMatchObject({
      hash: newHash,
    });
    expect(bodyOf(lookupWithPendingRestoration)).toMatchObject({
      access: { state: "revoked" },
      invitation: { delivery: { status: "accepted" } },
    });
    expect(JSON.stringify(bodyOf(lookupWithPendingRestoration))).not.toContain(newHash);
    expect(restored.statusCode).toBe(200);
    expect(bodyOf(restored)).toMatchObject({ status: "accepted" });
    expect(bodyOf(me)).toMatchObject({
      sub: "teacher-sub",
      access: { state: "active" },
    });
    expect(finalAccess).toMatchObject({ access: "active", sub: "teacher-sub", botId });
    expect(finalAccess.revision).toBeGreaterThan(accessBeforeNewAcceptance.revision);
    expect(finalAccess).not.toHaveProperty("currentInvitation");
    expect(oldInvitation).toMatchObject({ usedAt: new Date(now).toISOString() });
    expect(newInvitation).toMatchObject({ usedAt: new Date(now).toISOString() });
    expect(flow.identityState.user).toMatchObject({
      sub: "teacher-sub",
      email: invitedEmail,
      emailVerified: true,
      status: "CONFIRMED",
      password: initialPassword,
    });
    expect(flow.identityState.calls.filter(([name]) => name === "createUser")).toHaveLength(0);
    expect(
      flow.identityState.calls.filter(([name]) => name === "setPermanentPassword"),
    ).toHaveLength(0);
    expect(flow.identityState.calls.filter(([name]) => name === "markEmailVerified")).toHaveLength(
      0,
    );
    expect(flow.sent).toHaveLength(2);
  });
});
