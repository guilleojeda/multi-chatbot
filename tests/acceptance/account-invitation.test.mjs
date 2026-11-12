import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const modulePath = fileURLToPath(new URL("../../api/invitations.ts", import.meta.url));
const now = 1_800_000_000_000;
const tokenBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const ttl = 7 * 24 * 60 * 60 * 1000;

async function loadProvisioning() {
  expect(
    existsSync(modulePath),
    "Expected the invitation provisioning API at api/invitations.ts",
  ).toBe(true);
  if (!existsSync(modulePath)) return null;
  const { provisionInvitation } = await import(pathToFileURL(modulePath).href);
  expect(typeof provisionInvitation).toBe("function");
  return provisionInvitation;
}

function makeAccess({
  sub = "new-account-sub",
  botId = "docentes",
  access = "none",
  revision = 0,
  currentInvitation,
  lastAdminOperation,
} = {}) {
  return {
    sub,
    botId,
    access,
    revision,
    ...(currentInvitation ? { currentInvitation } : {}),
    ...(lastAdminOperation ? { lastAdminOperation } : {}),
  };
}

function fixture({ existingUser = null, currentAccess = null, oldInvitation = null } = {}) {
  const invitations = new Map(oldInvitation ? [[oldInvitation.tokenHash, oldInvitation]] : []);
  const identity = {
    getUserByEmail: vi.fn(async () => existingUser),
    createUser: vi.fn(async ({ email }) => ({
      sub: "new-account-sub",
      email,
      status: "FORCE_CHANGE_PASSWORD",
    })),
  };
  const store = {
    getAccess: vi.fn(async () => currentAccess),
    getInvitation: vi.fn(async (hash) => invitations.get(hash) ?? null),
    registerInvitation: vi.fn(async (input) => {
      const nextAccess = makeAccess({
        sub: input.sub,
        botId: input.botId,
        access: currentAccess?.access ?? "none",
        revision: input.expectedRevision + 1,
        currentInvitation: { hash: input.tokenHash, expiresAt: input.expiresAt },
        lastAdminOperation: {
          id: input.operationId,
          kind: "invite",
          invitationHash: input.tokenHash,
        },
      });
      const invitation = {
        id: input.tokenHash,
        tokenHash: input.tokenHash,
        sub: input.sub,
        botId: input.botId,
        email: input.email,
        expiresAt: input.expiresAt,
        operationId: input.operationId,
        delivery: { status: "unconfirmed" },
      };
      currentAccess = nextAccess;
      invitations.set(input.tokenHash, invitation);
      return { access: nextAccess, invitation, created: true };
    }),
    recordInvitationDelivery: vi.fn(async (input) => {
      const invitation = invitations.get(input.tokenHash);
      if (invitation) invitation.delivery = input.delivery;
    }),
  };
  const mail = { sendInvitation: vi.fn(async () => ({ messageId: "ses-message-id" })) };
  const config = {
    botId: "docentes",
    projectName: "Proyecto de docentes de prueba",
    siteUrl: "https://example.cloudfront.net/",
    sender: "verified-sender@example.edu",
    invitationTtlMs: ttl,
  };
  const randomBytes = vi.fn(() => tokenBytes);
  return {
    deps: { config, identity, store, mail, now: () => now, randomBytes },
    config,
    identity,
    store,
    mail,
    randomBytes,
    invitations,
  };
}

const defaultInput = {
  email: " Teacher@Example.edu ",
  operationId: "operation-1",
  expectedRevision: 0,
  expectedSub: null,
};

describe("technical invitation provisioning", () => {
  it("creates a suppressed account and sends a seven-day hash-only invitation", async () => {
    const provisionInvitation = await loadProvisioning();
    if (!provisionInvitation) return;
    const f = fixture();

    const result = await provisionInvitation(f.deps, defaultInput);

    expect(f.identity.createUser).toHaveBeenCalledExactlyOnceWith({
      email: "teacher@example.edu",
      messageAction: "SUPPRESS",
    });
    expect(f.randomBytes).toHaveBeenCalledWith(32);
    expect(f.store.registerInvitation).toHaveBeenCalledTimes(1);
    expect(f.mail.sendInvitation).toHaveBeenCalledTimes(1);
    const token = tokenBytes.toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    const registered = f.store.registerInvitation.mock.calls[0][0];
    const sent = f.mail.sendInvitation.mock.calls[0][0];
    expect(registered).toEqual({
      botId: "docentes",
      sub: "new-account-sub",
      email: "teacher@example.edu",
      tokenHash: hash,
      expiresAt: now + ttl,
      expectedRevision: 0,
      operationId: "operation-1",
    });
    expect(JSON.stringify(registered)).not.toContain(token);
    expect(sent).toMatchObject({
      from: f.config.sender,
      to: "teacher@example.edu",
      projectName: f.config.projectName,
      expiresAt: now + ttl,
    });
    const link = new URL(sent.url);
    expect(link.origin).toBe("https://example.cloudfront.net");
    expect(link.pathname).toBe("/");
    expect(link.search).toBe("");
    expect(new URLSearchParams(link.hash.split("?")[1]).get("token")).toBe(token);
    expect(result).toMatchObject({
      sub: "new-account-sub",
      botId: "docentes",
      access: { access: "none", revision: 1 },
      invitation: {
        tokenHash: hash,
        delivery: { status: "accepted", messageId: "ses-message-id" },
      },
      created: true,
      messageId: "ses-message-id",
      expiresAt: now + ttl,
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(sent.url);
  });

  it("reuses a confirmed common identity and keeps its password while targeting one bot", async () => {
    const provisionInvitation = await loadProvisioning();
    if (!provisionInvitation) return;
    const existingUser = {
      sub: "common-account-sub",
      email: "teacher@example.edu",
      status: "CONFIRMED",
      emailVerified: true,
    };
    const f = fixture({
      existingUser,
      currentAccess: makeAccess({
        sub: existingUser.sub,
        botId: "docentes",
        access: "active",
        revision: 8,
      }),
    });

    const result = await provisionInvitation(f.deps, {
      email: "teacher@example.edu",
      operationId: "operation-2",
      expectedRevision: 8,
      expectedSub: existingUser.sub,
    });

    expect(f.identity.createUser).not.toHaveBeenCalled();
    expect(f.store.registerInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: existingUser.sub,
        botId: "docentes",
        expectedRevision: 8,
      }),
    );
    expect(f.mail.sendInvitation.mock.calls[0][0].url).toContain(
      "https://example.cloudfront.net/#/invite?",
    );
    expect(f.mail.sendInvitation.mock.calls[0][0]).not.toHaveProperty("password");
    expect(result.access.access).toBe("active");
  });

  it("rereads an identity after a Cognito create collision and validates the email", async () => {
    const provisionInvitation = await loadProvisioning();
    if (!provisionInvitation) return;
    const collision = Object.assign(new Error("Account already exists"), {
      name: "UsernameExistsException",
    });
    const existingUser = {
      sub: "created-concurrently",
      email: "teacher@example.edu",
      status: "CONFIRMED",
    };
    const f = fixture();
    f.identity.createUser.mockRejectedValueOnce(collision);
    f.identity.getUserByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);

    const result = await provisionInvitation(f.deps, {
      email: "teacher@example.edu",
      operationId: "collision-operation",
      expectedRevision: 0,
      expectedSub: null,
    });

    expect(result.sub).toBe(existingUser.sub);
    expect(f.identity.getUserByEmail).toHaveBeenCalledTimes(2);
    expect(f.identity.createUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["MessageRejected", "failed"],
    ["TimeoutError", "unconfirmed"],
  ])("records SES %s as %s without claiming the invitation was delivered", async (name, status) => {
    const provisionInvitation = await loadProvisioning();
    if (!provisionInvitation) return;
    const f = fixture();
    f.mail.sendInvitation.mockRejectedValueOnce(Object.assign(new Error("SES result"), { name }));

    const result = await provisionInvitation(f.deps, defaultInput);

    expect(result.invitation.delivery).toEqual({ status });
    expect(f.store.recordInvitationDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: { status } }),
    );
    expect(f.invitations.get(result.invitation.tokenHash).delivery).toEqual({ status });
    expect(result.messageId).toBeUndefined();
  });

  it("replays an already registered operation without making another token or mail request", async () => {
    const provisionInvitation = await loadProvisioning();
    if (!provisionInvitation) return;
    const hash = "a".repeat(64);
    const invitation = {
      id: hash,
      tokenHash: hash,
      sub: "new-account-sub",
      botId: "docentes",
      email: "teacher@example.edu",
      expiresAt: now + ttl,
      operationId: "operation-1",
      delivery: { status: "accepted", messageId: "ses-first" },
    };
    const access = makeAccess({
      currentInvitation: { hash, expiresAt: invitation.expiresAt },
      revision: 4,
      lastAdminOperation: { id: "operation-1", kind: "invite", invitationHash: hash },
    });
    const f = fixture({ currentAccess: access, oldInvitation: invitation });

    const result = await provisionInvitation(f.deps, defaultInput);

    expect(result).toMatchObject({ created: false, access: { revision: 4 } });
    expect(result.invitation).toMatchObject({ tokenHash: hash, delivery: { status: "accepted" } });
    expect(f.randomBytes).not.toHaveBeenCalled();
    expect(f.store.registerInvitation).not.toHaveBeenCalled();
    expect(f.mail.sendInvitation).not.toHaveBeenCalled();
  });

  it("rejects an invalid recipient before creating an account, invitation or email", async () => {
    const provisionInvitation = await loadProvisioning();
    if (!provisionInvitation) return;
    const f = fixture();

    await expect(provisionInvitation(f.deps, { ...defaultInput, email: " " })).rejects.toThrow();

    expect(f.identity.getUserByEmail).not.toHaveBeenCalled();
    expect(f.identity.createUser).not.toHaveBeenCalled();
    expect(f.store.registerInvitation).not.toHaveBeenCalled();
    expect(f.mail.sendInvitation).not.toHaveBeenCalled();
  });
});
