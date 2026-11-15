import { createHash } from "node:crypto";
import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { parseVerifiedHistoryTimestamp } from "../runtime/history-projection.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_SEARCH_CANDIDATES = 50;
const MAX_TURNS_PER_PAGE = 25;
const MAX_BATCH_KEYS = 100;
const MAX_BATCH_RETRIES = 5;
const MAX_TEXT_CHUNKS = 16;
const MAX_HTTP_TEXT_CHUNKS = 4;
const MAX_CURSOR_BYTES = 8192;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const RESPONSE_RESERVE_BYTES = 8192;
const CORDOBA = "America/Argentina/Cordoba";

export type RecordsStatus = "in_progress" | "completed" | "failed";
export type RecordsTextRole = "question" | "answer" | "user" | "assistant";

export type NormalizedRecordsFilters = {
  from?: string;
  to?: string;
  status?: RecordsStatus;
  personId?: string;
  levelId?: string;
  subject?: string;
  excludeTests: boolean;
};

export type RecordsMeta = Record<string, unknown> & {
  pk: string;
  sk: "META";
  conversationId: string;
  sub: string;
  botId: string;
  lastOrdinal: number;
  closed: boolean;
};

export type RecordsTurn = Record<string, unknown> & {
  pk: string;
  sk: string;
  conversationId: string;
  botId: string;
  sub: string;
  queryId: string;
  ordinal: number;
  createdAt: string;
  status: RecordsStatus;
  questionManifest: { count: number; complete: true };
  answerManifest: { count: number; complete: boolean };
  profileSnapshot: Record<string, unknown>;
};

export type RecordsReaderErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "RECORDS_UNAVAILABLE";
export type RecordsReaderError = Error & { code: RecordsReaderErrorCode };

type Key = Record<string, unknown> & { pk: string; sk: string };
type DocumentClient = { send(command: object): Promise<unknown> };

type RecordsReaderOptions = {
  botId: string;
  conversationTableName: string;
  recordsIndexName: string;
  testPersonIds: readonly string[];
  documentClient: DocumentClient;
  environment: string;
  now?: () => number;
};

type Candidate = {
  pk: string;
  sk: string;
  botId: string;
  createdAt: string;
  conversationId: string;
  ordinal: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: RecordsReaderErrorCode, message: string): RecordsReaderError {
  return Object.assign(new Error(message), { code });
}

function isSafePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function verifiedTimestamp(value: unknown): value is string {
  return typeof value === "string" && parseVerifiedHistoryTimestamp(value) !== undefined;
}

function dateParts(value: string): [number, number, number] | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return [year, month, day];
}

function pseudoUtcMidnight(value: string): number {
  const parts = dateParts(value);
  if (!parts) throw fail("INVALID_INPUT", "A records date is invalid.");
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function offsetAt(instant: number): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: CORDOBA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
  );
  const localAsUtc = new Date(0);
  localAsUtc.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  localAsUtc.setUTCHours(
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
    Number(parts.fractionalSecond ?? 0),
  );
  return localAsUtc.getTime() - instant;
}

function localMidnightUtc(value: string): number {
  const target = pseudoUtcMidnight(value);
  let instant = target - offsetAt(target);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const adjusted = target - offsetAt(instant);
    if (adjusted === instant) break;
    instant = adjusted;
  }
  return instant;
}

function nextCalendarDay(value: string): string {
  const next = new Date(pseudoUtcMidnight(value));
  next.setUTCDate(next.getUTCDate() + 1);
  const year = String(next.getUTCFullYear()).padStart(4, "0");
  const month = String(next.getUTCMonth() + 1).padStart(2, "0");
  const day = String(next.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeSubject(value: string): string {
  return value.trim().normalize("NFC").toLowerCase();
}

/** Validate and canonicalize the filters shared by the panel and export worker. */
export function normalizeRecordsFilters(value: unknown): NormalizedRecordsFilters {
  const source = value === undefined ? {} : value;
  if (!record(source)) throw fail("INVALID_INPUT", "Records filters are invalid.");
  const allowed = new Set([
    "from",
    "to",
    "status",
    "personId",
    "levelId",
    "subject",
    "excludeTests",
  ]);
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    throw fail("INVALID_INPUT", "Records filters contain an unsupported field.");
  }

  const normalized: NormalizedRecordsFilters = { excludeTests: false };
  for (const key of ["from", "to"] as const) {
    const date = source[key];
    if (date === undefined) continue;
    if (typeof date !== "string" || !dateParts(date)) {
      throw fail("INVALID_INPUT", "Records dates must be valid calendar dates.");
    }
    normalized[key] = date;
  }
  if (normalized.from && normalized.to && normalized.from > normalized.to) {
    throw fail("INVALID_INPUT", "The records date range is reversed.");
  }
  if (source.status !== undefined) {
    if (
      source.status !== "in_progress" &&
      source.status !== "completed" &&
      source.status !== "failed"
    ) {
      throw fail("INVALID_INPUT", "The records status is invalid.");
    }
    normalized.status = source.status;
  }
  for (const key of ["personId", "levelId"] as const) {
    const id = source[key];
    if (id === undefined) continue;
    if (typeof id !== "string" || id.length === 0 || id.length > 256 || id.trim() !== id) {
      throw fail("INVALID_INPUT", `The records ${key} is invalid.`);
    }
    normalized[key] = id;
  }
  if (source.subject !== undefined) {
    if (typeof source.subject !== "string" || source.subject.length > 1024) {
      throw fail("INVALID_INPUT", "The records subject is invalid.");
    }
    const subject = normalizeSubject(source.subject);
    if (subject.length > 0) normalized.subject = subject;
  }
  if (source.excludeTests !== undefined) {
    if (typeof source.excludeTests !== "boolean") {
      throw fail("INVALID_INPUT", "The test-account filter must be boolean.");
    }
    normalized.excludeTests = source.excludeTests;
  }
  return normalized;
}

function educationLevelIds(fields: unknown): string[] | null {
  if (!record(fields) || !Array.isArray(fields.educationLevels)) return null;
  const ids: string[] = [];
  for (const item of fields.educationLevels) {
    if (typeof item === "string") {
      ids.push(item);
      continue;
    }
    if (!record(item) || typeof item.id !== "string" || typeof item.label !== "string") {
      return null;
    }
    ids.push(item.id);
  }
  return ids;
}

function profileFields(turn: Record<string, unknown>): Record<string, unknown> | null {
  const snapshot = turn.profileSnapshot;
  if (
    !record(snapshot) ||
    snapshot.sub !== turn.sub ||
    snapshot.botId !== turn.botId ||
    !record(snapshot.fields) ||
    educationLevelIds(snapshot.fields) === null ||
    !Array.isArray(snapshot.fields.subjects) ||
    !snapshot.fields.subjects.every((subject) => typeof subject === "string") ||
    (snapshot.responsePreferenceIds !== undefined &&
      (!Array.isArray(snapshot.responsePreferenceIds) ||
        !snapshot.responsePreferenceIds.every((id) => typeof id === "string")))
  ) {
    return null;
  }
  return snapshot.fields;
}

function normalizedTurnTimestamp(turn: Record<string, unknown>): number | null {
  return verifiedTimestamp(turn.createdAt) ? parseVerifiedHistoryTimestamp(turn.createdAt)! : null;
}

/** Apply all filters to the same turn and its stored professional-profile snapshot. */
export function matchesRecordsFilters(
  value: unknown,
  inputFilters: NormalizedRecordsFilters | unknown,
  testPersonIds: readonly string[],
  personId?: string,
  cutoff?: number | string,
): boolean {
  if (!record(value)) return false;
  const filters = normalizeRecordsFilters(inputFilters);
  const fields = profileFields(value);
  const admittedAt = normalizedTurnTimestamp(value);
  if (fields === null || admittedAt === null) return false;
  const sub = personId ?? value.sub;
  if (typeof sub !== "string") return false;
  if (filters.personId !== undefined && sub !== filters.personId) return false;
  if (filters.status !== undefined && value.status !== filters.status) return false;
  if (filters.from && admittedAt < localMidnightUtc(filters.from)) return false;
  if (filters.to && admittedAt > localMidnightUtc(nextCalendarDay(filters.to)) - 1) return false;
  if (cutoff !== undefined) {
    const cutoffMs = typeof cutoff === "number" ? cutoff : Date.parse(cutoff);
    if (!Number.isFinite(cutoffMs) || admittedAt > cutoffMs) return false;
  }
  if (filters.levelId !== undefined) {
    const levels = educationLevelIds(fields);
    if (!levels?.includes(filters.levelId)) return false;
  }
  if (filters.subject !== undefined) {
    const subjects = fields.subjects;
    if (
      !Array.isArray(subjects) ||
      !subjects.some(
        (subject) => typeof subject === "string" && normalizeSubject(subject) === filters.subject,
      )
    ) {
      return false;
    }
  }
  if (filters.excludeTests && testPersonIds.includes(sub)) return false;
  return true;
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw fail("INVALID_INPUT", "The records cursor is invalid.");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) throw new Error();
    const parsed: unknown = JSON.parse(decoded);
    if (!record(parsed)) throw new Error();
    return parsed;
  } catch {
    throw fail("INVALID_INPUT", "The records cursor is invalid.");
  }
}

function scopeHash(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

function isKey(value: unknown): value is Key {
  return record(value) && typeof value.pk === "string" && typeof value.sk === "string";
}

function turnKey(conversationId: string, ordinal: number): Key {
  return { pk: `CONV#${conversationId}`, sk: `TURN#${String(ordinal).padStart(8, "0")}` };
}

function textPrefix(turn: RecordsTurn, role: "user" | "assistant"): string {
  return `${turn.sk}#${turn.queryId}#${role.toUpperCase()}#`;
}

function statusPhaseMatches(turn: Record<string, unknown>): boolean {
  if (turn.status === "in_progress") {
    return turn.phase === "admitted" || turn.phase === "invocation_claimed";
  }
  if (turn.status === "completed") return turn.phase === "complete";
  if (turn.status === "failed") return turn.phase === "failed";
  return false;
}

function isValidMeta(value: unknown, botId: string, conversationId?: string): value is RecordsMeta {
  return (
    record(value) &&
    typeof value.conversationId === "string" &&
    UUID.test(value.conversationId) &&
    (conversationId === undefined || value.conversationId === conversationId) &&
    value.pk === `CONV#${value.conversationId}` &&
    value.sk === "META" &&
    value.botId === botId &&
    typeof value.sub === "string" &&
    value.sub.length > 0 &&
    isSafePositive(value.lastOrdinal) &&
    typeof value.closed === "boolean"
  );
}

function isValidTurn(
  value: unknown,
  input: { botId: string; meta: RecordsMeta; ordinal?: number },
): value is RecordsTurn {
  if (!record(value)) return false;
  const ordinal = value.ordinal;
  const questionManifest = value.questionManifest;
  const answerManifest = value.answerManifest;
  return (
    value.pk === `CONV#${input.meta.conversationId}` &&
    typeof ordinal === "number" &&
    isSafePositive(ordinal) &&
    (input.ordinal === undefined || ordinal === input.ordinal) &&
    ordinal <= input.meta.lastOrdinal &&
    value.sk === turnKey(input.meta.conversationId, ordinal).sk &&
    value.conversationId === input.meta.conversationId &&
    value.botId === input.botId &&
    value.sub === input.meta.sub &&
    typeof value.queryId === "string" &&
    UUID.test(value.queryId) &&
    value.operation === (ordinal === 1 ? "start" : "message") &&
    value.baseOrdinal === ordinal - 1 &&
    typeof value.requestFingerprint === "string" &&
    value.requestFingerprint.length > 0 &&
    typeof value.ownerAttemptId === "string" &&
    value.ownerAttemptId.length > 0 &&
    isSafeNonNegative(value.resultDeadlineAt) &&
    verifiedTimestamp(value.createdAt) &&
    statusPhaseMatches(value) &&
    record(questionManifest) &&
    isSafePositive(questionManifest.count) &&
    questionManifest.complete === true &&
    record(answerManifest) &&
    isSafeNonNegative(answerManifest.count) &&
    typeof answerManifest.complete === "boolean" &&
    value.cursor === answerManifest.count &&
    (value.status !== "completed" || (answerManifest.complete && answerManifest.count > 0)) &&
    (value.status !== "in_progress" || !answerManifest.complete) &&
    (value.status !== "failed" || !answerManifest.complete) &&
    profileFields(value) !== null &&
    (value.failure === undefined ||
      (record(value.failure) && typeof value.failure.code === "string"))
  );
}

function toCandidate(
  value: unknown,
  botId: string,
  bounds: { lower: string; upper: string },
): Candidate {
  if (
    !record(value) ||
    typeof value.conversationId !== "string" ||
    !UUID.test(value.conversationId) ||
    value.pk !== `CONV#${value.conversationId}` ||
    typeof value.ordinal !== "number" ||
    !isSafePositive(value.ordinal) ||
    value.sk !== turnKey(value.conversationId, value.ordinal).sk ||
    value.botId !== botId ||
    !verifiedTimestamp(value.createdAt) ||
    value.createdAt < bounds.lower ||
    value.createdAt > bounds.upper
  ) {
    throw fail("RECORDS_UNAVAILABLE", "The records index returned an invalid candidate.");
  }
  return {
    pk: value.pk as string,
    sk: value.sk as string,
    botId,
    createdAt: value.createdAt as string,
    conversationId: value.conversationId,
    ordinal: value.ordinal,
  };
}

function validIndexKey(
  value: unknown,
  botId: string,
  bounds: { lower: string; upper: string },
): value is Key {
  if (!record(value)) return false;
  try {
    toCandidate(value, botId, bounds);
    return true;
  } catch {
    return false;
  }
}

function normalizedCutoff(value: number | string | undefined, now: () => number): number {
  const cutoff =
    value === undefined ? now() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(cutoff)) throw fail("INVALID_INPUT", "The records cutoff is invalid.");
  return Math.min(cutoff, now());
}

function queryBounds(
  filters: NormalizedRecordsFilters,
  cutoff: number,
): { lower: string; upper: string } {
  const lower = filters.from
    ? new Date(localMidnightUtc(filters.from)).toISOString()
    : "0001-01-01T00:00:00.000Z";
  const filterUpper = filters.to
    ? localMidnightUtc(nextCalendarDay(filters.to)) - 1
    : Number.POSITIVE_INFINITY;
  return {
    lower,
    upper: new Date(Math.min(filterUpper, cutoff)).toISOString(),
  };
}

function fitsResponse(value: unknown): boolean {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8") + RESPONSE_RESERVE_BYTES;
  return bytes <= MAX_RESPONSE_BYTES;
}

function toPublicTurn(turn: RecordsTurn) {
  const failure =
    record(turn.failure) && typeof turn.failure.code === "string" ? turn.failure.code : undefined;
  return {
    ordinal: turn.ordinal,
    queryId: turn.queryId,
    admittedAt: turn.createdAt,
    status: turn.status,
    answerComplete: turn.answerManifest.complete,
    profileFields: turn.profileSnapshot.fields,
    ...(failure ? { failureCode: failure } : {}),
  };
}

function normalizeTextRole(role: RecordsTextRole): "user" | "assistant" {
  return role === "question" || role === "user" ? "user" : "assistant";
}

function publicTextRole(role: RecordsTextRole): "question" | "answer" {
  return normalizeTextRole(role) === "user" ? "question" : "answer";
}

function shortQuestion(value: string): string {
  const characters = Array.from(value.replace(/\s+/gu, " ").trim());
  return characters.length <= 120 ? characters.join("") : `${characters.slice(0, 119).join("")}…`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Create the read-only DynamoDB boundary for administrative record lookup and export. */
export function createRecordsReader(options: RecordsReaderOptions) {
  if (
    !options ||
    typeof options.botId !== "string" ||
    !options.botId ||
    typeof options.conversationTableName !== "string" ||
    !options.conversationTableName ||
    typeof options.recordsIndexName !== "string" ||
    !options.recordsIndexName ||
    !Array.isArray(options.testPersonIds) ||
    !options.testPersonIds.every((id) => typeof id === "string") ||
    typeof options.documentClient?.send !== "function" ||
    typeof options.environment !== "string" ||
    !options.environment
  ) {
    throw new TypeError("Records reader configuration is invalid.");
  }

  const { botId, conversationTableName, recordsIndexName, documentClient } = options;
  const testPersonIds = [...options.testPersonIds];
  const classificationScope = [...testPersonIds].sort();
  const now = options.now ?? Date.now;

  async function send(command: object): Promise<Record<string, unknown>> {
    try {
      const result: unknown = await documentClient.send(command);
      if (!record(result)) throw new Error("DynamoDB returned an invalid response.");
      return result;
    } catch (error) {
      if (record(error) && error.code === "INVALID_INPUT") throw error;
      if (record(error) && error.code === "NOT_FOUND") throw error;
      if (record(error) && error.code === "RECORDS_UNAVAILABLE") throw error;
      throw fail("RECORDS_UNAVAILABLE", "Administrative records are temporarily unavailable.");
    }
  }

  async function readMeta(conversationId: string): Promise<RecordsMeta | null> {
    if (typeof conversationId !== "string" || !UUID.test(conversationId)) {
      throw fail("INVALID_INPUT", "The conversation ID is invalid.");
    }
    const result = await send(
      new GetCommand({
        TableName: conversationTableName,
        Key: { pk: `CONV#${conversationId}`, sk: "META" },
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) return null;
    if (!isValidMeta(result.Item, botId, conversationId)) {
      throw fail("RECORDS_UNAVAILABLE", "The conversation descriptor is invalid.");
    }
    return result.Item;
  }

  async function readTurns(
    meta: RecordsMeta,
    startOrdinal: number,
    endOrdinal: number,
  ): Promise<RecordsTurn[]> {
    if (
      !isValidMeta(meta, botId) ||
      !isSafePositive(startOrdinal) ||
      !isSafePositive(endOrdinal) ||
      startOrdinal > endOrdinal ||
      endOrdinal > meta.lastOrdinal
    ) {
      if (startOrdinal > endOrdinal) return [];
      throw fail("INVALID_INPUT", "The conversation turn range is invalid.");
    }

    const turns: RecordsTurn[] = [];
    for (let batchStart = startOrdinal; batchStart <= endOrdinal; batchStart += MAX_BATCH_KEYS) {
      const batchEnd = Math.min(endOrdinal, batchStart + MAX_BATCH_KEYS - 1);
      const expected = new Map<number, RecordsTurn>();
      let keys: Key[] = Array.from({ length: batchEnd - batchStart + 1 }, (_, index) =>
        turnKey(meta.conversationId, batchStart + index),
      );
      for (let retry = 0; keys.length > 0; retry += 1) {
        if (retry > MAX_BATCH_RETRIES) {
          throw fail("RECORDS_UNAVAILABLE", "Conversation turn reads could not be completed.");
        }
        const result = await send(
          new BatchGetCommand({
            RequestItems: {
              [conversationTableName]: {
                Keys: keys,
                ConsistentRead: true,
              },
            },
          }),
        );
        const responses = record(result.Responses) ? result.Responses : {};
        const rows = responses[conversationTableName];
        if (rows !== undefined && !Array.isArray(rows)) {
          throw fail("RECORDS_UNAVAILABLE", "Conversation turn reads returned invalid data.");
        }
        for (const row of (rows ?? []) as unknown[]) {
          if (!record(row) || !isSafePositive(row.ordinal) || !isValidTurn(row, { botId, meta })) {
            throw fail("RECORDS_UNAVAILABLE", "A conversation turn is invalid.");
          }
          if (row.ordinal < batchStart || row.ordinal > batchEnd || expected.has(row.ordinal)) {
            throw fail("RECORDS_UNAVAILABLE", "Conversation turn reads returned duplicate data.");
          }
          expected.set(row.ordinal, row);
        }
        const unprocessed = record(result.UnprocessedKeys) ? result.UnprocessedKeys : {};
        const unprocessedTable = unprocessed[conversationTableName];
        const nextKeys = record(unprocessedTable) ? unprocessedTable.Keys : undefined;
        if (nextKeys === undefined) {
          keys = [];
        } else if (!Array.isArray(nextKeys) || !nextKeys.every(isKey)) {
          throw fail("RECORDS_UNAVAILABLE", "Conversation turn reads returned invalid keys.");
        } else {
          keys = nextKeys;
          await sleep(Math.min(20 * 2 ** retry, 250));
        }
      }
      for (let ordinal = batchStart; ordinal <= batchEnd; ordinal += 1) {
        const turn = expected.get(ordinal);
        if (!turn) throw fail("RECORDS_UNAVAILABLE", "A conversation turn is missing.");
        turns.push(turn);
      }
    }
    return turns;
  }

  function filterBounds(filters: NormalizedRecordsFilters, cutoff: number) {
    return queryBounds(filters, cutoff);
  }

  async function queryCandidates(
    inputFilters: NormalizedRecordsFilters | unknown,
    startKey?: Key | null,
    cutoff?: number | string,
  ): Promise<{ candidates: Candidate[]; nextKey: Key | null }> {
    const filters = normalizeRecordsFilters(inputFilters);
    const cutoffMs = normalizedCutoff(cutoff, now);
    const bounds = filterBounds(filters, cutoffMs);
    if (bounds.lower > bounds.upper) return { candidates: [], nextKey: null };
    if (startKey !== undefined && startKey !== null && !validIndexKey(startKey, botId, bounds)) {
      throw fail("INVALID_INPUT", "The records cursor key is invalid.");
    }
    const result = await send(
      new QueryCommand({
        TableName: conversationTableName,
        IndexName: recordsIndexName,
        KeyConditionExpression: "#botId = :botId AND #createdAt BETWEEN :from AND :through",
        ExpressionAttributeNames: { "#botId": "botId", "#createdAt": "createdAt" },
        ExpressionAttributeValues: {
          ":botId": botId,
          ":from": bounds.lower,
          ":through": bounds.upper,
        },
        ScanIndexForward: false,
        Limit: MAX_SEARCH_CANDIDATES,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    const rows = result.Items === undefined ? [] : result.Items;
    if (!Array.isArray(rows)) {
      throw fail("RECORDS_UNAVAILABLE", "The records index returned invalid candidates.");
    }
    const candidates = rows.map((row) => toCandidate(row, botId, bounds));
    if (
      result.LastEvaluatedKey !== undefined &&
      !validIndexKey(result.LastEvaluatedKey, botId, bounds)
    ) {
      throw fail("RECORDS_UNAVAILABLE", "The records index returned an invalid continuation key.");
    }
    return {
      candidates,
      nextKey: isKey(result.LastEvaluatedKey) ? result.LastEvaluatedKey : null,
    };
  }

  async function getTurn(meta: RecordsMeta, ordinal: number): Promise<RecordsTurn> {
    if (!isSafePositive(ordinal) || ordinal > meta.lastOrdinal) {
      throw fail("NOT_FOUND", "The conversation turn was not found.");
    }
    const result = await send(
      new GetCommand({
        TableName: conversationTableName,
        Key: turnKey(meta.conversationId, ordinal),
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) {
      throw fail("RECORDS_UNAVAILABLE", "A conversation turn is missing.");
    }
    if (!isValidTurn(result.Item, { botId, meta, ordinal })) {
      throw fail("RECORDS_UNAVAILABLE", "A conversation turn is invalid.");
    }
    return result.Item;
  }

  async function getTextPage(input: {
    turn: RecordsTurn;
    role: "user" | "assistant";
    actorSub: string;
    cursor?: unknown;
  }): Promise<{ chunks: string[]; nextCursor: string | null }> {
    const manifest =
      input.role === "user" ? input.turn.questionManifest : input.turn.answerManifest;
    const currentCount = manifest.count;
    let through = currentCount;
    const digest = scopeHash(
      options.environment,
      botId,
      classificationScope,
      input.actorSub,
      input.turn.conversationId,
      input.turn.ordinal,
      input.role,
    );
    let startIndex = 0;
    let startKey: Key | undefined;
    if (input.cursor !== undefined && input.cursor !== null) {
      const cursor = decodeCursor(input.cursor);
      if (
        cursor.v !== 1 ||
        cursor.kind !== "text" ||
        cursor.scope !== digest ||
        cursor.conversationId !== input.turn.conversationId ||
        cursor.ordinal !== input.turn.ordinal ||
        cursor.queryId !== input.turn.queryId ||
        cursor.role !== input.role ||
        !isSafeNonNegative(cursor.through) ||
        cursor.through > currentCount ||
        (input.role === "user" && cursor.through !== currentCount) ||
        !isSafeNonNegative(cursor.nextIndex) ||
        !isKey(cursor.key) ||
        cursor.key.pk !== `CONV#${input.turn.conversationId}` ||
        cursor.key.sk !==
          `${textPrefix(input.turn, input.role)}${String(cursor.nextIndex - 1).padStart(8, "0")}` ||
        cursor.nextIndex === 0 ||
        cursor.nextIndex >= Number(cursor.through)
      ) {
        throw fail("INVALID_INPUT", "The text cursor does not match this request.");
      }
      through = cursor.through;
      startIndex = cursor.nextIndex;
      startKey = cursor.key;
    }

    const immutable =
      input.role === "user" || (input.turn.status !== "in_progress" && through === currentCount);

    const chunks: string[] = [];
    let expectedIndex = startIndex;
    let lastIncludedKey: Key | undefined;
    let stoppedForSize = false;
    let page: Record<string, unknown> = {};
    if (expectedIndex < through) {
      const remaining = through - expectedIndex;
      page = await send(
        new QueryCommand({
          TableName: conversationTableName,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": `CONV#${input.turn.conversationId}`,
            ":prefix": textPrefix(input.turn, input.role),
          },
          ConsistentRead: true,
          ScanIndexForward: true,
          Limit: Math.min(MAX_HTTP_TEXT_CHUNKS, Math.max(1, remaining + (immutable ? 1 : 0))),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      const rows = page.Items === undefined ? [] : page.Items;
      if (!Array.isArray(rows)) {
        throw fail("RECORDS_UNAVAILABLE", "Conversation text returned invalid data.");
      }
      for (const row of rows) {
        if (!record(row) || !validChunk(row, input.turn, input.role)) {
          throw fail("RECORDS_UNAVAILABLE", "A conversation text fragment is invalid.");
        }
        if (row.index >= through) {
          if (immutable) {
            throw fail("RECORDS_UNAVAILABLE", "Conversation text extends beyond its manifest.");
          }
          continue;
        }
        if (row.index !== expectedIndex) {
          throw fail("RECORDS_UNAVAILABLE", "Conversation text has a missing fragment.");
        }
        const proposed = [...chunks, row.text as string];
        const envelope = {
          conversationId: input.turn.conversationId,
          ordinal: input.turn.ordinal,
          role: publicTextRole(input.role),
          text: proposed.join(""),
          nextCursor: null,
        };
        if (!fitsResponse(envelope) && chunks.length > 0) {
          stoppedForSize = true;
          break;
        }
        if (!fitsResponse(envelope)) {
          throw fail(
            "RECORDS_UNAVAILABLE",
            "A conversation text fragment exceeds the response limit.",
          );
        }
        chunks.push(row.text as string);
        expectedIndex += 1;
        lastIncludedKey = { pk: row.pk as string, sk: row.sk as string };
      }
    }
    if (expectedIndex === through && immutable) {
      await rejectExtraTextChunk(input.turn, input.role, lastIncludedKey);
    }
    if (expectedIndex < through && !stoppedForSize && !page.LastEvaluatedKey) {
      throw fail("RECORDS_UNAVAILABLE", "Conversation text is incomplete.");
    }

    if (startIndex < through && chunks.length === 0) {
      throw fail("RECORDS_UNAVAILABLE", "Conversation text could not be read.");
    }
    const complete = expectedIndex === through;
    let nextCursor: string | null = null;
    if (!complete) {
      if (!lastIncludedKey) throw fail("RECORDS_UNAVAILABLE", "Conversation text is incomplete.");
      nextCursor = encodeCursor({
        v: 1,
        kind: "text",
        scope: digest,
        conversationId: input.turn.conversationId,
        ordinal: input.turn.ordinal,
        queryId: input.turn.queryId,
        role: input.role,
        through,
        nextIndex: expectedIndex,
        key: lastIncludedKey,
      });
    }
    return { chunks, nextCursor };
  }

  function validChunk(
    value: unknown,
    turn: RecordsTurn,
    role: "user" | "assistant",
  ): value is Record<string, unknown> & { index: number; text: string } {
    if (!record(value)) return false;
    return (
      value.pk === `CONV#${turn.conversationId}` &&
      value.sk === `${textPrefix(turn, role)}${String(value.index).padStart(8, "0")}` &&
      value.conversationId === turn.conversationId &&
      value.ordinal === turn.ordinal &&
      value.queryId === turn.queryId &&
      value.role === role &&
      isSafeNonNegative(value.index) &&
      typeof value.text === "string"
    );
  }

  async function rejectExtraTextChunk(
    turn: RecordsTurn,
    role: "user" | "assistant",
    afterKey?: Key,
  ): Promise<void> {
    const result = await send(
      new QueryCommand({
        TableName: conversationTableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": `CONV#${turn.conversationId}`,
          ":prefix": textPrefix(turn, role),
        },
        ConsistentRead: true,
        ScanIndexForward: true,
        Limit: 1,
        ...(afterKey ? { ExclusiveStartKey: afterKey } : {}),
      }),
    );
    if (!Array.isArray(result.Items)) {
      throw fail("RECORDS_UNAVAILABLE", "Conversation text returned invalid data.");
    }
    const extra = result.Items[0];
    if (extra !== undefined) {
      if (!validChunk(extra, turn, role)) {
        throw fail("RECORDS_UNAVAILABLE", "Conversation text contains an invalid fragment.");
      }
      throw fail("RECORDS_UNAVAILABLE", "Conversation text extends beyond its manifest.");
    }
    if (result.LastEvaluatedKey) {
      throw fail("RECORDS_UNAVAILABLE", "Conversation text continuation is invalid.");
    }
  }

  async function questionPreview(turn: RecordsTurn): Promise<string> {
    const result = await send(
      new QueryCommand({
        TableName: conversationTableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": `CONV#${turn.conversationId}`,
          ":prefix": textPrefix(turn, "user"),
        },
        ConsistentRead: true,
        ScanIndexForward: true,
        Limit: 1,
      }),
    );
    if (
      !Array.isArray(result.Items) ||
      !record(result.Items[0]) ||
      !validChunk(result.Items[0], turn, "user") ||
      result.Items[0].index !== 0
    ) {
      throw fail("RECORDS_UNAVAILABLE", "The original question is unavailable.");
    }
    return shortQuestion(result.Items[0].text as string);
  }

  async function search(input: {
    actorSub: string;
    filters: unknown;
    cursor?: unknown;
  }): Promise<{ results: Record<string, unknown>[]; nextCursor: string | null }> {
    if (typeof input?.actorSub !== "string" || input.actorSub.trim().length === 0) {
      throw fail("INVALID_INPUT", "The administrative identity is invalid.");
    }
    const filters = normalizeRecordsFilters(input.filters);
    const digest = scopeHash(
      options.environment,
      botId,
      classificationScope,
      input.actorSub,
      filters,
    );
    let cursorKey: Key | undefined;
    let cutoff = now();
    if (input.cursor !== undefined && input.cursor !== null) {
      const cursor = decodeCursor(input.cursor);
      if (
        cursor.v !== 1 ||
        cursor.kind !== "search" ||
        cursor.scope !== digest ||
        !verifiedTimestamp(cursor.cutoff) ||
        !validIndexKey(cursor.key, botId, queryBounds(filters, Date.parse(cursor.cutoff)))
      ) {
        throw fail("INVALID_INPUT", "The records cursor does not match this search.");
      }
      cutoff = Date.parse(cursor.cutoff);
      if (cutoff > now()) throw fail("INVALID_INPUT", "The records cursor is from the future.");
      cursorKey = cursor.key;
    }
    const candidatesPage = await queryCandidates(filters, cursorKey, cutoff);
    const results: Record<string, unknown>[] = [];
    const seenTurns = new Set<string>();
    let lastConsumedKey: Key | undefined;
    let stoppedBeforeCandidate = false;
    for (const candidate of candidatesPage.candidates) {
      const key: Key = {
        pk: candidate.pk,
        sk: candidate.sk,
        botId: candidate.botId,
        createdAt: candidate.createdAt,
        conversationId: candidate.conversationId,
        ordinal: candidate.ordinal,
      };
      const meta = await readMeta(candidate.conversationId);
      if (!meta) throw fail("RECORDS_UNAVAILABLE", "A conversation descriptor is missing.");
      const turnResult = await send(
        new GetCommand({
          TableName: conversationTableName,
          Key: { pk: candidate.pk, sk: candidate.sk },
          ConsistentRead: true,
        }),
      );
      if (
        turnResult.Item === undefined ||
        !isValidTurn(turnResult.Item, { botId, meta, ordinal: candidate.ordinal }) ||
        turnResult.Item.createdAt !== candidate.createdAt
      ) {
        throw fail("RECORDS_UNAVAILABLE", "A records index entry does not match its turn.");
      }
      const turn = turnResult.Item;
      const turnIdentity = `${turn.conversationId}\0${turn.ordinal}`;
      if (
        matchesRecordsFilters(turn, filters, testPersonIds, meta.sub) &&
        !seenTurns.has(turnIdentity)
      ) {
        const profile = profileFields(turn)!;
        const result = {
          conversationId: turn.conversationId,
          queryId: turn.queryId,
          ordinal: turn.ordinal,
          personId: meta.sub,
          admittedAt: turn.createdAt,
          status: turn.status,
          questionPreview: await questionPreview(turn),
          profileFields: profile,
          isTest: testPersonIds.includes(meta.sub),
        };
        const proposed = [...results, result];
        if (!fitsResponse({ results: proposed, nextCursor: null })) {
          if (results.length === 0) {
            throw fail("RECORDS_UNAVAILABLE", "A records result exceeds the response limit.");
          }
          stoppedBeforeCandidate = true;
          break;
        }
        results.push(result);
        seenTurns.add(turnIdentity);
      }
      lastConsumedKey = key;
    }
    const hasUnconsumedCandidates = stoppedBeforeCandidate;
    const nextKey = hasUnconsumedCandidates ? lastConsumedKey : (candidatesPage.nextKey ?? null);
    let nextCursor: string | null = null;
    if (nextKey) {
      nextCursor = encodeCursor({
        v: 1,
        kind: "search",
        scope: digest,
        cutoff: new Date(cutoff).toISOString(),
        key: nextKey,
      });
    }
    const response = { results, nextCursor };
    if (!fitsResponse(response))
      throw fail("RECORDS_UNAVAILABLE", "The records page exceeds its response limit.");
    return response;
  }

  async function conversation(input: {
    actorSub: string;
    conversationId: string;
    cursor?: unknown;
  }): Promise<{
    conversationId: string;
    personId: string;
    hidden: boolean;
    isTest: boolean;
    throughOrdinal: number;
    turns: ReturnType<typeof toPublicTurn>[];
    nextCursor: string | null;
  }> {
    if (typeof input?.actorSub !== "string" || input.actorSub.trim().length === 0) {
      throw fail("INVALID_INPUT", "The administrative identity is invalid.");
    }
    if (typeof input.conversationId !== "string" || !UUID.test(input.conversationId)) {
      throw fail("INVALID_INPUT", "The conversation ID is invalid.");
    }
    const digest = scopeHash(
      options.environment,
      botId,
      classificationScope,
      input.actorSub,
      input.conversationId,
    );
    let throughOrdinal: number | undefined;
    let nextOrdinal: number | undefined;
    if (input.cursor !== undefined && input.cursor !== null) {
      const cursor = decodeCursor(input.cursor);
      if (
        cursor.v !== 1 ||
        cursor.kind !== "conversation" ||
        cursor.scope !== digest ||
        cursor.conversationId !== input.conversationId ||
        !isSafePositive(cursor.throughOrdinal) ||
        !isSafePositive(cursor.nextOrdinal) ||
        !isKey(cursor.key) ||
        cursor.key.pk !== `CONV#${input.conversationId}` ||
        cursor.key.sk !== turnKey(input.conversationId, cursor.nextOrdinal).sk ||
        cursor.nextOrdinal > cursor.throughOrdinal
      ) {
        throw fail("INVALID_INPUT", "The conversation cursor does not match this request.");
      }
      throughOrdinal = cursor.throughOrdinal;
      nextOrdinal = cursor.nextOrdinal;
    }
    const meta = await readMeta(input.conversationId);
    if (!meta) throw fail("NOT_FOUND", "The conversation was not found.");
    if (throughOrdinal !== undefined && throughOrdinal > meta.lastOrdinal) {
      throw fail("INVALID_INPUT", "The conversation cursor is newer than the conversation.");
    }
    throughOrdinal ??= meta.lastOrdinal;
    nextOrdinal ??= throughOrdinal;
    const firstOrdinal = Math.max(1, nextOrdinal - MAX_TURNS_PER_PAGE + 1);
    const descriptors = await readTurns(meta, firstOrdinal, nextOrdinal);
    const turns = descriptors.map(toPublicTurn);
    const nextTurnOrdinal = firstOrdinal - 1;
    const nextCursor =
      nextTurnOrdinal > 0
        ? encodeCursor({
            v: 1,
            kind: "conversation",
            scope: digest,
            conversationId: input.conversationId,
            throughOrdinal,
            nextOrdinal: nextTurnOrdinal,
            key: turnKey(input.conversationId, nextTurnOrdinal),
          })
        : null;
    const response = {
      conversationId: input.conversationId,
      personId: meta.sub,
      hidden: Object.hasOwn(meta, "hiddenAt"),
      isTest: testPersonIds.includes(meta.sub),
      throughOrdinal,
      turns,
      nextCursor,
    };
    if (!fitsResponse(response))
      throw fail("RECORDS_UNAVAILABLE", "The conversation page exceeds its response limit.");
    return response;
  }

  async function text(input: {
    actorSub: string;
    conversationId: string;
    ordinal: number;
    role: "question" | "answer";
    cursor?: unknown;
  }): Promise<{
    conversationId: string;
    ordinal: number;
    role: "question" | "answer";
    text: string;
    nextCursor: string | null;
  }> {
    if (
      typeof input?.actorSub !== "string" ||
      input.actorSub.trim().length === 0 ||
      typeof input.conversationId !== "string" ||
      !UUID.test(input.conversationId) ||
      !isSafePositive(input.ordinal) ||
      (input.role !== "question" && input.role !== "answer")
    ) {
      throw fail("INVALID_INPUT", "The conversation text request is invalid.");
    }
    const meta = await readMeta(input.conversationId);
    if (!meta) throw fail("NOT_FOUND", "The conversation was not found.");
    const turn = await getTurn(meta, input.ordinal);
    const page = await getTextPage({
      turn,
      role: normalizeTextRole(input.role),
      actorSub: input.actorSub,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    const response = {
      conversationId: input.conversationId,
      ordinal: input.ordinal,
      role: input.role,
      text: page.chunks.join(""),
      nextCursor: page.nextCursor,
    };
    if (!fitsResponse(response))
      throw fail("RECORDS_UNAVAILABLE", "The conversation text page exceeds its response limit.");
    return response;
  }

  async function* readTextChunks(
    turn: RecordsTurn,
    inputRole: RecordsTextRole,
  ): AsyncIterable<string> {
    if (
      !isValidTurn(turn, {
        botId,
        meta: {
          pk: `CONV#${turn.conversationId}`,
          sk: "META",
          conversationId: turn.conversationId,
          sub: turn.sub,
          botId,
          lastOrdinal: turn.ordinal,
          closed: true,
        },
      })
    ) {
      throw fail("RECORDS_UNAVAILABLE", "The conversation turn is invalid.");
    }
    const role = normalizeTextRole(inputRole);
    const manifest = role === "user" ? turn.questionManifest : turn.answerManifest;
    const count = manifest.count;
    const immutable = role === "user" || turn.status !== "in_progress" || manifest.complete;
    let expected = 0;
    let startKey: Key | undefined;
    let hasNonWhitespaceText = false;
    while (expected < count) {
      const result = await send(
        new QueryCommand({
          TableName: conversationTableName,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": `CONV#${turn.conversationId}`,
            ":prefix": textPrefix(turn, role),
          },
          ConsistentRead: true,
          ScanIndexForward: true,
          Limit: Math.min(MAX_TEXT_CHUNKS, count - expected + (immutable ? 1 : 0)),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      if (result.Items !== undefined && !Array.isArray(result.Items)) {
        throw fail("RECORDS_UNAVAILABLE", "Conversation text returned invalid data.");
      }
      const rows = (result.Items ?? []) as unknown[];
      let lastIncludedKey: Key | undefined;
      for (const row of rows) {
        if (!record(row) || !validChunk(row, turn, role)) {
          throw fail("RECORDS_UNAVAILABLE", "A conversation text fragment is invalid.");
        }
        if (row.index >= count) {
          if (immutable)
            throw fail("RECORDS_UNAVAILABLE", "Conversation text extends beyond its manifest.");
          continue;
        }
        if (row.index !== expected)
          throw fail("RECORDS_UNAVAILABLE", "Conversation text has a missing fragment.");
        expected += 1;
        lastIncludedKey = { pk: row.pk as string, sk: row.sk as string };
        if ((row.text as string).trim().length > 0) hasNonWhitespaceText = true;
        yield row.text as string;
      }
      if (expected === count) {
        if (immutable) await rejectExtraTextChunk(turn, role, lastIncludedKey);
        break;
      }
      if (!lastIncludedKey || !isKey(result.LastEvaluatedKey)) {
        throw fail("RECORDS_UNAVAILABLE", "Conversation text is incomplete.");
      }
      startKey = lastIncludedKey;
    }
    if (count === 0 && immutable) await rejectExtraTextChunk(turn, role);
    if (role === "assistant" && turn.status === "completed" && !hasNonWhitespaceText) {
      throw fail("RECORDS_UNAVAILABLE", "A completed answer is empty.");
    }
  }

  return {
    search,
    conversation,
    text,
    queryCandidates,
    readMeta,
    readTurns,
    readTextChunks,
  };
}
