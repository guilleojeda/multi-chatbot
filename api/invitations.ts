import { createHash } from "node:crypto";

export type InvitationUser = {
  sub: string;
  email: string;
  emailVerified?: boolean;
  status?: string;
};

type InvitationConfig = {
  botId: string;
  projectName: string;
  siteUrl: string;
  sender: string;
  invitationTtlMs: number;
};

type InvitationRecord = {
  botId: string;
  sub: string;
  email: string;
  kind: "new" | "existing";
  tokenHash: string;
  expiresAt: number;
};

type ProvisioningDependencies = {
  config: InvitationConfig;
  identity: {
    getUserByEmail(email: string): Promise<InvitationUser | null>;
    createUser(input: { email: string; messageAction: "SUPPRESS" }): Promise<InvitationUser>;
  };
  store: { replacePendingInvitation(invitation: InvitationRecord): Promise<void> };
  mail: {
    sendInvitation(input: {
      from: string;
      to: string;
      projectName: string;
      url: string;
      expiresAt: number;
    }): Promise<{ messageId?: string }>;
  };
  now: () => number;
  randomBytes: (size: number) => Buffer | Uint8Array;
};

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function invitationUrl(siteUrl: string, token: string): string {
  const url = new URL(siteUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search) {
    throw new Error(
      "The invitation site URL must be an HTTPS origin without credentials or query parameters.",
    );
  }
  url.pathname = "/";
  url.hash = `/invite?token=${encodeURIComponent(token)}`;
  return url.toString();
}

export async function provisionInvitation(
  deps: ProvisioningDependencies,
  input: { email: string },
): Promise<{
  sub: string;
  botId: string;
  messageId?: string;
  expiresAt: number;
}> {
  const email = typeof input?.email === "string" ? normalizeEmail(input.email) : "";
  if (!isEmail(email)) throw new Error("Enter a valid recipient email address.");

  const { config } = deps;
  if (
    !config.botId ||
    !config.projectName ||
    !config.sender ||
    !Number.isFinite(config.invitationTtlMs) ||
    config.invitationTtlMs <= 0
  ) {
    throw new Error("Invitation configuration is incomplete.");
  }

  const existing = await deps.identity.getUserByEmail(email);
  let account: InvitationUser;
  if (existing) {
    account = existing;
  } else {
    account = await deps.identity.createUser({ email, messageAction: "SUPPRESS" });
  }

  if (
    typeof account.sub !== "string" ||
    account.sub.length === 0 ||
    typeof account.email !== "string" ||
    normalizeEmail(account.email) !== email
  ) {
    throw new Error("The account email could not be confirmed.");
  }

  const random = Buffer.from(deps.randomBytes(32));
  if (random.length !== 32) throw new Error("Could not create a secure invitation token.");
  const token = random.toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = deps.now() + config.invitationTtlMs;
  if (!Number.isFinite(expiresAt)) throw new Error("Invitation expiry is invalid.");

  const kind = account.status === "CONFIRMED" ? "existing" : "new";
  const url = invitationUrl(config.siteUrl, token);

  await deps.store.replacePendingInvitation({
    botId: config.botId,
    sub: account.sub,
    email,
    kind,
    tokenHash,
    expiresAt,
  });

  const sent = await deps.mail.sendInvitation({
    from: config.sender,
    to: email,
    projectName: config.projectName,
    url,
    expiresAt,
  });

  return {
    sub: account.sub,
    botId: config.botId,
    ...(sent.messageId ? { messageId: sent.messageId } : {}),
    expiresAt,
  };
}
