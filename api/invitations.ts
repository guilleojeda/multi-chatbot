import { createHash } from "node:crypto";
import {
  StateChangedError,
  type AccountAccessStore,
  type AccessRecord,
  type InvitationRecord,
  type RegisterInvitationResult,
} from "./access.js";

export type InvitationUser = {
  sub: string;
  email: string;
  emailVerified?: boolean;
  status?: string;
};

export type InvitationConfig = {
  botId: string;
  projectName: string;
  siteUrl: string;
  sender: string;
  invitationTtlMs: number;
};

export type ProvisioningDependencies = {
  config: InvitationConfig;
  identity: {
    getUserByEmail(email: string): Promise<InvitationUser | null>;
    createUser(input: { email: string; messageAction: "SUPPRESS" }): Promise<InvitationUser>;
  };
  store: Pick<
    AccountAccessStore,
    "getAccess" | "getInvitation" | "registerInvitation" | "recordInvitationDelivery"
  >;
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

export type ProvisionInvitationInput = {
  email: string;
  operationId: string;
  expectedRevision: number;
  expectedSub: string | null;
};

export type ProvisionInvitationResult = {
  sub: string;
  botId: string;
  access: AccessRecord;
  invitation: InvitationRecord;
  created: boolean;
  expiresAt: number;
  messageId?: string;
};

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isHashableError(error: unknown): error is { name: string } {
  return (
    typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
  );
}

function isUsernameExists(error: unknown): boolean {
  return isHashableError(error) && error.name === "UsernameExistsException";
}

function isRejectedBySes(error: unknown): boolean {
  return isHashableError(error) && error.name === "MessageRejected";
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

function validateConfig(config: InvitationConfig): void {
  if (
    !config.botId ||
    !config.projectName ||
    !config.sender ||
    !Number.isFinite(config.invitationTtlMs) ||
    config.invitationTtlMs <= 0
  ) {
    throw new Error("Invitation configuration is incomplete.");
  }
}

function confirmedReplay(
  sub: string,
  botId: string,
  result: RegisterInvitationResult,
): ProvisionInvitationResult {
  return {
    sub,
    botId,
    access: result.access,
    invitation: result.invitation,
    created: false,
    expiresAt: result.invitation.expiresAt,
    ...(result.invitation.delivery.messageId
      ? { messageId: result.invitation.delivery.messageId }
      : {}),
  };
}

async function findReplay(
  deps: ProvisioningDependencies,
  input: ProvisionInvitationInput,
  access: AccessRecord | null,
): Promise<ProvisionInvitationResult | null> {
  const operation = access?.lastAdminOperation;
  if (!operation || operation.id !== input.operationId) return null;
  const invitation = await deps.store.getInvitation(operation.invitationHash);
  if (
    !invitation ||
    invitation.sub !== access.sub ||
    invitation.botId !== access.botId ||
    invitation.operationId !== input.operationId
  ) {
    throw new StateChangedError("The prior invitation operation can no longer be confirmed.");
  }
  return confirmedReplay(access.sub, access.botId, { access, invitation, created: false });
}

async function resolveAccount(
  deps: ProvisioningDependencies,
  email: string,
  expectedSub: string | null,
): Promise<InvitationUser> {
  let account = await deps.identity.getUserByEmail(email);
  if (account) {
    if (
      normalizeEmail(account.email) !== email ||
      (expectedSub !== null && account.sub !== expectedSub)
    ) {
      throw new StateChangedError("The observed Cognito identity changed before invitation.");
    }
    return account;
  }

  if (expectedSub !== null) {
    throw new StateChangedError("The observed Cognito identity is no longer available.");
  }

  try {
    account = await deps.identity.createUser({ email, messageAction: "SUPPRESS" });
  } catch (error) {
    if (!isUsernameExists(error)) throw error;
    account = await deps.identity.getUserByEmail(email);
    if (!account || normalizeEmail(account.email) !== email) {
      throw new StateChangedError("The Cognito identity changed during account creation.");
    }
  }

  if (
    typeof account.sub !== "string" ||
    account.sub.length === 0 ||
    typeof account.email !== "string" ||
    normalizeEmail(account.email) !== email ||
    (expectedSub !== null && account.sub !== expectedSub)
  ) {
    throw new StateChangedError("The account email could not be confirmed.");
  }
  return account;
}

export async function provisionInvitation(
  deps: ProvisioningDependencies,
  input: ProvisionInvitationInput,
): Promise<ProvisionInvitationResult> {
  const email = typeof input?.email === "string" ? normalizeEmail(input.email) : "";
  if (!isEmail(email)) throw new Error("Enter a valid recipient email address.");
  if (
    typeof input.operationId !== "string" ||
    input.operationId.trim().length === 0 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    (input.expectedSub !== null &&
      (typeof input.expectedSub !== "string" || input.expectedSub.length === 0))
  ) {
    throw new Error("Invitation operation details are invalid.");
  }
  validateConfig(deps.config);

  const account = await resolveAccount(deps, email, input.expectedSub);
  const identity = { sub: account.sub, botId: deps.config.botId };
  const currentAccess = await deps.store.getAccess(identity);
  const replay = await findReplay(deps, input, currentAccess);
  if (replay) return replay;

  const random = Buffer.from(deps.randomBytes(32));
  if (random.length !== 32) throw new Error("Could not create a secure invitation token.");
  const token = random.toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = deps.now() + deps.config.invitationTtlMs;
  if (!Number.isFinite(expiresAt)) throw new Error("Invitation expiry is invalid.");
  const url = invitationUrl(deps.config.siteUrl, token);

  const registered = await deps.store.registerInvitation({
    botId: deps.config.botId,
    sub: account.sub,
    email,
    tokenHash,
    expiresAt,
    expectedRevision: input.expectedRevision,
    operationId: input.operationId,
  });
  if (!registered.created) return confirmedReplay(account.sub, deps.config.botId, registered);

  let delivery: InvitationRecord["delivery"] = { status: "unconfirmed" };
  let messageId: string | undefined;
  try {
    const accepted = await deps.mail.sendInvitation({
      from: deps.config.sender,
      to: email,
      projectName: deps.config.projectName,
      url,
      expiresAt,
    });
    messageId = accepted.messageId;
    delivery = { status: "accepted", ...(messageId ? { messageId } : {}) };
  } catch (error) {
    delivery = { status: isRejectedBySes(error) ? "failed" : "unconfirmed" };
  }

  let deliveryRecorded = false;
  try {
    await deps.store.recordInvitationDelivery({
      botId: deps.config.botId,
      sub: account.sub,
      tokenHash,
      operationId: input.operationId,
      delivery,
    });
    deliveryRecorded = true;
  } catch {
    // The durable invitation remains confirmed; a delivery acknowledgement failure is separate.
  }

  let currentDelivery = deliveryRecorded ? delivery : { status: "unconfirmed" as const };
  if (!deliveryRecorded) {
    try {
      const saved = await deps.store.getInvitation(tokenHash);
      if (
        saved &&
        saved.sub === account.sub &&
        saved.botId === deps.config.botId &&
        saved.operationId === input.operationId
      ) {
        currentDelivery = saved.delivery;
      }
    } catch {
      currentDelivery = { status: "unconfirmed" };
    }
  }

  const invitation = { ...registered.invitation, delivery: currentDelivery };
  return {
    sub: account.sub,
    botId: deps.config.botId,
    access: registered.access,
    invitation,
    created: true,
    expiresAt,
    ...(currentDelivery.messageId ? { messageId: currentDelivery.messageId } : {}),
  };
}
