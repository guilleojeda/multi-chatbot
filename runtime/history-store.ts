import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createConversationStoreAdapter } from "./conversation-store.js";
import type { ConversationMeta } from "./contracts.js";
import { parseVerifiedHistoryTimestamp } from "./history-projection.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGE = 50;
const MAX_INDEX_PAGES = 4;
const MAX_INDEX_READS = 100;
const MAX_CHUNKS = 16;
const MAX_BYTES = 3 * 1024 * 1024;
const ENVELOPE_RESERVE = 8192;
type Code =
  | "invalid_cursor"
  | "invalid_request"
  | "forbidden"
  | "conversation_unavailable"
  | "history_unavailable";
type Err = Error & { code: Code };
type Key = Record<string, unknown>;
type Meta = ConversationMeta;
type VerifiedTimestamp = { value: string; milliseconds: number };

function fail(code: Code, message: string): Err {
  const error = new Error(message) as Err;
  error.code = code;
  return error;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isVerifiedTimestamp(value: unknown): value is string {
  return verifiedTimestamp(value) !== undefined;
}
function verifiedTimestamp(value: unknown): VerifiedTimestamp | undefined {
  const milliseconds = parseVerifiedHistoryTimestamp(value);
  return typeof value === "string" && milliseconds !== undefined
    ? { value, milliseconds }
    : undefined;
}
function canonicalHistoryOrderTimestamp(
  value: unknown,
  conversationId: string,
): VerifiedTimestamp | undefined {
  if (typeof value !== "string") return undefined;
  const suffix = "#" + conversationId;
  if (!value.endsWith(suffix)) return undefined;
  const timestamp = value.slice(0, -suffix.length);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    return undefined;
  }
  const verified = verifiedTimestamp(timestamp);
  return verified && new Date(verified.milliseconds).toISOString() === timestamp
    ? verified
    : undefined;
}
function presentationUpdatedAt(
  meta: Meta,
  conversationId: string,
  expectedHistoryOwner: string,
): string | undefined {
  const updatedAt = verifiedTimestamp(meta.updatedAt);
  if (meta.historyOwner !== expectedHistoryOwner) return updatedAt?.value;
  const projectedAt = canonicalHistoryOrderTimestamp(meta.historyOrder, conversationId);
  if (!projectedAt) return updatedAt?.value;
  return !updatedAt || projectedAt.milliseconds > updatedAt.milliseconds
    ? projectedAt.value
    : updatedAt.value;
}
function isLegacyGeneratingTurn(value: unknown): boolean {
  if (!isRecord(value) || value.status !== "in_progress" || value.phase !== "generating") {
    return false;
  }
  const question = value.questionManifest;
  const answer = value.answerManifest;
  return (
    isRecord(question) &&
    positive(question.count) &&
    question.complete === true &&
    isRecord(answer) &&
    answer.count === 0 &&
    answer.complete === false &&
    (value.cursor === undefined || value.cursor === 0)
  );
}
function hashScope(sub: string, botId: string): string {
  return createHash("sha256")
    .update(sub + "\0" + botId)
    .digest("base64url");
}
function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decode(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    throw fail("invalid_cursor", "History cursor is invalid.");
  }
  try {
    const result: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(result)) throw new Error("invalid cursor");
    return result;
  } catch {
    throw fail("invalid_cursor", "History cursor is invalid.");
  }
}
function verifyCursor(cursor: Record<string, unknown>, kind: string, scope: string): void {
  if (cursor.v !== 1 || cursor.kind !== kind || cursor.scope !== scope) {
    throw fail("invalid_cursor", "History cursor does not match this request.");
  }
}
function getPageSize(value: unknown): number {
  if (value === undefined) return 25;
  if (!positive(value)) throw fail("invalid_request", "History page size is invalid.");
  return Math.min(value, MAX_PAGE);
}
function isKey(value: unknown): value is Key {
  return isRecord(value) && typeof value.pk === "string" && typeof value.sk === "string";
}
function turnKey(id: string, ordinal: number): Key {
  return { pk: "CONV#" + id, sk: "TURN#" + String(ordinal).padStart(8, "0") };
}
function textPrefix(
  id: string,
  ordinal: number,
  queryId: string,
  role: "user" | "assistant",
): string {
  return turnKey(id, ordinal).sk + "#" + queryId + "#" + role.toUpperCase() + "#";
}
function fitsEnvelope(body: Record<string, unknown>): boolean {
  const serialized = JSON.stringify({
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
  return Buffer.byteLength(serialized, "utf8") + ENVELOPE_RESERVE <= MAX_BYTES;
}
function asStorageError(error: unknown, fallback: Code): Err {
  const codes: Code[] = [
    "invalid_cursor",
    "invalid_request",
    "forbidden",
    "conversation_unavailable",
    "history_unavailable",
  ];
  if (error instanceof Error && isRecord(error) && codes.includes(error.code as Code)) {
    const mapped = new Error(error.message) as Err;
    mapped.code = error.code as Code;
    return mapped;
  }
  return fail(fallback, "Conversation history is temporarily unavailable.");
}
function validMeta(value: unknown, id: string): value is Meta {
  return (
    isRecord(value) &&
    value.pk === "CONV#" + id &&
    value.sk === "META" &&
    value.conversationId === id &&
    typeof value.sub === "string" &&
    typeof value.botId === "string" &&
    positive(value.lastOrdinal) &&
    (value.closed === undefined || typeof value.closed === "boolean") &&
    (value.activeQueryId === undefined || typeof value.activeQueryId === "string")
  );
}
function validTurn(
  value: unknown,
  input: { id: string; ordinal?: number; sub: string; botId: string },
): value is Record<string, unknown> {
  const answerCount =
    isRecord(value) && isRecord(value.answerManifest) ? value.answerManifest.count : undefined;
  const cursor = isRecord(value) ? value.cursor : undefined;
  return (
    isRecord(value) &&
    value.pk === "CONV#" + input.id &&
    value.conversationId === input.id &&
    positive(value.ordinal) &&
    (input.ordinal === undefined || value.ordinal === input.ordinal) &&
    value.sk === turnKey(input.id, Number(value.ordinal)).sk &&
    value.sub === input.sub &&
    value.botId === input.botId &&
    typeof value.queryId === "string" &&
    uuid.test(value.queryId) &&
    ["in_progress", "completed", "failed"].includes(String(value.status)) &&
    (value.phase === undefined ||
      (value.status === "in_progress"
        ? ["admitted", "invocation_claimed"].includes(String(value.phase)) ||
          isLegacyGeneratingTurn(value)
        : value.status === "completed"
          ? value.phase === "complete"
          : value.phase === "failed")) &&
    isRecord(value.questionManifest) &&
    positive(value.questionManifest.count) &&
    value.questionManifest.complete === true &&
    isRecord(value.answerManifest) &&
    nonNegative(value.answerManifest.count) &&
    typeof value.answerManifest.complete === "boolean" &&
    (cursor === undefined || (nonNegative(cursor) && cursor === answerCount)) &&
    (value.status !== "completed" || positive(value.answerManifest.count)) &&
    (value.status !== "in_progress" || value.answerManifest.complete === false) &&
    (value.status !== "completed" || value.answerManifest.complete === true) &&
    (value.status !== "failed" || value.answerManifest.complete === false)
  );
}
function validChunk(
  value: unknown,
  input: { id: string; ordinal: number; queryId: string; role: "user" | "assistant" },
): value is { pk: string; sk: string; index: number; text: string } {
  return (
    isRecord(value) &&
    value.pk === "CONV#" + input.id &&
    value.sk ===
      textPrefix(input.id, input.ordinal, input.queryId, input.role) +
        String(value.index).padStart(8, "0") &&
    value.conversationId === input.id &&
    (value.ordinal === undefined || value.ordinal === input.ordinal) &&
    value.queryId === input.queryId &&
    value.role === input.role &&
    nonNegative(value.index) &&
    typeof value.text === "string"
  );
}
function answerCount(value: Record<string, unknown>): number {
  const manifest = value.answerManifest;
  if (!isRecord(manifest) || !nonNegative(manifest.count)) {
    throw fail("conversation_unavailable", "Conversation answer manifest is invalid.");
  }
  return manifest.count;
}
function failureCode(value: unknown): { code: string } | undefined {
  return isRecord(value) && typeof value.code === "string" ? { code: value.code } : undefined;
}

export function createHistoryStore(input: {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
  botId: string;
  historyIndexName?: string;
  now?: () => number;
}) {
  if (
    !input ||
    typeof input.documentClient?.send !== "function" ||
    typeof input.tableName !== "string" ||
    input.tableName.length === 0 ||
    typeof input.botId !== "string" ||
    input.botId.length === 0 ||
    (input.historyIndexName !== undefined &&
      (typeof input.historyIndexName !== "string" || !input.historyIndexName))
  ) {
    throw new TypeError("History store configuration is invalid.");
  }
  const { documentClient, tableName, botId } = input;
  const indexName = input.historyIndexName ?? "ConversationHistory";
  const now = input.now ?? Date.now;
  const ownerKey = (sub: string) => "USER#" + sub + "#BOT#" + botId;
  const baseStore = createConversationStoreAdapter({ documentClient, tableName, now });
  function scopeHash(scope: { sub: string; botId: string }): string {
    if (
      !scope ||
      typeof scope.sub !== "string" ||
      !scope.sub.trim() ||
      typeof scope.botId !== "string" ||
      !scope.botId
    ) {
      throw fail("invalid_request", "History owner is invalid.");
    }
    if (scope.botId !== botId) throw fail("forbidden", "History is unavailable.");
    return hashScope(scope.sub, scope.botId);
  }
  async function ownedMeta(sub: string, id: string): Promise<Meta> {
    let meta: Meta | null;
    try {
      meta = await baseStore.getMeta({ conversationId: id });
    } catch (error) {
      throw asStorageError(error, "conversation_unavailable");
    }
    if (!meta) throw fail("conversation_unavailable", "Conversation is unavailable.");
    if (meta.sub !== sub || meta.botId !== botId)
      throw fail("forbidden", "Conversation is unavailable.");
    if (!validMeta(meta, id)) {
      throw fail("conversation_unavailable", "Conversation is unavailable.");
    }
    return meta;
  }

  async function listConversations(scope: {
    sub: string;
    botId: string;
    cursor?: string;
    limit?: number;
  }) {
    const scopeDigest = scopeHash(scope);
    const limit = getPageSize(scope.limit);
    let startKey: Key | undefined;
    if (scope.cursor !== undefined) {
      const cursor = decode(scope.cursor);
      verifyCursor(cursor, "list", scopeDigest);
      const key = cursor.key;
      if (
        !isRecord(key) ||
        typeof key.pk !== "string" ||
        !/^CONV#[0-9a-f-]{36}$/i.test(key.pk) ||
        key.sk !== "META" ||
        key.historyOwner !== ownerKey(scope.sub) ||
        typeof key.historyOrder !== "string"
      ) {
        throw fail("invalid_cursor", "History cursor is invalid.");
      }
      startKey = key;
    }
    const conversations: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let queryPages = 0;
    let metaReads = 0;
    let nextKey = startKey;
    let more = false;
    while (
      conversations.length < limit &&
      queryPages < MAX_INDEX_PAGES &&
      metaReads < MAX_INDEX_READS
    ) {
      let page: Record<string, unknown>;
      try {
        page = await documentClient.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: indexName,
            KeyConditionExpression: "#historyOwner = :historyOwner",
            ExpressionAttributeNames: { "#historyOwner": "historyOwner" },
            ExpressionAttributeValues: { ":historyOwner": ownerKey(scope.sub) },
            ScanIndexForward: false,
            Limit: Math.min(limit, MAX_INDEX_READS - metaReads),
            ...(nextKey ? { ExclusiveStartKey: nextKey } : {}),
          }),
        );
      } catch (error) {
        throw asStorageError(error, "history_unavailable");
      }
      queryPages += 1;
      const candidates = Array.isArray(page.Items) ? page.Items.filter(isRecord) : [];
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (typeof candidate.pk !== "string" || candidate.sk !== "META") continue;
        const candidateKey = {
          pk: candidate.pk,
          sk: candidate.sk,
          historyOwner: candidate.historyOwner,
          historyOrder: candidate.historyOrder,
        };
        nextKey = candidateKey;
        const match = candidate.pk.match(/^CONV#([0-9a-f-]{36})$/i);
        if (
          !match ||
          candidate.historyOwner !== ownerKey(scope.sub) ||
          typeof candidate.historyOrder !== "string"
        )
          continue;
        const id = match[1];
        if (seen.has(id)) continue;
        seen.add(id);
        if (metaReads >= MAX_INDEX_READS) {
          more = true;
          break;
        }
        metaReads += 1;
        let meta: Meta | null;
        try {
          meta = await baseStore.getMeta({ conversationId: id });
        } catch (error) {
          throw asStorageError(error, "history_unavailable");
        }
        // GSI updates are eventual; stale and now-foreign projections are skipped.
        if (!meta || meta.sub !== scope.sub || meta.botId !== botId) continue;
        if (typeof meta.historyLabel !== "string" || !meta.historyLabel.trim()) {
          throw fail("history_unavailable", "Conversation history projection is invalid.");
        }
        const updatedAt = presentationUpdatedAt(meta, id, ownerKey(scope.sub));
        const row: Record<string, unknown> = {
          conversationId: id,
          label: meta.historyLabel,
          lastOrdinal: meta.lastOrdinal,
          closed: meta.closed === true,
          ...(isVerifiedTimestamp(meta.createdAt) ? { createdAt: meta.createdAt } : {}),
          ...(updatedAt ? { updatedAt } : {}),
          ...(typeof meta.activeQueryId === "string" ? { activeQueryId: meta.activeQueryId } : {}),
        };
        if (!fitsEnvelope({ version: 1, conversations: [...conversations, row] })) {
          throw fail(
            "history_unavailable",
            "Conversation history page exceeds its response limit.",
          );
        }
        conversations.push(row);
        if (conversations.length === limit) {
          more = Boolean(page.LastEvaluatedKey) || index < candidates.length - 1;
          break;
        }
      }
      if (conversations.length >= limit || more) break;
      if (page.LastEvaluatedKey && isKey(page.LastEvaluatedKey)) {
        nextKey = page.LastEvaluatedKey;
        more = true;
      } else {
        nextKey = undefined;
        more = false;
        break;
      }
    }
    if (queryPages >= MAX_INDEX_PAGES && nextKey) more = true;
    const result: Record<string, unknown> = { version: 1, conversations };
    if (more && nextKey)
      result.nextCursor = encode({
        v: 1,
        kind: "list",
        scope: scopeDigest,
        key: { ...nextKey, historyOwner: ownerKey(scope.sub) },
      });
    return result;
  }

  function readTurnCursor(
    value: unknown,
    digest: string,
    id: string,
  ): { through: number; nextOrdinal: number; key?: Key } | undefined {
    if (value === undefined) return undefined;
    const cursor = decode(value);
    verifyCursor(cursor, "turns", digest);
    if (!isKey(cursor.key)) {
      throw fail("invalid_cursor", "History cursor does not match this conversation.");
    }
    const ordinalMatch =
      typeof cursor.key.sk === "string" ? cursor.key.sk.match(/^TURN#(\d{8})/) : null;
    const keyOrdinal = ordinalMatch ? Number(ordinalMatch[1]) : -1;
    const nextOrdinal =
      cursor.nextOrdinal === undefined
        ? keyOrdinal - (cursor.key.sk === turnKey(id, keyOrdinal).sk ? 1 : 0)
        : Number(cursor.nextOrdinal);
    if (
      cursor.conversationId !== id ||
      !positive(cursor.throughOrdinal) ||
      cursor.key.pk !== "CONV#" + id ||
      !/^TURN#\d{8}(?:#.*)?$/.test(String(cursor.key.sk)) ||
      Number(cursor.throughOrdinal) > Number.MAX_SAFE_INTEGER ||
      !nonNegative(nextOrdinal) ||
      keyOrdinal > Number(cursor.throughOrdinal) ||
      (nextOrdinal !== keyOrdinal && nextOrdinal !== keyOrdinal - 1)
    ) {
      throw fail("invalid_cursor", "History cursor does not match this conversation.");
    }
    return { through: Number(cursor.throughOrdinal), nextOrdinal, key: cursor.key };
  }

  function makeTurnCursor(
    digest: string,
    id: string,
    through: number,
    nextOrdinal: number,
    key: Key,
  ): string {
    return encode({
      v: 1,
      kind: "turns",
      scope: digest,
      conversationId: id,
      throughOrdinal: through,
      nextOrdinal,
      key,
    });
  }

  async function readLegacyAnswerPrefixLength(
    id: string,
    turn: Record<string, unknown>,
  ): Promise<number> {
    if (!isLegacyGeneratingTurn(turn)) return answerCount(turn);
    const prefix = textPrefix(id, Number(turn.ordinal), String(turn.queryId), "assistant");
    let page: Record<string, unknown>;
    try {
      page = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: { ":pk": turn.pk, ":prefix": prefix },
          ConsistentRead: true,
          ScanIndexForward: false,
          Limit: 1,
        }),
      );
    } catch (error) {
      throw asStorageError(error, "conversation_unavailable");
    }
    const candidates = Array.isArray(page.Items) ? page.Items.filter(isRecord) : [];
    if (candidates.length > 1) {
      throw fail("conversation_unavailable", "Legacy answer prefix is invalid.");
    }
    const last = candidates[0];
    if (!last) {
      if (page.LastEvaluatedKey !== undefined) {
        throw fail("conversation_unavailable", "Legacy answer prefix is invalid.");
      }
      return 0;
    }
    if (
      !validChunk(last, {
        id,
        ordinal: Number(turn.ordinal),
        queryId: String(turn.queryId),
        role: "assistant",
      }) ||
      (page.LastEvaluatedKey !== undefined &&
        (!isKey(page.LastEvaluatedKey) ||
          page.LastEvaluatedKey.pk !== last.pk ||
          page.LastEvaluatedKey.sk !== last.sk))
    ) {
      throw fail("conversation_unavailable", "Legacy answer prefix is invalid.");
    }
    return last.index + 1;
  }

  async function rejectExtraTextChunk(input: {
    id: string;
    ordinal: number;
    queryId: string;
    role: "user" | "assistant";
    afterKey?: Key;
  }): Promise<void> {
    let remainder: Record<string, unknown>;
    try {
      remainder = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": "CONV#" + input.id,
            ":prefix": textPrefix(input.id, input.ordinal, input.queryId, input.role),
          },
          ConsistentRead: true,
          ScanIndexForward: true,
          Limit: 1,
          ...(input.afterKey ? { ExclusiveStartKey: input.afterKey } : {}),
        }),
      );
    } catch (error) {
      throw asStorageError(error, "conversation_unavailable");
    }
    const candidates = Array.isArray(remainder.Items) ? remainder.Items.filter(isRecord) : [];
    if (candidates.length > 1) {
      throw fail("conversation_unavailable", "Conversation text prefix is invalid.");
    }
    const extra = candidates[0];
    if (extra) {
      if (
        !validChunk(extra, {
          id: input.id,
          ordinal: input.ordinal,
          queryId: input.queryId,
          role: input.role,
        })
      ) {
        throw fail("conversation_unavailable", "Conversation text chunk is invalid.");
      }
      throw fail(
        "conversation_unavailable",
        input.role === "user"
          ? "Conversation question has data beyond its manifest."
          : "Conversation answer has data beyond its manifest.",
      );
    }
    if (remainder.LastEvaluatedKey) {
      throw fail("conversation_unavailable", "Conversation text prefix is invalid.");
    }
  }

  async function readTurns(scope: {
    sub: string;
    botId: string;
    conversationId: string;
    cursor?: string;
    limit?: number;
  }) {
    const digest = scopeHash(scope);
    if (typeof scope.conversationId !== "string" || !uuid.test(scope.conversationId)) {
      throw fail("invalid_request", "Conversation ID is invalid.");
    }
    const limit = getPageSize(scope.limit);
    const meta = await ownedMeta(scope.sub, scope.conversationId);
    const continuation = readTurnCursor(scope.cursor, digest, scope.conversationId);
    if (continuation && continuation.through > meta.lastOrdinal) {
      throw fail("invalid_cursor", "History cursor is newer than this conversation.");
    }
    const throughOrdinal = continuation?.through ?? meta.lastOrdinal;
    let nextOrdinal = continuation?.nextOrdinal ?? throughOrdinal;
    const firstOrdinal = Math.max(1, nextOrdinal - limit + 1);
    const rows: Record<string, unknown>[] = [];
    for (let ordinal = nextOrdinal; ordinal >= firstOrdinal; ordinal -= 1) {
      let result: Record<string, unknown>;
      try {
        result = await documentClient.send(
          new GetCommand({
            TableName: tableName,
            Key: turnKey(scope.conversationId, ordinal),
            ConsistentRead: true,
          }),
        );
      } catch (error) {
        throw asStorageError(error, "conversation_unavailable");
      }
      if (!isRecord(result.Item)) {
        throw fail("conversation_unavailable", "Conversation history has a missing turn.");
      }
      rows.push(result.Item);
    }
    const descriptors: Record<string, unknown>[] = [];
    let currentMeta = meta;
    for (const row of rows) {
      if (
        !validTurn(row, {
          id: scope.conversationId,
          ordinal: nextOrdinal,
          sub: scope.sub,
          botId,
        }) ||
        nextOrdinal > throughOrdinal
      ) {
        throw fail("conversation_unavailable", "Conversation turn is invalid.");
      }
      nextOrdinal -= 1;
      let current = row;
      let unconfirmable = false;
      if (row.status === "in_progress") {
        const confirmable =
          (row.phase === "admitted" || row.phase === "invocation_claimed") &&
          typeof row.ownerAttemptId === "string" &&
          row.ownerAttemptId.length > 0 &&
          Number.isSafeInteger(row.resultDeadlineAt) &&
          nonNegative(row.cursor) &&
          currentMeta.activeQueryId === row.queryId &&
          currentMeta.activeOwnerAttemptId === row.ownerAttemptId;
        if (!confirmable) {
          unconfirmable = true;
        } else if (Number(row.resultDeadlineAt) <= now()) {
          try {
            const reconciled = await baseStore.reconcileHistoryTurn({
              sub: scope.sub,
              botId,
              conversationId: scope.conversationId,
              ordinal: Number(row.ordinal),
              queryId: String(row.queryId),
              now: now(),
            });
            current = reconciled.turn;
            currentMeta = reconciled.meta;
            unconfirmable = !reconciled.confirmable;
          } catch (error) {
            throw asStorageError(error, "conversation_unavailable");
          }
          if (
            !validTurn(current, {
              id: scope.conversationId,
              ordinal: Number(row.ordinal),
              sub: scope.sub,
              botId,
            })
          ) {
            throw fail("conversation_unavailable", "Conversation turn is invalid.");
          }
        }
      }
      const failure = failureCode(current.failure);
      const cursor = await readLegacyAnswerPrefixLength(scope.conversationId, current);
      descriptors.push({
        ordinal: current.ordinal,
        queryId: current.queryId,
        status: current.status,
        questionManifest: current.questionManifest,
        answerManifest: current.answerManifest,
        cursor,
        ...(nonNegative(current.resultDeadlineAt)
          ? { resultDeadlineAt: current.resultDeadlineAt }
          : {}),
        ...(failure ? { failure } : unconfirmable ? { failure: { code: "unconfirmable" } } : {}),
      });
    }
    descriptors.sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
    const updatedAt = presentationUpdatedAt(currentMeta, scope.conversationId, ownerKey(scope.sub));
    const response: Record<string, unknown> = {
      version: 1,
      conversationId: scope.conversationId,
      ...(typeof currentMeta.historyLabel === "string" && currentMeta.historyLabel.trim()
        ? { label: currentMeta.historyLabel }
        : {}),
      ...(isVerifiedTimestamp(currentMeta.createdAt) ? { createdAt: currentMeta.createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      throughOrdinal,
      closed: currentMeta.closed === true,
      canContinue: descriptors.some(
        (turn) =>
          turn.ordinal === throughOrdinal &&
          turn.status !== "in_progress" &&
          currentMeta.closed !== true &&
          currentMeta.activeQueryId === undefined,
      ),
      turns: descriptors,
    };
    if (nextOrdinal > 0) {
      const lastIncludedOrdinal = nextOrdinal + 1;
      response.nextCursor = makeTurnCursor(
        digest,
        scope.conversationId,
        throughOrdinal,
        nextOrdinal,
        turnKey(scope.conversationId, lastIncludedOrdinal),
      );
    }
    if (!fitsEnvelope(response))
      throw fail("history_unavailable", "Conversation history page exceeds its response limit.");
    return response;
  }

  function parseTextCursor(
    value: unknown,
    digest: string,
    input: {
      conversationId: string;
      ordinal: number;
      queryId: string;
      role: "user" | "assistant";
    },
  ): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    const cursor = decode(value);
    verifyCursor(cursor, "text", digest);
    if (!isKey(cursor.key)) {
      throw fail("invalid_cursor", "Text cursor does not match this request.");
    }
    const prefix = textPrefix(input.conversationId, input.ordinal, input.queryId, input.role);
    const cursorKey = cursor.key.sk;
    const chunkIndex =
      typeof cursorKey === "string" && cursorKey.startsWith(prefix)
        ? cursorKey.slice(prefix.length)
        : "";
    const parsedIndex = /^\d{8}$/.test(chunkIndex) ? Number(chunkIndex) : -1;
    if (
      cursor.conversationId !== input.conversationId ||
      cursor.ordinal !== input.ordinal ||
      cursor.queryId !== input.queryId ||
      cursor.role !== input.role ||
      !nonNegative(cursor.throughCursor) ||
      !nonNegative(cursor.nextIndex) ||
      cursor.key.pk !== "CONV#" + input.conversationId ||
      parsedIndex < 0 ||
      Number(cursor.nextIndex) !== parsedIndex + 1 ||
      Number(cursor.nextIndex) > Number(cursor.throughCursor)
    ) {
      throw fail("invalid_cursor", "Text cursor does not match this request.");
    }
    return cursor;
  }

  async function readText(scope: {
    sub: string;
    botId: string;
    conversationId: string;
    ordinal: number;
    queryId: string;
    role: "user" | "assistant";
    throughCursor?: number;
    cursor?: string;
  }) {
    const digest = scopeHash(scope);
    if (
      typeof scope.conversationId !== "string" ||
      !uuid.test(scope.conversationId) ||
      !positive(scope.ordinal) ||
      typeof scope.queryId !== "string" ||
      !uuid.test(scope.queryId) ||
      (scope.role !== "user" && scope.role !== "assistant")
    ) {
      throw fail("invalid_request", "Conversation text request is invalid.");
    }
    await ownedMeta(scope.sub, scope.conversationId);
    let turn: Record<string, unknown> | undefined;
    try {
      const result = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: turnKey(scope.conversationId, scope.ordinal),
          ConsistentRead: true,
        }),
      );
      turn = isRecord(result.Item) ? result.Item : undefined;
    } catch (error) {
      throw asStorageError(error, "conversation_unavailable");
    }
    if (!turn) throw fail("conversation_unavailable", "Conversation turn is unavailable.");
    if (
      !validTurn(turn, {
        id: scope.conversationId,
        ordinal: scope.ordinal,
        sub: scope.sub,
        botId,
      })
    ) {
      throw fail("conversation_unavailable", "Conversation turn is invalid.");
    }
    if (turn.queryId !== scope.queryId) {
      throw fail("conversation_unavailable", "Conversation turn is unavailable.");
    }

    const manifest = scope.role === "user" ? turn.questionManifest : turn.answerManifest;
    if (!isRecord(manifest) || !nonNegative(manifest.count)) {
      throw fail("conversation_unavailable", "Conversation text manifest is invalid.");
    }
    const manifestCount = manifest.count;
    const legacyPrefixLength =
      scope.role === "assistant" && isLegacyGeneratingTurn(turn)
        ? await readLegacyAnswerPrefixLength(scope.conversationId, turn)
        : undefined;
    const available = legacyPrefixLength ?? manifestCount;
    const cursor = parseTextCursor(scope.cursor, digest, {
      conversationId: scope.conversationId,
      ordinal: scope.ordinal,
      queryId: scope.queryId,
      role: scope.role,
    });
    const frozen = cursor ? Number(cursor.throughCursor) : available;
    const throughCursor = scope.throughCursor ?? frozen;
    if (
      !nonNegative(throughCursor) ||
      throughCursor > available ||
      (scope.role === "user" && throughCursor !== manifestCount) ||
      (cursor && scope.throughCursor !== undefined && scope.throughCursor !== cursor.throughCursor)
    ) {
      throw fail(cursor ? "invalid_cursor" : "invalid_request", "Text prefix cursor is invalid.");
    }
    const immutableAnswerBoundary =
      scope.role === "assistant" &&
      turn.status !== "in_progress" &&
      throughCursor === manifestCount;
    const startIndex = cursor ? Number(cursor.nextIndex) : 0;
    if (startIndex > throughCursor)
      throw fail("invalid_cursor", "Text cursor is outside the frozen prefix.");

    let page: Record<string, unknown> = {};
    if (startIndex < throughCursor) {
      const remaining = throughCursor - startIndex;
      try {
        page = await documentClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
            ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
            ExpressionAttributeValues: {
              ":pk": "CONV#" + scope.conversationId,
              ":prefix": textPrefix(scope.conversationId, scope.ordinal, scope.queryId, scope.role),
            },
            ConsistentRead: true,
            ScanIndexForward: true,
            Limit:
              scope.role === "user"
                ? remaining <= MAX_CHUNKS
                  ? remaining + 1
                  : MAX_CHUNKS
                : immutableAnswerBoundary && remaining <= MAX_CHUNKS
                  ? remaining + 1
                  : Math.min(MAX_CHUNKS, remaining),
            ...(cursor && isKey(cursor.key) ? { ExclusiveStartKey: cursor.key } : {}),
          }),
        );
      } catch (error) {
        throw asStorageError(error, "conversation_unavailable");
      }
    }

    const candidates = Array.isArray(page.Items) ? page.Items.filter(isRecord) : [];
    const chunks: { index: number; text: string }[] = [];
    let expectedIndex = startIndex;
    let lastIncludedKey: Key | undefined;
    for (const candidate of candidates) {
      if (
        !validChunk(candidate, {
          id: scope.conversationId,
          ordinal: scope.ordinal,
          queryId: scope.queryId,
          role: scope.role,
        })
      ) {
        throw fail("conversation_unavailable", "Conversation text chunk is invalid.");
      }
      // Chunks appended after this descriptor's frozen cursor belong to a later read.
      if (candidate.index >= throughCursor) {
        if (scope.role === "assistant" && !immutableAnswerBoundary) continue;
        if (scope.role === "assistant") {
          throw fail(
            "conversation_unavailable",
            "Conversation answer has data beyond its manifest.",
          );
        }
        throw fail(
          "conversation_unavailable",
          "Conversation question has data beyond its manifest.",
        );
      }
      if (candidate.index !== expectedIndex)
        throw fail("conversation_unavailable", "Conversation text prefix has a gap.");
      const chunk = { index: candidate.index, text: candidate.text };
      const proposed = {
        version: 1,
        conversationId: scope.conversationId,
        queryId: scope.queryId,
        ordinal: scope.ordinal,
        role: scope.role,
        chunks: [...chunks, chunk],
        complete: expectedIndex + 1 === throughCursor,
      };
      if (!fitsEnvelope(proposed)) break;
      chunks.push(chunk);
      expectedIndex += 1;
      lastIncludedKey = { pk: candidate.pk, sk: candidate.sk };
    }
    if (startIndex < throughCursor && chunks.length === 0) {
      throw fail("history_unavailable", "A history text chunk exceeds the response limit.");
    }
    const complete = expectedIndex === throughCursor;
    // `complete` means this frozen prefix was loaded. Reject an empty answer only
    // when this request started at zero and read the current completed manifest.
    if (
      scope.role === "assistant" &&
      turn.status === "completed" &&
      startIndex === 0 &&
      throughCursor === manifestCount &&
      complete &&
      !chunks.some(({ text }) => text.trim().length > 0)
    ) {
      throw fail("conversation_unavailable", "Completed conversation answer is empty.");
    }
    if (complete && page.LastEvaluatedKey && (scope.role === "user" || immutableAnswerBoundary)) {
      if (!lastIncludedKey) {
        throw fail("conversation_unavailable", "Conversation text manifest is invalid.");
      }
      await rejectExtraTextChunk({
        id: scope.conversationId,
        ordinal: scope.ordinal,
        queryId: scope.queryId,
        role: scope.role,
        afterKey: lastIncludedKey,
      });
    }
    if (scope.role === "assistant" && immutableAnswerBoundary && complete && throughCursor === 0) {
      await rejectExtraTextChunk({
        id: scope.conversationId,
        ordinal: scope.ordinal,
        queryId: scope.queryId,
        role: scope.role,
      });
    }
    if (!complete && expectedIndex === startIndex && candidates.length === 0) {
      throw fail("conversation_unavailable", "Conversation text prefix is incomplete.");
    }
    const nextKey =
      lastIncludedKey ?? (isKey(page.LastEvaluatedKey) ? page.LastEvaluatedKey : undefined);
    if (!complete && !nextKey)
      throw fail("conversation_unavailable", "Conversation text prefix is incomplete.");
    const response: Record<string, unknown> = {
      version: 1,
      conversationId: scope.conversationId,
      queryId: scope.queryId,
      ordinal: scope.ordinal,
      role: scope.role,
      chunks,
      complete,
    };
    if (!complete && nextKey) {
      response.nextCursor = encode({
        v: 1,
        kind: "text",
        scope: digest,
        conversationId: scope.conversationId,
        ordinal: scope.ordinal,
        queryId: scope.queryId,
        role: scope.role,
        throughCursor,
        nextIndex: expectedIndex,
        key: nextKey,
      });
    }
    if (!fitsEnvelope(response))
      throw fail("history_unavailable", "Conversation text page exceeds its response limit.");
    return response;
  }

  return { listConversations, readTurns, readText };
}
