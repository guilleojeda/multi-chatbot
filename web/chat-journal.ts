import type { PublicConfig } from "./api";
import type { ChatRequest } from "./chat-api";

export type ChatJournalEntry =
  | { request: ChatRequest; admitted: false }
  | { request: Omit<ChatRequest, "text">; admitted: true; ordinal: number };

type Owner = { sub: string; botId: string };
type StoredJournal = {
  version: 3;
  scope: string[];
  sub: string;
  botId: string;
  request: ChatRequest | Omit<ChatRequest, "text">;
  admitted: boolean;
  ordinal?: number;
};

const prefix = "chat-journal:v3";
const selectionPrefix = "chat-selection:v1";
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

function entryKey(config: PublicConfig, owner: Owner, conversationId: string) {
  return `${prefix}:entry:${encoded([...scopeFor(config), owner.sub, owner.botId, conversationId])}`;
}

function ownerKey(config: PublicConfig) {
  return `${prefix}:owner:${encoded(scopeFor(config))}`;
}

function indexKey(config: PublicConfig, owner: Owner) {
  return `${prefix}:index:${encoded([...scopeFor(config), owner.sub, owner.botId])}`;
}

function selectionKey(config: PublicConfig) {
  return `${selectionPrefix}:${encoded(scopeFor(config))}`;
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
    record.version !== 3 ||
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

function readIndex(config: PublicConfig, owner: Owner): string[] {
  const raw = storage().getItem(indexKey(config, owner));
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string" && uuidPattern.test(item))
    ) {
      return [...new Set(value)];
    }
  } catch {
    // Invalid index is replaced only after its records are recovered below.
  }
  return [];
}

function publicEntry(record: StoredJournal): ChatJournalEntry {
  return record.admitted
    ? {
        request: record.request as Omit<ChatRequest, "text">,
        admitted: true,
        ordinal: record.ordinal as number,
      }
    : { request: record.request as ChatRequest, admitted: false };
}

function writeIndex(config: PublicConfig, owner: Owner, ids: string[]) {
  storage().setItem(indexKey(config, owner), JSON.stringify([...new Set(ids)]));
}

export function readChatJournals(
  config: PublicConfig,
  owner: Owner,
): Map<string, ChatJournalEntry> {
  const store = storage();
  const pointerKey = ownerKey(config);
  const pointedRaw = store.getItem(pointerKey);
  if (pointedRaw) {
    let pointed: unknown;
    try {
      pointed = JSON.parse(pointedRaw) as unknown;
    } catch {
      pointed = null;
    }
    const pointedOwner =
      pointed &&
      typeof pointed === "object" &&
      !Array.isArray(pointed) &&
      typeof (pointed as Owner).sub === "string" &&
      typeof (pointed as Owner).botId === "string"
        ? (pointed as Owner)
        : null;
    if (pointedOwner && (pointedOwner.sub !== owner.sub || pointedOwner.botId !== owner.botId)) {
      clearChatJournal(config, pointedOwner);
    }
  }

  const ids = readIndex(config, owner);
  const journals = new Map<string, ChatJournalEntry>();
  for (const conversationId of ids) {
    const key = entryKey(config, owner, conversationId);
    const raw = store.getItem(key);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      removeQuietly(key);
      continue;
    }
    if (
      !validStoredJournal(parsed, config, owner) ||
      (parsed as StoredJournal).request.conversationId !== conversationId
    ) {
      removeQuietly(key);
      continue;
    }
    journals.set(conversationId, publicEntry(parsed as StoredJournal));
  }

  return journals;
}

export function readChatJournal(config: PublicConfig, owner: Owner): ChatJournalEntry | null {
  const journals = readChatJournals(config, owner);
  const entries = [...journals.values()];
  return entries.at(-1) ?? null;
}

export function writePendingChatJournal(config: PublicConfig, owner: Owner, request: ChatRequest) {
  const store = storage();
  const key = entryKey(config, owner, request.conversationId);
  const pointerKey = ownerKey(config);
  const listKey = indexKey(config, owner);
  const previousEntry = store.getItem(key);
  const previousIndex = store.getItem(listKey);
  const previousOwner = store.getItem(pointerKey);
  const ids = readIndex(config, owner);
  const stored: StoredJournal = {
    version: 3,
    scope: scopeFor(config),
    sub: owner.sub,
    botId: owner.botId,
    request,
    admitted: false,
  };
  try {
    store.setItem(key, JSON.stringify(stored));
    writeIndex(config, owner, [...ids, request.conversationId]);
    store.setItem(pointerKey, JSON.stringify(owner));
  } catch (error) {
    try {
      if (previousEntry === null) store.removeItem(key);
      else store.setItem(key, previousEntry);
    } catch {
      // Preserve existing data as far as the storage implementation allows.
    }
    try {
      if (previousIndex === null) store.removeItem(listKey);
      else store.setItem(listKey, previousIndex);
    } catch {
      // Other references remain in their independent entries.
    }
    try {
      if (previousOwner === null) store.removeItem(pointerKey);
      else store.setItem(pointerKey, previousOwner);
    } catch {
      // The request is not sent if its durable reference cannot be written.
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
  const store = storage();
  const key = entryKey(config, owner, request.conversationId);
  const listKey = indexKey(config, owner);
  const pointerKey = ownerKey(config);
  const previousIndex = store.getItem(listKey);
  const previousOwner = store.getItem(pointerKey);
  const ids = readIndex(config, owner);
  const alreadyIndexed = ids.includes(request.conversationId);
  let ownerMatches = false;
  if (previousOwner !== null) {
    try {
      const value: unknown = JSON.parse(previousOwner);
      ownerMatches =
        Boolean(value) &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Owner).sub === owner.sub &&
        (value as Owner).botId === owner.botId;
    } catch {
      ownerMatches = false;
    }
  }
  const stored: StoredJournal = {
    version: 3,
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
  let entryWritten = false;
  try {
    store.setItem(key, JSON.stringify(stored));
    entryWritten = true;
    if (!alreadyIndexed) writeIndex(config, owner, [...ids, request.conversationId]);
    if (!ownerMatches) store.setItem(pointerKey, JSON.stringify(owner));
  } catch (error) {
    // Never restore a pending entry's body after the server has confirmed admission.
    // Keep a minimized entry only when the existing index can still find it.
    if (!entryWritten || !alreadyIndexed) removeQuietly(key);
    try {
      if (previousIndex === null) store.removeItem(listKey);
      else store.setItem(listKey, previousIndex);
    } catch {
      // Other indexed conversation references remain untouched.
    }
    try {
      if (previousOwner === null) store.removeItem(pointerKey);
      else store.setItem(pointerKey, previousOwner);
    } catch {
      // Preserve the previous owner pointer as far as storage allows.
    }
    throw error;
  }
}

export function clearChatJournalEntry(config: PublicConfig, owner: Owner, conversationId: string) {
  removeQuietly(entryKey(config, owner, conversationId));
  try {
    const ids = readIndex(config, owner).filter((id) => id !== conversationId);
    if (ids.length) writeIndex(config, owner, ids);
    else storage().removeItem(indexKey(config, owner));
  } catch {
    // A stale index is harmless; missing entry is treated as removed on read.
  }
}

export function clearChatJournal(config: PublicConfig, owner: Owner) {
  const store = storage();
  const ids = readIndex(config, owner);
  for (const id of ids) removeQuietly(entryKey(config, owner, id));
  removeQuietly(indexKey(config, owner));
  removeQuietly(selectionKey(config));
  try {
    const raw = store.getItem(ownerKey(config));
    if (raw) {
      let pointed: unknown = null;
      try {
        pointed = JSON.parse(raw) as unknown;
      } catch {
        pointed = null;
      }
      if (
        pointed &&
        typeof pointed === "object" &&
        !Array.isArray(pointed) &&
        (pointed as Owner).sub === owner.sub &&
        (pointed as Owner).botId === owner.botId
      ) {
        store.removeItem(ownerKey(config));
      }
    }
  } catch {
    // Logout still invalidates in-memory consumers if storage is unavailable.
  }
}

export function clearChatJournalForConfiguredBot(config: PublicConfig) {
  const store = storage();
  const raw = store.getItem(ownerKey(config));
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as Owner).sub !== "string" ||
    (parsed as Owner).botId !== config.botId
  ) {
    return;
  }
  const owner = parsed as Owner;
  clearChatJournal(config, owner);
  removeQuietly(ownerKey(config));
}

export function readChatSelection(config: PublicConfig, owner: Owner): string | null {
  const raw = storage().getItem(selectionKey(config));
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Owner).sub === owner.sub &&
      (value as Owner).botId === owner.botId &&
      typeof (value as { conversationId?: unknown }).conversationId === "string" &&
      uuidPattern.test((value as { conversationId: string }).conversationId)
    ) {
      return (value as { conversationId: string }).conversationId;
    }
  } catch {
    // Ignore an invalid selection and let the server history supply the view.
  }
  return null;
}

export function writeChatSelection(
  config: PublicConfig,
  owner: Owner,
  conversationId: string | null,
) {
  const key = selectionKey(config);
  if (conversationId === null) {
    removeQuietly(key);
    return;
  }
  storage().setItem(key, JSON.stringify({ ...owner, conversationId }));
}
