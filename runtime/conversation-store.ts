import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { maxDynamoTextChunkBytes, splitUtf8Text } from "./text.js";

type ProfileSnapshot = Record<string, unknown>;
type Invocation = { modelId: string; revision?: string };
type ChunkRole = "user" | "assistant";

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

      const updatedAt = createdAt;
      await documentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: turnKey(turn.conversationId, ordinal),
          UpdateExpression:
            "SET #questionManifest = :manifest, #phase = :phase, #updatedAt = :updatedAt",
          ConditionExpression: "#status = :inProgress",
          ExpressionAttributeNames: {
            "#questionManifest": "questionManifest",
            "#phase": "phase",
            "#status": "status",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":manifest": { count: questionChunks.length, complete: true },
            ":phase": "generating",
            ":inProgress": "in_progress",
            ":updatedAt": updatedAt,
          },
        }),
      );
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
