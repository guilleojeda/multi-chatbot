import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { createContextStorage } from "../../runtime/context-storage.ts";
import { createConversationStoreAdapter } from "../../runtime/conversation-store.ts";

const tableName = "context-snapshot-regressions";
const conversationId = "b2000000-0000-4000-8000-000000000001";
const owner = { sub: "snapshot-teacher", botId: "bot-snapshot" };
const now = Date.parse("2026-10-24T15:00:00.000Z");
const quota = {
  daily: { used: 2, limit: 20, resetAt: now + 12 * 60 * 60 * 1000, period: "2026-10-24" },
  monthly: { used: 8, limit: 200, resetAt: now + 10 * 24 * 60 * 60 * 1000, period: "2026-10" },
  serverNow: now,
  blockedUntil: null,
  policyRevision: "context-snapshot-test-policy",
};

function queryId(ordinal) {
  return `b3000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function reference(ordinal) {
  return { ordinal, queryId: queryId(ordinal) };
}

function recordKey(item) {
  return `${item.pk}\u0000${item.sk}`;
}

function meta(lastOrdinal, summary, overrides = {}) {
  return {
    pk: `CONV#${conversationId}`,
    sk: "META",
    conversationId,
    ...owner,
    lastOrdinal,
    closed: false,
    lastQueryId: queryId(lastOrdinal),
    ...(summary ? { summary } : {}),
    ...overrides,
  };
}

function turnRecord(ordinal, overrides = {}) {
  const id = queryId(ordinal);
  const padded = String(ordinal).padStart(8, "0");
  const status = overrides.status ?? "completed";
  const answerManifest = overrides.answerManifest ?? { count: 1, complete: status === "completed" };
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${padded}`,
    conversationId,
    ...owner,
    ordinal,
    queryId: id,
    operation: ordinal === 1 ? "start" : "message",
    baseOrdinal: ordinal - 1,
    requestFingerprint: `stored-fingerprint-${ordinal}`,
    ownerAttemptId: `stored-attempt-${ordinal}`,
    resultDeadlineAt: now + 60 * 60 * 1000,
    status,
    phase:
      status === "completed" ? "complete" : status === "failed" ? "failed" : "invocation_claimed",
    cursor: answerManifest.count,
    questionManifest: { count: 1, complete: true },
    answerManifest,
    contextManifest: { count: 0, complete: true },
    contextSnapshot: { version: 1, recentReferences: [] },
    documentContextManifest: { count: 1, complete: true },
    ...overrides,
  };
}

function turnText(ordinal, role, text, id = queryId(ordinal)) {
  const upperRole = role.toUpperCase();
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}#${id}#${upperRole}#00000000`,
    conversationId,
    queryId: id,
    ordinal,
    role,
    index: 0,
    text,
  };
}

function uppercaseUuidCompletedTurnFixture(id) {
  const record = turnRecord(1, {
    queryId: id,
    profileSnapshot: { sub: owner.sub, botId: owner.botId },
    invocation: {
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "context-snapshot-test-r1",
    },
  });
  const answer = turnText(1, "assistant", "answer-1", id);
  const marker = {
    pk: `USER#${owner.sub}#BOT#${owner.botId}`,
    sk: `SEND#${id}`,
    ...owner,
    conversationId,
    queryId: id,
    requestFingerprint: record.requestFingerprint,
    operation: "start",
    baseOrdinal: 0,
    ordinal: 1,
    resultDeadlineAt: record.resultDeadlineAt,
  };
  const documentContext = {
    knowledgeBaseId: "kb-snapshot-test",
    query: "context snapshot recovery test",
    revision: "documents-r1",
    retrievedAt: now,
    status: "empty",
    results: [],
  };
  const documentChunk = {
    pk: `CONV#${conversationId}`,
    sk: "TURN#00000001#DOCUMENT#00000000",
    conversationId,
    queryId: id,
    ordinal: 1,
    index: 0,
    text: JSON.stringify(documentContext),
  };
  return {
    answer,
    records: [
      meta(1, undefined, { lastQueryId: id }),
      record,
      marker,
      turnText(1, "user", "question-1", id),
      answer,
      documentChunk,
    ],
  };
}

function setAssignments(update) {
  const names = update.ExpressionAttributeNames ?? {};
  const values = update.ExpressionAttributeValues ?? {};
  const fields = {};
  for (const match of String(update.UpdateExpression ?? "").matchAll(
    /(#[A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)/g,
  )) {
    const [, nameToken, valueToken] = match;
    const name = names[nameToken];
    if (name) fields[name] = values[valueToken];
  }
  return fields;
}

function makeDatabase(items = []) {
  const records = new Map(items.map((item) => [recordKey(item), structuredClone(item)]));
  const transactions = [];
  const queries = [];
  const documentClient = {
    async send(command) {
      if (command instanceof GetCommand) {
        return { Item: records.get(recordKey(command.input.Key)) };
      }
      if (command instanceof QueryCommand) {
        queries.push(command.input);
        const values = command.input.ExpressionAttributeValues ?? {};
        const rows = [...records.values()]
          .filter((item) => item.pk === values[":pk"])
          .filter(
            (item) =>
              values[":prefix"] === undefined || item.sk.startsWith(String(values[":prefix"])),
          )
          .sort((left, right) => left.sk.localeCompare(right.sk));
        return { Items: rows };
      }
      if (command instanceof TransactWriteCommand) {
        transactions.push(command);
        for (const action of command.input.TransactItems) {
          if (action.Put?.Item) {
            records.set(recordKey(action.Put.Item), structuredClone(action.Put.Item));
          } else if (action.Update?.Key?.sk === "META") {
            const key = action.Update.Key;
            const current = records.get(recordKey(key)) ?? { ...key };
            records.set(recordKey(key), { ...current, ...setAssignments(action.Update) });
          }
        }
        return {};
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    },
  };
  return { documentClient, records, queries, transactions };
}

function makeStore(documentClient) {
  return createConversationStoreAdapter({ documentClient, tableName, now: () => now });
}

function invalidSnapshot(version, recentReferences) {
  return { version, recentReferences };
}

function contextReadItems(snapshot, ordinal) {
  return [
    meta(ordinal),
    turnRecord(ordinal, { contextSnapshot: snapshot }),
    turnText(ordinal, "user", `question-${ordinal}`),
    turnText(ordinal, "assistant", `answer-${ordinal}`),
  ];
}

function summaryVersion(references, summaryId = "large-source-summary") {
  return {
    version: 1,
    summaryId,
    throughOrdinal: references.at(-1).ordinal,
    sourceReferences: references,
    text: "Resumen de referencias fragmentadas.",
    modelId: "global.anthropic.claude-sonnet-4-6",
    revision: "context-snapshot-test-r1",
    preparedAt: "2026-10-24T14:00:00.000Z",
    inputTokens: 5000,
  };
}

function continuationInput({ baseOrdinal, contextSnapshot, contextReferences, summaryCandidate }) {
  const ordinal = baseOrdinal + 1;
  return {
    ...owner,
    conversationId,
    queryId: queryId(ordinal),
    now,
    ownerAttemptId: `snapshot-attempt-${ordinal}`,
    resultDeadlineAt: now + 60 * 60 * 1000,
    text: `new question ${ordinal}`,
    operation: "message",
    baseOrdinal,
    profileSnapshot: { sub: owner.sub, botId: owner.botId },
    documentContext: {
      knowledgeBaseId: "kb-snapshot-dev",
      query: "context snapshot storage",
      revision: "documents-snapshot-r1",
      retrievedAt: now,
      status: "empty",
      results: [],
    },
    invocation: {
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "context-snapshot-test-r1",
    },
    quota,
    requestFingerprint: `snapshot-fingerprint-${ordinal}`,
    contextReferences,
    contextSnapshot,
    ...(summaryCandidate === undefined ? {} : { summaryCandidate }),
  };
}

function putItems(transaction) {
  return transaction.input.TransactItems.flatMap((action) =>
    action.Put?.Item ? [action.Put.Item] : [],
  );
}

function assertTransactionLimits(transaction) {
  const puts = putItems(transaction);
  expect(transaction.input.TransactItems.length).toBeLessThanOrEqual(100);
  expect(puts.every((item) => Buffer.byteLength(JSON.stringify(item), "utf8") < 400 * 1024)).toBe(
    true,
  );
  expect(Buffer.byteLength(JSON.stringify(transaction.input), "utf8")).toBeLessThan(
    4 * 1024 * 1024,
  );
}

async function admitLargeContextContinuation() {
  const references = Array.from({ length: 7000 }, (_, index) => reference(index + 1));
  const initialTurns = references.map(({ ordinal }) => turnRecord(ordinal));
  const db = makeDatabase([meta(references.length), ...initialTurns]);
  const snapshot = { version: 1, recentReferences: references };
  const input = continuationInput({
    baseOrdinal: references.length,
    contextSnapshot: snapshot,
    contextReferences: references,
  });
  const store = makeStore(db.documentClient);

  await store.continueTurn(input);

  const transaction = db.transactions.at(-1);
  const turn = putItems(transaction).find(
    (item) => item.sk === `TURN#${String(references.length + 1).padStart(8, "0")}`,
  );
  const contextItems = putItems(transaction).filter((item) => item.sk.includes("#CONTEXT#"));
  return { references, snapshot, db, input, store, transaction, turn, contextItems };
}

describe("stored context snapshot read validation", () => {
  it.each([
    ["a declared version mismatch", invalidSnapshot(2, [])],
    ["a self-reference outside its range", invalidSnapshot(1, [reference(1)])],
  ])("rejects %s without a summary", async (_label, snapshot) => {
    const db = makeDatabase(contextReadItems(snapshot, 1));

    await expect(makeStore(db.documentClient).readContext({ conversationId })).rejects.toThrow(
      /context snapshot|context references/i,
    );
  });

  it.each([
    ["a declared version mismatch", invalidSnapshot(2, [])],
    ["a self-reference outside its range", invalidSnapshot(1, [reference(2)])],
  ])("rejects %s after the current summary", async (_label, snapshot) => {
    const references = [reference(1)];
    const summary = summaryVersion(references, "summary-before-corrupt-turn");
    const storage = createContextStorage({ documentClient: { send: async () => ({}) }, tableName });
    const summaryItems = storage.createSummaryItems({
      conversationId,
      ...owner,
      summary,
    });
    const items = [
      meta(2, { summaryId: summary.summaryId, throughOrdinal: 1 }),
      turnRecord(1),
      ...summaryItems.sourceReferenceItems,
      ...summaryItems.textItems,
      summaryItems.descriptor,
      turnRecord(2, { contextSnapshot: snapshot }),
      turnText(2, "user", "question-2"),
      turnText(2, "assistant", "answer-2"),
    ];
    const db = makeDatabase(items);

    await expect(makeStore(db.documentClient).readContext({ conversationId })).rejects.toThrow(
      /context snapshot|context references/i,
    );
  });
});

describe("conversation context integrity", () => {
  it.each([
    [
      "a missing latest turn",
      [turnRecord(1), turnText(1, "user", "question-1"), turnText(1, "assistant", "answer-1")],
      2,
    ],
    ["no turn records", [], 1],
  ])("rejects %s when META declares it", async (_label, turns, lastOrdinal) => {
    const db = makeDatabase([meta(lastOrdinal), ...turns]);

    await expect(makeStore(db.documentClient).readContext({ conversationId })).rejects.toThrow(
      /missing a turn/i,
    );
  });

  it("checks coverage across failed and active turns without requiring SEND rows", async () => {
    const items = [
      meta(3, undefined, {
        activeQueryId: queryId(3),
        activeOwnerAttemptId: "attempt-3",
      }),
      turnRecord(1),
      turnText(1, "user", "question-1"),
      turnText(1, "assistant", "answer-1"),
      turnRecord(2, {
        status: "failed",
        phase: "failed",
        cursor: 0,
        answerManifest: { count: 0, complete: false },
      }),
      turnText(2, "user", "failed-question"),
      turnRecord(3, {
        status: "in_progress",
        phase: "admitted",
        ownerAttemptId: "attempt-3",
        resultDeadlineAt: now + 60 * 60 * 1000,
        cursor: 0,
        answerManifest: { count: 0, complete: false },
      }),
      turnText(3, "user", "active-question"),
    ];
    const db = makeDatabase(items);

    const context = await makeStore(db.documentClient).readContext({ conversationId });

    expect(context.references).toEqual([reference(1)]);
    expect(context.messages).toEqual([
      { role: "user", content: [{ text: "question-1" }] },
      { role: "assistant", content: [{ text: "answer-1" }] },
    ]);
    expect(items.some((item) => item.sk.startsWith("SEND#"))).toBe(false);
  });

  const corruptCompletedTurns = [
    ["a cursor that contradicts the answer manifest", { cursor: 0 }],
    ["an explicitly failed phase", { phase: "failed" }],
    ["an explicit foreign owner", { sub: "another-teacher" }],
    ["an explicit foreign bot", { botId: "another-bot" }],
  ];

  it.each(["without a summary", "after a summary"])(
    "rejects contradictory completed turns %s",
    async (mode) => {
      for (const [label, overrides] of corruptCompletedTurns) {
        const ordinal = mode === "without a summary" ? 1 : 2;
        const completed = turnRecord(ordinal, overrides);
        let items;
        if (mode === "without a summary") {
          items = [
            meta(1),
            completed,
            turnText(1, "user", "question-1"),
            turnText(1, "assistant", "answer-1"),
          ];
        } else {
          const summary = summaryVersion([reference(1)], `integrity-${label.replaceAll(" ", "-")}`);
          const persistedSummary = createContextStorage({
            documentClient: { send: async () => ({}) },
            tableName,
          }).createSummaryItems({ conversationId, ...owner, summary });
          items = [
            meta(2, { summaryId: summary.summaryId, throughOrdinal: 1 }),
            turnRecord(1),
            ...persistedSummary.sourceReferenceItems,
            ...persistedSummary.textItems,
            persistedSummary.descriptor,
            completed,
            turnText(2, "user", "question-2"),
            turnText(2, "assistant", "answer-2"),
          ];
        }
        const db = makeDatabase(items);

        await expect(
          makeStore(db.documentClient).readContext({ conversationId }),
        ).rejects.toThrow();
      }
    },
  );

  it.each(["without a summary", "after a summary"])(
    "rejects a completed turn missing its current owner or lifecycle fields %s",
    async (mode) => {
      const ordinal = mode === "without a summary" ? 1 : 2;
      const legacyTurn = turnRecord(ordinal);
      delete legacyTurn.cursor;
      delete legacyTurn.phase;
      delete legacyTurn.sub;
      delete legacyTurn.botId;
      let items;
      if (mode === "without a summary") {
        items = [
          meta(1),
          legacyTurn,
          turnText(1, "user", "legacy-question"),
          turnText(1, "assistant", "legacy-answer"),
        ];
      } else {
        const summary = summaryVersion([reference(1)], "legacy-optional-fields-summary");
        const persistedSummary = createContextStorage({
          documentClient: { send: async () => ({}) },
          tableName,
        }).createSummaryItems({ conversationId, ...owner, summary });
        items = [
          meta(2, { summaryId: summary.summaryId, throughOrdinal: 1 }),
          turnRecord(1),
          ...persistedSummary.sourceReferenceItems,
          ...persistedSummary.textItems,
          persistedSummary.descriptor,
          legacyTurn,
          turnText(2, "user", "legacy-question"),
          turnText(2, "assistant", "legacy-answer"),
        ];
      }
      const db = makeDatabase(items);

      await expect(makeStore(db.documentClient).readContext({ conversationId })).rejects.toThrow(
        /turn|owner|context/i,
      );
    },
  );

  it.each(
    ["without a summary", "after a summary"].flatMap((mode) =>
      ["user", "assistant"].flatMap((role) => {
        const ordinal = mode === "without a summary" ? 1 : 2;
        return [
          [mode, role, "matching explicit ordinal", ordinal, false],
          [mode, role, "missing current ordinal", undefined, true],
          [mode, role, "contradictory explicit ordinal", ordinal + 1, true],
        ];
      }),
    ),
  )(
    "%s validates a consumed %s chunk with a %s",
    async (mode, role, _label, chunkOrdinal, shouldReject) => {
      const ordinal = mode === "without a summary" ? 1 : 2;
      const textChunk = (targetOrdinal, targetRole) => {
        const chunk = turnText(
          targetOrdinal,
          targetRole,
          targetRole === "user" ? `question-${targetOrdinal}` : `answer-${targetOrdinal}`,
        );
        if (targetRole === role) {
          if (chunkOrdinal === undefined) delete chunk.ordinal;
          else chunk.ordinal = chunkOrdinal;
        }
        return chunk;
      };
      let items;
      if (mode === "without a summary") {
        items = [meta(1), turnRecord(1), textChunk(1, "user"), textChunk(1, "assistant")];
      } else {
        const summary = summaryVersion([reference(1)], "ordinal-validation-summary");
        const persistedSummary = createContextStorage({
          documentClient: { send: async () => ({}) },
          tableName,
        }).createSummaryItems({ conversationId, ...owner, summary });
        const coveredQuestion = turnText(1, "user", "covered-question");
        const coveredAnswer = turnText(1, "assistant", "covered-answer");
        coveredQuestion.ordinal = 99;
        coveredAnswer.ordinal = 99;
        items = [
          meta(2, { summaryId: summary.summaryId, throughOrdinal: 1 }),
          turnRecord(1),
          coveredQuestion,
          coveredAnswer,
          ...persistedSummary.sourceReferenceItems,
          ...persistedSummary.textItems,
          persistedSummary.descriptor,
          turnRecord(2),
          textChunk(2, "user"),
          textChunk(2, "assistant"),
        ];
      }
      const db = makeDatabase(items);

      if (shouldReject) {
        await expect(makeStore(db.documentClient).readContext({ conversationId })).rejects.toThrow(
          /malformed text chunk/i,
        );
      } else {
        const context = await makeStore(db.documentClient).readContext({ conversationId });
        expect(context.messages).toEqual([
          { role: "user", content: [{ text: `question-${ordinal}` }] },
          { role: "assistant", content: [{ text: `answer-${ordinal}` }] },
        ]);
        if (mode === "after a summary") {
          expect(context.summary?.text).toBe("Resumen de referencias fragmentadas.");
          expect(
            db.queries.some((query) =>
              String(query.ExpressionAttributeValues?.[":prefix"]).startsWith("TURN#00000001#"),
            ),
          ).toBe(false);
        }
      }
    },
  );
});

describe("continuation base races", () => {
  it("rejects a context prepared through a newer ordinal before validating its snapshot", async () => {
    const db = makeDatabase([meta(2), turnRecord(1), turnRecord(2)]);
    const references = [reference(1), reference(2)];
    const input = continuationInput({
      baseOrdinal: 1,
      contextSnapshot: { version: 1, recentReferences: references },
      contextReferences: references,
    });

    await expect(makeStore(db.documentClient).continueTurn(input)).rejects.toMatchObject({
      code: "stale_base",
    });
    expect(db.transactions).toHaveLength(0);
  });

  it.each([
    ["another owner", { ...meta(2), sub: "another-teacher" }, "conflict"],
    ["an active turn", { ...meta(2), activeQueryId: queryId(2) }, "conversation_busy"],
    ["a closed conversation", { ...meta(2), closed: true }, "conversation_busy"],
  ])(
    "checks %s before validating context from a newer ordinal",
    async (_state, currentMeta, code) => {
      const db = makeDatabase([currentMeta, turnRecord(1), turnRecord(2)]);
      const references = [reference(1), reference(2)];
      const input = continuationInput({
        baseOrdinal: 1,
        contextSnapshot: { version: 1, recentReferences: references },
        contextReferences: references,
      });

      await expect(makeStore(db.documentClient).continueTurn(input)).rejects.toMatchObject({
        code,
      });
      expect(db.transactions).toHaveLength(0);
    },
  );

  it("preserves a compatible durable SEND winner after an admission condition loses", async () => {
    const input = continuationInput({
      baseOrdinal: 1,
      contextSnapshot: { version: 1, recentReferences: [reference(1)] },
      contextReferences: [reference(1)],
    });
    const records = new Map([[recordKey(meta(1)), meta(1)]]);
    let winner;
    let transactions = 0;
    const documentClient = {
      async send(command) {
        if (command instanceof GetCommand) {
          const key = recordKey(command.input.Key);
          return {
            Item:
              key === `USER#${owner.sub}#BOT#${owner.botId}\u0000SEND#${input.queryId}`
                ? winner
                : records.get(key),
          };
        }
        if (command instanceof TransactWriteCommand) {
          transactions += 1;
          winner = {
            pk: `USER#${owner.sub}#BOT#${owner.botId}`,
            sk: `SEND#${input.queryId}`,
            sub: owner.sub,
            botId: owner.botId,
            queryId: input.queryId,
            requestFingerprint: input.requestFingerprint,
            operation: "message",
            baseOrdinal: 1,
            conversationId,
            ordinal: 2,
          };
          throw Object.assign(new Error("Conditional write lost to the matching request."), {
            name: "ConditionalCheckFailedException",
          });
        }
        throw new Error(`Unexpected command ${command.constructor.name}`);
      },
    };

    await expect(makeStore(documentClient).continueTurn(input)).rejects.toMatchObject({
      code: "submission_exists",
    });
    expect(transactions).toBe(1);
    expect(winner).toMatchObject({ queryId: input.queryId, ordinal: 2 });
  });
});

describe("canonical conversation text chunk keys", () => {
  const uppercaseId = queryId(1).toUpperCase();

  it("accepts uppercase UUIDs during context reconstruction", async () => {
    const fixture = uppercaseUuidCompletedTurnFixture(uppercaseId);
    const db = makeDatabase(fixture.records);
    const store = makeStore(db.documentClient);

    await expect(store.readContext({ conversationId })).resolves.toMatchObject({
      messages: [
        { role: "user", content: [{ text: "question-1" }] },
        { role: "assistant", content: [{ text: "answer-1" }] },
      ],
    });
  });

  it("rejects a noncanonical role token during context reconstruction", async () => {
    const fixture = uppercaseUuidCompletedTurnFixture(uppercaseId);
    const db = makeDatabase(fixture.records);
    const store = makeStore(db.documentClient);
    db.records.delete(recordKey(fixture.answer));
    const malformedAnswer = {
      ...fixture.answer,
      sk: fixture.answer.sk.replace("#ASSISTANT#", "#assistant#"),
    };
    db.records.set(recordKey(malformedAnswer), malformedAnswer);

    await expect(store.readContext({ conversationId })).rejects.toThrow(/malformed text chunk/i);
  });

  it("accepts uppercase UUIDs during submission recovery", async () => {
    const fixture = uppercaseUuidCompletedTurnFixture(uppercaseId);
    const db = makeDatabase(fixture.records);
    const store = makeStore(db.documentClient);

    await expect(store.getSubmission({ ...owner, queryId: uppercaseId })).resolves.toMatchObject({
      question: "question-1",
      answer: "answer-1",
    });
  });

  it("rejects a noncanonical role token during submission recovery", async () => {
    const fixture = uppercaseUuidCompletedTurnFixture(uppercaseId);
    const db = makeDatabase(fixture.records);
    const store = makeStore(db.documentClient);
    db.records.delete(recordKey(fixture.answer));
    const malformedAnswer = {
      ...fixture.answer,
      sk: fixture.answer.sk.replace("#ASSISTANT#", "#assistant#"),
    };
    db.records.set(recordKey(malformedAnswer), malformedAnswer);

    await expect(store.getSubmission({ ...owner, queryId: uppercaseId })).rejects.toThrow(
      /malformed text chunk/i,
    );
  });
});

describe("summarized history with snapshots created before coverage", () => {
  it.each(["inline", "fragmented"])(
    "keeps a historical recent reference to covered turn data when stored %s",
    async (storageMode) => {
      const source = reference(1);
      const summary = summaryVersion([source], `summary-covering-old-reference-${storageMode}`);
      const summaryStorage = createContextStorage({
        documentClient: { send: async () => ({}) },
        tableName,
      });
      const persistedSummary = summaryStorage.createSummaryItems({
        conversationId,
        ...owner,
        summary,
      });
      const snapshot =
        storageMode === "inline"
          ? { version: 1, recentReferences: [source] }
          : { version: 1, recentReferencesStorage: "context_chunks" };
      const contextRows =
        storageMode === "inline"
          ? []
          : [
              {
                pk: `CONV#${conversationId}`,
                sk: "TURN#00000002#CONTEXT#00000000",
                conversationId,
                ordinal: 2,
                index: 0,
                text: JSON.stringify([source]),
              },
            ];
      const db = makeDatabase([
        meta(2, { summaryId: summary.summaryId, throughOrdinal: summary.throughOrdinal }),
        turnRecord(1),
        turnText(1, "user", "covered-question-must-not-be-read"),
        turnText(1, "assistant", "covered-answer-must-not-be-read"),
        ...persistedSummary.sourceReferenceItems,
        ...persistedSummary.textItems,
        persistedSummary.descriptor,
        turnRecord(2, {
          contextSnapshot: snapshot,
          contextManifest: { count: contextRows.length, complete: true },
        }),
        ...contextRows,
        turnText(2, "user", "question-2"),
        turnText(2, "assistant", "answer-2"),
      ]);

      const context = await makeStore(db.documentClient).readContext({ conversationId });

      expect(context.summary).toMatchObject({ summaryId: summary.summaryId, text: summary.text });
      expect(context.references).toEqual([reference(2)]);
      expect(JSON.stringify(context.messages)).toContain("question-2");
      expect(JSON.stringify(context.messages)).toContain("answer-2");
      expect(JSON.stringify(context.messages)).not.toContain("covered-question");
      expect(JSON.stringify(context.messages)).not.toContain("covered-answer");
      expect(
        db.queries.some((query) =>
          String(query.ExpressionAttributeValues?.[":prefix"]).startsWith("TURN#00000001#"),
        ),
      ).toBe(false);
    },
  );
});

describe("fragmented large context references", () => {
  it("admits and restores 7,000 recent references without putting the list in a turn item", async () => {
    const { references, snapshot, db, input, store, transaction, turn, contextItems } =
      await admitLargeContextContinuation();
    assertTransactionLimits(transaction);
    expect(turn.contextSnapshot).toEqual({ version: 1, recentReferencesStorage: "context_chunks" });
    expect(turn.contextSnapshot).not.toHaveProperty("recentReferences");
    expect(turn.contextManifest).toEqual({ count: contextItems.length, complete: true });
    expect(contextItems.length).toBeGreaterThan(1);

    const submission = await store.getSubmission({ ...owner, queryId: input.queryId });
    expect(submission.contextSnapshot).toEqual(snapshot);
    expect(submission.contextReferences).toEqual(references);

    const storedTurn = db.records.get(recordKey(turn));
    storedTurn.contextManifest = { ...storedTurn.contextManifest, count: contextItems.length + 1 };
    await expect(store.getSubmission({ ...owner, queryId: input.queryId })).rejects.toThrow();
    storedTurn.contextManifest = { count: contextItems.length, complete: true };
    db.records.delete(recordKey(contextItems.at(-1)));
    await expect(store.getSubmission({ ...owner, queryId: input.queryId })).rejects.toThrow();
  });

  it("rejects noncanonical fragment padding during submission recovery", async () => {
    const { references, db, input, store, contextItems } = await admitLargeContextContinuation();
    const submission = await store.getSubmission({ ...owner, queryId: input.queryId });
    expect(submission.contextReferences).toEqual(references);

    const firstContextItem = contextItems.find((item) => item.index === 0);
    expect(firstContextItem.sk).toMatch(/#CONTEXT#00000000$/);
    const firstContextKey = recordKey(firstContextItem);
    const malformedContextItem = {
      ...db.records.get(firstContextKey),
      sk: firstContextItem.sk.replace(/#CONTEXT#\d+$/, "#CONTEXT#0"),
    };
    db.records.delete(firstContextKey);
    db.records.set(recordKey(malformedContextItem), malformedContextItem);

    let rejectedMalformedContextKey = false;
    try {
      await store.getSubmission({ ...owner, queryId: input.queryId });
    } catch {
      rejectedMalformedContextKey = true;
    }
    expect(rejectedMalformedContextKey).toBe(true);
  });
});

describe("fragmented large summary source references", () => {
  it("admits and restores 7,000 source references and rejects a damaged manifest or fragment", async () => {
    const references = Array.from({ length: 7000 }, (_, index) => reference(index + 1));
    const candidate = summaryVersion(references);
    const db = makeDatabase([
      meta(references.length),
      ...references.map(({ ordinal }) => turnRecord(ordinal)),
    ]);
    const input = continuationInput({
      baseOrdinal: references.length,
      contextSnapshot: {
        version: 1,
        summary: { summaryId: candidate.summaryId, throughOrdinal: candidate.throughOrdinal },
        recentReferences: [],
      },
      contextReferences: [],
      summaryCandidate: candidate,
    });
    const store = makeStore(db.documentClient);

    await store.continueTurn(input);

    const transaction = db.transactions.at(-1);
    assertTransactionLimits(transaction);
    const descriptor = putItems(transaction).find(
      (item) => item.summaryId === candidate.summaryId && item.throughOrdinal !== undefined,
    );
    const sourceItems = putItems(transaction).filter((item) => item.sk.includes("#SOURCES#"));
    expect(descriptor).not.toHaveProperty("sourceReferences");
    expect(descriptor.sourceReferencesManifest).toEqual({
      count: sourceItems.length,
      complete: true,
    });
    expect(sourceItems.length).toBeGreaterThan(1);

    const context = await store.readContext({ conversationId });
    expect(context.summary.sourceReferences).toEqual(references);

    const descriptorKey = recordKey(descriptor);
    const persistedDescriptor = db.records.get(descriptorKey);
    persistedDescriptor.sourceReferencesManifest = {
      ...persistedDescriptor.sourceReferencesManifest,
      count: sourceItems.length + 1,
    };
    await expect(store.readContext({ conversationId })).rejects.toThrow();
    persistedDescriptor.sourceReferencesManifest = {
      count: sourceItems.length,
      complete: true,
    };
    db.records.delete(recordKey(sourceItems.at(-1)));
    await expect(store.readContext({ conversationId })).rejects.toThrow();
  });
});
