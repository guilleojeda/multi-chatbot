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

type LegacyStoredJournal = {
  version: 2;
  scope: string[];
  sub: string;
  botId: string;
  request: ChatRequest | Omit<ChatRequest, "text">;
  admitted: boolean;
  ordinal?: number;
};

const prefix = "chat-journal:v3";
const legacyPrefix = "chat-journal:v2";
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

function legacyEntryKey(config: PublicConfig, owner: Owner) {
  return `${legacyPrefix}:entry:${encoded([...scopeFor(config), owner.sub, owner.botId])}`;
}

function legacyOwnerKey(config: PublicConfig) {
  return `${legacyPrefix}:owner:${encoded(scopeFor(config))}`;
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
  version: 2 | 3,
): value is StoredJournal | LegacyStoredJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== version ||
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

function publicEntry(record: StoredJournal | LegacyStoredJournal): ChatJournalEntry {
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

function migrateLegacy(config: PublicConfig, owner: Owner): ChatJournalEntry | null {
  const store = storage();
  const oldOwnerKey = legacyOwnerKey(config);
  const oldEntryKey = legacyEntryKey(config, owner);
  const pointedSub = store.getItem(oldOwnerKey);
  if (pointedSub && pointedSub !== owner.sub) {
    removeQuietly(legacyEntryKey(config, { sub: pointedSub, botId: owner.botId }));
    removeQuietly(oldOwnerKey);
    return null;
  }
  const raw = store.getItem(oldEntryKey);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    removeQuietly(oldEntryKey);
    return null;
  }
  if (!validStoredJournal(parsed, config, owner, 2)) {
    removeQuietly(oldEntryKey);
    return null;
  }

  const legacy = parsed as LegacyStoredJournal;
  const conversationId = legacy.request.conversationId;
  const nextEntry = { ...legacy, version: 3 } as StoredJournal;
  const ids = readIndex(config, owner);
  const previousEntry = store.getItem(entryKey(config, owner, conversationId));
  const previousIndex = store.getItem(indexKey(config, owner));
  const previousOwner = store.getItem(ownerKey(config));
  try {
    store.setItem(entryKey(config, owner, conversationId), JSON.stringify(nextEntry));
    writeIndex(config, owner, [...ids, conversationId]);
    store.setItem(ownerKey(config), JSON.stringify(owner));
  } catch (error) {
    try {
      if (previousEntry === null) store.removeItem(entryKey(config, owner, conversationId));
      else store.setItem(entryKey(config, owner, conversationId), previousEntry);
    } catch {
      // Keep every other conversation reference intact when rollback is constrained.
    }
    try {
      if (previousIndex === null) store.removeItem(indexKey(config, owner));
      else store.setItem(indexKey(config, owner), previousIndex);
    } catch {
      // The old journal remains available for another migration attempt.
    }
    try {
      if (previousOwner === null) store.removeItem(ownerKey(config));
      else store.setItem(ownerKey(config), previousOwner);
    } catch {
      // The old journal remains available for another migration attempt.
    }
    throw error;
  }
  removeQuietly(oldEntryKey);
  removeQuietly(oldOwnerKey);
  return publicEntry(nextEntry);
}

export function readChatJournals(
  config: PublicConfig,
  owner: Owner,
): Map<string, ChatJournalEntry> {
  const store = storage();
  const pointerKey = ownerKey(config);
  const pointedRaw = store.getItem(pointerKey);
  if (pointedRaw) {
    let pointed: unknown = pointedRaw;
    try {
      pointed = JSON.parse(pointedRaw) as unknown;
    } catch {
      // The v2 pointer stored the subject directly.
    }
    const pointedOwner =
      typeof pointed === "string"
        ? { sub: pointed, botId: owner.botId }
        : pointed && typeof pointed === "object" && !Array.isArray(pointed)
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
      !validStoredJournal(parsed, config, owner, 3) ||
      (parsed as StoredJournal).request.conversationId !== conversationId
    ) {
      removeQuietly(key);
      continue;
    }
    journals.set(conversationId, publicEntry(parsed as StoredJournal));
  }

  const legacy = migrateLegacy(config, owner);
  if (legacy) journals.set(legacy.request.conversationId, legacy);
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
  const key = entryKey(config, owner, request.conversationId);
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
  try {
    storage().setItem(key, JSON.stringify(stored));
  } catch (error) {
    removeQuietly(key);
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
  removeQuietly(legacyEntryKey(config, owner));
  removeQuietly(selectionKey(config));
  try {
    const raw = store.getItem(ownerKey(config));
    if (raw) {
      let pointed: unknown = raw;
      try {
        pointed = JSON.parse(raw) as unknown;
      } catch {
        // A legacy v2 pointer stores the subject directly.
      }
      if (pointed === owner.sub || (pointed as Owner)?.sub === owner.sub) {
        store.removeItem(ownerKey(config));
      }
    }
    if (store.getItem(legacyOwnerKey(config)) === owner.sub) {
      store.removeItem(legacyOwnerKey(config));
    }
  } catch {
    // Logout still invalidates in-memory consumers if storage is unavailable.
  }
}

export function clearChatJournalForConfiguredBot(config: PublicConfig) {
  const store = storage();
  const raw = store.getItem(ownerKey(config)) ?? store.getItem(legacyOwnerKey(config));
  if (!raw) return;
  let owner: Owner = { sub: raw, botId: config.botId };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Owner).sub === "string" &&
      typeof (parsed as Owner).botId === "string"
    ) {
      owner = parsed as Owner;
    }
  } catch {
    // v2 stored only the subject.
  }
  clearChatJournal(config, owner);
  removeQuietly(ownerKey(config));
  removeQuietly(legacyOwnerKey(config));
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
