import { describe, expect, it, vi } from "vitest";
import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createConversationStoreAdapter } from "../../runtime/conversation-store.ts";

const turn = {
  sub: "teacher-123",
  botId: "bot-aurora",
  conversationId: "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9",
  queryId: "e54bd567-c9a1-49af-b204-8b69ef988a31",
  now: Date.parse("2026-10-20T12:00:00.000Z"),
  text: "Adaptá la actividad para un grupo que todavía no trabajó decimales.",
  profileSnapshot: {
    sub: "teacher-123",
    botId: "bot-aurora",
    fields: { subjects: ["Matemática"] },
    responsePreferenceIds: [],
    promptTexts: [],
    updatedAt: "2026-10-20T11:00:00.000Z",
    configurationRevision: "revision-123",
  },
  invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "revision-123" },
  expectedLastOrdinal: 3,
};

function conditionValue(command, attribute) {
  const names = command.ExpressionAttributeNames ?? {};
  const values = command.ExpressionAttributeValues ?? {};
  const token = Object.entries(names).find(([, name]) => name === attribute)?.[0] ?? attribute;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.ConditionExpression.match(
    new RegExp(`(?:^|\\W)${escaped}\\s*=\\s*(:[A-Za-z0-9_]+)(?:\\W|$)`),
  );
  return match ? values[match[1]] : undefined;
}

describe("continuation store ownership guard", () => {
  it("compares the same owner, chatbot, conversation, and observed ordinal in its allocation transaction", async () => {
    const documentClient = { send: vi.fn(async () => ({})) };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
    });

    await store.continueTurn(turn);

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const transaction = commands.find((command) => command instanceof TransactWriteCommand);
    expect(transaction).toBeTruthy();
    const update = transaction.input.TransactItems.find(({ Update }) => Update)?.Update;
    const put = transaction.input.TransactItems.find(({ Put }) => Put)?.Put;
    expect(update).toBeTruthy();
    expect(put).toBeTruthy();
    expect(update.Key).toEqual({ pk: `CONV#${turn.conversationId}`, sk: "META" });
    expect(conditionValue(update, "sub")).toBe(turn.sub);
    expect(conditionValue(update, "botId")).toBe(turn.botId);
    expect(conditionValue(update, "conversationId")).toBe(turn.conversationId);
    expect(conditionValue(update, "lastOrdinal")).toBe(turn.expectedLastOrdinal);
    expect(put.Item).toMatchObject({
      pk: `CONV#${turn.conversationId}`,
      sk: "TURN#00000004",
      sub: turn.sub,
      botId: turn.botId,
      queryId: turn.queryId,
      ordinal: 4,
      profileSnapshot: turn.profileSnapshot,
    });
    expect(put.ConditionExpression).toMatch(/attribute_not_exists/);
    expect(commands[0]).toBe(transaction);
    expect(commands.some((command) => command instanceof PutCommand)).toBe(true);
  });
});
