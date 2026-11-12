import { describe, expect, it, vi } from "vitest";
import { createAdminHandler } from "../../api/admin.ts";

const botId = "docentes";
const currentEmail = "teacher.current@example.test";
const oldEmail = "teacher.old@example.test";
const tokenHash = "a".repeat(64);
const expiresAt = Date.parse("2026-11-18T15:00:00.000Z");
const operationId = "original-invitation-operation";

function event(path, body) {
  return {
    version: "2.0",
    rawPath: path,
    headers: { authorization: "Bearer valid-admin-token" },
    requestContext: {
      http: { method: "POST", path },
      authorizer: {
        jwt: {
          claims: {
            sub: "admin-sub",
            token_use: "access",
            client_id: "admin-client",
            "cognito:groups": ["global-admin"],
          },
        },
      },
    },
    body: JSON.stringify(body),
  };
}

function makeAdminApi({ personEmail = currentEmail, invitedEmail = oldEmail } = {}) {
  const access = {
    sub: "teacher-sub",
    botId,
    access: "active",
    revision: 4,
    currentInvitation: { hash: tokenHash, expiresAt },
    lastAdminOperation: { id: operationId, kind: "invite", invitationHash: tokenHash },
  };
  const invitation = {
    id: tokenHash,
    tokenHash,
    sub: "teacher-sub",
    botId,
    email: invitedEmail,
    expiresAt,
    operationId,
    delivery: { status: "accepted", messageId: "ses-message" },
  };
  const store = {
    getAccess: vi.fn(async () => access),
    getInvitation: vi.fn(async (hash) => (hash === tokenHash ? invitation : null)),
    registerInvitation: vi.fn(),
    recordInvitationDelivery: vi.fn(),
    reserveActivation: vi.fn(),
    releaseActivation: vi.fn(),
    consumeInvitation: vi.fn(),
  };
  const identity = {
    getUserByEmail: vi.fn(async (email) =>
      email.toLowerCase() === personEmail.toLowerCase()
        ? {
            sub: "teacher-sub",
            email: personEmail,
            emailVerified: true,
            status: "CONFIRMED",
          }
        : null,
    ),
    createUser: vi.fn(),
  };
  const mail = { sendInvitation: vi.fn() };
  const randomBytes = vi.fn(() => Buffer.alloc(32, 1));
  const handler = createAdminHandler({
    config: {
      clientId: "admin-client",
      adminGroup: "global-admin",
      sender: "verified-sender@example.test",
      invitationTtlMs: 7 * 24 * 60 * 60 * 1000,
      bots: [{ botId, projectName: "Docentes", siteUrl: "https://docentes.example.test/" }],
    },
    stores: { [botId]: store },
    identity,
    mail,
    now: () => Date.parse("2026-11-11T15:00:00.000Z"),
    randomBytes,
  });
  return { handler, store, identity, mail, randomBytes };
}

function responseBody(response) {
  return JSON.parse(response.body);
}

describe("administrative invitation email display", () => {
  it("exposes the recorded recipient when the current Cognito email has changed", async () => {
    const api = makeAdminApi({ personEmail: currentEmail, invitedEmail: oldEmail });
    const response = await api.handler(
      event(`/api/admin/bots/${botId}/people/lookup`, { email: currentEmail }),
    );

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toMatchObject({
      person: { sub: "teacher-sub", email: currentEmail },
      invitation: { invitedEmail: oldEmail },
    });
    expect(JSON.stringify(responseBody(response))).not.toMatch(/tokenHash|https:\/\//i);
  });

  it("omits invitedEmail when the recorded recipient still matches the current email", async () => {
    const api = makeAdminApi({
      personEmail: currentEmail,
      invitedEmail: currentEmail.toUpperCase(),
    });
    const response = await api.handler(
      event(`/api/admin/bots/${botId}/people/lookup`, { email: currentEmail }),
    );

    expect(response.statusCode).toBe(200);
    expect(responseBody(response).person.email).toBe(currentEmail);
    expect(responseBody(response).invitation).not.toHaveProperty("invitedEmail");
  });

  it("retains the old recipient on a confirmed operation replay after an email change", async () => {
    const api = makeAdminApi({ personEmail: currentEmail, invitedEmail: oldEmail });
    const response = await api.handler(
      event(`/api/admin/bots/${botId}/invitations`, {
        email: currentEmail,
        expectedSub: "teacher-sub",
        expectedRevision: 4,
        operationId,
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toMatchObject({
      person: { sub: "teacher-sub", email: currentEmail },
      invitation: { invitedEmail: oldEmail },
      operation: { id: operationId, status: "already_recorded" },
    });
    expect(api.store.registerInvitation).not.toHaveBeenCalled();
    expect(api.mail.sendInvitation).not.toHaveBeenCalled();
    expect(api.randomBytes).not.toHaveBeenCalled();
  });
});
