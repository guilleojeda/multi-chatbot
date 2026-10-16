import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const modulePath = fileURLToPath(new URL("../../api/invitations.ts", import.meta.url));
const now = 1_800_000_000_000;
const tokenBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));

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

function fixture(existingUser = null) {
  const identity = {
    getUserByEmail: vi.fn(async () => existingUser),
    createUser: vi.fn(async ({ email }) => ({
      sub: "new-account-sub",
      email,
      status: "FORCE_CHANGE_PASSWORD",
    })),
  };
  const store = { replacePendingInvitation: vi.fn(async () => undefined) };
  const mail = { sendInvitation: vi.fn(async () => ({ messageId: "ses-message-id" })) };
  const config = {
    botId: "docentes",
    projectName: "Proyecto de docentes de prueba",
    siteUrl: "https://example.cloudfront.net/",
    sender: "verified-sender@example.edu",
    invitationTtlMs: 7 * 24 * 60 * 60 * 1000,
  };
  const randomBytes = vi.fn(() => tokenBytes);
  return {
    deps: { config, identity, store, mail, now: () => now, randomBytes },
    config,
    identity,
    store,
    mail,
    randomBytes,
  };
}

describe("technical invitation provisioning", () => {
  it("creates a suppressed invited account and sends the correct hash-route link without storing its token", async () => {
    const provisionInvitation = await loadProvisioning();
    if (!provisionInvitation) return;
    const f = fixture();

    const result = await provisionInvitation(f.deps, { email: " Teacher@Example.edu " });

    expect(f.identity.createUser).toHaveBeenCalledExactlyOnceWith({
      email: "teacher@example.edu",
      messageAction: "SUPPRESS",
    });
    expect(f.randomBytes).toHaveBeenCalledWith(32);
    expect(f.store.replacePendingInvitation).toHaveBeenCalledTimes(1);
    expect(f.mail.sendInvitation).toHaveBeenCalledTimes(1);
    const saved = f.store.replacePendingInvitation.mock.calls[0][0];
    const sent = f.mail.sendInvitation.mock.calls[0][0];
    const token = tokenBytes.toString("base64url");
    expect(saved).toMatchObject({
      botId: "docentes",
      sub: "new-account-sub",
      email: "teacher@example.edu",
      kind: "new",
      expiresAt: now + f.config.invitationTtlMs,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(sent).toMatchObject({
      from: f.config.sender,
      to: "teacher@example.edu",
      projectName: f.config.projectName,
      expiresAt: saved.expiresAt,
    });
    const link = new URL(sent.url);
    expect(link.origin).toBe("https://example.cloudfront.net");
    expect(link.pathname).toBe("/");
    expect(link.search).toBe("");
    expect(link.hash.startsWith("#/invite?")).toBe(true);
    expect(new URLSearchParams(link.hash.split("?")[1]).get("token")).toBe(token);
    expect(result).toMatchObject({
      sub: "new-account-sub",
      botId: "docentes",
      messageId: "ses-message-id",
      expiresAt: saved.expiresAt,
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(sent.url);
  });

  it("reuses the common active identity when inviting another authorized bot and does not create a password", async () => {
    const provisionInvitation = await loadProvisioning();
    if (!provisionInvitation) return;
    const f = fixture({
      sub: "common-account-sub",
      email: "teacher@example.edu",
      status: "CONFIRMED",
      emailVerified: true,
    });
    f.config.botId = "other-project";
    f.config.siteUrl = "https://other-project.cloudfront.net/";

    await provisionInvitation(f.deps, { email: "teacher@example.edu" });

    expect(f.identity.createUser).not.toHaveBeenCalled();
    const saved = f.store.replacePendingInvitation.mock.calls[0][0];
    expect(saved).toMatchObject({
      sub: "common-account-sub",
      botId: "other-project",
      kind: "existing",
    });
    expect(f.mail.sendInvitation.mock.calls[0][0].url).toContain(
      "https://other-project.cloudfront.net/#/invite?",
    );
    expect(f.mail.sendInvitation.mock.calls[0][0]).not.toHaveProperty("password");
  });

  it("replaces a pending invitation before sending and never reports an email failure as delivered", async () => {
    const provisionInvitation = await loadProvisioning();
    if (!provisionInvitation) return;
    const f = fixture();
    const order = [];
    f.store.replacePendingInvitation.mockImplementation(async () => {
      order.push("save");
    });
    f.mail.sendInvitation.mockImplementation(async () => {
      order.push("send");
      throw new Error("SES rejected this email");
    });

    await expect(provisionInvitation(f.deps, { email: "teacher@example.edu" })).rejects.toThrow();
    expect(order).toEqual(["save", "send"]);
  });

  it("rejects a missing recipient before creating identity, invitation or email", async () => {
    const provisionInvitation = await loadProvisioning();
    if (!provisionInvitation) return;
    const f = fixture();

    await expect(provisionInvitation(f.deps, { email: " " })).rejects.toThrow();

    expect(f.identity.getUserByEmail).not.toHaveBeenCalled();
    expect(f.identity.createUser).not.toHaveBeenCalled();
    expect(f.store.replacePendingInvitation).not.toHaveBeenCalled();
    expect(f.mail.sendInvitation).not.toHaveBeenCalled();
  });
});
