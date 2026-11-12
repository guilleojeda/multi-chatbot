import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { prepareUnchangedContext } from "../support/context-preparation.mjs";
import { createConversationStoreAdapter } from "../../runtime/conversation-store.ts";
import {
  botId,
  caller,
  conversationId,
  fixedNow,
  invoke,
  makeContext,
  makeRuntimeHarness,
  profileConfig,
  projectRoot,
  startPayload,
  terminal,
  validProfile,
} from "./helpers/documents-runtime-harness.mjs";

const chatPath = path.join(projectRoot, "runtime/chat.ts");
const accountTableName = "accounts-aurora-dev";
const conversationTableName = "conversations-aurora-dev";
const followupPayload = {
  version: 2,
  operation: "message",
  conversationId,
  queryId: "b88e6e51-074e-48da-b087-bb942e6a812c",
  baseOrdinal: 2,
  text: "Sumá una instancia de cierre.",
};

let createChatHandler;

function ownedMeta(overrides = {}) {
  return {
    conversationId,
    sub: caller.sub,
    botId,
    lastOrdinal: 2,
    closed: false,
    ...overrides,
  };
}

function callNames(state) {
  return state.calls.map(([name]) => name);
}

function makeControlledAdmission(payload) {
  const state = {
    access: "active",
    calls: [],
    documentsPrepared: 0,
    generated: 0,
    transactions: [],
    accessConditionIndexes: [],
  };
  const meta = {
    pk: `CONV#${conversationId}`,
    sk: "META",
    conversationId,
    sub: caller.sub,
    botId,
    lastOrdinal: payload.operation === "message" ? payload.baseOrdinal : 1,
    closed: false,
  };
  const documentClient = {
    async send(command) {
      if (command instanceof GetCommand) {
        if (command.input.Key.sk === "META" && payload.operation === "message") {
          return { Item: structuredClone(meta) };
        }
        if (command.input.Key.sk === "QUOTA#POLICY") {
          return {
            Item: {
              pk: `BOT#${botId}`,
              sk: "QUOTA#POLICY",
              dailyLimit: 20,
              monthlyLimit: 200,
              revision: "usage-policy-1",
            },
          };
        }
        return {};
      }
      if (command instanceof TransactWriteCommand) {
        state.transactions.push(command);
        const index = command.input.TransactItems.findIndex(
          (action) => action.ConditionCheck?.TableName === accountTableName,
        );
        state.accessConditionIndexes.push(index);
        const cancellationReasons = command.input.TransactItems.map((_, actionIndex) => ({
          Code: actionIndex === index ? "ConditionalCheckFailed" : "None",
        }));
        throw Object.assign(new Error("controlled ACCESS condition cancellation"), {
          name: "TransactionCanceledException",
          CancellationReasons: cancellationReasons,
        });
      }
      throw new Error(`Unexpected DynamoDB command ${command.constructor.name}`);
    },
  };
  const actualStore = createConversationStoreAdapter({
    documentClient,
    tableName: conversationTableName,
    accountTableName,
    now: () => fixedNow,
  });
  const store = {
    ...actualStore,
    async readContext() {
      return { messages: [], references: [] };
    },
  };
  const handler = createChatHandler({
    config: {
      botId,
      profile: profileConfig,
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "runtime-access-r1",
      systemPrompt: "Test account access before new chat admission.",
    },
    accounts: {
      async getAccess(input) {
        state.calls.push(["getAccess", structuredClone(input)]);
        return { ...input, access: state.access, revision: 7 };
      },
    },
    profiles: {
      async getProfile(input) {
        state.calls.push(["getProfile", structuredClone(input)]);
        return structuredClone(validProfile);
      },
    },
    store,
    prepareContext: prepareUnchangedContext,
    async prepareDocuments() {
      state.documentsPrepared += 1;
      state.access = "revoked";
      return {
        knowledgeBaseId: "kb-test-aurora",
        query: "consulta de prueba",
        revision: "documents-r1",
        retrievedAt: fixedNow,
        status: "empty",
        results: [],
      };
    },
    async countInputTokens() {
      return { inputTokens: 0 };
    },
    generate() {
      state.generated += 1;
      return (async function* () {
        yield { type: "result", stopReason: "end_turn" };
      })();
    },
    now: () => fixedNow,
  });
  return { handler, state };
}

describe("Runtime access revocation", () => {
  beforeAll(async () => {
    if (!existsSync(chatPath)) return;
    const module = await import(pathToFileURL(chatPath).href);
    createChatHandler = module.createChatHandler;
  });

  beforeEach(() => {
    expect(
      typeof createChatHandler,
      "producto ausente: expected runtime/chat.ts#createChatHandler",
    ).toBe("function");
  });

  it("keeps none distinct from revoked before looking up a SEND record", async () => {
    const harness = makeRuntimeHarness(createChatHandler, { access: "none" });

    const result = await invoke(harness, startPayload);

    expect(terminal(result)).toMatchObject({
      type: "failed",
      code: "access_denied",
      recordStatus: "not_admitted",
    });
    expect(callNames(harness.state)).toEqual(["getAccess"]);
    expect(harness.state.generated).toBe(0);
  });

  it.each([
    ["start", startPayload, null],
    ["message", followupPayload, ownedMeta()],
  ])(
    "rejects a revoked new %s before profile, quota, or preparation",
    async (_label, payload, meta) => {
      const harness = makeRuntimeHarness(createChatHandler, { access: "revoked", meta });

      const result = await invoke(harness, payload);

      expect(terminal(result)).toMatchObject({
        type: "failed",
        code: "access_revoked",
        recordStatus: "not_admitted",
        queryId: payload.queryId,
      });
      expect(callNames(harness.state)).toEqual(["getAccess", "getSubmission"]);
      expect(harness.state.profileReads).toBe(0);
      expect(harness.state.prepareInputs).toEqual([]);
      expect(harness.state.countInputs).toEqual([]);
      expect(harness.state.admittedTurns).toEqual([]);
      expect(harness.state.submissions.size).toBe(0);
      expect(harness.state.generated).toBe(0);
    },
  );

  it.each([
    ["another owner", { sub: "teacher-other", botId }, "conversation_unavailable"],
    ["another chatbot", { sub: caller.sub, botId: "bot-cobalt" }, "conversation_unavailable"],
    [
      "an owner-hidden thread",
      { ...ownedMeta(), hiddenAt: "2026-10-23T17:00:00.000Z" },
      "conversation_hidden",
    ],
  ])("does not expose a revoked SEND for %s", async (_label, meta, expectedCode) => {
    const harness = makeRuntimeHarness(createChatHandler, { access: "revoked", meta });
    harness.state.seedSubmission(startPayload);

    const result = await invoke(harness, startPayload);

    expect(terminal(result)).toMatchObject({
      type: "failed",
      code: expectedCode,
      queryId: startPayload.queryId,
    });
    expect(harness.state.generated).toBe(0);
    expect(harness.state.profileReads).toBe(0);
  });

  it("returns a known terminal SEND to its revoked owner without preparing or generating again", async () => {
    const harness = makeRuntimeHarness(createChatHandler, {
      access: "revoked",
      meta: ownedMeta(),
    });
    harness.state.seedSubmission(startPayload, {
      answer: "Respuesta ya guardada.",
      answerManifest: { count: 1, complete: true },
      cursor: 1,
    });

    const result = await invoke(harness, startPayload);

    expect(result).toMatchObject({
      version: 2,
      conversationId,
      queryId: startPayload.queryId,
      status: "completed",
      question: startPayload.text,
      answer: "Respuesta ya guardada.",
    });
    expect(callNames(harness.state)).toEqual(["getAccess", "getSubmission", "getMeta"]);
    expect(harness.state.profileReads).toBe(0);
    expect(harness.state.prepareInputs).toEqual([]);
    expect(harness.state.admittedTurns).toEqual([]);
    expect(harness.state.generated).toBe(0);
  });

  it("continues the admitted stream after access is revoked", async () => {
    const harness = makeRuntimeHarness(createChatHandler, { access: "active" });
    const response = await harness.handler(startPayload, makeContext());
    const stream = response[Symbol.asyncIterator]();

    try {
      expect((await stream.next()).value).toMatchObject({
        type: "accepted",
        conversationId,
        queryId: startPayload.queryId,
      });
      harness.state.access = "revoked";

      const remaining = [];
      for await (const event of stream) remaining.push(event);

      expect(remaining.at(-1)).toMatchObject({ type: "completed", queryId: startPayload.queryId });
      expect(harness.state.generated).toBe(1);
      expect(harness.state.calls.filter(([name]) => name === "getAccess")).toHaveLength(1);
    } finally {
      await stream.return();
    }
  });

  it("recovers a committed SEND after its admission acknowledgement is lost and access is revoked", async () => {
    const harness = makeRuntimeHarness(createChatHandler, { access: "active" });
    const commit = harness.store.startTurn.bind(harness.store);
    harness.store.startTurn = vi.fn(async (input) => {
      await commit(input);
      harness.state.access = "revoked";
      throw new Error("private transaction acknowledgement loss");
    });

    const firstAttempt = await invoke(harness, startPayload);
    const retry = await invoke(harness, startPayload);

    expect(firstAttempt).toMatchObject({
      version: 2,
      queryId: startPayload.queryId,
      status: "in_progress",
    });
    expect(retry).toMatchObject({
      version: 2,
      queryId: startPayload.queryId,
      status: "in_progress",
    });
    expect(harness.store.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.state.admittedTurns).toHaveLength(1);
    expect(harness.state.generated).toBe(0);
    expect(harness.state.access).toBe("revoked");
  });

  it.each([
    ["without a durable SEND", false],
    ["when the SEND read is uncertain", true],
  ])("keeps a lost admission acknowledgement unconfirmed %s", async (_label, failLookup) => {
    const harness = makeRuntimeHarness(createChatHandler, { access: "active" });
    harness.store.startTurn = vi.fn(async () => {
      throw new Error("private transaction timeout");
    });
    if (failLookup) harness.state.submissionLookupFailures.add(2);

    const result = await invoke(harness, startPayload);

    expect(terminal(result)).toMatchObject({
      type: "failed",
      code: "temporarily_unavailable",
      recordStatus: "unconfirmed",
      queryId: startPayload.queryId,
    });
    expect(harness.store.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.state.submissions.size).toBe(0);
    expect(harness.state.admittedTurns).toEqual([]);
    expect(harness.state.generated).toBe(0);
  });

  it.each([
    ["start", startPayload],
    ["message", followupPayload],
  ])(
    "maps an actual store ACCESS cancellation during %s admission to non-admitted",
    async (_label, payload) => {
      const harness = makeControlledAdmission(payload);

      const result = await invoke(harness, payload);

      expect(terminal(result)).toMatchObject({
        type: "failed",
        code: "access_revoked",
        recordStatus: "not_admitted",
        queryId: payload.queryId,
      });
      expect(harness.state.documentsPrepared).toBe(1);
      expect(harness.state.access).toBe("revoked");
      expect(harness.state.transactions).toHaveLength(1);
      expect(harness.state.accessConditionIndexes[0]).toBeGreaterThanOrEqual(0);
      const transaction = harness.state.transactions[0];
      const accessCondition =
        transaction.input.TransactItems[harness.state.accessConditionIndexes[0]];
      expect(accessCondition.ConditionCheck).toMatchObject({
        TableName: accountTableName,
        Key: { pk: `BOT#${botId}#USER#${caller.sub}`, sk: "ACCESS" },
      });
      expect(transaction.input.TransactItems.length).toBeLessThanOrEqual(100);
      expect(harness.state.generated).toBe(0);
      expect(harness.state.calls.filter(([name]) => name === "getProfile")).toHaveLength(1);
    },
  );
});
