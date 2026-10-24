import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { MessageData } from "@strands-agents/sdk";
import type {
  AppendChunkInput,
  CompleteTurnInput,
  ContextSnapshot,
  ContextReference,
  ConversationContext,
  ConversationMeta,
  DocumentContext,
  ContinueTurnInput,
  FailTurnInput,
  QuotaView,
  StartTurnInput,
  SummaryVersion,
  SubmissionSnapshot,
  TurnManifest,
} from "./contracts.js";
import {
  createContextStorage,
  dynamoItemSize,
  readSummaryPointer,
  validateContextSnapshot,
  validateSummaryVersion,
} from "./context-storage.js";
import { createHistoryLabel, createHistoryOrder } from "./history-projection.js";
import { maxDynamoTextChunkBytes, splitUtf8Text } from "./text.js";

type ChunkRole = "user" | "assistant";
type TextChunk = { index: number; text: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const turnRecordPattern = /^TURN#(\d+)$/;
const chunkPrefixPattern = /^TURN#(\d+)#/;
const chunkRecordPattern = /^TURN#(\d+)#([0-9a-f-]{36})#(USER|ASSISTANT)#(\d+)$/i;
const contextChunkRecordPattern = /^TURN#(\d+)#CONTEXT#(\d+)$/;
const documentContextChunkRecordPattern = /^TURN#(\d+)#DOCUMENT#(\d+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isConversationMeta(value: unknown, conversationId: string): value is ConversationMeta {
  return (
    isRecord(value) &&
    value.pk === `CONV#${conversationId}` &&
    value.sk === "META" &&
    value.conversationId === conversationId &&
    typeof value.sub === "string" &&
    value.sub.length > 0 &&
    typeof value.botId === "string" &&
    value.botId.length > 0 &&
    isPositiveSafeInteger(value.lastOrdinal) &&
    (value.lastQueryId === undefined ||
      (typeof value.lastQueryId === "string" && value.lastQueryId.length > 0)) &&
    (value.activeQueryId === undefined ||
      (typeof value.activeQueryId === "string" && value.activeQueryId.length > 0)) &&
    (value.closed === undefined || typeof value.closed === "boolean")
  );
}

function manifestCount(value: unknown): number | null {
  if (!isRecord(value) || value.complete !== true || !isPositiveSafeInteger(value.count)) {
    return null;
  }
  return value.count;
}

function contextManifestCount(value: unknown): number | null {
  if (
    !isRecord(value) ||
    value.complete !== true ||
    typeof value.count !== "number" ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  ) {
    return null;
  }
  return value.count;
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (Array.isArray(value)) {
    ancestors.add(value);
    const valid = value.every((entry) => isJsonValue(entry, ancestors));
    ancestors.delete(value);
    return valid;
  }
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalNonEmptyString(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || isNonEmptyString(value[key]);
}

function isDocumentContext(value: unknown): value is DocumentContext {
  if (
    !isRecord(value) ||
    !isJsonValue(value) ||
    !isNonEmptyString(value.knowledgeBaseId) ||
    !isNonEmptyString(value.query) ||
    !isNonEmptyString(value.revision) ||
    typeof value.retrievedAt !== "number" ||
    !Number.isFinite(value.retrievedAt) ||
    (value.status !== "results" && value.status !== "empty") ||
    !Array.isArray(value.results) ||
    (value.status === "empty" && value.results.length !== 0) ||
    (value.status === "results" && value.results.length === 0) ||
    !isOptionalNonEmptyString(value, "requestId")
  ) {
    return false;
  }

  if (
    !value.results.every((result) => {
      if (
        !isRecord(result) ||
        !isNonEmptyString(result.text) ||
        (result.location !== undefined && !isRecord(result.location)) ||
        (result.metadata !== undefined && !isRecord(result.metadata)) ||
        (result.score !== undefined &&
          (typeof result.score !== "number" || !Number.isFinite(result.score))) ||
        (result.documentId !== undefined && !isNonEmptyString(result.documentId))
      ) {
        return false;
      }
      return true;
    })
  ) {
    return false;
  }

  if (value.reformulation === undefined) return true;
  const reformulation = value.reformulation;
  return (
    isRecord(reformulation) &&
    isNonEmptyString(reformulation.modelId) &&
    Number.isSafeInteger(reformulation.inputTokens) &&
    Number(reformulation.inputTokens) >= 0 &&
    isOptionalNonEmptyString(reformulation, "requestId") &&
    isOptionalNonEmptyString(reformulation, "countRequestId") &&
    (reformulation.metrics === undefined ||
      (isRecord(reformulation.metrics) &&
        Object.values(reformulation.metrics).every(
          (metric) => typeof metric === "number" && Number.isFinite(metric),
        )))
  );
}

function serializeDocumentContext(value: DocumentContext): string[] {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") {
    throw new TypeError("Document context cannot be serialized for admission.");
  }
  return splitUtf8Text(serialized);
}

function partialManifestCount(value: unknown): number | null {
  if (
    !isRecord(value) ||
    typeof value.complete !== "boolean" ||
    typeof value.count !== "number" ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  ) {
    return null;
  }
  return value.count;
}

function assemblePrefix(fragments: TextChunk[], count: number, queryId: string): string {
  if (fragments.length !== count) {
    throw new Error(`Conversation query ${queryId} has an incomplete answer prefix.`);
  }
  const ordered = [...fragments].sort((left, right) => left.index - right.index);
  for (let index = 0; index < count; index += 1) {
    if (ordered[index].index !== index) {
      throw new Error(`Conversation query ${queryId} has an invalid answer cursor.`);
    }
  }
  return ordered.map(({ text }) => text).join("");
}

function assembleText(
  fragments: TextChunk[],
  count: number,
  role: ChunkRole | "context" | "document context",
  queryId: string,
): string {
  if (fragments.length !== count) {
    throw new Error(`Completed conversation query ${queryId} has an incomplete ${role}.`);
  }
  const ordered = [...fragments].sort((left, right) => left.index - right.index);
  for (let index = 0; index < count; index += 1) {
    if (ordered[index].index !== index) {
      throw new Error(`Completed conversation query ${queryId} has invalid ${role} chunk order.`);
    }
  }
  const text = ordered.map(({ text: chunkText }) => chunkText).join("");
  if (text.trim().length === 0) {
    throw new Error(`Completed conversation query ${queryId} has empty ${role} text.`);
  }
  return text;
}

function parseContextReferences(input: {
  ordinal: number;
  queryId: string;
  count: number | undefined;
  chunks: Record<string, unknown>[];
  partition: string;
  conversationId: string;
  turns: Map<string, Record<string, unknown>>;
  verifyTargets?: boolean;
}): ContextReference[] {
  const {
    ordinal,
    queryId,
    count,
    chunks,
    partition,
    conversationId,
    turns,
    verifyTargets = true,
  } = input;
  const contextRecords = chunks.filter((chunk) => String(chunk.sk).includes("#CONTEXT#"));
  if (count === undefined) {
    if (contextRecords.length > 0) {
      throw new Error("Conversation context has reference chunks without a manifest.");
    }
    return [];
  }
  if (contextRecords.length !== count) {
    throw new Error("Conversation context has an incomplete reference manifest.");
  }
  if (count === 0) return [];

  const fragments: TextChunk[] = [];
  for (const chunk of contextRecords) {
    const match = contextChunkRecordPattern.exec(String(chunk.sk));
    const index = match ? Number(match[2]) : Number.NaN;
    if (
      !match ||
      match[1] !== String(ordinal).padStart(8, "0") ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      String(index).padStart(8, "0") !== match[2] ||
      chunk.pk !== partition ||
      chunk.conversationId !== conversationId ||
      chunk.ordinal !== ordinal ||
      chunk.index !== index ||
      typeof chunk.text !== "string"
    ) {
      throw new Error(`Completed conversation query ${queryId} has an invalid context reference.`);
    }
    fragments.push({ index, text: chunk.text });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(assembleText(fragments, count, "context", queryId));
  } catch {
    throw new Error(`Completed conversation query ${queryId} has malformed context references.`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Completed conversation query ${queryId} has malformed context references.`);
  }

  const references: ContextReference[] = [];
  let previousOrdinal = 0;
  for (const value of parsed) {
    if (
      !isRecord(value) ||
      !isPositiveSafeInteger(value.ordinal) ||
      value.ordinal <= previousOrdinal ||
      value.ordinal >= ordinal ||
      typeof value.queryId !== "string" ||
      !uuidPattern.test(value.queryId)
    ) {
      throw new Error(`Completed conversation query ${queryId} has invalid context references.`);
    }
    if (verifyTargets) {
      const referencedTurn = turns.get(String(value.ordinal).padStart(8, "0"));
      if (
        !referencedTurn ||
        referencedTurn.status !== "completed" ||
        referencedTurn.ordinal !== value.ordinal ||
        referencedTurn.queryId !== value.queryId
      ) {
        throw new Error(`Completed conversation query ${queryId} references a missing turn.`);
      }
    }
    references.push({ ordinal: value.ordinal, queryId: value.queryId });
    previousOrdinal = value.ordinal;
  }
  return references;
}

function reconstructMessages(
  conversationId: string,
  items: unknown[],
  options: { validateContextReferences?: boolean } = {},
): ConversationContext {
  const partition = `CONV#${conversationId}`;
  const turns = new Map<string, Record<string, unknown>>();
  const chunks = new Map<string, Record<string, unknown>[]>();

  for (const item of items) {
    if (!isRecord(item) || typeof item.pk !== "string" || typeof item.sk !== "string") {
      throw new Error("Conversation context contains a malformed record.");
    }
    if (item.pk !== partition) {
      throw new Error("Conversation context contains a record from another partition.");
    }
    if (item.sk === "META") continue;

    const turnKeyMatch = turnRecordPattern.exec(item.sk);
    if (turnKeyMatch) {
      if (turns.has(turnKeyMatch[1])) {
        throw new Error("Conversation context contains a duplicate turn record.");
      }
      turns.set(turnKeyMatch[1], item);
      continue;
    }

    const chunkPrefixMatch = chunkPrefixPattern.exec(item.sk);
    if (!chunkPrefixMatch) {
      if (item.status === "failed" || item.status === "in_progress") continue;
      throw new Error("Conversation context contains an unrecognized record.");
    }
    const turnChunks = chunks.get(chunkPrefixMatch[1]) ?? [];
    turnChunks.push(item);
    chunks.set(chunkPrefixMatch[1], turnChunks);
  }

  const completedTurns: {
    ordinal: number;
    ordinalKey: string;
    queryId: string;
    questionCount: number;
    answerCount: number;
    contextCount: number | undefined;
    contextManifest: unknown;
    contextSnapshot: unknown;
  }[] = [];

  for (const [ordinalKey, turn] of turns) {
    if (turn.status !== "in_progress" && turn.status !== "failed" && turn.status !== "completed") {
      throw new Error("Conversation context contains a turn with an unknown status.");
    }
    if (turn.status !== "completed") continue;

    const ordinal = Number(ordinalKey);
    const questionCount = manifestCount(turn.questionManifest);
    const answerCount = manifestCount(turn.answerManifest);
    const contextCount =
      turn.contextManifest === undefined ? undefined : contextManifestCount(turn.contextManifest);
    if (
      !isPositiveSafeInteger(ordinal) ||
      String(ordinal).padStart(8, "0") !== ordinalKey ||
      turn.ordinal !== ordinal ||
      turn.pk !== partition ||
      turn.conversationId !== conversationId ||
      typeof turn.queryId !== "string" ||
      !uuidPattern.test(turn.queryId) ||
      questionCount === null ||
      answerCount === null ||
      (turn.contextManifest !== undefined && contextCount === null)
    ) {
      throw new Error("Completed conversation context has an invalid turn record.");
    }
    completedTurns.push({
      ordinal,
      ordinalKey,
      queryId: turn.queryId,
      questionCount,
      answerCount,
      contextCount: contextCount ?? undefined,
      contextManifest: turn.contextManifest,
      contextSnapshot: turn.contextSnapshot,
    });
  }

  for (const [ordinalKey] of chunks) {
    if (!turns.has(ordinalKey)) {
      throw new Error("Conversation context contains chunks without a turn record.");
    }
  }

  completedTurns.sort((left, right) => left.ordinal - right.ordinal);
  const messages: MessageData[] = [];
  const references: ContextReference[] = [];
  for (const turn of completedTurns) {
    const questionChunks: TextChunk[] = [];
    const answerChunks: TextChunk[] = [];
    const turnChunks = chunks.get(turn.ordinalKey) ?? [];
    for (const chunk of turnChunks) {
      if (String(chunk.sk).includes("#CONTEXT#")) continue;
      if (String(chunk.sk).includes("#DOCUMENT#")) continue;
      const keyMatch = chunkRecordPattern.exec(String(chunk.sk));
      const index = keyMatch ? Number(keyMatch[4]) : Number.NaN;
      const role: ChunkRole | null =
        keyMatch?.[3].toUpperCase() === "USER"
          ? "user"
          : keyMatch?.[3].toUpperCase() === "ASSISTANT"
            ? "assistant"
            : null;
      if (
        !keyMatch ||
        keyMatch[1] !== turn.ordinalKey ||
        keyMatch[2] !== turn.queryId ||
        !role ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        String(index).padStart(8, "0") !== keyMatch[4] ||
        chunk.pk !== partition ||
        chunk.conversationId !== conversationId ||
        chunk.queryId !== turn.queryId ||
        chunk.role !== role ||
        chunk.index !== index ||
        typeof chunk.text !== "string"
      ) {
        throw new Error(`Completed conversation query ${turn.queryId} has a malformed text chunk.`);
      }
      const collection = role === "user" ? questionChunks : answerChunks;
      collection.push({ index, text: chunk.text });
    }

    const question = assembleText(questionChunks, turn.questionCount, "user", turn.queryId);
    const answer = assembleText(answerChunks, turn.answerCount, "assistant", turn.queryId);
    if (turn.contextSnapshot !== undefined) {
      if (turn.contextManifest === undefined || turn.contextCount === undefined) {
        throw new Error("Completed conversation snapshot has no context manifest.");
      }
      const fragmentedReferences = isChunkedContextSnapshot(turn.contextSnapshot)
        ? parseContextReferences({
            ordinal: turn.ordinal,
            queryId: turn.queryId,
            count: turn.contextCount,
            chunks: turnChunks,
            partition,
            conversationId,
            turns,
            verifyTargets: options.validateContextReferences !== false,
          })
        : undefined;
      if (fragmentedReferences === undefined) {
        if (turn.contextCount !== 0) {
          throw new Error("Completed conversation snapshot has conflicting context storage.");
        }
        parseContextReferences({
          ordinal: turn.ordinal,
          queryId: turn.queryId,
          count: 0,
          chunks: turnChunks,
          partition,
          conversationId,
          turns,
        });
      }
      const snapshot = hydrateStoredContextSnapshot(
        turn.contextSnapshot,
        turn.ordinal,
        fragmentedReferences,
      );
      if (options.validateContextReferences !== false) {
        verifySnapshotReferenceTurns(snapshot, turns);
      }
    } else if (options.validateContextReferences !== false) {
      parseContextReferences({
        ordinal: turn.ordinal,
        queryId: turn.queryId,
        count: turn.contextCount,
        chunks: turnChunks,
        partition,
        conversationId,
        turns,
      });
    }
    references.push({ ordinal: turn.ordinal, queryId: turn.queryId });
    messages.push(
      { role: "user", content: [{ text: question }] },
      { role: "assistant", content: [{ text: answer }] },
    );
  }
  return { messages, references };
}

function conversationKey(conversationId: string) {
  return { pk: `CONV#${conversationId}` };
}

function turnKey(conversationId: string, ordinal: number) {
  return {
    ...conversationKey(conversationId),
    sk: `TURN#${String(ordinal).padStart(8, "0")}`,
  };
}

function isoDate(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function chunkKey(
  conversationId: string,
  ordinal: number,
  queryId: string,
  role: ChunkRole,
  index: number,
) {
  return {
    ...conversationKey(conversationId),
    sk: `${turnKey(conversationId, ordinal).sk}#${queryId}#${role.toUpperCase()}#${String(index).padStart(8, "0")}`,
  };
}

function contextChunkKey(conversationId: string, ordinal: number, index: number) {
  return {
    ...conversationKey(conversationId),
    sk: `${turnKey(conversationId, ordinal).sk}#CONTEXT#${String(index).padStart(8, "0")}`,
  };
}

function documentContextChunkKey(conversationId: string, ordinal: number, index: number) {
  return {
    ...conversationKey(conversationId),
    sk: `${turnKey(conversationId, ordinal).sk}#DOCUMENT#${String(index).padStart(8, "0")}`,
  };
}

function encodeContextReferences(references: ContextReference[], targetOrdinal: number): string[] {
  if (!Array.isArray(references))
    throw new TypeError("Conversation context references are invalid.");
  let previousOrdinal = 0;
  for (const reference of references) {
    if (
      !isRecord(reference) ||
      !isPositiveSafeInteger(reference.ordinal) ||
      reference.ordinal <= previousOrdinal ||
      reference.ordinal >= targetOrdinal ||
      typeof reference.queryId !== "string" ||
      !uuidPattern.test(reference.queryId)
    ) {
      throw new TypeError("Conversation context references are invalid.");
    }
    previousOrdinal = reference.ordinal;
  }
  return references.length > 0 ? splitUtf8Text(JSON.stringify(references)) : [];
}

function sameContextReferences(left: ContextReference[], right: ContextReference[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (reference, index) =>
        reference.ordinal === right[index].ordinal && reference.queryId === right[index].queryId,
    )
  );
}

function sameSummaryPointer(
  left: ContextSnapshot["summary"] | undefined,
  right: ContextSnapshot["summary"] | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
        left.summaryId === right.summaryId &&
        left.throughOrdinal === right.throughOrdinal;
}

function hydrateStoredContextSnapshot(
  value: unknown,
  targetOrdinal: number,
  fragmentedReferences?: ContextReference[],
): ContextSnapshot {
  if (isRecord(value) && Object.hasOwn(value, "recentReferencesStorage")) {
    if (
      value.recentReferencesStorage !== "context_chunks" ||
      Object.hasOwn(value, "recentReferences") ||
      !Array.isArray(fragmentedReferences) ||
      fragmentedReferences.length === 0
    ) {
      throw new Error("Conversation context snapshot reference fragments are malformed.");
    }
    return validateContextSnapshot(
      {
        version: value.version,
        ...(value.summary === undefined ? {} : { summary: value.summary }),
        recentReferences: fragmentedReferences,
      },
      targetOrdinal,
    );
  }
  if (fragmentedReferences !== undefined) {
    throw new Error("Conversation context snapshot duplicates its reference fragments.");
  }
  return validateContextSnapshot(value, targetOrdinal);
}

function verifySnapshotReferenceTurns(
  snapshot: ContextSnapshot,
  turns: Map<string, Record<string, unknown>>,
): void {
  for (const reference of snapshot.recentReferences) {
    const turn = turns.get(String(reference.ordinal).padStart(8, "0"));
    if (
      !turn ||
      turn.status !== "completed" ||
      turn.ordinal !== reference.ordinal ||
      turn.queryId !== reference.queryId
    ) {
      throw new Error("Conversation context snapshot references a missing completed turn.");
    }
  }
}

function isChunkedContextSnapshot(value: unknown): boolean {
  return isRecord(value) && value.recentReferencesStorage === "context_chunks";
}

export function createConversationStoreAdapter(input: {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
  now?: () => number;
}) {
  const { documentClient, tableName } = input;
  const currentTime = input.now ?? Date.now;
  const contextStorage = createContextStorage({ documentClient, tableName });
  const zone = "America/Argentina/Cordoba";
  const itemLimit = 400 * 1024;
  const transactionLimit = 4 * 1024 * 1024;
  const actionLimit = 100;
  const resultDeadlineMs = 60 * 60 * 1000;
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  function storeError(
    code:
      | "quota_exceeded"
      | "conversation_busy"
      | "stale_base"
      | "conflict"
      | "quota_period_changed"
      | "submission_exists",
    message: string,
    quota?: QuotaView,
  ): Error & { code: string; quota?: QuotaView } {
    const error = new Error(message) as Error & { code: string; quota?: QuotaView };
    error.code = code;
    if (quota) error.quota = quota;
    return error;
  }

  function partsAt(instant: number): Record<string, number> {
    if (!Number.isFinite(instant)) throw new TypeError("Quota time must be a finite timestamp.");
    const parts = Object.fromEntries(
      timeFormatter
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second,
    };
  }

  function calendarDate(instant: number): { year: number; month: number; day: number } {
    const parts = partsAt(instant);
    return { year: parts.year, month: parts.month, day: parts.day };
  }

  function localDateString(date: { year: number; month: number; day: number }): string {
    return (
      String(date.year).padStart(4, "0") +
      "-" +
      String(date.month).padStart(2, "0") +
      "-" +
      String(date.day).padStart(2, "0")
    );
  }

  function localDateToInstant(date: { year: number; month: number; day: number }): number {
    const wanted = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0, 0);
    let candidate = wanted;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const local = partsAt(candidate);
      const observed = Date.UTC(
        local.year,
        local.month - 1,
        local.day,
        local.hour,
        local.minute,
        local.second,
        0,
      );
      const correction = wanted - observed;
      candidate += correction;
      if (correction === 0) break;
    }
    return candidate;
  }

  function localPeriods(instant: number) {
    const current = calendarDate(instant);
    const nextDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
    const nextMonth = new Date(Date.UTC(current.year, current.month, 1));
    const dayPeriod = localDateString(current);
    const monthPeriod =
      String(current.year).padStart(4, "0") + "-" + String(current.month).padStart(2, "0");
    return {
      day: {
        period: dayPeriod,
        resetAt: localDateToInstant({
          year: nextDay.getUTCFullYear(),
          month: nextDay.getUTCMonth() + 1,
          day: nextDay.getUTCDate(),
        }),
      },
      month: {
        period: monthPeriod,
        resetAt: localDateToInstant({
          year: nextMonth.getUTCFullYear(),
          month: nextMonth.getUTCMonth() + 1,
          day: 1,
        }),
      },
    };
  }

  function itemKey(item: Record<string, unknown>): string {
    if (typeof item.pk !== "string" || typeof item.sk !== "string") {
      throw new TypeError("DynamoDB transaction item has no valid key.");
    }
    return item.pk + "\u0000" + item.sk;
  }

  function storageCapacityError(message: string): RangeError & {
    code: "storage_capacity_exceeded";
  } {
    return Object.assign(new RangeError(message), { code: "storage_capacity_exceeded" as const });
  }

  function preflight(
    actions: Record<string, unknown>[],
    affectedItems: Record<string, unknown>[],
  ): void {
    if (actions.length > actionLimit)
      throw storageCapacityError("DynamoDB transaction exceeds 100 actions.");
    const keys = new Set<string>();
    for (const item of affectedItems) {
      const key = itemKey(item);
      if (keys.has(key))
        throw new TypeError("DynamoDB transactions cannot target an item more than once.");
      keys.add(key);
      if (dynamoItemSize(item) > itemLimit)
        throw storageCapacityError("DynamoDB transaction item exceeds 400 KiB.");
    }
    if (affectedItems.reduce((total, item) => total + dynamoItemSize(item), 0) > transactionLimit) {
      throw storageCapacityError("DynamoDB transaction exceeds 4 MiB.");
    }
  }

  async function getItem(
    key: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await documentClient.send(
      new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
    );
    return result.Item;
  }

  async function readFirstQuestionLabel(conversationId: string): Promise<string | undefined> {
    const firstTurn = await getItem(turnKey(conversationId, 1));
    if (
      !firstTurn ||
      firstTurn.pk !== conversationKey(conversationId).pk ||
      firstTurn.sk !== turnKey(conversationId, 1).sk ||
      firstTurn.conversationId !== conversationId ||
      firstTurn.ordinal !== 1 ||
      typeof firstTurn.queryId !== "string" ||
      !uuidPattern.test(firstTurn.queryId) ||
      manifestCount(firstTurn.questionManifest) === null
    ) {
      return undefined;
    }
    const prefix = `${turnKey(conversationId, 1).sk}#${firstTurn.queryId}#USER#`;
    const result = await documentClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": conversationKey(conversationId).pk,
          ":prefix": prefix,
        },
        ConsistentRead: true,
        ScanIndexForward: true,
        Limit: 1,
      }),
    );
    const chunk = result.Items?.[0];
    if (
      !chunk ||
      chunk.pk !== conversationKey(conversationId).pk ||
      chunk.conversationId !== conversationId ||
      chunk.queryId !== firstTurn.queryId ||
      chunk.ordinal !== 1 ||
      chunk.role !== "user" ||
      chunk.index !== 0 ||
      typeof chunk.text !== "string"
    ) {
      return undefined;
    }
    try {
      return createHistoryLabel(chunk.text);
    } catch {
      return undefined;
    }
  }

  async function historyProjectionFor(
    previousMeta: Record<string, unknown> | undefined,
    conversationId: string,
    sub: string,
    botId: string,
    activityAt: string,
  ): Promise<{ historyOwner: string; historyOrder: string; historyLabel: string } | undefined> {
    const owner = `USER#${sub}#BOT#${botId}`;
    const label =
      typeof previousMeta?.historyLabel === "string" && previousMeta.historyLabel.trim().length > 0
        ? previousMeta.historyLabel
        : await readFirstQuestionLabel(conversationId);
    // Keep legacy transitions independent of an unreadable label; let backfill report it instead of inventing text.
    if (!label) return undefined;
    return {
      historyOwner: owner,
      historyOrder: createHistoryOrder(activityAt, conversationId),
      historyLabel: label,
    };
  }

  function historyUpdateParts(
    previousMeta: Record<string, unknown> | undefined,
    projection: { historyOwner: string; historyOrder: string; historyLabel: string } | undefined,
  ) {
    const assignments = projection ? ["#historyOrder = :historyOrder"] : [];
    const names: Record<string, string> = projection ? { "#historyOrder": "historyOrder" } : {};
    const values: Record<string, unknown> = projection
      ? { ":historyOrder": projection.historyOrder }
      : {};
    if (!projection) return { assignments, names, values };
    if (previousMeta?.historyOwner !== projection.historyOwner) {
      assignments.push("#historyOwner = :historyOwner");
      names["#historyOwner"] = "historyOwner";
      values[":historyOwner"] = projection.historyOwner;
    }
    if (previousMeta?.historyLabel !== projection.historyLabel) {
      assignments.push("#historyLabel = :historyLabel");
      names["#historyLabel"] = "historyLabel";
      values[":historyLabel"] = projection.historyLabel;
    }
    return { assignments, names, values };
  }

  function historyMetaSetExpression(
    updatedAtName: string,
    historyUpdate: ReturnType<typeof historyUpdateParts>,
  ): string {
    return `SET ${updatedAtName} = :now${historyUpdate.assignments.length ? ", " + historyUpdate.assignments.join(", ") : ""}`;
  }

  function validCounter(item: Record<string, unknown> | undefined): number {
    if (!item) return 0;
    if (!Number.isSafeInteger(item.used) || Number(item.used) < 0) {
      throw new Error("Quota usage record is invalid; refusing admission.");
    }
    return Number(item.used);
  }

  function validPolicy(item: Record<string, unknown> | undefined): {
    dailyLimit: number;
    monthlyLimit: number;
    revision: string;
  } {
    if (
      !item ||
      !Number.isSafeInteger(item.dailyLimit) ||
      Number(item.dailyLimit) < 0 ||
      !Number.isSafeInteger(item.monthlyLimit) ||
      Number(item.monthlyLimit) < 0 ||
      typeof item.revision !== "string" ||
      item.revision.trim().length === 0
    ) {
      throw new Error("Quota policy is missing or invalid; refusing new submissions.");
    }
    return {
      dailyLimit: Number(item.dailyLimit),
      monthlyLimit: Number(item.monthlyLimit),
      revision: item.revision,
    };
  }

  function chunkItem(chunk: {
    conversationId: string;
    ordinal: number;
    queryId: string;
    role: ChunkRole;
    index: number;
    text: string;
    now: number;
  }): Record<string, unknown> {
    return {
      ...chunkKey(chunk.conversationId, chunk.ordinal, chunk.queryId, chunk.role, chunk.index),
      conversationId: chunk.conversationId,
      queryId: chunk.queryId,
      ordinal: chunk.ordinal,
      role: chunk.role,
      index: chunk.index,
      text: chunk.text,
      createdAt: isoDate(chunk.now),
    };
  }

  function contextItem(input: {
    conversationId: string;
    ordinal: number;
    index: number;
    text: string;
    now: number;
  }): Record<string, unknown> {
    return {
      ...contextChunkKey(input.conversationId, input.ordinal, input.index),
      conversationId: input.conversationId,
      ordinal: input.ordinal,
      index: input.index,
      text: input.text,
      createdAt: isoDate(input.now),
    };
  }

  function documentContextItem(input: {
    conversationId: string;
    ordinal: number;
    queryId: string;
    index: number;
    text: string;
    now: number;
  }): Record<string, unknown> {
    return {
      ...documentContextChunkKey(input.conversationId, input.ordinal, input.index),
      conversationId: input.conversationId,
      queryId: input.queryId,
      ordinal: input.ordinal,
      index: input.index,
      text: input.text,
      createdAt: isoDate(input.now),
    };
  }

  function isConditionalFailure(error: unknown): boolean {
    if (!isRecord(error)) return false;
    if (error.name === "ConditionalCheckFailedException") return true;
    return (
      error.name === "TransactionCanceledException" &&
      Array.isArray(error.CancellationReasons) &&
      error.CancellationReasons.some(
        (reason) => isRecord(reason) && reason.Code === "ConditionalCheckFailed",
      )
    );
  }

  function inputBaseOrdinal(turn: ContinueTurnInput): number {
    const value = turn.baseOrdinal ?? turn.expectedLastOrdinal;
    if (
      !isPositiveSafeInteger(value) ||
      (turn.baseOrdinal !== undefined &&
        turn.expectedLastOrdinal !== undefined &&
        turn.baseOrdinal !== turn.expectedLastOrdinal) ||
      !Number.isSafeInteger(value + 1)
    ) {
      throw new RangeError("Conversation base ordinal is invalid.");
    }
    return value;
  }

  function validateAdmission(
    turn: StartTurnInput | ContinueTurnInput,
    operation: "start" | "message",
    baseOrdinal: number,
  ): void {
    if (
      typeof turn.sub !== "string" ||
      turn.sub.length === 0 ||
      typeof turn.botId !== "string" ||
      turn.botId.length === 0 ||
      typeof turn.conversationId !== "string" ||
      turn.conversationId.length === 0 ||
      typeof turn.queryId !== "string" ||
      !uuidPattern.test(turn.queryId) ||
      typeof turn.ownerAttemptId !== "string" ||
      turn.ownerAttemptId.length === 0 ||
      typeof turn.requestFingerprint !== "string" ||
      turn.requestFingerprint.length === 0 ||
      typeof turn.text !== "string" ||
      turn.text.trim().length === 0 ||
      !isRecord(turn.profileSnapshot) ||
      !isRecord(turn.invocation) ||
      (turn.documentContext !== undefined && !isDocumentContext(turn.documentContext)) ||
      !Number.isFinite(turn.now) ||
      turn.resultDeadlineAt !== turn.now + resultDeadlineMs ||
      (operation === "start" && baseOrdinal !== 0)
    ) {
      throw new TypeError("Submission admission input is invalid.");
    }
    const periods = localPeriods(turn.now);
    if (
      turn.quota.daily.period !== periods.day.period ||
      turn.quota.monthly.period !== periods.month.period
    ) {
      throw storeError("quota_period_changed", "Quota period changed before admission.");
    }
    if (
      turn.quota.daily.used >= turn.quota.daily.limit ||
      turn.quota.monthly.used >= turn.quota.monthly.limit
    ) {
      throw storeError("quota_exceeded", "A submission quota is exhausted.", turn.quota);
    }
  }

  function assertCurrentQuotaPeriod(quota: QuotaView): void {
    const periods = localPeriods(currentTime());
    if (
      periods.day.period !== quota.daily.period ||
      periods.month.period !== quota.monthly.period
    ) {
      throw storeError(
        "quota_period_changed",
        "Quota period changed before transaction submission.",
      );
    }
  }

  async function readExistingSubmission(
    sub: string,
    botId: string,
    queryId: string,
  ): Promise<Record<string, unknown> | undefined> {
    return getItem({ pk: "USER#" + sub + "#BOT#" + botId, sk: "SEND#" + queryId });
  }

  function markerMatches(
    marker: Record<string, unknown>,
    turn: StartTurnInput | ContinueTurnInput,
    operation: "start" | "message",
    baseOrdinal: number,
  ): boolean {
    return (
      marker.sub === turn.sub &&
      marker.botId === turn.botId &&
      marker.queryId === turn.queryId &&
      marker.conversationId === turn.conversationId &&
      marker.requestFingerprint === turn.requestFingerprint &&
      marker.operation === operation &&
      marker.baseOrdinal === baseOrdinal
    );
  }

  async function existingAdmission(
    turn: StartTurnInput | ContinueTurnInput,
    operation: "start" | "message",
    baseOrdinal: number,
  ): Promise<{ queryId: string; ordinal: number } | null> {
    const marker = await readExistingSubmission(turn.sub, turn.botId, turn.queryId);
    if (!marker) return null;
    if (
      !markerMatches(marker, turn, operation, baseOrdinal) ||
      !isPositiveSafeInteger(marker.ordinal)
    ) {
      throw storeError(
        "conflict",
        "Stable submission ID was already used for a different request.",
      );
    }
    throw storeError(
      "submission_exists",
      "Stable submission already exists; load its durable snapshot.",
    );
  }

  async function buildAdmission(
    turn: StartTurnInput | ContinueTurnInput,
    operation: "start" | "message",
    baseOrdinal: number,
  ) {
    const ordinal = baseOrdinal + 1;
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0)
      throw new RangeError("Conversation ordinal cannot be safely incremented.");
    const createdAt = isoDate(turn.now);
    const partition = conversationKey(turn.conversationId);
    const metaKey = { ...partition, sk: "META" };
    const previousMeta = operation === "message" ? await getItem(metaKey) : undefined;
    const currentSummary = readSummaryPointer(previousMeta);
    const contextSnapshot =
      turn.contextSnapshot === undefined
        ? undefined
        : validateContextSnapshot(turn.contextSnapshot, ordinal);
    const contextReferences =
      operation === "message"
        ? encodeContextReferences((turn as ContinueTurnInput).contextReferences, ordinal)
        : [];
    const summaryCandidate =
      turn.summaryCandidate === undefined
        ? undefined
        : validateSummaryVersion(turn.summaryCandidate);

    if (summaryCandidate !== undefined && contextSnapshot === undefined) {
      throw new TypeError("A summary candidate requires a versioned context snapshot.");
    }
    if (contextSnapshot !== undefined) {
      if (
        operation === "message" &&
        !sameContextReferences(
          contextSnapshot.recentReferences,
          (turn as ContinueTurnInput).contextReferences,
        )
      ) {
        throw new TypeError(
          "Context snapshot references must match the recent context references.",
        );
      }
      if (
        operation === "start" &&
        (contextSnapshot.summary !== undefined || contextSnapshot.recentReferences.length > 0)
      ) {
        throw new TypeError("A new conversation cannot begin with prior conversation context.");
      }
      if (summaryCandidate !== undefined) {
        const previousThrough = currentSummary?.throughOrdinal ?? 0;
        const snapshotMatchesCandidate = sameSummaryPointer(contextSnapshot.summary, {
          summaryId: summaryCandidate.summaryId,
          throughOrdinal: summaryCandidate.throughOrdinal,
        });
        if (
          operation !== "message" ||
          !snapshotMatchesCandidate ||
          summaryCandidate.throughOrdinal > baseOrdinal ||
          summaryCandidate.throughOrdinal <= previousThrough ||
          summaryCandidate.sourceReferences.some(
            (reference) =>
              reference.ordinal <= previousThrough ||
              reference.ordinal > summaryCandidate.throughOrdinal,
          ) ||
          summaryCandidate.previousSummaryId !== currentSummary?.summaryId
        ) {
          throw new TypeError(
            "Summary candidate does not extend the current conversation context.",
          );
        }
      } else if (!sameSummaryPointer(contextSnapshot.summary, currentSummary)) {
        throw new TypeError("Context snapshot does not match the current conversation summary.");
      }
    } else if (currentSummary !== undefined) {
      throw new TypeError("A conversation with a summary requires a versioned context snapshot.");
    }

    const questionChunks = splitUtf8Text(turn.text);
    if (questionChunks.length === 0) throw new TypeError("Submission question is empty.");
    let contextChunks =
      operation === "message" && contextSnapshot === undefined ? contextReferences : [];
    const documentContextChunks =
      turn.documentContext === undefined ? [] : serializeDocumentContext(turn.documentContext);
    const marker = {
      pk: "USER#" + turn.sub + "#BOT#" + turn.botId,
      sk: "SEND#" + turn.queryId,
      sub: turn.sub,
      botId: turn.botId,
      queryId: turn.queryId,
      requestFingerprint: turn.requestFingerprint,
      operation,
      baseOrdinal,
      conversationId: turn.conversationId,
      ordinal,
      admittedAt: turn.now,
      resultDeadlineAt: turn.resultDeadlineAt,
      quotaSnapshot: turn.quota,
    };
    const record: Record<string, unknown> = {
      ...turnKey(turn.conversationId, ordinal),
      conversationId: turn.conversationId,
      sub: turn.sub,
      botId: turn.botId,
      queryId: turn.queryId,
      requestFingerprint: turn.requestFingerprint,
      operation,
      baseOrdinal,
      ordinal,
      status: "in_progress",
      phase: "admitted",
      ownerAttemptId: turn.ownerAttemptId,
      resultDeadlineAt: turn.resultDeadlineAt,
      cursor: 0,
      createdAt,
      updatedAt: createdAt,
      questionManifest: { count: questionChunks.length, complete: true },
      answerManifest: { count: 0, complete: false },
      contextManifest: { count: contextChunks.length, complete: true },
      ...(turn.documentContext === undefined
        ? {}
        : {
            documentContextManifest: {
              count: documentContextChunks.length,
              complete: true,
            },
          }),
      profileSnapshot: turn.profileSnapshot,
      invocation: turn.invocation,
      ...(contextSnapshot === undefined ? {} : { contextSnapshot }),
    };
    if (
      contextSnapshot !== undefined &&
      contextSnapshot.recentReferences.length > 0 &&
      dynamoItemSize(record) > itemLimit
    ) {
      contextChunks = encodeContextReferences(contextSnapshot.recentReferences, ordinal);
      const { version, summary } = contextSnapshot;
      record.contextSnapshot = {
        version,
        ...(summary === undefined ? {} : { summary }),
        recentReferencesStorage: "context_chunks",
      };
      record.contextManifest = { count: contextChunks.length, complete: true };
    }
    const meta = {
      ...metaKey,
      conversationId: turn.conversationId,
      sub: turn.sub,
      botId: turn.botId,
      createdAt,
      updatedAt: createdAt,
      lastOrdinal: ordinal,
      lastQueryId: turn.queryId,
      activeQueryId: turn.queryId,
      activeOwnerAttemptId: turn.ownerAttemptId,
      closed: false,
      historyOwner: `USER#${turn.sub}#BOT#${turn.botId}`,
      historyOrder: createHistoryOrder(createdAt, turn.conversationId),
      historyLabel: createHistoryLabel(turn.text),
    };
    const summaryStorage =
      summaryCandidate === undefined
        ? undefined
        : contextStorage.createSummaryItems({
            conversationId: turn.conversationId,
            sub: turn.sub,
            botId: turn.botId,
            summary: summaryCandidate,
          });
    const day = localPeriods(turn.now).day.period;
    const month = localPeriods(turn.now).month.period;
    const usagePk = { pk: "USER#" + turn.sub + "#BOT#" + turn.botId };
    const dailyKey = { ...usagePk, sk: "USAGE#DAY#" + day };
    const monthlyKey = { ...usagePk, sk: "USAGE#MONTH#" + month };
    const dailyCounter = {
      ...dailyKey,
      used: turn.quota.daily.used + 1,
      period: day,
      updatedAt: createdAt,
    };
    const monthlyCounter = {
      ...monthlyKey,
      used: turn.quota.monthly.used + 1,
      period: month,
      updatedAt: createdAt,
    };
    const policyKey = { pk: "BOT#" + turn.botId, sk: "QUOTA#POLICY" };
    const transactionItems: Record<string, unknown>[] = [
      {
        ConditionCheck: {
          TableName: tableName,
          Key: policyKey,
          ConditionExpression:
            "#revision = :revision AND #dailyLimit = :dailyLimit AND #monthlyLimit = :monthlyLimit",
          ExpressionAttributeNames: {
            "#revision": "revision",
            "#dailyLimit": "dailyLimit",
            "#monthlyLimit": "monthlyLimit",
          },
          ExpressionAttributeValues: {
            ":revision": turn.quota.policyRevision,
            ":dailyLimit": turn.quota.daily.limit,
            ":monthlyLimit": turn.quota.monthly.limit,
          },
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: dailyKey,
          UpdateExpression: "SET #period = :period, #updatedAt = :updatedAt ADD #used :one",
          ConditionExpression:
            ":limit > :zero AND (attribute_not_exists(#used) OR (#used >= :zero AND #used < :limit))",
          ExpressionAttributeNames: {
            "#period": "period",
            "#updatedAt": "updatedAt",
            "#used": "used",
          },
          ExpressionAttributeValues: {
            ":period": day,
            ":updatedAt": createdAt,
            ":one": 1,
            ":zero": 0,
            ":limit": turn.quota.daily.limit,
          },
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: monthlyKey,
          UpdateExpression: "SET #period = :period, #updatedAt = :updatedAt ADD #used :one",
          ConditionExpression:
            ":limit > :zero AND (attribute_not_exists(#used) OR (#used >= :zero AND #used < :limit))",
          ExpressionAttributeNames: {
            "#period": "period",
            "#updatedAt": "updatedAt",
            "#used": "used",
          },
          ExpressionAttributeValues: {
            ":period": month,
            ":updatedAt": createdAt,
            ":one": 1,
            ":zero": 0,
            ":limit": turn.quota.monthly.limit,
          },
        },
      },
    ];
    const affectedItems: Record<string, unknown>[] = [
      {
        pk: policyKey.pk,
        sk: policyKey.sk,
        dailyLimit: turn.quota.daily.limit,
        monthlyLimit: turn.quota.monthly.limit,
        revision: turn.quota.policyRevision,
      },
      dailyCounter,
      monthlyCounter,
    ];
    if (operation === "start") {
      transactionItems.push(
        {
          Put: {
            TableName: tableName,
            Item: meta,
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: record,
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      );
      affectedItems.push(meta, record);
    } else {
      if (
        previousMeta &&
        (previousMeta.sub !== turn.sub ||
          previousMeta.botId !== turn.botId ||
          previousMeta.conversationId !== turn.conversationId)
      ) {
        throw storeError("conflict", "Conversation does not belong to this user and chatbot.");
      }
      if (previousMeta?.activeQueryId || previousMeta?.closed === true) {
        throw storeError("conversation_busy", "Conversation already has an active or closed turn.");
      }
      if (previousMeta && previousMeta.lastOrdinal !== baseOrdinal)
        throw storeError("stale_base", "Conversation base ordinal is stale.");
      const historyProjection = await historyProjectionFor(
        previousMeta,
        turn.conversationId,
        turn.sub,
        turn.botId,
        createdAt,
      );
      const historyUpdate = historyUpdateParts(previousMeta, historyProjection);
      const summaryPointer = summaryCandidate
        ? {
            summaryId: summaryCandidate.summaryId,
            throughOrdinal: summaryCandidate.throughOrdinal,
          }
        : undefined;
      const summaryUpdate = summaryPointer === undefined ? "" : ", #summary = :summary";
      const summaryCondition =
        contextSnapshot === undefined
          ? ""
          : currentSummary === undefined
            ? " AND attribute_not_exists(#summary)"
            : " AND #summary = :expectedSummary";
      transactionItems.push({
        Update: {
          TableName: tableName,
          Key: metaKey,
          UpdateExpression: `SET #lastOrdinal = :nextOrdinal, #lastQueryId = :queryId, #activeQueryId = :queryId, #activeOwnerAttemptId = :ownerAttemptId, #updatedAt = :updatedAt${historyUpdate.assignments.length ? ", " + historyUpdate.assignments.join(", ") : ""}${summaryUpdate}`,
          ConditionExpression:
            "#sub = :sub AND #botId = :botId AND #conversationId = :conversationId AND #lastOrdinal = :expectedLastOrdinal AND attribute_not_exists(#activeQueryId) AND (attribute_not_exists(#closed) OR #closed = :false)" +
            summaryCondition,
          ExpressionAttributeNames: {
            "#sub": "sub",
            "#botId": "botId",
            "#conversationId": "conversationId",
            "#lastOrdinal": "lastOrdinal",
            "#lastQueryId": "lastQueryId",
            "#activeQueryId": "activeQueryId",
            "#activeOwnerAttemptId": "activeOwnerAttemptId",
            "#updatedAt": "updatedAt",
            "#closed": "closed",
            ...(contextSnapshot === undefined ? {} : { "#summary": "summary" }),
            ...historyUpdate.names,
          },
          ExpressionAttributeValues: {
            ":sub": turn.sub,
            ":botId": turn.botId,
            ":conversationId": turn.conversationId,
            ":expectedLastOrdinal": baseOrdinal,
            ":nextOrdinal": ordinal,
            ":queryId": turn.queryId,
            ":ownerAttemptId": turn.ownerAttemptId,
            ":updatedAt": createdAt,
            ":false": false,
            ...(summaryPointer === undefined ? {} : { ":summary": summaryPointer }),
            ...(contextSnapshot === undefined || currentSummary === undefined
              ? {}
              : { ":expectedSummary": currentSummary }),
            ...historyUpdate.values,
          },
        },
      });
      affectedItems.push({
        ...(previousMeta ?? {
          ...metaKey,
          conversationId: turn.conversationId,
          sub: turn.sub,
          botId: turn.botId,
          lastOrdinal: baseOrdinal,
        }),
        lastOrdinal: ordinal,
        lastQueryId: turn.queryId,
        activeQueryId: turn.queryId,
        activeOwnerAttemptId: turn.ownerAttemptId,
        updatedAt: createdAt,
        ...(historyProjection ?? {}),
        ...(summaryPointer === undefined ? {} : { summary: summaryPointer }),
      });
      transactionItems.push({
        Put: {
          TableName: tableName,
          Item: record,
          ConditionExpression: "attribute_not_exists(pk)",
        },
      });
      affectedItems.push(record);
    }
    if (summaryStorage !== undefined) {
      for (const item of [
        summaryStorage.descriptor,
        ...summaryStorage.textItems,
        ...summaryStorage.sourceReferenceItems,
      ]) {
        transactionItems.push({
          Put: {
            TableName: tableName,
            Item: item,
            ConditionExpression: "attribute_not_exists(pk)",
          },
        });
        affectedItems.push(item);
      }
    }
    const questionItems = questionChunks.map((text, index) =>
      chunkItem({
        conversationId: turn.conversationId,
        ordinal,
        queryId: turn.queryId,
        role: "user",
        index,
        text,
        now: turn.now,
      }),
    );
    const contextRecords = contextChunks.map((text, index) =>
      contextItem({
        conversationId: turn.conversationId,
        ordinal,
        index,
        text,
        now: turn.now,
      }),
    );
    const documentContextRecords = documentContextChunks.map((text, index) =>
      documentContextItem({
        conversationId: turn.conversationId,
        ordinal,
        queryId: turn.queryId,
        index,
        text,
        now: turn.now,
      }),
    );
    for (const item of [...questionItems, ...contextRecords, ...documentContextRecords]) {
      transactionItems.push({
        Put: { TableName: tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" },
      });
      affectedItems.push(item);
    }
    transactionItems.push({
      Put: {
        TableName: tableName,
        Item: marker,
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
    affectedItems.push(marker);
    preflight(transactionItems, affectedItems);
    return { ordinal, transactionItems, affectedItems, marker };
  }

  async function classifyAdmissionFailure(
    turn: StartTurnInput | ContinueTurnInput,
    original: unknown,
    operation: "start" | "message",
    baseOrdinal: number,
  ): Promise<never> {
    const marker = await readExistingSubmission(turn.sub, turn.botId, turn.queryId);
    if (marker) {
      if (
        !markerMatches(marker, turn, operation, baseOrdinal) ||
        !isPositiveSafeInteger(marker.ordinal)
      ) {
        throw storeError(
          "conflict",
          "Stable submission ID was already used for a different request.",
        );
      }
      throw storeError("submission_exists", "Admission is already durable; load its snapshot.");
    }
    if (!isConditionalFailure(original)) throw original;
    const quota = await adapter.readQuota({ sub: turn.sub, botId: turn.botId, now: turn.now });
    if (quota.daily.used >= quota.daily.limit || quota.monthly.used >= quota.monthly.limit) {
      throw storeError("quota_exceeded", "A submission quota is exhausted.", quota);
    }
    if (operation === "message") {
      const meta = await adapter.getMeta({ conversationId: turn.conversationId });
      if (!meta) throw storeError("stale_base", "Conversation does not exist.");
      if (meta?.activeQueryId || meta?.closed === true)
        throw storeError("conversation_busy", "Conversation is busy or closed.");
      if (meta && meta.lastOrdinal !== baseOrdinal)
        throw storeError("stale_base", "Conversation base ordinal is stale.");
    } else {
      const meta = await adapter.getMeta({ conversationId: turn.conversationId });
      if (meta) throw storeError("conversation_busy", "Conversation already exists.");
    }
    throw storeError("conflict", "Admission was conditionally rejected.");
  }

  async function queryItems(
    key: Record<string, unknown>,
    sortPrefix?: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: sortPrefix
            ? "#pk = :pk AND begins_with(#sk, :prefix)"
            : "#pk = :pk",
          ExpressionAttributeNames: sortPrefix ? { "#pk": "pk", "#sk": "sk" } : { "#pk": "pk" },
          ExpressionAttributeValues: sortPrefix
            ? { ":pk": key.pk, ":prefix": sortPrefix }
            : { ":pk": key.pk },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      items.push(...(page.Items ?? []));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  async function getSubmission(input: {
    sub: string;
    botId: string;
    queryId: string;
  }): Promise<SubmissionSnapshot | null> {
    const marker = await readExistingSubmission(input.sub, input.botId, input.queryId);
    if (!marker) return null;
    if (
      marker.sub !== input.sub ||
      marker.botId !== input.botId ||
      marker.queryId !== input.queryId ||
      typeof marker.conversationId !== "string" ||
      !isPositiveSafeInteger(marker.ordinal)
    )
      throw new Error("Submission marker is malformed or outside the requested scope.");
    const turn = await getItem(turnKey(marker.conversationId, marker.ordinal));
    if (!turn) throw new Error("Submission marker points to a missing turn.");
    if (
      turn.conversationId !== marker.conversationId ||
      turn.ordinal !== marker.ordinal ||
      turn.queryId !== input.queryId ||
      turn.pk !== conversationKey(marker.conversationId).pk ||
      (turn.sub !== undefined && turn.sub !== input.sub) ||
      (turn.botId !== undefined && turn.botId !== input.botId) ||
      (turn.requestFingerprint !== undefined &&
        turn.requestFingerprint !== marker.requestFingerprint)
    )
      throw new Error("Submission marker does not match its turn.");
    const ordinal = Number(marker.ordinal);
    const chunks = await queryItems(
      conversationKey(marker.conversationId),
      turnKey(marker.conversationId, ordinal).sk + "#",
    );
    const questionCount = contextManifestCount(turn.questionManifest);
    const answerCount = partialManifestCount(turn.answerManifest);
    const cursor = turn.cursor;
    if (
      questionCount === null ||
      !isRecord(turn.questionManifest) ||
      turn.questionManifest.complete !== true ||
      answerCount === null ||
      typeof cursor !== "number" ||
      !Number.isSafeInteger(cursor) ||
      Number(cursor) < 0 ||
      Number(cursor) > answerCount ||
      !["in_progress", "completed", "failed"].includes(String(turn.status)) ||
      !["admitted", "invocation_claimed", "complete", "failed"].includes(String(turn.phase))
    )
      throw new Error("Submission turn is malformed.");
    if (
      turn.status === "completed" &&
      (!isRecord(turn.answerManifest) ||
        turn.answerManifest.complete !== true ||
        Number(cursor) !== answerCount)
    ) {
      throw new Error("Completed submission has an inconsistent answer cursor.");
    }
    if (
      turn.status !== "completed" &&
      isRecord(turn.answerManifest) &&
      turn.answerManifest.complete === true
    ) {
      throw new Error("Non-completed submission has a completed answer manifest.");
    }
    const questionPieces: TextChunk[] = [];
    const answerPieces: TextChunk[] = [];
    for (const item of chunks) {
      const match = chunkRecordPattern.exec(String(item.sk));
      if (!match) continue;
      const chunkOrdinal = Number(match[1]);
      const chunkIndex = Number(match[4]);
      const role = match[3].toLowerCase();
      if (
        chunkOrdinal !== ordinal ||
        String(chunkOrdinal).padStart(8, "0") !== match[1] ||
        !Number.isSafeInteger(chunkIndex) ||
        chunkIndex < 0 ||
        item.pk !== turn.pk ||
        item.conversationId !== marker.conversationId ||
        item.ordinal !== ordinal ||
        item.index !== chunkIndex ||
        typeof item.text !== "string" ||
        item.queryId !== input.queryId ||
        (role !== "user" && role !== "assistant") ||
        item.role !== role
      )
        throw new Error("Submission contains a malformed text chunk.");
      if (role === "user") questionPieces.push({ index: chunkIndex, text: item.text });
      else if (chunkIndex < cursor) answerPieces.push({ index: chunkIndex, text: item.text });
    }
    const question = assembleText(questionPieces, questionCount, "user", input.queryId);
    const answer = assemblePrefix(answerPieces, Number(cursor), input.queryId);

    let contextReferences: ContextReference[] = [];
    const rawContextCount =
      turn.contextManifest === undefined ? 0 : contextManifestCount(turn.contextManifest);
    if (
      rawContextCount === null ||
      (turn.contextManifest !== undefined &&
        (!isRecord(turn.contextManifest) || turn.contextManifest.complete !== true))
    ) {
      throw new Error("Submission context manifest is malformed.");
    }
    if (rawContextCount > 0) {
      const contextParts = chunks.filter((item) => String(item.sk).includes("#CONTEXT#"));
      const serialized = assembleText(
        contextParts.flatMap((item) => {
          const match = contextChunkRecordPattern.exec(String(item.sk));
          if (!match) throw new Error("Submission context record is malformed.");
          const index = Number(match[2]);
          if (
            Number(match[1]) !== ordinal ||
            item.pk !== turn.pk ||
            item.conversationId !== marker.conversationId ||
            item.ordinal !== ordinal ||
            item.index !== index ||
            typeof item.text !== "string"
          )
            throw new Error("Submission context record is malformed.");
          return [{ index, text: item.text }];
        }),
        rawContextCount,
        "context",
        input.queryId,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        throw new Error("Submission context references are malformed.");
      }
      if (!Array.isArray(parsed)) throw new Error("Submission context references are malformed.");
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("Submission context references are malformed.");
      }
      encodeContextReferences(parsed as ContextReference[], ordinal);
      contextReferences = parsed as ContextReference[];
    } else {
      parseContextReferences({
        ordinal,
        queryId: input.queryId,
        count: 0,
        chunks,
        partition: String(turn.pk),
        conversationId: marker.conversationId,
        turns: new Map(),
      });
    }
    let contextSnapshot: ContextSnapshot | undefined;
    let summary: SummaryVersion | undefined;
    if (turn.contextSnapshot !== undefined) {
      if (turn.contextManifest === undefined) {
        throw new Error("Submission context snapshot has no context manifest.");
      }
      contextSnapshot = hydrateStoredContextSnapshot(
        turn.contextSnapshot,
        ordinal,
        rawContextCount > 0 ? contextReferences : undefined,
      );
      if (rawContextCount > 0) {
        if (!sameContextReferences(contextReferences, contextSnapshot.recentReferences)) {
          throw new Error("Submission context references do not match its context snapshot.");
        }
      } else {
        contextReferences = contextSnapshot.recentReferences;
      }
      if (contextSnapshot.summary !== undefined) {
        summary = await contextStorage.readSummary({
          conversationId: marker.conversationId,
          ...contextSnapshot.summary,
          sub: input.sub,
          botId: input.botId,
        });
        await contextStorage.verifyReferences(marker.conversationId, summary.sourceReferences, {
          sub: input.sub,
          botId: input.botId,
        });
      }
      await contextStorage.verifyReferences(
        marker.conversationId,
        contextSnapshot.recentReferences,
        { sub: input.sub, botId: input.botId },
      );
    }
    let documentContext: DocumentContext | undefined;
    const documentContextRecords = chunks.filter((item) => String(item.sk).includes("#DOCUMENT#"));
    if (turn.documentContextManifest === undefined) {
      if (documentContextRecords.length > 0) {
        throw new Error("Submission has document context records without a manifest.");
      }
    } else {
      const documentContextCount = contextManifestCount(turn.documentContextManifest);
      if (
        documentContextCount === null ||
        !isRecord(turn.documentContextManifest) ||
        turn.documentContextManifest.complete !== true
      ) {
        throw new Error("Submission document context manifest is malformed.");
      }
      const serialized = assembleText(
        documentContextRecords.flatMap((item) => {
          const match = documentContextChunkRecordPattern.exec(String(item.sk));
          if (!match) throw new Error("Submission document context record is malformed.");
          const chunkOrdinal = Number(match[1]);
          const index = Number(match[2]);
          if (
            chunkOrdinal !== ordinal ||
            String(chunkOrdinal).padStart(8, "0") !== match[1] ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            String(index).padStart(8, "0") !== match[2] ||
            item.pk !== turn.pk ||
            item.conversationId !== marker.conversationId ||
            item.queryId !== input.queryId ||
            item.ordinal !== ordinal ||
            item.index !== index ||
            typeof item.text !== "string"
          ) {
            throw new Error("Submission document context record is malformed.");
          }
          return [{ index, text: item.text }];
        }),
        documentContextCount,
        "document context",
        input.queryId,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        throw new Error("Submission document context is malformed.");
      }
      if (!isDocumentContext(parsed)) {
        throw new Error("Submission document context is malformed.");
      }
      documentContext = parsed;
    }
    const meta = await getItem({ ...conversationKey(marker.conversationId), sk: "META" });
    const status = turn.status as SubmissionSnapshot["status"];
    const stage = turn.phase as SubmissionSnapshot["stage"];
    const snapshot: SubmissionSnapshot = {
      sub: input.sub,
      botId: input.botId,
      conversationId: marker.conversationId,
      queryId: input.queryId,
      requestFingerprint: String(marker.requestFingerprint ?? turn.requestFingerprint ?? ""),
      operation: (marker.operation ??
        turn.operation ??
        (ordinal === 1 ? "start" : "message")) as SubmissionSnapshot["operation"],
      baseOrdinal: Number(marker.baseOrdinal ?? turn.baseOrdinal ?? ordinal - 1),
      ordinal,
      status,
      stage,
      question,
      questionManifest: turn.questionManifest as TurnManifest,
      contextReferences,
      ...(contextSnapshot === undefined ? {} : { contextSnapshot }),
      ...(summary === undefined ? {} : { summary }),
      ...(documentContext === undefined ? {} : { documentContext }),
      answer,
      answerManifest: turn.answerManifest as TurnManifest,
      cursor: Number(cursor),
      canContinue:
        status !== "in_progress" &&
        meta?.closed !== true &&
        !meta?.activeQueryId &&
        meta?.lastOrdinal === ordinal,
      resultDeadlineAt: Number(turn.resultDeadlineAt ?? marker.resultDeadlineAt),
      profileSnapshot: isRecord(turn.profileSnapshot) ? turn.profileSnapshot : {},
      invocation: isRecord(turn.invocation)
        ? (turn.invocation as SubmissionSnapshot["invocation"])
        : { modelId: "" },
      ...(isRecord(turn.failure) && typeof turn.failure.code === "string"
        ? { failure: { code: turn.failure.code } }
        : {}),
      ...(typeof turn.ownerAttemptId === "string" ? { ownerAttemptId: turn.ownerAttemptId } : {}),
    };
    return snapshot;
  }

  async function failTurnInternal(turn: FailTurnInput, remainingRetries: number): Promise<void> {
    if (
      !isPositiveSafeInteger(turn.ordinal) ||
      typeof turn.invocationClaimed !== "boolean" ||
      typeof turn.providerFinished !== "boolean"
    ) {
      throw new TypeError("Turn failure input is invalid.");
    }
    const key = turnKey(turn.conversationId, turn.ordinal);
    const metaKey = { ...conversationKey(turn.conversationId), sk: "META" };
    const [previousTurn, previousMeta] = await Promise.all([getItem(key), getItem(metaKey)]);
    const now = isoDate(turn.now);
    const sub = previousMeta?.sub ?? previousTurn?.sub;
    const botId = previousMeta?.botId ?? previousTurn?.botId;
    const historyProjection =
      typeof sub === "string" && typeof botId === "string"
        ? await historyProjectionFor(previousMeta, turn.conversationId, sub, botId, now)
        : undefined;
    const historyUpdate = historyUpdateParts(previousMeta, historyProjection);
    const cursor = previousTurn?.cursor ?? turn.answerManifest?.count ?? 0;
    const phase = turn.invocationClaimed ? "invocation_claimed" : "admitted";
    const retire = turn.invocationClaimed && !turn.providerFinished;
    const answerManifest = { count: cursor, complete: false };
    const projectedTurn = {
      ...(previousTurn ?? {
        ...key,
        conversationId: turn.conversationId,
        queryId: turn.queryId,
        ordinal: turn.ordinal,
      }),
      status: "failed",
      phase: "failed",
      failure: { code: turn.code },
      failedAt: now,
      updatedAt: now,
      answerManifest,
      ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
      ...(turn.requestId ? { requestId: turn.requestId } : {}),
      ...(turn.metrics ? { metrics: turn.metrics } : {}),
      ...(turn.providerError ? { providerError: turn.providerError } : {}),
    };
    const projectedMeta: Record<string, unknown> = {
      ...(previousMeta ?? metaKey),
      updatedAt: now,
      ...historyProjection,
      ...(retire ? { closed: true } : {}),
    };
    delete projectedMeta.activeQueryId;
    delete projectedMeta.activeOwnerAttemptId;
    const turnUpdate = {
      Update: {
        TableName: tableName,
        Key: key,
        UpdateExpression:
          "SET #status = :failed, #phase = :failed, #failure = :failure, #failedAt = :now, #updatedAt = :now, #answerManifest = :manifest" +
          (turn.stopReason ? ", #stopReason = :stopReason" : "") +
          (turn.requestId ? ", #requestId = :requestId" : "") +
          (turn.metrics ? ", #metrics = :metrics" : "") +
          (turn.providerError ? ", #providerError = :providerError" : ""),
        ConditionExpression:
          "#status = :inProgress AND #phase = :expectedPhase AND #queryId = :queryId AND #ownerAttemptId = :ownerAttemptId AND #cursor = :cursor AND (#resultDeadlineAt >= :nowMs OR #phase = :claimed)",
        ExpressionAttributeNames: {
          "#status": "status",
          "#phase": "phase",
          "#queryId": "queryId",
          "#ownerAttemptId": "ownerAttemptId",
          "#cursor": "cursor",
          "#resultDeadlineAt": "resultDeadlineAt",
          "#failure": "failure",
          "#failedAt": "failedAt",
          "#updatedAt": "updatedAt",
          "#answerManifest": "answerManifest",
          ...(turn.stopReason ? { "#stopReason": "stopReason" } : {}),
          ...(turn.requestId ? { "#requestId": "requestId" } : {}),
          ...(turn.metrics ? { "#metrics": "metrics" } : {}),
          ...(turn.providerError ? { "#providerError": "providerError" } : {}),
        },
        ExpressionAttributeValues: {
          ":failed": "failed",
          ":failure": { code: turn.code },
          ":now": now,
          ":nowMs": turn.now,
          ":inProgress": "in_progress",
          ":expectedPhase": phase,
          ":claimed": "invocation_claimed",
          ":queryId": turn.queryId,
          ":ownerAttemptId": turn.ownerAttemptId,
          ":cursor": cursor,
          ":manifest": answerManifest,
          ...(turn.stopReason ? { ":stopReason": turn.stopReason } : {}),
          ...(turn.requestId ? { ":requestId": turn.requestId } : {}),
          ...(turn.metrics ? { ":metrics": turn.metrics } : {}),
          ...(turn.providerError ? { ":providerError": turn.providerError } : {}),
        },
      },
    };
    const metaUpdate = {
      Update: {
        TableName: tableName,
        Key: metaKey,
        UpdateExpression:
          historyMetaSetExpression("#updatedAt", historyUpdate) +
          (retire ? ", #closed = :true" : "") +
          " REMOVE #activeQueryId, #activeOwnerAttemptId",
        ConditionExpression:
          "#activeQueryId = :queryId AND #activeOwnerAttemptId = :ownerAttemptId",
        ExpressionAttributeNames: {
          "#updatedAt": "updatedAt",
          "#activeQueryId": "activeQueryId",
          "#activeOwnerAttemptId": "activeOwnerAttemptId",
          ...historyUpdate.names,
          ...(retire ? { "#closed": "closed" } : {}),
        },
        ExpressionAttributeValues: {
          ":now": now,
          ...historyUpdate.values,
          ":queryId": turn.queryId,
          ":ownerAttemptId": turn.ownerAttemptId,
          ...(retire ? { ":true": true } : {}),
        },
      },
    };
    const actions = [turnUpdate, metaUpdate];
    preflight(actions, [projectedTurn, projectedMeta]);
    try {
      await documentClient.send(new TransactWriteCommand({ TransactItems: actions }));
    } catch (error) {
      const latest = await getSubmissionByTurn(turn).catch(() => null);
      if (latest?.status === "failed" && latest.ownerAttemptId === turn.ownerAttemptId) return;
      if (
        remainingRetries > 0 &&
        isConditionalFailure(error) &&
        latest?.status === "in_progress" &&
        latest.ownerAttemptId === turn.ownerAttemptId &&
        latest.queryId === turn.queryId &&
        latest.cursor !== cursor
      ) {
        return failTurnInternal(turn, remainingRetries - 1);
      }
      throw error;
    }
  }

  async function reconcileExpiredStoredTurn(input: {
    sub: string;
    botId: string;
    conversationId: string;
    ordinal: number;
    queryId: string;
    now: number;
  }): Promise<{
    turn: Record<string, unknown>;
    meta: ConversationMeta;
    confirmable: boolean;
  }> {
    const key = turnKey(input.conversationId, input.ordinal);
    const metaKey = { ...conversationKey(input.conversationId), sk: "META" };
    const [turn, meta] = await Promise.all([getItem(key), getItem(metaKey)]);
    if (!turn || !meta) throw new Error("Conversation turn or META record is missing.");
    if (
      turn.pk !== key.pk ||
      turn.sk !== key.sk ||
      turn.conversationId !== input.conversationId ||
      turn.ordinal !== input.ordinal ||
      turn.queryId !== input.queryId ||
      (turn.sub !== undefined && turn.sub !== input.sub) ||
      (turn.botId !== undefined && turn.botId !== input.botId) ||
      !isConversationMeta(meta, input.conversationId) ||
      meta.sub !== input.sub ||
      meta.botId !== input.botId
    ) {
      throw new Error("Conversation turn does not match its owner and META record.");
    }
    if (turn.status !== "in_progress") return { turn, meta, confirmable: true };
    const phase = turn.phase;
    const ownerAttemptId = turn.ownerAttemptId;
    const cursor = turn.cursor;
    const deadline = turn.resultDeadlineAt;
    const active =
      (phase === "admitted" || phase === "invocation_claimed") &&
      typeof ownerAttemptId === "string" &&
      ownerAttemptId.length > 0 &&
      Number.isSafeInteger(cursor) &&
      Number(cursor) >= 0 &&
      Number.isSafeInteger(deadline) &&
      Number(deadline) >= 0 &&
      meta.activeQueryId === input.queryId &&
      meta.activeOwnerAttemptId === ownerAttemptId;
    if (!active) return { turn, meta, confirmable: false };
    if (input.now < Number(deadline)) return { turn, meta, confirmable: true };

    const now = isoDate(input.now);
    const retired = phase === "invocation_claimed";
    const answerManifest = { count: Number(cursor), complete: false };
    const historyProjection = await historyProjectionFor(
      meta,
      input.conversationId,
      input.sub,
      input.botId,
      now,
    );
    const historyUpdate = historyUpdateParts(meta, historyProjection);
    const projectedTurn = {
      ...turn,
      status: "failed",
      phase: "failed",
      failure: { code: "result_timeout" },
      failedAt: now,
      updatedAt: now,
      answerManifest,
    };
    const projectedMeta: Record<string, unknown> = {
      ...meta,
      updatedAt: now,
      ...historyProjection,
      ...(retired ? { closed: true } : {}),
    };
    delete projectedMeta.activeQueryId;
    delete projectedMeta.activeOwnerAttemptId;
    const turnUpdate = {
      Update: {
        TableName: tableName,
        Key: key,
        UpdateExpression:
          "SET #status = :failed, #phase = :failed, #failure = :failure, #failedAt = :now, #updatedAt = :now, #answerManifest = :manifest",
        ConditionExpression:
          "#status = :inProgress AND #phase = :phase AND #ownerAttemptId = :ownerAttemptId AND #resultDeadlineAt <= :nowMs AND #cursor = :cursor AND #queryId = :queryId",
        ExpressionAttributeNames: {
          "#status": "status",
          "#phase": "phase",
          "#ownerAttemptId": "ownerAttemptId",
          "#resultDeadlineAt": "resultDeadlineAt",
          "#cursor": "cursor",
          "#queryId": "queryId",
          "#failure": "failure",
          "#failedAt": "failedAt",
          "#updatedAt": "updatedAt",
          "#answerManifest": "answerManifest",
        },
        ExpressionAttributeValues: {
          ":failed": "failed",
          ":phase": phase,
          ":ownerAttemptId": ownerAttemptId,
          ":nowMs": input.now,
          ":cursor": Number(cursor),
          ":queryId": input.queryId,
          ":inProgress": "in_progress",
          ":failure": { code: "result_timeout" },
          ":now": now,
          ":manifest": answerManifest,
        },
      },
    };
    const metaUpdate = {
      Update: {
        TableName: tableName,
        Key: metaKey,
        UpdateExpression:
          historyMetaSetExpression("#updatedAt", historyUpdate) +
          (retired ? ", #closed = :true" : "") +
          " REMOVE #activeQueryId, #activeOwnerAttemptId",
        ConditionExpression:
          "#sub = :sub AND #botId = :botId AND #conversationId = :conversationId AND #activeQueryId = :queryId AND #activeOwnerAttemptId = :ownerAttemptId",
        ExpressionAttributeNames: {
          "#updatedAt": "updatedAt",
          "#sub": "sub",
          "#botId": "botId",
          "#conversationId": "conversationId",
          "#activeQueryId": "activeQueryId",
          "#activeOwnerAttemptId": "activeOwnerAttemptId",
          ...historyUpdate.names,
          ...(retired ? { "#closed": "closed" } : {}),
        },
        ExpressionAttributeValues: {
          ":now": now,
          ":sub": input.sub,
          ":botId": input.botId,
          ":conversationId": input.conversationId,
          ":queryId": input.queryId,
          ":ownerAttemptId": ownerAttemptId,
          ...historyUpdate.values,
          ...(retired ? { ":true": true } : {}),
        },
      },
    };
    const actions = [turnUpdate, metaUpdate];
    preflight(actions, [projectedTurn, projectedMeta]);
    try {
      await documentClient.send(new TransactWriteCommand({ TransactItems: actions }));
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
    const [currentTurn, currentMeta] = await Promise.all([getItem(key), getItem(metaKey)]);
    if (
      !currentTurn ||
      !currentMeta ||
      !isConversationMeta(currentMeta, input.conversationId) ||
      currentMeta.sub !== input.sub ||
      currentMeta.botId !== input.botId
    ) {
      throw new Error("Reconciled conversation could not be read.");
    }
    return {
      turn: currentTurn,
      meta: currentMeta,
      confirmable:
        currentTurn.status !== "in_progress" ||
        ((currentTurn.phase === "admitted" || currentTurn.phase === "invocation_claimed") &&
          typeof currentTurn.ownerAttemptId === "string" &&
          currentMeta.activeQueryId === currentTurn.queryId &&
          currentMeta.activeOwnerAttemptId === currentTurn.ownerAttemptId &&
          Number.isSafeInteger(currentTurn.resultDeadlineAt) &&
          Number.isSafeInteger(currentTurn.cursor)),
    };
  }

  const adapter = {
    async getMeta({
      conversationId,
    }: {
      conversationId: string;
    }): Promise<ConversationMeta | null> {
      const item = await getItem({ ...conversationKey(conversationId), sk: "META" });
      if (!item) return null;
      if (!isConversationMeta(item, conversationId)) {
        throw new Error("Conversation META record is malformed; refusing to use it.");
      }
      return item;
    },

    async readContext({
      conversationId,
    }: {
      conversationId: string;
    }): Promise<ConversationContext> {
      const partition = conversationKey(conversationId);
      const metaItem = await getItem({ ...partition, sk: "META" });
      if (!metaItem) {
        return reconstructMessages(conversationId, await queryItems(partition));
      }
      if (!isConversationMeta(metaItem, conversationId)) {
        throw new Error("Conversation META record is malformed; refusing to use its context.");
      }
      const summaryPointer = readSummaryPointer(metaItem);
      if (!summaryPointer) {
        return reconstructMessages(conversationId, await queryItems(partition));
      }
      if (summaryPointer.throughOrdinal > metaItem.lastOrdinal) {
        throw new Error("Conversation META summary is ahead of its latest turn.");
      }

      const summary = await contextStorage.readSummary({
        conversationId,
        ...summaryPointer,
        sub: metaItem.sub,
        botId: metaItem.botId,
      });
      await contextStorage.verifyReferences(conversationId, summary.sourceReferences, {
        sub: metaItem.sub,
        botId: metaItem.botId,
      });

      const items: Record<string, unknown>[] = [metaItem];
      if (summaryPointer.throughOrdinal < metaItem.lastOrdinal) {
        const firstOrdinal = summaryPointer.throughOrdinal + 1;
        const turnRecords = await contextStorage.readTurnRange(
          conversationId,
          firstOrdinal,
          metaItem.lastOrdinal,
        );
        if (turnRecords.length !== metaItem.lastOrdinal - summaryPointer.throughOrdinal) {
          throw new Error("Conversation context is missing a turn after its summary.");
        }
        for (let index = 0; index < turnRecords.length; index += 1) {
          const ordinal = firstOrdinal + index;
          const turn = turnRecords[index];
          if (
            turn.pk !== partition.pk ||
            turn.sk !== turnKey(conversationId, ordinal).sk ||
            turn.conversationId !== conversationId ||
            turn.ordinal !== ordinal ||
            typeof turn.queryId !== "string" ||
            !uuidPattern.test(turn.queryId) ||
            !["completed", "failed", "in_progress"].includes(String(turn.status)) ||
            (turn.sub !== undefined && turn.sub !== metaItem.sub) ||
            (turn.botId !== undefined && turn.botId !== metaItem.botId)
          ) {
            throw new Error("Conversation context contains a malformed turn after its summary.");
          }
          items.push(turn);
          if (turn.status === "completed") {
            items.push(
              ...(await queryItems(
                partition,
                `${turnKey(conversationId, ordinal).sk}#${turn.queryId}#`,
              )),
            );
            if (isChunkedContextSnapshot(turn.contextSnapshot)) {
              items.push(
                ...(await queryItems(partition, `${turnKey(conversationId, ordinal).sk}#CONTEXT#`)),
              );
            }
          }
        }
      }
      return {
        ...reconstructMessages(conversationId, items, { validateContextReferences: false }),
        summary,
      };
    },

    async readQuota({
      sub,
      botId,
      now,
    }: {
      sub: string;
      botId: string;
      now: number;
    }): Promise<QuotaView> {
      if (
        typeof sub !== "string" ||
        !sub ||
        typeof botId !== "string" ||
        !botId ||
        !Number.isFinite(now)
      ) {
        throw new TypeError("Quota read input is invalid.");
      }
      const periods = localPeriods(now);
      const usagePk = { pk: "USER#" + sub + "#BOT#" + botId };
      const policyKey = { pk: "BOT#" + botId, sk: "QUOTA#POLICY" };
      const dailyKey = { ...usagePk, sk: "USAGE#DAY#" + periods.day.period };
      const monthlyKey = { ...usagePk, sk: "USAGE#MONTH#" + periods.month.period };
      const [policyItem, dailyItem, monthlyItem] = await Promise.all([
        getItem(policyKey),
        getItem(dailyKey),
        getItem(monthlyKey),
      ]);
      const policy = validPolicy(policyItem);
      const dailyUsed = validCounter(dailyItem);
      const monthlyUsed = validCounter(monthlyItem);
      const daily: QuotaView["daily"] = {
        used: dailyUsed,
        limit: policy.dailyLimit,
        resetAt: periods.day.resetAt,
        period: periods.day.period,
      };
      const monthly: QuotaView["monthly"] = {
        used: monthlyUsed,
        limit: policy.monthlyLimit,
        resetAt: periods.month.resetAt,
        period: periods.month.period,
      };
      const exhausted = [
        ...(daily.used >= daily.limit ? [daily.resetAt] : []),
        ...(monthly.used >= monthly.limit ? [monthly.resetAt] : []),
      ];
      return {
        daily,
        monthly,
        serverNow: now,
        blockedUntil: exhausted.length > 0 ? Math.max(...exhausted) : null,
        policyRevision: policy.revision,
      };
    },

    getSubmission,

    async startTurn(turn: StartTurnInput): Promise<{ queryId: string; ordinal: number }> {
      const operation = turn.operation ?? "start";
      const baseOrdinal = turn.baseOrdinal ?? 0;
      if (operation !== "start") throw new TypeError("Start admission operation is invalid.");
      validateAdmission(turn, operation, baseOrdinal);
      const prior = await existingAdmission(turn, operation, baseOrdinal);
      if (prior) return prior;
      const plan = await buildAdmission(turn, operation, baseOrdinal);
      assertCurrentQuotaPeriod(turn.quota);
      try {
        await documentClient.send(
          new TransactWriteCommand({
            TransactItems: plan.transactionItems,
            ReturnConsumedCapacity: "NONE",
          }),
        );
      } catch (error) {
        return classifyAdmissionFailure(turn, error, operation, baseOrdinal);
      }
      return { queryId: turn.queryId, ordinal: plan.ordinal };
    },

    async continueTurn(turn: ContinueTurnInput): Promise<{ queryId: string; ordinal: number }> {
      const operation = turn.operation ?? "message";
      const baseOrdinal = inputBaseOrdinal(turn);
      if (operation !== "message") throw new TypeError("Continue admission operation is invalid.");
      validateAdmission(turn, operation, baseOrdinal);
      const prior = await existingAdmission(turn, operation, baseOrdinal);
      if (prior) return prior;
      const plan = await buildAdmission(turn, operation, baseOrdinal);
      assertCurrentQuotaPeriod(turn.quota);
      try {
        await documentClient.send(
          new TransactWriteCommand({
            TransactItems: plan.transactionItems,
            ReturnConsumedCapacity: "NONE",
          }),
        );
      } catch (error) {
        return classifyAdmissionFailure(turn, error, operation, baseOrdinal);
      }
      return { queryId: turn.queryId, ordinal: plan.ordinal };
    },

    async claimInvocation(claim: {
      conversationId: string;
      ordinal: number;
      queryId: string;
      ownerAttemptId: string;
      now: number;
    }): Promise<boolean> {
      const key = turnKey(claim.conversationId, claim.ordinal);
      const now = isoDate(claim.now);
      const current = await getItem(key);
      const projectedTurn = {
        ...(current ?? {
          ...key,
          conversationId: claim.conversationId,
          queryId: claim.queryId,
          ordinal: claim.ordinal,
          status: "in_progress",
          ownerAttemptId: claim.ownerAttemptId,
          resultDeadlineAt: claim.now + 1,
        }),
        phase: "invocation_claimed",
        invocationClaimedAt: now,
        updatedAt: now,
      };
      const claimUpdate = {
        Update: {
          TableName: tableName,
          Key: key,
          UpdateExpression: "SET #phase = :claimed, #invocationClaimedAt = :now, #updatedAt = :now",
          ConditionExpression:
            "#status = :inProgress AND #phase = :admitted AND #queryId = :queryId AND #ownerAttemptId = :ownerAttemptId AND #resultDeadlineAt > :nowMs",
          ExpressionAttributeNames: {
            "#status": "status",
            "#phase": "phase",
            "#queryId": "queryId",
            "#ownerAttemptId": "ownerAttemptId",
            "#resultDeadlineAt": "resultDeadlineAt",
            "#invocationClaimedAt": "invocationClaimedAt",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":inProgress": "in_progress",
            ":admitted": "admitted",
            ":claimed": "invocation_claimed",
            ":queryId": claim.queryId,
            ":ownerAttemptId": claim.ownerAttemptId,
            ":now": now,
            ":nowMs": claim.now,
          },
        },
      };
      preflight([claimUpdate], [projectedTurn]);
      try {
        await documentClient.send(new UpdateCommand(claimUpdate.Update));
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        try {
          const current = await getItem(key);
          return (
            current?.queryId === claim.queryId &&
            current?.ownerAttemptId === claim.ownerAttemptId &&
            current?.status === "in_progress" &&
            current?.phase === "invocation_claimed"
          );
        } catch {
          throw error;
        }
      }
    },

    async appendChunk(chunk: AppendChunkInput): Promise<void> {
      if (
        chunk.role !== "assistant" ||
        !isPositiveSafeInteger(chunk.ordinal) ||
        !Number.isSafeInteger(chunk.index) ||
        chunk.index < 0 ||
        typeof chunk.text !== "string" ||
        !Number.isFinite(chunk.now)
      ) {
        throw new TypeError("Assistant chunk input is invalid.");
      }
      if (Buffer.byteLength(chunk.text, "utf8") > maxDynamoTextChunkBytes) {
        throw new RangeError("Conversation text chunk exceeds the storage item limit.");
      }
      const key = turnKey(chunk.conversationId, chunk.ordinal);
      const previous = await getItem(key);
      const projectedTurn = {
        ...(previous ?? {
          ...key,
          conversationId: chunk.conversationId,
          queryId: chunk.queryId,
          ordinal: chunk.ordinal,
          status: "in_progress",
          phase: "invocation_claimed",
          ownerAttemptId: chunk.ownerAttemptId,
          resultDeadlineAt: chunk.now + 1,
        }),
        cursor: chunk.index + 1,
        answerManifest: { count: chunk.index + 1, complete: false },
        updatedAt: isoDate(chunk.now),
      };
      const output = chunkItem(chunk);
      const update = {
        Update: {
          TableName: tableName,
          Key: key,
          UpdateExpression:
            "SET #cursor = :nextCursor, #answerManifest = :manifest, #updatedAt = :updatedAt",
          ConditionExpression:
            "#status = :inProgress AND #phase = :claimed AND #queryId = :queryId AND #ownerAttemptId = :ownerAttemptId AND #cursor = :index AND #resultDeadlineAt > :now",
          ExpressionAttributeNames: {
            "#cursor": "cursor",
            "#answerManifest": "answerManifest",
            "#updatedAt": "updatedAt",
            "#status": "status",
            "#phase": "phase",
            "#queryId": "queryId",
            "#ownerAttemptId": "ownerAttemptId",
            "#resultDeadlineAt": "resultDeadlineAt",
          },
          ExpressionAttributeValues: {
            ":nextCursor": chunk.index + 1,
            ":manifest": { count: chunk.index + 1, complete: false },
            ":updatedAt": isoDate(chunk.now),
            ":inProgress": "in_progress",
            ":claimed": "invocation_claimed",
            ":queryId": chunk.queryId,
            ":ownerAttemptId": chunk.ownerAttemptId,
            ":index": chunk.index,
            ":now": chunk.now,
          },
        },
      };
      const actions = [
        {
          Put: {
            TableName: tableName,
            Item: output,
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        update,
      ];
      preflight(actions, [output, projectedTurn]);
      try {
        await documentClient.send(new TransactWriteCommand({ TransactItems: actions }));
      } catch (error) {
        try {
          const [current, savedChunk] = await Promise.all([
            getItem(key),
            getItem(
              chunkKey(chunk.conversationId, chunk.ordinal, chunk.queryId, chunk.role, chunk.index),
            ),
          ]);
          if (
            savedChunk?.queryId === chunk.queryId &&
            savedChunk?.role === chunk.role &&
            savedChunk?.index === chunk.index &&
            savedChunk?.text === chunk.text &&
            current?.queryId === chunk.queryId &&
            current?.ownerAttemptId === chunk.ownerAttemptId &&
            Number(current.cursor) >= chunk.index + 1
          )
            return;
        } catch {
          /* Preserve the original write error when confirmation is unavailable. */
        }
        throw error;
      }
    },

    async completeTurn(turn: CompleteTurnInput): Promise<void> {
      if (
        !isPositiveSafeInteger(turn.ordinal) ||
        turn.answerManifest.complete !== true ||
        !Number.isSafeInteger(turn.answerManifest.count) ||
        turn.answerManifest.count < 0
      ) {
        throw new TypeError("Turn completion input is invalid.");
      }
      const key = turnKey(turn.conversationId, turn.ordinal);
      const metaKey = { ...conversationKey(turn.conversationId), sk: "META" };
      const [previousTurn, previousMeta] = await Promise.all([getItem(key), getItem(metaKey)]);
      const cursor = previousTurn?.cursor ?? turn.answerManifest.count;
      const completedAt = isoDate(turn.now);
      const sub = previousMeta?.sub ?? previousTurn?.sub;
      const botId = previousMeta?.botId ?? previousTurn?.botId;
      const historyProjection =
        typeof sub === "string" && typeof botId === "string"
          ? await historyProjectionFor(previousMeta, turn.conversationId, sub, botId, completedAt)
          : undefined;
      const historyUpdate = historyUpdateParts(previousMeta, historyProjection);
      const projectedTurn = {
        ...(previousTurn ?? {
          ...key,
          conversationId: turn.conversationId,
          queryId: turn.queryId,
          ordinal: turn.ordinal,
        }),
        status: "completed",
        phase: "complete",
        answerManifest: turn.answerManifest,
        cursor,
        invocation: turn.invocation ?? previousTurn?.invocation,
        completedAt,
        updatedAt: completedAt,
        stopReason: turn.stopReason ?? "endTurn",
        ...(turn.requestId ? { requestId: turn.requestId } : {}),
        ...(turn.metrics ? { metrics: turn.metrics } : {}),
      };
      const projectedMeta: Record<string, unknown> = {
        ...(previousMeta ?? metaKey),
        updatedAt: completedAt,
        ...historyProjection,
      };
      delete projectedMeta.activeQueryId;
      delete projectedMeta.activeOwnerAttemptId;
      const turnUpdate = {
        Update: {
          TableName: tableName,
          Key: key,
          UpdateExpression:
            "SET #status = :completed, #phase = :complete, #answerManifest = :manifest, #completedAt = :now, #updatedAt = :now, #stopReason = :stopReason" +
            (turn.invocation ? ", #invocation = :invocation" : "") +
            (turn.requestId ? ", #requestId = :requestId" : "") +
            (turn.metrics ? ", #metrics = :metrics" : ""),
          ConditionExpression:
            "#status = :inProgress AND #phase = :claimed AND #queryId = :queryId AND #ownerAttemptId = :ownerAttemptId AND #resultDeadlineAt > :nowMs AND #cursor = :count",
          ExpressionAttributeNames: {
            "#status": "status",
            "#phase": "phase",
            "#queryId": "queryId",
            "#ownerAttemptId": "ownerAttemptId",
            "#resultDeadlineAt": "resultDeadlineAt",
            "#cursor": "cursor",
            "#answerManifest": "answerManifest",
            "#completedAt": "completedAt",
            "#updatedAt": "updatedAt",
            "#stopReason": "stopReason",
            ...(turn.invocation ? { "#invocation": "invocation" } : {}),
            ...(turn.requestId ? { "#requestId": "requestId" } : {}),
            ...(turn.metrics ? { "#metrics": "metrics" } : {}),
          },
          ExpressionAttributeValues: {
            ":completed": "completed",
            ":complete": "complete",
            ":manifest": turn.answerManifest,
            ":now": completedAt,
            ":nowMs": turn.now,
            ":stopReason": turn.stopReason ?? "endTurn",
            ":inProgress": "in_progress",
            ":claimed": "invocation_claimed",
            ":queryId": turn.queryId,
            ":ownerAttemptId": turn.ownerAttemptId,
            ":count": turn.answerManifest.count,
            ...(turn.invocation ? { ":invocation": turn.invocation } : {}),
            ...(turn.requestId ? { ":requestId": turn.requestId } : {}),
            ...(turn.metrics ? { ":metrics": turn.metrics } : {}),
          },
        },
      };
      const metaUpdate = {
        Update: {
          TableName: tableName,
          Key: metaKey,
          UpdateExpression: `${historyMetaSetExpression("#updatedAt", historyUpdate)} REMOVE #activeQueryId, #activeOwnerAttemptId`,
          ConditionExpression:
            "#activeQueryId = :queryId AND #activeOwnerAttemptId = :ownerAttemptId",
          ExpressionAttributeNames: {
            "#updatedAt": "updatedAt",
            "#activeQueryId": "activeQueryId",
            "#activeOwnerAttemptId": "activeOwnerAttemptId",
            ...historyUpdate.names,
          },
          ExpressionAttributeValues: {
            ":now": completedAt,
            ...historyUpdate.values,
            ":queryId": turn.queryId,
            ":ownerAttemptId": turn.ownerAttemptId,
          },
        },
      };
      const actions = [turnUpdate, metaUpdate];
      preflight(actions, [projectedTurn, projectedMeta]);
      try {
        await documentClient.send(new TransactWriteCommand({ TransactItems: actions }));
      } catch (error) {
        const latest = await getSubmissionByTurn(turn).catch(() => null);
        if (
          latest?.status === "completed" &&
          latest.ownerAttemptId === turn.ownerAttemptId &&
          latest.cursor === turn.answerManifest.count
        )
          return;
        throw error;
      }
    },

    async failTurn(turn: FailTurnInput): Promise<void> {
      return failTurnInternal(turn, 1);
    },
    async reconcileTurn(input: {
      sub: string;
      botId: string;
      conversationId: string;
      queryId: string;
      now: number;
    }): Promise<SubmissionSnapshot | null> {
      const snapshot = await getSubmission({
        sub: input.sub,
        botId: input.botId,
        queryId: input.queryId,
      });
      if (
        !snapshot ||
        snapshot.conversationId !== input.conversationId ||
        snapshot.status !== "in_progress"
      )
        return snapshot;
      if (input.now < snapshot.resultDeadlineAt) return snapshot;
      if (!snapshot.ownerAttemptId) throw new Error("Expired turn has no owner attempt.");
      await reconcileExpiredStoredTurn({
        sub: input.sub,
        botId: input.botId,
        conversationId: input.conversationId,
        ordinal: snapshot.ordinal,
        queryId: input.queryId,
        now: input.now,
      });
      return getSubmission({ sub: input.sub, botId: input.botId, queryId: input.queryId });
    },

    async reconcileHistoryTurn(input: {
      sub: string;
      botId: string;
      conversationId: string;
      ordinal: number;
      queryId: string;
      now: number;
    }): Promise<{
      turn: Record<string, unknown>;
      meta: ConversationMeta;
      confirmable: boolean;
    }> {
      if (
        typeof input.sub !== "string" ||
        input.sub.length === 0 ||
        typeof input.botId !== "string" ||
        input.botId.length === 0 ||
        typeof input.conversationId !== "string" ||
        !uuidPattern.test(input.conversationId) ||
        !isPositiveSafeInteger(input.ordinal) ||
        typeof input.queryId !== "string" ||
        !uuidPattern.test(input.queryId) ||
        !Number.isFinite(input.now)
      ) {
        throw new TypeError("History reconciliation input is invalid.");
      }
      return reconcileExpiredStoredTurn(input);
    },
  };

  async function getSubmissionByTurn(turn: {
    conversationId: string;
    queryId: string;
  }): Promise<SubmissionSnapshot | null> {
    const record = await getItem({ pk: "CONV#" + turn.conversationId, sk: "META" });
    if (!record || typeof record.sub !== "string" || typeof record.botId !== "string") return null;
    return getSubmission({
      sub: String(record.sub),
      botId: String(record.botId),
      queryId: turn.queryId,
    });
  }

  return adapter;
}
