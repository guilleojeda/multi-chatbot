import { randomUUID } from "node:crypto";
import { exportAttemptKey, isRecordsExportId } from "./records-export-contract.js";
import {
  createRecordsReader,
  matchesRecordsFilters,
  normalizeRecordsFilters,
  type NormalizedRecordsFilters,
  type RecordsMeta,
  type RecordsTurn,
} from "./records-reader.js";

export type RecordsExportResources = {
  conversationTableName: string;
  recordsIndexName: string;
  documentUploadBucketName: string;
  testPersonIds: string[];
};

export type RecordsExportInput = {
  botId: string;
  actorSub: string;
  exportId: string;
  filters: unknown;
};

export type RecordsCsvPublication = {
  bucket: string;
  key: string;
  contentType: "text/csv; charset=utf-8";
  body: AsyncIterable<Uint8Array>;
};

export type RecordsExportWorkerOptions = {
  environment: string;
  resourcesByBot: Record<string, RecordsExportResources>;
  documentClient: Parameters<typeof createRecordsReader>[0]["documentClient"];
  publishCsv(input: RecordsCsvPublication): Promise<{ eTag?: string }>;
  now?: () => number;
  remainingTimeMs?: () => number;
};

type ConversationMeta = RecordsMeta;
type TurnRecord = RecordsTurn;
type RecordsReader = ReturnType<typeof createRecordsReader>;
type CandidatePage = Awaited<ReturnType<RecordsReader["queryCandidates"]>>;
type Candidate = CandidatePage["candidates"][number];

type SelectedConversation = {
  meta: ConversationMeta;
  turns: Array<{ turn: TurnRecord; matches: boolean }>;
  isTest: boolean;
};

const csvHeader = [
  "id_persona",
  "id_conversacion",
  "id_consulta",
  "orden",
  "admitida_en",
  "estado",
  "respuesta_completa",
  "codigo_fallo",
  "pregunta",
  "respuesta",
  "contexto_profesional",
  "es_prueba",
  "coincide_filtros",
].join(",");

const errorCodePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function assertExportInput(value: unknown): asserts value is RecordsExportInput {
  if (
    !isRecord(value) ||
    !requiredString(value.botId, 64) ||
    !safeIdPattern.test(value.botId) ||
    !requiredString(value.actorSub, 128) ||
    !isRecordsExportId(value.exportId) ||
    !isRecord(value.filters)
  ) {
    throw new TypeError("Records export input is invalid.");
  }
}

function csvStaticField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

async function* quotedText(chunks: AsyncIterable<string>): AsyncIterable<string> {
  yield '"';
  for await (const chunk of chunks) {
    if (typeof chunk !== "string") throw new Error("Conversation text is invalid.");
    yield chunk.replaceAll('"', '""');
  }
  yield '"';
}

function booleanCell(value: boolean): string {
  return value ? "true" : "false";
}

function safeFailureCode(turn: TurnRecord): string {
  if (turn.status !== "failed") return "";
  if (!isRecord(turn.failure) || typeof turn.failure.code !== "string") return "";
  return errorCodePattern.test(turn.failure.code) ? turn.failure.code : "";
}

function profileContext(turn: TurnRecord): string {
  const snapshot = turn.profileSnapshot;
  if (
    !isRecord(snapshot) ||
    !isRecord(snapshot.fields) ||
    !Array.isArray(snapshot.responsePreferenceIds) ||
    !snapshot.responsePreferenceIds.every((id) => typeof id === "string")
  ) {
    throw new Error("A conversation turn has an invalid professional context snapshot.");
  }
  return JSON.stringify({
    fields: snapshot.fields,
    responsePreferenceIds: snapshot.responsePreferenceIds,
  });
}

function* csvRowPrefix(
  conversation: SelectedConversation,
  turn: TurnRecord,
  matches: boolean,
): Generator<string> {
  const cells = [
    conversation.meta.sub,
    conversation.meta.conversationId,
    turn.queryId,
    String(turn.ordinal),
    turn.createdAt,
    turn.status,
    booleanCell(turn.answerManifest.complete),
    safeFailureCode(turn),
  ];
  yield cells.map(csvStaticField).join(",") + ",";
  yield `"${profileContext(turn).replaceAll('"', '""')}"`;
  yield `,${booleanCell(conversation.isTest)},${booleanCell(matches)}`;
}

async function* csvTurn(
  conversation: SelectedConversation,
  selected: { turn: TurnRecord; matches: boolean },
  reader: ReturnType<typeof createRecordsReader>,
): AsyncIterable<string> {
  const turn = selected.turn;
  const prefix = csvRowPrefix(conversation, turn, selected.matches);
  const firstPart = prefix.next();
  if (!firstPart.done) yield firstPart.value;
  yield* quotedText(reader.readTextChunks(turn, "question"));
  yield ",";
  yield* quotedText(reader.readTextChunks(turn, "answer"));
  const context = prefix.next();
  if (!context.done) {
    yield ",";
    yield context.value;
  }
  const flags = prefix.next();
  if (!flags.done) yield flags.value;
  if (!prefix.next().done) throw new Error("CSV row encoding failed.");
  yield "\r\n";
}

function cursorFingerprint(value: Record<string, unknown>): string {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

async function* candidateRows(
  reader: RecordsReader,
  filters: NormalizedRecordsFilters,
  cutoff: string,
  assertTime: () => void,
): AsyncIterable<Candidate> {
  let cursor: CandidatePage["nextKey"] = null;
  const seenCursors = new Set<string>();
  while (true) {
    assertTime();
    const page = await reader.queryCandidates(filters, cursor, cutoff);
    for (const candidate of page.candidates) yield candidate;
    if (page.nextKey === null) return;
    const fingerprint = cursorFingerprint(page.nextKey);
    if (seenCursors.has(fingerprint)) throw new Error("The records index cursor did not advance.");
    seenCursors.add(fingerprint);
    cursor = page.nextKey;
  }
}

async function readSelectedConversation(
  reader: RecordsReader,
  candidate: Candidate,
  testPersonIds: string[],
  filters: NormalizedRecordsFilters,
  cutoff: string,
): Promise<SelectedConversation | null> {
  const meta = await reader.readMeta(candidate.conversationId);
  if (!meta || candidate.ordinal > meta.lastOrdinal)
    throw new Error("The indexed turn falls outside the conversation snapshot.");
  const testAccount = testPersonIds.includes(meta.sub);
  if (filters.excludeTests && testAccount) return null;

  // Only the last admitted turn can still change. Read it before the terminal prefix.
  const [head] = await reader.readTurns(meta, meta.lastOrdinal, meta.lastOrdinal);
  const earlier = await reader.readTurns(meta, 1, meta.lastOrdinal - 1);
  if (!head || earlier.some((turn) => turn.status === "in_progress"))
    throw new Error("Conversation turn history is incomplete or inconsistent.");
  const descriptors = [...earlier, head];
  if (descriptors[candidate.ordinal - 1]?.createdAt !== candidate.createdAt) {
    throw new Error("The indexed turn does not match its conversation record.");
  }
  const turns = descriptors.map((turn) => ({
    turn,
    matches: matchesRecordsFilters(turn, filters, testPersonIds, meta.sub, cutoff),
  }));
  if (!turns.some(({ matches }) => matches)) return null;
  return { meta, turns, isTest: testAccount };
}

export function createRecordsExportWorker({
  environment,
  resourcesByBot,
  documentClient,
  publishCsv,
  now = Date.now,
  remainingTimeMs,
}: RecordsExportWorkerOptions) {
  if (!requiredString(environment, 32)) throw new Error("Records export environment is invalid.");
  if (!isRecord(resourcesByBot) || Object.keys(resourcesByBot).length === 0) {
    throw new Error("Records export resources are unavailable.");
  }

  const readers = new Map<string, ReturnType<typeof createRecordsReader>>();
  for (const [botId, resources] of Object.entries(resourcesByBot)) {
    if (
      !safeIdPattern.test(botId) ||
      !isRecord(resources) ||
      !requiredString(resources.conversationTableName) ||
      !requiredString(resources.recordsIndexName) ||
      !requiredString(resources.documentUploadBucketName) ||
      !Array.isArray(resources.testPersonIds) ||
      !resources.testPersonIds.every((sub) => requiredString(sub, 128))
    ) {
      throw new Error("Records export resources are invalid.");
    }
    readers.set(
      botId,
      createRecordsReader({
        botId,
        conversationTableName: resources.conversationTableName,
        recordsIndexName: resources.recordsIndexName,
        testPersonIds: resources.testPersonIds,
        documentClient,
        environment,
        now,
      }),
    );
  }

  return {
    async run(
      input: unknown,
      runtime?: { remainingTimeMs?: () => number },
    ): Promise<
      | { status: "empty" }
      | {
          status: "ready";
          objectKey: string;
          conversationCount: number;
          rowCount: number;
          bytes: number;
          eTag: string;
        }
    > {
      assertExportInput(input);
      const resources = resourcesByBot[input.botId];
      const reader = readers.get(input.botId);
      if (!resources || !reader) throw new Error("Records export chatbot is unavailable.");

      const fixedNow = now();
      if (!Number.isFinite(fixedNow)) throw new Error("Records export time is unavailable.");
      const filters = normalizeRecordsFilters(input.filters);
      const cutoff = new Date(fixedNow).toISOString();
      const assertTime = () => {
        const currentRemainingTimeMs = runtime?.remainingTimeMs?.() ?? remainingTimeMs?.();
        if (currentRemainingTimeMs !== undefined && currentRemainingTimeMs < 10_000) {
          throw new Error("Records export exceeded its available processing time.");
        }
      };
      const source = candidateRows(reader, filters, cutoff, assertTime)[Symbol.asyncIterator]();
      const seenConversations = new Set<string>();
      let firstConversation: SelectedConversation | null = null;
      let firstCandidate: IteratorResult<Candidate>;

      try {
        while (true) {
          assertTime();
          firstCandidate = await source.next();
          if (firstCandidate.done) break;
          const { conversationId } = firstCandidate.value;
          if (seenConversations.has(conversationId)) continue;
          seenConversations.add(conversationId);
          firstConversation = await readSelectedConversation(
            reader,
            firstCandidate.value,
            resources.testPersonIds,
            filters,
            cutoff,
          );
          if (firstConversation) break;
        }

        if (!firstConversation) return { status: "empty" };

        const attemptId = randomUUID();
        const objectKey = exportAttemptKey(
          environment,
          input.botId,
          input.actorSub,
          input.exportId,
          attemptId,
        );
        let byteCount = 0;
        let rowCount = 0;
        let conversationCount = 0;
        const encodedRows = async function* (): AsyncIterable<Uint8Array> {
          const emit = async function* (value: string): AsyncIterable<Uint8Array> {
            const bytes = Buffer.from(value, "utf8");
            byteCount += bytes.byteLength;
            yield bytes;
          };
          yield* emit(`${csvHeader}\r\n`);

          let conversation: SelectedConversation | null = firstConversation;
          while (conversation) {
            assertTime();
            conversationCount += 1;
            for (const selected of conversation.turns) {
              assertTime();
              rowCount += 1;
              for await (const part of csvTurn(conversation, selected, reader)) yield* emit(part);
            }

            conversation = null;
            while (true) {
              assertTime();
              const next = await source.next();
              if (next.done) break;
              const { conversationId } = next.value;
              if (seenConversations.has(conversationId)) continue;
              seenConversations.add(conversationId);
              const selected = await readSelectedConversation(
                reader,
                next.value,
                resources.testPersonIds,
                filters,
                cutoff,
              );
              if (selected) {
                conversation = selected;
                break;
              }
            }
          }
        };

        const published = await publishCsv({
          bucket: resources.documentUploadBucketName,
          key: objectKey,
          contentType: "text/csv; charset=utf-8",
          body: encodedRows(),
        });
        if (
          !Number.isSafeInteger(rowCount) ||
          rowCount < 1 ||
          !Number.isSafeInteger(conversationCount) ||
          conversationCount < 1 ||
          !Number.isSafeInteger(byteCount) ||
          byteCount < 1 ||
          !requiredString(published?.eTag, 256)
        ) {
          throw new Error("CSV publication could not be confirmed.");
        }
        return {
          status: "ready",
          objectKey,
          conversationCount,
          rowCount,
          bytes: byteCount,
          eTag: published.eTag,
        };
      } catch {
        try {
          await source.return?.();
        } catch {
          // The source is read-only; failure to close it does not change the safe result.
        }
        throw new Error("Records export preparation failed.");
      }
    },
  };
}
