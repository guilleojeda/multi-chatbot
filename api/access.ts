export type AccessState = "none" | "active" | "revoked";

export type InvitationDeliveryStatus = "accepted" | "failed" | "unconfirmed";

export type InvitationDelivery = {
  status: InvitationDeliveryStatus;
  messageId?: string;
};

export type AccessRecord = {
  sub: string;
  botId: string;
  access: AccessState;
  revision: number;
  currentInvitation?: { hash: string; expiresAt: number };
  activationClaim?: { invitationHash: string; claimedAt: string };
  lastAdminOperation?: { id: string; kind: "invite"; invitationHash: string };
};

export type InvitationRecord = {
  id: string;
  tokenHash: string;
  sub: string;
  botId: string;
  email: string;
  expiresAt: number;
  operationId: string;
  delivery: InvitationDelivery;
  usedAt?: string;
};

export type RegisterInvitationInput = {
  botId: string;
  sub: string;
  email: string;
  tokenHash: string;
  expiresAt: number;
  expectedRevision: number;
  operationId: string;
};

export type RegisterInvitationResult = {
  access: AccessRecord;
  invitation: InvitationRecord;
  created: boolean;
};

export type RecordInvitationDeliveryInput = {
  botId: string;
  sub: string;
  tokenHash: string;
  operationId: string;
  delivery: InvitationDelivery;
};

export type ActivationInput = { sub: string; botId: string; tokenHash: string };

export type AccountAccessStore = {
  getAccess(input: { sub: string; botId: string }): Promise<AccessRecord | null>;
  getInvitation(tokenHash: string): Promise<InvitationRecord | null>;
  registerInvitation(input: RegisterInvitationInput): Promise<RegisterInvitationResult>;
  recordInvitationDelivery(input: RecordInvitationDeliveryInput): Promise<void>;
  reserveActivation(input: ActivationInput): Promise<boolean>;
  releaseActivation(input: ActivationInput): Promise<void>;
  consumeInvitation(input: ActivationInput): Promise<boolean>;
};

export class StateChangedError extends Error {
  readonly code = "STATE_CHANGED";

  constructor(message = "The observed account access changed before the operation completed.") {
    super(message);
    this.name = "StateChangedError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  try {
    return new Date(parsed).toISOString() === value;
  } catch {
    return false;
  }
}

function mapCurrentInvitation(value: unknown): AccessRecord["currentInvitation"] | null {
  if (!isRecord(value) || !isHash(value.hash) || typeof value.expiresAt !== "number") return null;
  if (!Number.isFinite(value.expiresAt)) return null;
  return { hash: value.hash, expiresAt: value.expiresAt };
}

function mapActivationClaim(value: unknown): AccessRecord["activationClaim"] | null {
  if (!isRecord(value) || !isHash(value.invitationHash) || !isIsoDate(value.claimedAt)) return null;
  return { invitationHash: value.invitationHash, claimedAt: value.claimedAt };
}

function mapLastAdminOperation(value: unknown): AccessRecord["lastAdminOperation"] | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.kind !== "invite" ||
    !isHash(value.invitationHash)
  ) {
    return null;
  }
  return { id: value.id, kind: "invite", invitationHash: value.invitationHash };
}

export function mapAccessRecord(
  value: Record<string, unknown> | undefined,
  identity: { sub: string; botId: string },
): AccessRecord | null {
  if (!value) return null;
  if (
    value.pk !== `BOT#${identity.botId}#USER#${identity.sub}` ||
    value.sk !== "ACCESS" ||
    value.sub !== identity.sub ||
    value.botId !== identity.botId ||
    (value.access !== "none" && value.access !== "active" && value.access !== "revoked") ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return null;
  }

  const currentInvitation =
    value.currentInvitation === undefined
      ? undefined
      : mapCurrentInvitation(value.currentInvitation);
  if (value.currentInvitation !== undefined && !currentInvitation) return null;
  const activationClaim =
    value.activationClaim === undefined ? undefined : mapActivationClaim(value.activationClaim);
  if (value.activationClaim !== undefined && !activationClaim) return null;
  const lastAdminOperation =
    value.lastAdminOperation === undefined
      ? undefined
      : mapLastAdminOperation(value.lastAdminOperation);
  if (value.lastAdminOperation !== undefined && !lastAdminOperation) return null;

  return {
    sub: identity.sub,
    botId: identity.botId,
    access: value.access,
    revision: value.revision,
    ...(currentInvitation ? { currentInvitation } : {}),
    ...(activationClaim ? { activationClaim } : {}),
    ...(lastAdminOperation ? { lastAdminOperation } : {}),
  };
}

function mapDelivery(value: unknown): InvitationDelivery | null {
  if (!isRecord(value)) return null;
  if (value.status !== "accepted" && value.status !== "failed" && value.status !== "unconfirmed") {
    return null;
  }
  if (value.messageId !== undefined && typeof value.messageId !== "string") return null;
  return {
    status: value.status,
    ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
  };
}

export function mapInvitationRecord(
  value: Record<string, unknown> | undefined,
): InvitationRecord | null {
  if (
    !value ||
    value.sk !== "INVITATION" ||
    !isHash(value.tokenHash) ||
    value.id !== value.tokenHash ||
    value.pk !== `INVITE#${value.tokenHash}` ||
    typeof value.botId !== "string" ||
    value.botId.length === 0 ||
    typeof value.sub !== "string" ||
    value.sub.length === 0 ||
    typeof value.email !== "string" ||
    value.email.length === 0 ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    typeof value.operationId !== "string" ||
    value.operationId.length === 0
  ) {
    return null;
  }

  const delivery = mapDelivery(value.delivery);
  if (!delivery || (value.usedAt !== undefined && !isIsoDate(value.usedAt))) return null;
  return {
    id: value.id,
    tokenHash: value.tokenHash,
    sub: value.sub,
    botId: value.botId,
    email: value.email,
    expiresAt: value.expiresAt,
    operationId: value.operationId,
    delivery,
    ...(typeof value.usedAt === "string" ? { usedAt: value.usedAt } : {}),
  };
}

export function assertAccessRecord(
  value: Record<string, unknown> | undefined,
  identity: { sub: string; botId: string },
): AccessRecord {
  const mapped = mapAccessRecord(value, identity);
  if (!mapped) throw new Error("Stored account access record is invalid.");
  return mapped;
}

export function assertInvitationRecord(
  value: Record<string, unknown> | undefined,
): InvitationRecord {
  const mapped = mapInvitationRecord(value);
  if (!mapped) throw new Error("Stored invitation record is invalid.");
  return mapped;
}
