import type { PublicConfig } from "./api";
import type { ChatRequest } from "./chat-api";

export type ChatJournalEntry =
  | { request: ChatRequest; admitted: false }
  | { request: Omit<ChatRequest, "text">; admitted: true; ordinal: number };

type Owner = { sub: string; botId: string };
type StoredJournal = {
  version: 2;
  scope: string[];
  sub: string;
  botId: string;
  request: ChatRequest | Omit<ChatRequest, "text">;
  admitted: boolean;
  ordinal?: number;
};

const prefix = "chat-journal:v2";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function scopeFor(config: PublicConfig): string[] {
  return [
    config.region,
    config.clientId,
    config.apiBaseUrl,
    config.runtimeArn ?? "",
    config.runtimeQualifier ?? "",
    config.botId,
  ];
}

function encoded(value: unknown) {
  return encodeURIComponent(JSON.stringify(value));
}

function entryKey(config: PublicConfig, owner: Owner) {
  return `${prefix}:entry:${encoded([...scopeFor(config), owner.sub, owner.botId])}`;
}

function ownerKey(config: PublicConfig) {
  return `${prefix}:owner:${encoded(scopeFor(config))}`;
}

function validRequest(value: unknown, admitted: boolean): value is StoredJournal["request"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (
    request.version !== 2 ||
    (request.operation !== "start" && request.operation !== "message") ||
    typeof request.conversationId !== "string" ||
    !uuidPattern.test(request.conversationId) ||
    typeof request.queryId !== "string" ||
    !uuidPattern.test(request.queryId) ||
    !Number.isSafeInteger(request.baseOrdinal) ||
    (request.baseOrdinal as number) < 0 ||
    (request.operation === "start" && request.baseOrdinal !== 0) ||
    (request.operation === "message" && (request.baseOrdinal as number) === 0)
  ) {
    return false;
  }
  if (admitted) return !Object.hasOwn(request, "text");
  return typeof request.text === "string" && request.text.trim().length > 0;
}

function validStoredJournal(
  value: unknown,
  config: PublicConfig,
  owner: Owner,
): value is StoredJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 2 ||
    JSON.stringify(record.scope) !== JSON.stringify(scopeFor(config)) ||
    record.sub !== owner.sub ||
    record.botId !== owner.botId ||
    typeof record.admitted !== "boolean" ||
    !validRequest(record.request, record.admitted)
  ) {
    return false;
  }
  if (record.admitted) {
    return (
      Number.isSafeInteger(record.ordinal) &&
      record.ordinal === (record.request as ChatRequest).baseOrdinal + 1
    );
  }
  return record.ordinal === undefined;
}

function storage() {
  return window.sessionStorage;
}

function removeQuietly(key: string) {
  try {
    storage().removeItem(key);
  } catch {
    // An inaccessible storage area cannot be repaired from this page.
  }
}

export function readChatJournal(config: PublicConfig, owner: Owner): ChatJournalEntry | null {
  const store = storage();
  const pointerKey = ownerKey(config);
  const pointedSub = store.getItem(pointerKey);
  if (pointedSub && pointedSub !== owner.sub) {
    removeQuietly(entryKey(config, { sub: pointedSub, botId: owner.botId }));
    removeQuietly(pointerKey);
  }

  const key = entryKey(config, owner);
  const raw = store.getItem(key);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    removeQuietly(key);
    removeQuietly(pointerKey);
    return null;
  }
  if (!validStoredJournal(parsed, config, owner)) {
    removeQuietly(key);
    removeQuietly(pointerKey);
    return null;
  }
  return {
    ...(parsed.admitted
      ? {
          request: parsed.request as Omit<ChatRequest, "text">,
          admitted: true as const,
          ordinal: parsed.ordinal as number,
        }
      : { request: parsed.request as ChatRequest, admitted: false as const }),
  };
}

export function writePendingChatJournal(config: PublicConfig, owner: Owner, request: ChatRequest) {
  const key = entryKey(config, owner);
  const pointerKey = ownerKey(config);
  const stored: StoredJournal = {
    version: 2,
    scope: scopeFor(config),
    sub: owner.sub,
    botId: owner.botId,
    request,
    admitted: false,
  };
  const store = storage();
  const previousEntry = store.getItem(key);
  const previousOwner = store.getItem(pointerKey);
  let entryWritten = false;
  try {
    store.setItem(key, JSON.stringify(stored));
    entryWritten = true;
    store.setItem(pointerKey, owner.sub);
  } catch (error) {
    if (entryWritten) {
      try {
        if (previousEntry === null) store.removeItem(key);
        else store.setItem(key, previousEntry);
      } catch {
        // Preserve the previous entry whenever the storage implementation permits it.
      }
    }
    try {
      if (previousOwner === null) store.removeItem(pointerKey);
      else store.setItem(pointerKey, previousOwner);
    } catch {
      // A failed pointer update must not replace the best available owner reference.
    }
    throw error;
  }
}

export function markChatJournalAdmitted(
  config: PublicConfig,
  owner: Owner,
  request: Pick<ChatRequest, "operation" | "conversationId" | "queryId" | "baseOrdinal">,
  ordinal: number,
) {
  const key = entryKey(config, owner);
  const stored: StoredJournal = {
    version: 2,
    scope: scopeFor(config),
    sub: owner.sub,
    botId: owner.botId,
    request: {
      version: 2,
      operation: request.operation,
      conversationId: request.conversationId,
      queryId: request.queryId,
      baseOrdinal: request.baseOrdinal,
    },
    admitted: true,
    ordinal,
  };
  try {
    storage().setItem(key, JSON.stringify(stored));
  } catch (error) {
    removeQuietly(key);
    throw error;
  }
}

export function clearChatJournal(config: PublicConfig, owner: Owner) {
  const store = storage();
  const pointerKey = ownerKey(config);
  removeQuietly(entryKey(config, owner));
  try {
    if (store.getItem(pointerKey) === owner.sub) store.removeItem(pointerKey);
  } catch {
    // The reference is cleared in memory even if storage is inaccessible.
  }
}

export function clearChatJournalForConfiguredBot(config: PublicConfig) {
  const store = storage();
  const pointerKey = ownerKey(config);
  try {
    const sub = store.getItem(pointerKey);
    if (sub) removeQuietly(entryKey(config, { sub, botId: config.botId }));
    store.removeItem(pointerKey);
  } catch {
    // Membership failure still invalidates all in-memory state.
  }
}
