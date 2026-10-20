import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { MessageData } from "@strands-agents/sdk";
import type { ContextReference, ConversationContext } from "./contracts.js";
import { maxDynamoTextChunkBytes, splitUtf8Text } from "./text.js";

type ProfileSnapshot = Record<string, unknown>;
type Invocation = { modelId: string; revision?: string };
type ChunkRole = "user" | "assistant";
type TextChunk = { index: number; text: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const turnRecordPattern = /^TURN#(\d+)$/;
const chunkPrefixPattern = /^TURN#(\d+)#/;
const chunkRecordPattern = /^TURN#(\d+)#([0-9a-f-]{36})#(USER|ASSISTANT)#(\d+)$/i;
const contextChunkRecordPattern = /^TURN#(\d+)#CONTEXT#(\d+)$/;

type StartTurnInput = {
  sub: string;
  botId: string;
  conversationId: string;
  queryId: string;
  now: number;
  text: string;
  profileSnapshot: ProfileSnapshot;
  invocation: Invocation;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

function assembleText(
  fragments: TextChunk[],
  count: number,
  role: ChunkRole | "context",
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
}): ContextReference[] {
  const { ordinal, queryId, count, chunks, partition, conversationId, turns } = input;
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
    const referencedTurn = turns.get(String(value.ordinal).padStart(8, "0"));
    if (
      !referencedTurn ||
      referencedTurn.status !== "completed" ||
      referencedTurn.ordinal !== value.ordinal ||
      referencedTurn.queryId !== value.queryId
    ) {
      throw new Error(`Completed conversation query ${queryId} references a missing turn.`);
    }
    references.push({ ordinal: value.ordinal, queryId: value.queryId });
    previousOrdinal = value.ordinal;
  }
  return references;
}

function reconstructMessages(conversationId: string, items: unknown[]): ConversationContext {
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
    parseContextReferences({
      ordinal: turn.ordinal,
      queryId: turn.queryId,
      count: turn.contextCount,
      chunks: turnChunks,
      partition,
      conversationId,
      turns,
    });
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

export function createConversationStoreAdapter(input: {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
}) {
  const { documentClient, tableName } = input;

  async function putChunk(chunk: {
    conversationId: string;
    ordinal: number;
    queryId: string;
    role: ChunkRole;
    index: number;
    text: string;
    now: number;
  }): Promise<void> {
    if (Buffer.byteLength(chunk.text, "utf8") > maxDynamoTextChunkBytes) {
      throw new RangeError("Conversation text chunk exceeds the storage item limit.");
    }
    await documentClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...chunkKey(chunk.conversationId, chunk.ordinal, chunk.queryId, chunk.role, chunk.index),
          conversationId: chunk.conversationId,
          queryId: chunk.queryId,
          role: chunk.role,
          index: chunk.index,
          text: chunk.text,
          createdAt: isoDate(chunk.now),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }

  async function putContextChunk(chunk: {
    conversationId: string;
    ordinal: number;
    index: number;
    text: string;
    now: number;
  }): Promise<void> {
    if (Buffer.byteLength(chunk.text, "utf8") > maxDynamoTextChunkBytes) {
      throw new RangeError("Conversation context reference chunk exceeds the storage item limit.");
    }
    await documentClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...contextChunkKey(chunk.conversationId, chunk.ordinal, chunk.index),
          conversationId: chunk.conversationId,
          ordinal: chunk.ordinal,
          index: chunk.index,
          text: chunk.text,
          createdAt: isoDate(chunk.now),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }

  async function writeQuestionAndPublish(
    turn: StartTurnInput,
    ordinal: number,
    questionChunks: string[],
    contextChunks: string[],
  ): Promise<void> {
    for (const [index, text] of contextChunks.entries()) {
      await putContextChunk({
        conversationId: turn.conversationId,
        ordinal,
        index,
        text,
        now: turn.now,
      });
    }
    for (const [index, text] of questionChunks.entries()) {
      await putChunk({
        conversationId: turn.conversationId,
        ordinal,
        queryId: turn.queryId,
        role: "user",
        index,
        text,
        now: turn.now,
      });
    }

    const updatedAt = isoDate(turn.now);
    await documentClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: turnKey(turn.conversationId, ordinal),
        UpdateExpression:
          "SET #questionManifest = :manifest, #contextManifest = :contextManifest, #phase = :phase, #updatedAt = :updatedAt",
        ConditionExpression: "#status = :inProgress",
        ExpressionAttributeNames: {
          "#questionManifest": "questionManifest",
          "#contextManifest": "contextManifest",
          "#phase": "phase",
          "#status": "status",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":manifest": { count: questionChunks.length, complete: true },
          ":contextManifest": { count: contextChunks.length, complete: true },
          ":phase": "generating",
          ":inProgress": "in_progress",
          ":updatedAt": updatedAt,
        },
      }),
    );
  }

  return {
    async getMeta({ conversationId }: { conversationId: string }) {
      const result = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { ...conversationKey(conversationId), sk: "META" },
          ConsistentRead: true,
        }),
      );
      return result.Item ?? null;
    },

    async readContext({
      conversationId,
    }: {
      conversationId: string;
    }): Promise<ConversationContext> {
      const items: unknown[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await documentClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "#pk = :pk",
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: { ":pk": `CONV#${conversationId}` },
            ConsistentRead: true,
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          }),
        );
        items.push(...(page.Items ?? []));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey);
      return reconstructMessages(conversationId, items);
    },

    async startTurn(turn: StartTurnInput): Promise<{ queryId: string; ordinal: number }> {
      const createdAt = isoDate(turn.now);
      const questionChunks = splitUtf8Text(turn.text);
      const ordinal = 1;
      const meta = {
        ...conversationKey(turn.conversationId),
        sk: "META",
        conversationId: turn.conversationId,
        sub: turn.sub,
        botId: turn.botId,
        createdAt,
        updatedAt: createdAt,
        lastOrdinal: ordinal,
        lastQueryId: turn.queryId,
      };
      const record = {
        ...turnKey(turn.conversationId, ordinal),
        conversationId: turn.conversationId,
        sub: turn.sub,
        botId: turn.botId,
        queryId: turn.queryId,
        ordinal,
        status: "in_progress",
        phase: "recording_question",
        createdAt,
        updatedAt: createdAt,
        questionManifest: { count: questionChunks.length, complete: false },
        answerManifest: { count: 0, complete: false },
        contextManifest: { count: 0, complete: false },
        profileSnapshot: turn.profileSnapshot,
        invocation: turn.invocation,
      };

      await documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
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
          ],
        }),
      );

      await writeQuestionAndPublish(turn, ordinal, questionChunks, []);
      return { queryId: turn.queryId, ordinal };
    },

    async continueTurn(
      turn: StartTurnInput & { expectedLastOrdinal: number; contextReferences: ContextReference[] },
    ): Promise<{ queryId: string; ordinal: number }> {
      if (
        !isPositiveSafeInteger(turn.expectedLastOrdinal) ||
        !Number.isSafeInteger(turn.expectedLastOrdinal + 1)
      ) {
        throw new RangeError("Conversation ordinal cannot be safely incremented.");
      }
      const ordinal = turn.expectedLastOrdinal + 1;
      const createdAt = isoDate(turn.now);
      const questionChunks = splitUtf8Text(turn.text);
      const contextChunks = encodeContextReferences(turn.contextReferences, ordinal);
      const record = {
        ...turnKey(turn.conversationId, ordinal),
        conversationId: turn.conversationId,
        sub: turn.sub,
        botId: turn.botId,
        queryId: turn.queryId,
        ordinal,
        status: "in_progress",
        phase: "recording_question",
        createdAt,
        updatedAt: createdAt,
        questionManifest: { count: questionChunks.length, complete: false },
        answerManifest: { count: 0, complete: false },
        contextManifest: { count: contextChunks.length, complete: false },
        profileSnapshot: turn.profileSnapshot,
        invocation: turn.invocation,
      };

      await documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { ...conversationKey(turn.conversationId), sk: "META" },
                UpdateExpression:
                  "SET #lastOrdinal = :nextOrdinal, #lastQueryId = :queryId, #updatedAt = :updatedAt",
                ConditionExpression:
                  "#sub = :sub AND #botId = :botId AND #conversationId = :conversationId AND #lastOrdinal = :expectedLastOrdinal",
                ExpressionAttributeNames: {
                  "#sub": "sub",
                  "#botId": "botId",
                  "#conversationId": "conversationId",
                  "#lastOrdinal": "lastOrdinal",
                  "#lastQueryId": "lastQueryId",
                  "#updatedAt": "updatedAt",
                },
                ExpressionAttributeValues: {
                  ":sub": turn.sub,
                  ":botId": turn.botId,
                  ":conversationId": turn.conversationId,
                  ":expectedLastOrdinal": turn.expectedLastOrdinal,
                  ":nextOrdinal": ordinal,
                  ":queryId": turn.queryId,
                  ":updatedAt": createdAt,
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: record,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );

      await writeQuestionAndPublish(turn, ordinal, questionChunks, contextChunks);
      return { queryId: turn.queryId, ordinal };
    },

    async appendChunk(chunk: {
      conversationId: string;
      ordinal?: number;
      queryId: string;
      role: ChunkRole;
      index: number;
      text: string;
      now?: number;
    }): Promise<void> {
      await putChunk({ ...chunk, ordinal: chunk.ordinal ?? 1, now: chunk.now ?? Date.now() });
    },

    async completeTurn(turn: {
      conversationId: string;
      ordinal?: number;
      queryId: string;
      now?: number;
      answerManifest: { count: number; complete: true };
      invocation: Invocation;
      stopReason?: string;
      requestId?: string;
      metrics?: Record<string, unknown>;
    }): Promise<void> {
      const now = turn.now ?? Date.now();
      await documentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: turnKey(turn.conversationId, turn.ordinal ?? 1),
          UpdateExpression:
            "SET #status = :completed, #phase = :complete, #answerManifest = :manifest, #invocation = :invocation, #completedAt = :completedAt, #updatedAt = :completedAt, #stopReason = :stopReason" +
            (turn.requestId ? ", #requestId = :requestId" : "") +
            (turn.metrics ? ", #metrics = :metrics" : ""),
          ConditionExpression: "#status = :inProgress",
          ExpressionAttributeNames: {
            "#status": "status",
            "#phase": "phase",
            "#answerManifest": "answerManifest",
            "#invocation": "invocation",
            "#completedAt": "completedAt",
            "#updatedAt": "updatedAt",
            "#stopReason": "stopReason",
            ...(turn.requestId ? { "#requestId": "requestId" } : {}),
            ...(turn.metrics ? { "#metrics": "metrics" } : {}),
          },
          ExpressionAttributeValues: {
            ":completed": "completed",
            ":complete": "complete",
            ":manifest": turn.answerManifest,
            ":invocation": turn.invocation,
            ":completedAt": isoDate(now),
            ":stopReason": turn.stopReason ?? "endTurn",
            ":inProgress": "in_progress",
            ...(turn.requestId ? { ":requestId": turn.requestId } : {}),
            ...(turn.metrics ? { ":metrics": turn.metrics } : {}),
          },
        }),
      );
    },

    async failTurn(turn: {
      conversationId: string;
      ordinal?: number;
      queryId: string;
      now?: number;
      code: string;
      answerManifest?: { count: number; complete: false };
      stopReason?: string;
      requestId?: string;
      metrics?: Record<string, unknown>;
      providerError?: Record<string, unknown>;
    }): Promise<void> {
      const now = turn.now ?? Date.now();
      await documentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: turnKey(turn.conversationId, turn.ordinal ?? 1),
          UpdateExpression:
            "SET #status = :failed, #phase = :failedPhase, #failure = :failure, #failedAt = :failedAt, #updatedAt = :failedAt" +
            (turn.answerManifest ? ", #answerManifest = :manifest" : "") +
            (turn.stopReason ? ", #stopReason = :stopReason" : "") +
            (turn.requestId ? ", #requestId = :requestId" : "") +
            (turn.metrics ? ", #metrics = :metrics" : "") +
            (turn.providerError ? ", #providerError = :providerError" : ""),
          ConditionExpression: "#status = :inProgress",
          ExpressionAttributeNames: {
            "#status": "status",
            "#phase": "phase",
            "#failure": "failure",
            "#failedAt": "failedAt",
            "#updatedAt": "updatedAt",
            ...(turn.answerManifest ? { "#answerManifest": "answerManifest" } : {}),
            ...(turn.stopReason ? { "#stopReason": "stopReason" } : {}),
            ...(turn.requestId ? { "#requestId": "requestId" } : {}),
            ...(turn.metrics ? { "#metrics": "metrics" } : {}),
            ...(turn.providerError ? { "#providerError": "providerError" } : {}),
          },
          ExpressionAttributeValues: {
            ":failed": "failed",
            ":failedPhase": "failed",
            ":failure": { code: turn.code },
            ":failedAt": isoDate(now),
            ":inProgress": "in_progress",
            ...(turn.answerManifest ? { ":manifest": turn.answerManifest } : {}),
            ...(turn.stopReason ? { ":stopReason": turn.stopReason } : {}),
            ...(turn.requestId ? { ":requestId": turn.requestId } : {}),
            ...(turn.metrics ? { ":metrics": turn.metrics } : {}),
            ...(turn.providerError ? { ":providerError": turn.providerError } : {}),
          },
        }),
      );
    },
  };
}
