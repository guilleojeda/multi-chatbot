import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { backfillChatHistory } from "../../scripts/backfill-chat-history.mjs";

const botId = "bot-history-backfill";
const sub = "backfill-owner";
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const queryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";
const tableName = "conversation-history-regression";

describe("history backfill regressions", () => {
  it("reads only the first question when a turn has many assistant and private chunks", async () => {
    const meta = {
      pk: "CONV#" + conversationId,
      sk: "META",
      conversationId,
      sub,
      botId,
      lastOrdinal: 1,
    };
    const turn = {
      pk: meta.pk,
      sk: "TURN#00000001",
      conversationId,
      sub,
      botId,
      queryId,
      ordinal: 1,
      questionManifest: { count: 1, complete: true },
      answerManifest: { count: 12, complete: true },
      cursor: 12,
    };
    const userPrefix = `TURN#00000001#${queryId}#USER#`;
    const question = {
      pk: meta.pk,
      sk: userPrefix + "00000000",
      conversationId,
      queryId,
      ordinal: 1,
      role: "user",
      index: 0,
      text: "Pregunta histórica.",
    };
    const originalRows = [
      question,
      ...Array.from({ length: 12 }, (_, index) => ({
        pk: meta.pk,
        sk: `TURN#00000001#${queryId}#ASSISTANT#${String(index).padStart(8, "0")}`,
        conversationId,
        queryId,
        ordinal: 1,
        role: "assistant",
        index,
        text: `Respuesta ${index}`,
      })),
      {
        pk: meta.pk,
        sk: "TURN#00000001#CONTEXT#00000000",
        conversationId,
        ordinal: 1,
        text: "referencias privadas",
      },
      {
        pk: meta.pk,
        sk: "TURN#00000001#DOCUMENT#00000000",
        conversationId,
        ordinal: 1,
        text: "captura documental privada",
      },
    ].sort((left, right) => (left.sk < right.sk ? -1 : left.sk > right.sk ? 1 : 0));
    const queries = [];
    const reads = [];
    const send = vi.fn(async (command) => {
      reads.push(command);
      if (command instanceof ScanCommand) return { Items: [meta] };
      if (command instanceof GetCommand) return { Item: turn };
      if (command instanceof QueryCommand) {
        queries.push(command.input);
        const { ExclusiveStartKey, ExpressionAttributeValues: values, Limit } = command.input;
        const matching = originalRows.filter(
          (row) => row.pk === values[":pk"] && row.sk.startsWith(values[":prefix"]),
        );
        const startIndex = ExclusiveStartKey
          ? matching.findIndex(
              (row) => row.pk === ExclusiveStartKey.pk && row.sk === ExclusiveStartKey.sk,
            ) + 1
          : 0;
        const page = matching.slice(startIndex, startIndex + Limit);
        const lastIndex = startIndex + page.length - 1;
        return {
          Items: page,
          ...(lastIndex < matching.length - 1
            ? { LastEvaluatedKey: { pk: meta.pk, sk: page.at(-1).sk } }
            : {}),
        };
      }
      if (command instanceof UpdateCommand) return {};
      throw new Error("Unexpected command " + command.constructor.name);
    });

    const result = await backfillChatHistory({
      documentClient: { send },
      tableName,
      botId,
      pageSize: 1,
    });

    expect(result).toMatchObject({ updated: 1, incompatible: 0, scanned: 1 });
    expect(queries).toHaveLength(1);
    expect(queries[0].KeyConditionExpression).toContain("begins_with(#sk, :prefix)");
    expect(queries[0].ExpressionAttributeValues[":prefix"]).toBe(userPrefix);
    expect(queries[0].Limit).toBe(1);
    expect(reads.some((command) => command instanceof GetCommand)).toBe(true);
    expect(
      reads.some(
        (command) =>
          command instanceof QueryCommand && JSON.stringify(command.input).includes("ASSISTANT"),
      ),
    ).toBe(false);
    expect(send.mock.calls.some(([command]) => command instanceof UpdateCommand)).toBe(true);
  });

  it("finishes a large multi-chunk question when Dynamo pages before the item limit", async () => {
    const meta = {
      pk: "CONV#" + conversationId,
      sk: "META",
      conversationId,
      sub,
      botId,
      lastOrdinal: 1,
    };
    const chunkCount = 10;
    const turn = {
      pk: meta.pk,
      sk: "TURN#00000001",
      conversationId,
      sub,
      botId,
      queryId,
      ordinal: 1,
      questionManifest: { count: chunkCount, complete: true },
      answerManifest: { count: 12, complete: true },
      cursor: 12,
    };
    const userPrefix = `TURN#00000001#${queryId}#USER#`;
    const questionChunks = Array.from({ length: chunkCount }, (_, index) => ({
      pk: meta.pk,
      sk: userPrefix + String(index).padStart(8, "0"),
      conversationId,
      queryId,
      ordinal: 1,
      role: "user",
      index,
      text: "x".repeat(300 * 1024),
    }));
    let offset = 0;
    const queries = [];
    const send = vi.fn(async (command) => {
      if (command instanceof ScanCommand) return { Items: [meta] };
      if (command instanceof GetCommand) return { Item: turn };
      if (command instanceof QueryCommand) {
        queries.push(command.input);
        const startKey = command.input.ExclusiveStartKey;
        offset = startKey ? questionChunks.findIndex((chunk) => chunk.sk === startKey.sk) + 1 : 0;
        const page = questionChunks.slice(offset, offset + 3);
        offset += page.length;
        return {
          Items: page,
          ...(offset < questionChunks.length
            ? { LastEvaluatedKey: { pk: meta.pk, sk: page.at(-1).sk } }
            : {}),
        };
      }
      if (command instanceof UpdateCommand) return {};
      throw new Error("Unexpected command " + command.constructor.name);
    });

    const result = await backfillChatHistory({
      documentClient: { send },
      tableName,
      botId,
      pageSize: 50,
    });

    expect(result).toMatchObject({ updated: 1, incompatible: 0, scanned: 1 });
    expect(queries).toHaveLength(4);
    expect(queries.every(({ Limit }) => Limit === 50)).toBe(true);
    expect(
      queries.every(
        ({ ExpressionAttributeValues }) => ExpressionAttributeValues[":prefix"] === userPrefix,
      ),
    ).toBe(true);
  });
});
