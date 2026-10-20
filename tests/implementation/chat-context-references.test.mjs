import { describe, expect, it, vi } from "vitest";
import {
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createConversationStoreAdapter } from "../../runtime/conversation-store.ts";

const conversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const queryIds = [
  "a4bfbc9f-3699-4e93-b120-a03c0204bc67",
  "b5cfbc9f-3699-4e93-b120-a03c0204bc68",
  "c6dfbc9f-3699-4e93-b120-a03c0204bc69",
  "d7efbc9f-3699-4e93-b120-a03c0204bc60",
];

function completedTurn(ordinal, queryId) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}`,
    conversationId,
    queryId,
    ordinal,
    status: "completed",
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: 1, complete: true },
  };
}

function turnChunk(ordinal, queryId, role, text) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}#${queryId}#${role.toUpperCase()}#00000000`,
    conversationId,
    queryId,
    role,
    index: 0,
    text,
  };
}

const continuation = {
  sub: "teacher-123",
  botId: "bot-aurora",
  conversationId,
  queryId: queryIds[3],
  now: Date.parse("2026-10-20T12:00:00.000Z"),
  text: "Seguí con una adaptación.",
  profileSnapshot: { fields: {} },
  invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "revision-123" },
  expectedLastOrdinal: 3,
};

describe("conversation context references", () => {
  it("records an explicitly empty context for the first turn", async () => {
    const documentClient = { send: vi.fn(async () => ({})) };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
    });

    await store.startTurn({
      sub: "teacher-123",
      botId: "bot-aurora",
      conversationId,
      queryId: queryIds[0],
      now: Date.parse("2026-10-20T12:00:00.000Z"),
      text: "Primera pregunta.",
      profileSnapshot: { fields: {} },
      invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "revision-123" },
    });

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const transaction = commands.find((command) => command instanceof TransactWriteCommand);
    const record = transaction.input.TransactItems.find(({ Put }) =>
      Put?.Item?.sk.startsWith("TURN#"),
    ).Put.Item;
    const publish = commands.find((command) => command instanceof UpdateCommand);

    expect(record.contextManifest).toEqual({ count: 0, complete: false });
    expect(
      commands.some(
        (command) => command instanceof PutCommand && command.input.Item.sk.includes("#CONTEXT#"),
      ),
    ).toBe(false);
    expect(publish.input.ExpressionAttributeValues[":contextManifest"]).toEqual({
      count: 0,
      complete: true,
    });
  });

  it("excludes failed turns with whitespace-only prefixes from the selected context", async () => {
    const items = [
      completedTurn(1, queryIds[0]),
      turnChunk(1, queryIds[0], "user", "Pregunta completa."),
      turnChunk(1, queryIds[0], "assistant", "Respuesta completa."),
      {
        ...completedTurn(2, queryIds[1]),
        status: "failed",
        questionManifest: { count: 1, complete: false },
        answerManifest: { count: 1, complete: false },
      },
      turnChunk(2, queryIds[1], "user", "Pregunta fallida."),
      turnChunk(2, queryIds[1], "assistant", " \n\t "),
      {
        ...completedTurn(3, queryIds[2]),
        status: "in_progress",
        questionManifest: { count: 1, complete: true },
        answerManifest: { count: 0, complete: false },
      },
      turnChunk(3, queryIds[2], "user", "T1 sigue generándose."),
    ];
    const documentClient = {
      send: vi.fn(async (command) =>
        command instanceof QueryCommand ? { Items: structuredClone(items) } : {},
      ),
    };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
    });

    const selectedContext = await store.readContext({ conversationId });
    expect(selectedContext.messages).toEqual([
      { role: "user", content: [{ text: "Pregunta completa." }] },
      { role: "assistant", content: [{ text: "Respuesta completa." }] },
    ]);
    expect(selectedContext.references).toEqual([{ ordinal: 1, queryId: queryIds[0] }]);

    // T1 finishes after the consistent Query returned, before this continuation is allocated.
    items[6] = completedTurn(3, queryIds[2]);
    items.push(turnChunk(3, queryIds[2], "assistant", "T1 terminó tarde."));
    await store.continueTurn({ ...continuation, contextReferences: selectedContext.references });

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const allocation = commands.find((command) => command instanceof TransactWriteCommand);
    const turnPut = allocation.input.TransactItems.find(({ Put }) => Put).Put;
    expect(turnPut.Item).toMatchObject({
      ordinal: 4,
      contextManifest: { count: 1, complete: false },
    });
    expect(Object.hasOwn(turnPut.Item, "messages")).toBe(false);

    const contextPut = commands.find(
      (command) => command instanceof PutCommand && command.input.Item.sk.includes("#CONTEXT#"),
    );
    expect(contextPut.input.Item.text).toBe(JSON.stringify(selectedContext.references));
    expect(JSON.parse(contextPut.input.Item.text)).not.toContainEqual({
      ordinal: 3,
      queryId: queryIds[2],
    });
    const publish = commands.find((command) => command instanceof UpdateCommand);
    expect(publish.input.ExpressionAttributeValues[":contextManifest"]).toEqual({
      count: 1,
      complete: true,
    });
    expect(publish.input.ExpressionAttributeValues[":manifest"]).toEqual({
      count: 1,
      complete: true,
    });
    expect(commands.indexOf(contextPut)).toBeLessThan(commands.indexOf(publish));
  });

  it("splits a long reference list into bounded chunks before publishing its manifest", async () => {
    const references = Array.from({ length: 7000 }, (_, index) => ({
      ordinal: index + 1,
      queryId: `a4bfbc9f-3699-4e93-b120-${String(index + 100000000000).slice(-12)}`,
    }));
    const documentClient = { send: vi.fn(async () => ({})) };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
    });

    await store.continueTurn({
      ...continuation,
      expectedLastOrdinal: 7000,
      contextReferences: references,
    });

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const transaction = commands.find((command) => command instanceof TransactWriteCommand);
    const record = transaction.input.TransactItems.find(({ Put }) => Put).Put.Item;
    const contextPuts = commands.filter(
      (command) => command instanceof PutCommand && command.input.Item.sk.includes("#CONTEXT#"),
    );
    const publish = commands.find((command) => command instanceof UpdateCommand);

    expect(contextPuts.length).toBeGreaterThan(1);
    expect(
      contextPuts.every(({ input }) => Buffer.byteLength(input.Item.text, "utf8") <= 300 * 1024),
    ).toBe(true);
    expect(record.contextManifest).toEqual({ count: contextPuts.length, complete: false });
    expect(publish.input.ExpressionAttributeValues[":contextManifest"]).toEqual({
      count: contextPuts.length,
      complete: true,
    });
    expect(commands.indexOf(contextPuts.at(-1))).toBeLessThan(commands.indexOf(publish));
  });

  it("rejects a completed turn with a missing context reference chunk", async () => {
    const documentClient = {
      send: vi.fn(async () => ({
        Items: [
          {
            ...completedTurn(1, queryIds[0]),
            contextManifest: { count: 1, complete: true },
          },
          turnChunk(1, queryIds[0], "user", "Pregunta completa."),
          turnChunk(1, queryIds[0], "assistant", "Respuesta completa."),
        ],
      })),
    };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
    });

    await expect(store.readContext({ conversationId })).rejects.toThrow(/reference manifest/);
  });
});
