import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { ContextReference, ContextSnapshot, SummaryVersion } from "./contracts.js";
import { maxDynamoTextChunkBytes, splitUtf8Text } from "./text.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const summaryFragmentLimit = Math.floor((4 * 1024 * 1024) / maxDynamoTextChunkBytes) + 1;
const dynamoItemLimit = 400 * 1024;

type SummaryPointer = NonNullable<ContextSnapshot["summary"]>;
type SummaryMetadata = Omit<SummaryVersion, "text" | "sourceReferences">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 256
  );
}

function valueSize(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("DynamoDB items cannot contain non-finite numbers.");
    const digits = String(Math.abs(value))
      .split(/[eE]/)[0]
      .replace(/[^0-9]/g, "")
      .replace(/^0+|0+$/g, "");
    return Math.max(1, Math.ceil((digits.length || 1) / 2) + 1);
  }
  if (typeof value === "boolean" || value === null) return 1;
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) {
    return value.reduce(
      (total, entry) => (entry === undefined ? total : total + 1 + valueSize(entry)),
      3,
    );
  }
  if (isRecord(value)) {
    return Object.entries(value).reduce(
      (total, [name, entry]) =>
        entry === undefined
          ? total
          : total + 1 + Buffer.byteLength(name, "utf8") + valueSize(entry),
      3,
    );
  }
  throw new TypeError("DynamoDB item contains an unsupported value.");
}

export function dynamoItemSize(item: Record<string, unknown>): number {
  return Object.entries(item).reduce(
    (total, [name, value]) =>
      value === undefined ? total : total + Buffer.byteLength(name, "utf8") + valueSize(value),
    0,
  );
}

function referenceList(value: unknown, label: string): ContextReference[] {
  if (!Array.isArray(value)) throw new Error(`${label} are malformed.`);
  let previous = 0;
  const references: ContextReference[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.ordinal) ||
      Number(entry.ordinal) <= previous ||
      !isIdentifier(entry.queryId) ||
      !uuidPattern.test(entry.queryId)
    ) {
      throw new Error(`${label} are malformed.`);
    }
    const reference = { ordinal: Number(entry.ordinal), queryId: entry.queryId };
    references.push(reference);
    previous = reference.ordinal;
  }
  return references;
}

export function validateContextSnapshot(value: unknown, targetOrdinal: number): ContextSnapshot {
  if (!isRecord(value) || value.version !== 1 || !isPositiveOrdinal(targetOrdinal)) {
    throw new Error("Conversation context snapshot is malformed.");
  }
  let summary: SummaryPointer | undefined;
  if (value.summary !== undefined) {
    if (
      !isRecord(value.summary) ||
      !isIdentifier(value.summary.summaryId) ||
      !isPositiveOrdinal(value.summary.throughOrdinal) ||
      Number(value.summary.throughOrdinal) >= targetOrdinal
    ) {
      throw new Error("Conversation context summary reference is malformed.");
    }
    summary = {
      summaryId: value.summary.summaryId,
      throughOrdinal: Number(value.summary.throughOrdinal),
    };
  }
  const recentReferences = referenceList(value.recentReferences, "Conversation context references");
  const lowerBound = summary?.throughOrdinal ?? 0;
  if (
    recentReferences.some(
      (reference) => reference.ordinal <= lowerBound || reference.ordinal >= targetOrdinal,
    )
  ) {
    throw new Error("Conversation context references do not follow the declared summary.");
  }
  return {
    version: 1,
    ...(summary ? { summary } : {}),
    recentReferences,
  };
}

function isPositiveOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateSummaryMetadata(value: Record<string, unknown>): SummaryMetadata {
  if (
    value.version !== 1 ||
    !isIdentifier(value.summaryId) ||
    !isPositiveOrdinal(value.throughOrdinal) ||
    !isIdentifier(value.modelId) ||
    !isIdentifier(value.revision) ||
    (!(typeof value.preparedAt === "string" && value.preparedAt.trim().length > 0) &&
      !(typeof value.preparedAt === "number" && Number.isFinite(value.preparedAt))) ||
    typeof value.inputTokens !== "number" ||
    !Number.isSafeInteger(value.inputTokens) ||
    value.inputTokens < 0 ||
    (value.countRequestId !== undefined && !isIdentifier(value.countRequestId)) ||
    (value.requestId !== undefined && !isIdentifier(value.requestId))
  ) {
    throw new Error("Conversation summary version is malformed.");
  }
  if (value.previousSummaryId !== undefined && !isIdentifier(value.previousSummaryId)) {
    throw new Error("Conversation summary provenance is malformed.");
  }
  if (value.previousSummaryId === value.summaryId) {
    throw new Error("Conversation summary provenance cannot refer to itself.");
  }
  let metrics: Record<string, number> | undefined;
  if (value.metrics !== undefined) {
    if (
      !isRecord(value.metrics) ||
      Object.values(value.metrics).some(
        (metric) => typeof metric !== "number" || !Number.isFinite(metric),
      )
    ) {
      throw new Error("Conversation summary metrics are malformed.");
    }
    metrics = Object.fromEntries(
      Object.entries(value.metrics).map(([name, metric]) => [name, Number(metric)]),
    );
  }
  return {
    version: 1,
    summaryId: value.summaryId,
    throughOrdinal: value.throughOrdinal,
    ...(value.previousSummaryId === undefined
      ? {}
      : { previousSummaryId: value.previousSummaryId }),
    modelId: value.modelId,
    revision: value.revision,
    preparedAt: value.preparedAt,
    inputTokens: value.inputTokens,
    ...(value.countRequestId === undefined ? {} : { countRequestId: value.countRequestId }),
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
    ...(metrics === undefined ? {} : { metrics }),
  };
}

export function validateSummaryVersion(value: unknown): SummaryVersion {
  if (!isRecord(value) || typeof value.text !== "string" || value.text.trim().length === 0) {
    throw new Error("Conversation summary version is malformed.");
  }
  const metadata = validateSummaryMetadata(value);
  const sourceReferences = referenceList(
    value.sourceReferences,
    "Conversation summary source references",
  );
  if (sourceReferences.length === 0 || sourceReferences.at(-1)?.ordinal !== value.throughOrdinal) {
    throw new Error("Conversation summary version is malformed.");
  }
  return {
    ...metadata,
    sourceReferences,
    text: value.text,
  };
}

export function readSummaryPointer(meta: unknown): SummaryPointer | undefined {
  if (!isRecord(meta) || !Object.hasOwn(meta, "summary")) return undefined;
  const pointer = meta.summary;
  if (
    !isRecord(pointer) ||
    !isIdentifier(pointer.summaryId) ||
    !isPositiveOrdinal(pointer.throughOrdinal)
  ) {
    throw new Error("Conversation META declares a malformed summary pointer.");
  }
  return { summaryId: pointer.summaryId, throughOrdinal: pointer.throughOrdinal };
}

function summaryKey(conversationId: string, summaryId: string) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `SUMMARY#${encodeURIComponent(summaryId)}#VERSION#1`,
  };
}

function summaryTextPrefix(conversationId: string, summaryId: string): string {
  return `${summaryKey(conversationId, summaryId).sk}#TEXT#`;
}

function summaryTextKey(conversationId: string, summaryId: string, index: number) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `${summaryTextPrefix(conversationId, summaryId)}${String(index).padStart(8, "0")}`,
  };
}

function summarySourcePrefix(conversationId: string, summaryId: string): string {
  return `${summaryKey(conversationId, summaryId).sk}#SOURCES#`;
}

function summarySourceKey(conversationId: string, summaryId: string, index: number) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `${summarySourcePrefix(conversationId, summaryId)}${String(index).padStart(8, "0")}`,
  };
}

function descriptorFromVersion(
  conversationId: string,
  sub: string,
  botId: string,
  summary: SummaryVersion,
): {
  descriptor: Record<string, unknown>;
  textItems: Record<string, unknown>[];
  sourceReferenceItems: Record<string, unknown>[];
} {
  const key = summaryKey(conversationId, summary.summaryId);
  const textChunks = splitUtf8Text(summary.text);
  const sourceReferenceText = JSON.stringify(summary.sourceReferences);
  const sourceReferenceChunks = splitUtf8Text(sourceReferenceText);
  if (
    textChunks.length === 0 ||
    textChunks.length > summaryFragmentLimit ||
    sourceReferenceChunks.length === 0 ||
    sourceReferenceChunks.length > summaryFragmentLimit
  ) {
    throw new RangeError("Conversation summary exceeds the transaction text limit.");
  }
  const descriptorBase: Record<string, unknown> = {
    ...key,
    conversationId,
    sub,
    botId,
    version: summary.version,
    summaryId: summary.summaryId,
    throughOrdinal: summary.throughOrdinal,
    ...(summary.previousSummaryId ? { previousSummaryId: summary.previousSummaryId } : {}),
    modelId: summary.modelId,
    revision: summary.revision,
    preparedAt: summary.preparedAt,
    inputTokens: summary.inputTokens,
    ...(summary.countRequestId ? { countRequestId: summary.countRequestId } : {}),
    ...(summary.requestId ? { requestId: summary.requestId } : {}),
    ...(summary.metrics ? { metrics: summary.metrics } : {}),
    textManifest: { count: textChunks.length, complete: true },
  };
  const inlineDescriptor = { ...descriptorBase, sourceReferences: summary.sourceReferences };
  const sourceReferencesFragmented = dynamoItemSize(inlineDescriptor) > dynamoItemLimit;
  const descriptor: Record<string, unknown> = sourceReferencesFragmented
    ? {
        ...descriptorBase,
        sourceReferencesManifest: {
          count: sourceReferenceChunks.length,
          complete: true,
        },
      }
    : inlineDescriptor;
  const textItems = textChunks.map((text, index) => ({
    ...summaryTextKey(conversationId, summary.summaryId, index),
    conversationId,
    sub,
    botId,
    summaryId: summary.summaryId,
    version: summary.version,
    index,
    text,
  }));
  const sourceReferenceItems = sourceReferencesFragmented
    ? sourceReferenceChunks.map((text, index) => ({
        ...summarySourceKey(conversationId, summary.summaryId, index),
        conversationId,
        sub,
        botId,
        summaryId: summary.summaryId,
        version: summary.version,
        index,
        text,
      }))
    : [];
  return { descriptor, textItems, sourceReferenceItems };
}

function parseDescriptor(
  value: Record<string, unknown> | undefined,
  input: {
    conversationId: string;
    summaryId: string;
    throughOrdinal?: number;
    sub: string;
    botId: string;
  },
): {
  metadata: SummaryMetadata;
  sourceReferences?: ContextReference[];
  sourceReferenceFragmentCount?: number;
  textCount: number;
} {
  const key = summaryKey(input.conversationId, input.summaryId);
  if (
    !value ||
    value.pk !== key.pk ||
    value.sk !== key.sk ||
    value.conversationId !== input.conversationId ||
    value.summaryId !== input.summaryId ||
    value.version !== 1 ||
    !isPositiveOrdinal(value.throughOrdinal) ||
    (input.throughOrdinal !== undefined && value.throughOrdinal !== input.throughOrdinal) ||
    value.sub !== input.sub ||
    value.botId !== input.botId ||
    !isRecord(value.textManifest) ||
    value.textManifest.complete !== true ||
    !Number.isSafeInteger(value.textManifest.count) ||
    Number(value.textManifest.count) < 1 ||
    Number(value.textManifest.count) > summaryFragmentLimit
  ) {
    throw new Error("Declared conversation summary is missing or malformed.");
  }
  const metadata = validateSummaryMetadata(value);
  const hasInlineReferences = Object.hasOwn(value, "sourceReferences");
  const hasReferenceManifest = Object.hasOwn(value, "sourceReferencesManifest");
  if (hasInlineReferences === hasReferenceManifest) {
    throw new Error("Declared conversation summary source references are malformed.");
  }
  if (hasInlineReferences) {
    const sourceReferences = referenceList(
      value.sourceReferences,
      "Conversation summary source references",
    );
    if (
      sourceReferences.length === 0 ||
      sourceReferences.at(-1)?.ordinal !== metadata.throughOrdinal
    ) {
      throw new Error("Declared conversation summary source references are malformed.");
    }
    return {
      metadata,
      sourceReferences,
      textCount: Number(value.textManifest.count),
    };
  }
  const manifest = value.sourceReferencesManifest;
  if (
    !isRecord(manifest) ||
    manifest.complete !== true ||
    !Number.isSafeInteger(manifest.count) ||
    Number(manifest.count) < 1 ||
    Number(manifest.count) > summaryFragmentLimit
  ) {
    throw new Error("Declared conversation summary source manifest is malformed.");
  }
  return {
    metadata,
    sourceReferenceFragmentCount: Number(manifest.count),
    textCount: Number(value.textManifest.count),
  };
}

export function createContextStorage(input: {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
}) {
  const { documentClient, tableName } = input;

  async function queryPages(
    options: ConstructorParameters<typeof QueryCommand>[0],
    maximumRows?: number,
  ) {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await documentClient.send(
        new QueryCommand({
          ...options,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      items.push(...(page.Items ?? []));
      if (
        maximumRows !== undefined &&
        (items.length > maximumRows || (items.length === maximumRows && page.LastEvaluatedKey))
      ) {
        throw new Error("Conversation summary has too many fragments.");
      }
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  async function readTurnRecords(conversationId: string, ordinals: number[]) {
    const items: Record<string, unknown>[] = [];
    const batchSize = 50;
    for (let offset = 0; offset < ordinals.length; offset += batchSize) {
      const batch = ordinals.slice(offset, offset + batchSize);
      const records = await Promise.all(
        batch.map(async (ordinal) => {
          const result = await documentClient.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                pk: `CONV#${conversationId}`,
                sk: `TURN#${String(ordinal).padStart(8, "0")}`,
              },
              ConsistentRead: true,
            }),
          );
          return result.Item;
        }),
      );
      items.push(
        ...records.filter((record): record is Record<string, unknown> => record !== undefined),
      );
    }
    return items;
  }

  async function readTurnRange(conversationId: string, firstOrdinal: number, lastOrdinal: number) {
    if (
      !isPositiveOrdinal(firstOrdinal) ||
      !isPositiveOrdinal(lastOrdinal) ||
      lastOrdinal < firstOrdinal
    ) {
      throw new Error("Conversation turn range is malformed.");
    }
    const items: Record<string, unknown>[] = [];
    const batchSize = 50;
    for (let first = firstOrdinal; first <= lastOrdinal; first += batchSize) {
      const last = Math.min(first + batchSize - 1, lastOrdinal);
      const ordinals = Array.from({ length: last - first + 1 }, (_, index) => first + index);
      items.push(...(await readTurnRecords(conversationId, ordinals)));
    }
    return items;
  }

  async function verifyReferences(
    conversationId: string,
    references: ContextReference[],
    owner: { sub: string; botId: string },
  ): Promise<void> {
    const normalized = referenceList(references, "Conversation context references");
    if (normalized.length === 0) return;
    const rows = await readTurnRecords(
      conversationId,
      normalized.map((reference) => reference.ordinal),
    );
    const byOrdinal = new Map<number, Record<string, unknown>>();
    for (const row of rows) {
      const ordinal = row.ordinal;
      if (
        row.pk !== `CONV#${conversationId}` ||
        row.sk !== `TURN#${String(ordinal).padStart(8, "0")}` ||
        row.conversationId !== conversationId ||
        !isPositiveOrdinal(ordinal) ||
        row.operation !== (ordinal === 1 ? "start" : "message") ||
        row.baseOrdinal !== ordinal - 1 ||
        typeof row.requestFingerprint !== "string" ||
        row.requestFingerprint.length === 0 ||
        typeof row.ownerAttemptId !== "string" ||
        row.ownerAttemptId.length === 0 ||
        !Number.isSafeInteger(row.resultDeadlineAt) ||
        !isRecord(row.questionManifest) ||
        row.questionManifest.complete !== true ||
        !isPositiveOrdinal(row.questionManifest.count) ||
        !isRecord(row.answerManifest) ||
        row.answerManifest.complete !== true ||
        !isPositiveOrdinal(row.answerManifest.count) ||
        row.cursor !== row.answerManifest.count ||
        !isRecord(row.contextManifest) ||
        row.contextManifest.complete !== true ||
        !Number.isSafeInteger(row.contextManifest.count) ||
        Number(row.contextManifest.count) < 0 ||
        !isRecord(row.contextSnapshot) ||
        row.contextSnapshot.version !== 1 ||
        !isRecord(row.documentContextManifest) ||
        row.documentContextManifest.complete !== true ||
        !isPositiveOrdinal(row.documentContextManifest.count) ||
        byOrdinal.has(ordinal)
      ) {
        throw new Error("Conversation summary source turns are malformed.");
      }
      byOrdinal.set(ordinal, row);
    }
    for (const reference of normalized) {
      const turn = byOrdinal.get(reference.ordinal);
      if (
        !turn ||
        turn.status !== "completed" ||
        turn.queryId !== reference.queryId ||
        turn.phase !== "complete" ||
        turn.sub !== owner.sub ||
        turn.botId !== owner.botId
      ) {
        throw new Error("Conversation context reference does not identify a completed owned turn.");
      }
    }
  }

  async function readSummary(options: {
    conversationId: string;
    summaryId: string;
    throughOrdinal?: number;
    sub: string;
    botId: string;
  }): Promise<SummaryVersion> {
    const descriptorResult = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: summaryKey(options.conversationId, options.summaryId),
        ConsistentRead: true,
      }),
    );
    const {
      metadata,
      sourceReferences: inlineReferences,
      sourceReferenceFragmentCount,
      textCount,
    } = parseDescriptor(descriptorResult.Item, options);
    const chunks = await queryPages(
      {
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": `CONV#${options.conversationId}`,
          ":prefix": summaryTextPrefix(options.conversationId, options.summaryId),
        },
        ConsistentRead: true,
        ScanIndexForward: true,
        Limit: summaryFragmentLimit,
      },
      summaryFragmentLimit,
    );
    if (chunks.length !== textCount)
      throw new Error("Declared conversation summary text is incomplete.");
    const textParts: string[] = [];
    const seen = new Set<number>();
    for (const chunk of chunks) {
      const prefix = summaryTextPrefix(options.conversationId, options.summaryId);
      const key = typeof chunk.sk === "string" ? chunk.sk : "";
      const indexPart = key.startsWith(prefix) ? key.slice(prefix.length) : "";
      const index = /^\d{8}$/.test(indexPart) ? Number(indexPart) : Number.NaN;
      if (
        indexPart.length === 0 ||
        !Number.isSafeInteger(index) ||
        String(index).padStart(8, "0") !== indexPart ||
        seen.has(index) ||
        chunk.pk !== `CONV#${options.conversationId}` ||
        chunk.conversationId !== options.conversationId ||
        chunk.summaryId !== options.summaryId ||
        chunk.version !== 1 ||
        chunk.sub !== options.sub ||
        chunk.botId !== options.botId ||
        chunk.index !== index ||
        typeof chunk.text !== "string" ||
        chunk.text.length === 0
      ) {
        throw new Error("Declared conversation summary text has invalid fragments.");
      }
      seen.add(index);
      textParts.push(chunk.text);
    }
    for (let index = 0; index < textCount; index += 1) {
      if (!seen.has(index)) throw new Error("Declared conversation summary text has an index gap.");
    }
    let sourceReferences = inlineReferences;
    if (sourceReferenceFragmentCount !== undefined) {
      const sourceChunks = await queryPages(
        {
          TableName: tableName,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": `CONV#${options.conversationId}`,
            ":prefix": summarySourcePrefix(options.conversationId, options.summaryId),
          },
          ConsistentRead: true,
          ScanIndexForward: true,
          Limit: summaryFragmentLimit,
        },
        summaryFragmentLimit,
      );
      if (sourceChunks.length !== sourceReferenceFragmentCount) {
        throw new Error("Declared conversation summary source references are incomplete.");
      }
      const sourceTextParts: string[] = [];
      const sourceIndexes = new Set<number>();
      for (const chunk of sourceChunks) {
        const prefix = summarySourcePrefix(options.conversationId, options.summaryId);
        const key = typeof chunk.sk === "string" ? chunk.sk : "";
        const indexPart = key.startsWith(prefix) ? key.slice(prefix.length) : "";
        const index = /^\d{8}$/.test(indexPart) ? Number(indexPart) : Number.NaN;
        if (
          indexPart.length === 0 ||
          !Number.isSafeInteger(index) ||
          String(index).padStart(8, "0") !== indexPart ||
          sourceIndexes.has(index) ||
          chunk.pk !== `CONV#${options.conversationId}` ||
          chunk.conversationId !== options.conversationId ||
          chunk.summaryId !== options.summaryId ||
          chunk.version !== 1 ||
          chunk.sub !== options.sub ||
          chunk.botId !== options.botId ||
          chunk.index !== index ||
          typeof chunk.text !== "string" ||
          chunk.text.length === 0
        ) {
          throw new Error(
            "Declared conversation summary source references have invalid fragments.",
          );
        }
        sourceIndexes.add(index);
        sourceTextParts.push(chunk.text);
      }
      for (let index = 0; index < sourceReferenceFragmentCount; index += 1) {
        if (!sourceIndexes.has(index)) {
          throw new Error("Declared conversation summary source references have an index gap.");
        }
      }
      let parsedReferences: unknown;
      try {
        parsedReferences = JSON.parse(sourceTextParts.join(""));
      } catch {
        throw new Error("Declared conversation summary source references are malformed.");
      }
      sourceReferences = referenceList(parsedReferences, "Conversation summary source references");
    }
    if (sourceReferences === undefined) {
      throw new Error("Declared conversation summary source references are missing.");
    }
    const summary = validateSummaryVersion({
      ...metadata,
      sourceReferences,
      text: textParts.join(""),
    });
    if (summary.text.trim().length === 0)
      throw new Error("Declared conversation summary is empty.");
    return summary;
  }

  return {
    createSummaryItems(input: {
      conversationId: string;
      sub: string;
      botId: string;
      summary: unknown;
    }): {
      descriptor: Record<string, unknown>;
      textItems: Record<string, unknown>[];
      sourceReferenceItems: Record<string, unknown>[];
    } {
      if (
        !isIdentifier(input.conversationId) ||
        !isIdentifier(input.sub) ||
        !isIdentifier(input.botId)
      ) {
        throw new TypeError("Conversation summary owner is invalid.");
      }
      const summary = validateSummaryVersion(input.summary);
      return descriptorFromVersion(input.conversationId, input.sub, input.botId, summary);
    },
    readSummary,
    verifyReferences,
    readTurnRange,
  };
}
