import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createConversationStoreAdapter } from "../../runtime/conversation-store.ts";

const turn = {
  sub: "teacher-123",
  botId: "bot-aurora",
  conversationId: "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9",
  queryId: "e54bd567-c9a1-49af-b204-8b69ef988a31",
  now: Date.parse("2026-10-20T12:00:00.000Z"),
  ownerAttemptId: "attempt-followup",
  resultDeadlineAt: Date.parse("2026-10-20T13:00:00.000Z"),
  requestFingerprint: "fingerprint-followup",
  quota: {
    daily: {
      used: 1,
      limit: 20,
      resetAt: Date.parse("2026-10-21T03:00:00.000Z"),
      period: "2026-10-20",
    },
    monthly: {
      used: 1,
      limit: 200,
      resetAt: Date.parse("2026-11-01T03:00:00.000Z"),
      period: "2026-10",
    },
    serverNow: Date.parse("2026-10-20T12:00:00.000Z"),
    blockedUntil: null,
    policyRevision: "policy-r7",
  },
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
  it("rejects a stored META record without its required owner fields", async () => {
    const malformedMeta = {
      pk: `CONV#${turn.conversationId}`,
      sk: "META",
      conversationId: turn.conversationId,
      sub: turn.sub,
      lastOrdinal: 3,
    };
    const documentClient = {
      send: vi.fn(async (command) =>
        command instanceof GetCommand ? { Item: malformedMeta } : {},
      ),
    };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
    });

    await expect(store.getMeta({ conversationId: turn.conversationId })).rejects.toThrow(
      "Conversation META record is malformed",
    );
  });

  it("compares the same owner, chatbot, conversation, and observed ordinal in its allocation transaction", async () => {
    const meta = {
      pk: `CONV#${turn.conversationId}`,
      sk: "META",
      conversationId: turn.conversationId,
      sub: turn.sub,
      botId: turn.botId,
      lastOrdinal: turn.expectedLastOrdinal,
    };
    const documentClient = {
      send: vi.fn(async (command) =>
        command instanceof GetCommand && command.input.Key.sk === "META" ? { Item: meta } : {},
      ),
    };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
      now: () => turn.now,
    });

    await store.continueTurn({ ...turn, contextReferences: [] });

    const commands = documentClient.send.mock.calls.map(([command]) => command);
    const transaction = commands.find((command) => command instanceof TransactWriteCommand);
    expect(transaction).toBeTruthy();
    const update = transaction.input.TransactItems.find(
      ({ Update }) => Update?.Key?.sk === "META",
    )?.Update;
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
    expect(commands.indexOf(transaction)).toBeGreaterThan(0);
    expect(commands.some((command) => command instanceof GetCommand)).toBe(true);
    expect(
      commands.every(
        (command) => command instanceof GetCommand || command instanceof TransactWriteCommand,
      ),
    ).toBe(true);
  });

  it("re-reads and fences the failure prefix when an append wins after the first cursor read", async () => {
    const now = Date.parse("2026-10-20T12:10:00.000Z");
    const marker = {
      pk: "USER#teacher-123#BOT#bot-aurora",
      sk: "SEND#" + turn.queryId,
      sub: turn.sub,
      botId: turn.botId,
      queryId: turn.queryId,
      requestFingerprint: turn.requestFingerprint,
      operation: "message",
      baseOrdinal: 3,
      conversationId: turn.conversationId,
      ordinal: 4,
      resultDeadlineAt: turn.resultDeadlineAt,
    };
    const turnRecord = {
      pk: `CONV#${turn.conversationId}`,
      sk: "TURN#00000004",
      conversationId: turn.conversationId,
      queryId: turn.queryId,
      ordinal: 4,
      requestFingerprint: turn.requestFingerprint,
      operation: "message",
      baseOrdinal: 3,
      status: "in_progress",
      phase: "invocation_claimed",
      ownerAttemptId: "attempt-followup",
      resultDeadlineAt: turn.resultDeadlineAt,
      cursor: 0,
      questionManifest: { count: 1, complete: true },
      answerManifest: { count: 0, complete: false },
      contextManifest: { count: 0, complete: true },
      profileSnapshot: turn.profileSnapshot,
      invocation: turn.invocation,
    };
    const meta = {
      pk: `CONV#${turn.conversationId}`,
      sk: "META",
      conversationId: turn.conversationId,
      sub: turn.sub,
      botId: turn.botId,
      lastOrdinal: 4,
      activeQueryId: turn.queryId,
      activeOwnerAttemptId: "attempt-followup",
    };
    const question = {
      pk: `CONV#${turn.conversationId}`,
      sk: `TURN#00000004#${turn.queryId}#USER#00000000`,
      conversationId: turn.conversationId,
      queryId: turn.queryId,
      ordinal: 4,
      role: "user",
      index: 0,
      text: turn.text,
    };
    const records = new Map(
      [marker, turnRecord, meta, question].map((item) => [item.pk + "\u0000" + item.sk, item]),
    );
    const keyOf = (key) => key.pk + "\u0000" + key.sk;
    let transactions = 0;
    const documentClient = {
      send: vi.fn(async (command) => {
        if (command instanceof GetCommand) return { Item: records.get(keyOf(command.input.Key)) };
        if (command instanceof QueryCommand) {
          const values = command.input.ExpressionAttributeValues;
          const prefix = values[":prefix"];
          return {
            Items: [...records.values()].filter(
              (item) => item.pk === values[":pk"] && item.sk.startsWith(prefix),
            ),
          };
        }
        if (command instanceof TransactWriteCommand && transactions++ === 0) {
          turnRecord.cursor = 1;
          turnRecord.answerManifest = { count: 1, complete: false };
          const answer = {
            pk: `CONV#${turn.conversationId}`,
            sk: `TURN#00000004#${turn.queryId}#ASSISTANT#00000000`,
            conversationId: turn.conversationId,
            queryId: turn.queryId,
            ordinal: 4,
            role: "assistant",
            index: 0,
            text: "Prefijo durable.",
          };
          records.set(keyOf({ pk: turnRecord.pk, sk: turnRecord.sk }), turnRecord);
          records.set(keyOf({ pk: answer.pk, sk: answer.sk }), answer);
          throw Object.assign(new Error("cursor changed during failure write"), {
            name: "ConditionalCheckFailedException",
          });
        }
        return {};
      }),
    };
    const store = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
      now: () => turn.now,
    });

    await store.failTurn({
      conversationId: turn.conversationId,
      ordinal: 4,
      queryId: turn.queryId,
      ownerAttemptId: "attempt-followup",
      now,
      code: "provider_error",
      invocationClaimed: true,
      providerFinished: false,
    });

    const writes = documentClient.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof TransactWriteCommand);
    expect(writes).toHaveLength(2);
    const terminalActions = writes.map((command) => command.input.TransactItems);
    for (const actions of terminalActions) {
      expect(actions).toHaveLength(2);
      expect(actions.some(({ Update }) => Update?.Key?.sk === "META")).toBe(true);
    }
    const turnUpdates = terminalActions.map(
      (actions) => actions.find(({ Update }) => Update?.Key?.sk === "TURN#00000004").Update,
    );
    expect(
      turnUpdates.map((update) => update.ConditionExpression.includes("#cursor = :cursor")),
    ).toEqual([true, true]);
    expect(turnUpdates.map((update) => update.ExpressionAttributeNames["#cursor"])).toEqual([
      "cursor",
      "cursor",
    ]);
    expect(turnUpdates.map((update) => update.ExpressionAttributeValues[":cursor"])).toEqual([
      0, 1,
    ]);
    expect(turnUpdates[0].ExpressionAttributeValues[":cursor"]).toBe(0);
    expect(turnUpdates[0].ExpressionAttributeValues[":manifest"]).toEqual({
      count: 0,
      complete: false,
    });
    expect(turnUpdates[1].ExpressionAttributeValues[":cursor"]).toBe(1);
    expect(turnUpdates[1].ExpressionAttributeValues[":manifest"]).toEqual({
      count: 1,
      complete: false,
    });
  });

  it.each([
    { providerFinished: true, closesConversation: false },
    { providerFinished: false, closesConversation: true },
  ])(
    "binds the cursor fence and keeps the terminal transaction atomic when providerFinished=$providerFinished",
    async ({ providerFinished, closesConversation }) => {
      const now = Date.parse("2026-10-20T12:10:00.000Z");
      const turnRecord = {
        pk: `CONV#${turn.conversationId}`,
        sk: "TURN#00000004",
        conversationId: turn.conversationId,
        queryId: turn.queryId,
        ordinal: 4,
        status: "in_progress",
        phase: "invocation_claimed",
        ownerAttemptId: turn.ownerAttemptId,
        resultDeadlineAt: turn.resultDeadlineAt,
        cursor: 2,
        answerManifest: { count: 2, complete: false },
      };
      const metaRecord = {
        pk: `CONV#${turn.conversationId}`,
        sk: "META",
        conversationId: turn.conversationId,
        sub: turn.sub,
        botId: turn.botId,
        lastOrdinal: 4,
        activeQueryId: turn.queryId,
        activeOwnerAttemptId: turn.ownerAttemptId,
      };
      const records = new Map(
        [turnRecord, metaRecord].map((item) => [item.pk + "\u0000" + item.sk, item]),
      );
      const documentClient = {
        send: vi.fn(async (command) => {
          if (command instanceof GetCommand) {
            const key = command.input.Key;
            return { Item: records.get(key.pk + "\u0000" + key.sk) };
          }
          return {};
        }),
      };
      const store = createConversationStoreAdapter({
        documentClient,
        tableName: "conversations-aurora-dev",
      });

      await store.failTurn({
        conversationId: turn.conversationId,
        ordinal: 4,
        queryId: turn.queryId,
        ownerAttemptId: turn.ownerAttemptId,
        now,
        code: "provider_error",
        invocationClaimed: true,
        providerFinished,
      });

      const command = documentClient.send.mock.calls
        .map(([sent]) => sent)
        .find((sent) => sent instanceof TransactWriteCommand);
      expect(command).toBeInstanceOf(TransactWriteCommand);
      expect(command.input.TransactItems).toHaveLength(2);
      const turnUpdate = command.input.TransactItems.find(
        ({ Update }) => Update?.Key?.sk === "TURN#00000004",
      ).Update;
      const metaUpdate = command.input.TransactItems.find(
        ({ Update }) => Update?.Key?.sk === "META",
      ).Update;

      expect(turnUpdate.ConditionExpression).toContain("#cursor = :cursor");
      expect(turnUpdate.ExpressionAttributeNames).toMatchObject({
        "#status": "status",
        "#phase": "phase",
        "#queryId": "queryId",
        "#ownerAttemptId": "ownerAttemptId",
        "#cursor": "cursor",
        "#resultDeadlineAt": "resultDeadlineAt",
      });
      expect(turnUpdate.ExpressionAttributeValues).toMatchObject({
        ":inProgress": "in_progress",
        ":expectedPhase": "invocation_claimed",
        ":claimed": "invocation_claimed",
        ":queryId": turn.queryId,
        ":ownerAttemptId": turn.ownerAttemptId,
        ":cursor": 2,
        ":nowMs": now,
        ":manifest": { count: 2, complete: false },
      });
      expect(turnUpdate.ConditionExpression).toContain("#status = :inProgress");
      expect(turnUpdate.ConditionExpression).toContain("#phase = :expectedPhase");
      expect(turnUpdate.ConditionExpression).toContain("#queryId = :queryId");
      expect(turnUpdate.ConditionExpression).toContain("#resultDeadlineAt >= :nowMs");
      expect(turnUpdate.ConditionExpression).toContain("#ownerAttemptId = :ownerAttemptId");
      expect(metaUpdate.ConditionExpression).toContain("#activeOwnerAttemptId = :ownerAttemptId");
      expect(metaUpdate.ExpressionAttributeValues[":queryId"]).toBe(turn.queryId);
      expect(metaUpdate.ExpressionAttributeValues[":ownerAttemptId"]).toBe(turn.ownerAttemptId);
      expect(metaUpdate.UpdateExpression).toContain("REMOVE #activeQueryId, #activeOwnerAttemptId");
      expect(metaUpdate.UpdateExpression.includes("#closed = :true")).toBe(closesConversation);
      if (closesConversation) {
        expect(metaUpdate.ExpressionAttributeNames["#closed"]).toBe("closed");
        expect(metaUpdate.ExpressionAttributeValues[":true"]).toBe(true);
      } else {
        expect(metaUpdate.ExpressionAttributeNames["#closed"]).toBeUndefined();
        expect(metaUpdate.ExpressionAttributeValues[":true"]).toBeUndefined();
      }
    },
  );
});
