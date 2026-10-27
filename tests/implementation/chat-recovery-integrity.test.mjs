import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createChatHandler } from "../../runtime/chat.ts";
import { createConversationStoreAdapter } from "../../runtime/conversation-store.ts";

const conversationId = "90000000-0000-4000-8000-000000000001";
const queryIdForOrdinal = (ordinal) =>
  `a1000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const queryId = queryIdForOrdinal(8);
const sub = "teacher-recovery-integrity";
const botId = "bot-recovery-integrity";
const now = Date.parse("2026-10-25T15:00:00.000Z");
const text = "Saved question.";
const requestFingerprint = createHash("sha256")
  .update(JSON.stringify(["message", conversationId, 7, text]))
  .digest("hex");
const resultDeadlineAt = now + 60_000;
const documentContext = {
  knowledgeBaseId: "kb-recovery-integrity",
  query: "saved recovery context",
  revision: "documents-recovery-r1",
  retrievedAt: now,
  status: "empty",
  results: [],
};
const quotaSnapshot = {
  daily: { used: 1, limit: 20, resetAt: now + 12 * 60 * 60 * 1000, period: "2026-10-25" },
  monthly: { used: 1, limit: 200, resetAt: now + 10 * 24 * 60 * 60 * 1000, period: "2026-10" },
  serverNow: now,
  blockedUntil: null,
  policyRevision: "recovery-integrity-policy",
};
const conversationPk = `CONV#${conversationId}`;
const turnSk = "TURN#00000008";

function keyOf(key) {
  return `${key.pk}\u0000${key.sk}`;
}

function createHarness({ status, phase, answer = "", answerCount = 0, answerComplete } = {}) {
  const rows = new Map();
  const put = (item) => rows.set(keyOf(item), structuredClone(item));
  const meta = {
    pk: conversationPk,
    sk: "META",
    conversationId,
    sub,
    botId,
    lastOrdinal: 8,
    lastQueryId: queryId,
    ...(status === "in_progress" ? { activeQueryId: queryId } : {}),
  };
  const recentReferences = Array.from({ length: 7 }, (_, index) => ({
    ordinal: index + 1,
    queryId: queryIdForOrdinal(index + 1),
  }));
  const turn = {
    pk: conversationPk,
    sk: turnSk,
    conversationId,
    sub,
    botId,
    ordinal: 8,
    queryId,
    operation: "message",
    baseOrdinal: 7,
    requestFingerprint,
    status,
    phase,
    ownerAttemptId: "attempt-recovery-integrity",
    cursor: answerCount,
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: answerCount, complete: answerComplete },
    contextManifest: { count: 0, complete: true },
    contextSnapshot: { version: 1, recentReferences },
    resultDeadlineAt,
    documentContextManifest: { count: 1, complete: true },
    profileSnapshot: { historical: true },
    invocation: { modelId: "historical-model" },
  };
  const marker = {
    pk: `USER#${sub}#BOT#${botId}`,
    sk: `SEND#${queryId}`,
    sub,
    botId,
    queryId,
    conversationId,
    ordinal: 8,
    operation: "message",
    baseOrdinal: 7,
    requestFingerprint,
    admittedAt: now,
    resultDeadlineAt,
    quotaSnapshot,
  };
  put(meta);
  put(turn);
  put(marker);
  for (const reference of recentReferences) {
    const ordinalKey = `TURN#${String(reference.ordinal).padStart(8, "0")}`;
    put({
      pk: conversationPk,
      sk: ordinalKey,
      conversationId,
      sub,
      botId,
      ordinal: reference.ordinal,
      queryId: reference.queryId,
      status: "completed",
      phase: "complete",
      operation: reference.ordinal === 1 ? "start" : "message",
      baseOrdinal: reference.ordinal - 1,
      requestFingerprint: `source-fingerprint-${reference.ordinal}`,
      ownerAttemptId: `source-attempt-${reference.ordinal}`,
      resultDeadlineAt,
      cursor: 1,
      questionManifest: { count: 1, complete: true },
      answerManifest: { count: 1, complete: true },
      contextManifest: { count: 0, complete: true },
      contextSnapshot: { version: 1, recentReferences: [] },
      documentContextManifest: { count: 1, complete: true },
    });
    for (const role of ["user", "assistant"]) {
      put({
        pk: conversationPk,
        sk: `${ordinalKey}#${reference.queryId}#${role.toUpperCase()}#00000000`,
        conversationId,
        queryId: reference.queryId,
        ordinal: reference.ordinal,
        role,
        index: 0,
        text: `Valid ${role} turn ${reference.ordinal}.`,
      });
    }
    put({
      pk: conversationPk,
      sk: `${ordinalKey}#DOCUMENT#00000000`,
      conversationId,
      queryId: reference.queryId,
      ordinal: reference.ordinal,
      index: 0,
      text: JSON.stringify(documentContext),
    });
  }
  put({
    pk: conversationPk,
    sk: `${turnSk}#${queryId}#USER#00000000`,
    conversationId,
    queryId,
    ordinal: 8,
    role: "user",
    index: 0,
    text,
  });
  if (answerCount > 0) {
    put({
      pk: conversationPk,
      sk: `${turnSk}#${queryId}#ASSISTANT#00000000`,
      conversationId,
      queryId,
      ordinal: 8,
      role: "assistant",
      index: 0,
      text: answer,
    });
  }
  put({
    pk: conversationPk,
    sk: `${turnSk}#DOCUMENT#00000000`,
    conversationId,
    queryId,
    ordinal: 8,
    index: 0,
    text: JSON.stringify(documentContext),
  });

  const sentCommands = [];
  const documentClient = {
    async send(command) {
      sentCommands.push(command);
      if (command instanceof GetCommand) {
        return { Item: structuredClone(rows.get(keyOf(command.input.Key))) };
      }
      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues;
        const items = [...rows.values()]
          .filter((item) => item.pk === values[":pk"])
          .filter(
            (item) => values[":prefix"] === undefined || item.sk.startsWith(values[":prefix"]),
          )
          .sort((left, right) => left.sk.localeCompare(right.sk));
        return { Items: structuredClone(items) };
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    },
  };
  const store = createConversationStoreAdapter({
    documentClient,
    tableName: "conversation-recovery-integrity",
    now: () => now,
  });
  const auxiliary = vi.fn(() => {
    throw new Error("Recovery must not run auxiliary work.");
  });
  const handler = createChatHandler({
    config: {
      botId,
      profile: { fields: [], responsePreferences: [] },
      modelId: "current-model",
      revision: "current-revision",
      systemPrompt: "Testing public recovery.",
    },
    accounts: { hasMember: async () => true },
    profiles: { getProfile: auxiliary },
    store,
    prepareContext: auxiliary,
    prepareDocuments: auxiliary,
    countInputTokens: auxiliary,
    generate: auxiliary,
    now: () => now,
  });
  const context = {
    sessionId: conversationId,
    headers: {
      authorization: `Bearer e30.${Buffer.from(JSON.stringify({ sub, token_use: "access" })).toString("base64url")}.runtime-validated`,
      "x-amzn-bedrock-agentcore-runtime-session-id": conversationId,
    },
  };
  return { handler, context, sentCommands, auxiliary, store };
}

async function publicValue(result) {
  if (typeof result?.[Symbol.asyncIterator] !== "function") return result;
  const events = [];
  for await (const event of result) events.push(event);
  return events;
}

const recoverRequest = { version: 2, operation: "recover", conversationId, queryId };
const repeatedMessageRequest = {
  version: 2,
  operation: "message",
  conversationId,
  queryId,
  baseOrdinal: 7,
  text,
};

describe("public Runtime submission recovery integrity", () => {
  it.each([
    { kind: "empty", answer: "", answerCount: 0 },
    { kind: "whitespace-only", answer: " \n\t ", answerCount: 1 },
  ])("does not publish a completed $kind answer", async ({ answer, answerCount }) => {
    const harness = createHarness({
      status: "completed",
      phase: "complete",
      answer,
      answerCount,
      answerComplete: true,
    });

    const recovered = await publicValue(await harness.handler(recoverRequest, harness.context));
    const repeated = await publicValue(
      await harness.handler(repeatedMessageRequest, harness.context),
    );

    expect(recovered).toMatchObject({
      type: "failed",
      code: "temporarily_unavailable",
      recordStatus: "unconfirmed",
      queryId,
    });
    expect(JSON.stringify(recovered)).not.toContain('"status":"completed"');
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({
      type: "failed",
      code: "temporarily_unavailable",
      recordStatus: "unconfirmed",
      queryId,
    });
    expect(JSON.stringify(repeated)).not.toContain('"status":"completed"');
    expect(harness.auxiliary).not.toHaveBeenCalled();
    expect(
      harness.sentCommands.every(
        (command) => command instanceof GetCommand || command instanceof QueryCommand,
      ),
    ).toBe(true);
  });

  it.each([
    {
      status: "completed",
      phase: "complete",
      answer: "Saved answer.",
      answerCount: 1,
      answerComplete: true,
    },
    { status: "in_progress", phase: "admitted", answerComplete: false },
    {
      status: "in_progress",
      phase: "invocation_claimed",
      answer: "Saved prefix.",
      answerCount: 1,
      answerComplete: false,
    },
    { status: "failed", phase: "failed", answerComplete: false },
  ])(
    "preserves a valid $status/$phase submission during recovery",
    async ({ status, phase, answer, answerCount, answerComplete }) => {
      const harness = createHarness({ status, phase, answer, answerCount, answerComplete });

      const recovered = await harness.handler(recoverRequest, harness.context);

      expect(recovered).toMatchObject({
        version: 2,
        conversationId,
        queryId,
        ordinal: 8,
        status,
        question: text,
        answer: answer ?? "",
      });
      expect(harness.auxiliary).not.toHaveBeenCalled();
      expect(
        harness.sentCommands.every(
          (command) => command instanceof GetCommand || command instanceof QueryCommand,
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["in_progress", "complete"],
    ["in_progress", "failed"],
    ["completed", "admitted"],
    ["completed", "invocation_claimed"],
    ["completed", "failed"],
    ["failed", "admitted"],
    ["failed", "invocation_claimed"],
    ["failed", "complete"],
  ])(
    "does not publish a %s/%s submission and preserves safe caller errors",
    async (status, phase) => {
      const completed = status === "completed";
      const harness = createHarness({
        status,
        phase,
        answer: completed ? "Saved answer." : "",
        answerCount: completed ? 1 : 0,
        answerComplete: completed,
      });

      const recovered = await publicValue(await harness.handler(recoverRequest, harness.context));
      const repeated = await publicValue(
        await harness.handler(repeatedMessageRequest, harness.context),
      );

      for (const result of [recovered, ...(Array.isArray(repeated) ? repeated : [repeated])]) {
        expect(result).toMatchObject({
          type: "failed",
          code: "temporarily_unavailable",
          recordStatus: "unconfirmed",
          queryId,
        });
        expect(JSON.stringify(result)).not.toContain('"status":"completed"');
      }
      expect(repeated).toHaveLength(1);
      expect(harness.auxiliary).not.toHaveBeenCalled();
      expect(
        harness.sentCommands.every(
          (command) => command instanceof GetCommand || command instanceof QueryCommand,
        ),
      ).toBe(true);
    },
  );
});

describe("submission storage validates status and phase together", () => {
  it.each([
    ["in_progress", "complete"],
    ["in_progress", "failed"],
    ["completed", "admitted"],
    ["completed", "invocation_claimed"],
    ["completed", "failed"],
    ["failed", "admitted"],
    ["failed", "invocation_claimed"],
    ["failed", "complete"],
  ])("rejects the contradictory %s/%s enum pair", async (status, phase) => {
    const completed = status === "completed";
    const harness = createHarness({
      status,
      phase,
      answer: completed ? "Saved answer." : "",
      answerCount: completed ? 1 : 0,
      answerComplete: completed,
    });

    await expect(harness.store.getSubmission({ sub, botId, queryId })).rejects.toThrow(
      /Submission turn is malformed/,
    );
  });

  it.each([
    {
      status: "completed",
      phase: "complete",
      answer: "Saved answer.",
      answerCount: 1,
      answerComplete: true,
    },
    { status: "in_progress", phase: "admitted", answerComplete: false },
    {
      status: "in_progress",
      phase: "invocation_claimed",
      answer: "Saved prefix.",
      answerCount: 1,
      answerComplete: false,
    },
    { status: "failed", phase: "failed", answerComplete: false },
  ])(
    "accepts the valid $status/$phase enum pair",
    async ({ status, phase, answer, answerCount, answerComplete }) => {
      const harness = createHarness({ status, phase, answer, answerCount, answerComplete });

      await expect(harness.store.getSubmission({ sub, botId, queryId })).resolves.toMatchObject({
        status,
        stage: phase,
        answer: answer ?? "",
        canContinue: status !== "in_progress",
      });
    },
  );
});
