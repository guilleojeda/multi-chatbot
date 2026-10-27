import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const adapterPath = path.join(projectRoot, "runtime/conversation-store.ts");
const tableName = "conversations-summary-dev";
const conversationId = "90000000-0000-4000-8000-000000000001";
const owner = { sub: "summary-teacher", botId: "bot-summary" };
const now = Date.parse("2026-10-24T15:00:00.000Z");
const profileSnapshot = {
  sub: owner.sub,
  botId: owner.botId,
  fields: { educationLevels: [{ id: "secundario", label: "Secundario" }] },
  responsePreferenceIds: ["ready-material"],
  updatedAt: "2026-10-24T12:00:00.000Z",
  configurationRevision: "reviewed-runtime-revision",
};
const quota = {
  daily: {
    used: 3,
    limit: 20,
    resetAt: Date.parse("2026-10-25T03:00:00.000Z"),
    period: "2026-10-24",
  },
  monthly: {
    used: 17,
    limit: 200,
    resetAt: Date.parse("2026-11-01T03:00:00.000Z"),
    period: "2026-10",
  },
  serverNow: now,
  blockedUntil: null,
  policyRevision: "quota-r7",
};

let createConversationStoreAdapter;

function queryId(ordinal) {
  return `a1000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function keyFor({ pk, sk }) {
  return `${pk}\u0000${sk}`;
}

function ownerMeta(lastOrdinal, overrides = {}) {
  return {
    pk: `CONV#${conversationId}`,
    sk: "META",
    conversationId,
    ...owner,
    lastOrdinal,
    lastQueryId: lastOrdinal > 0 ? queryId(lastOrdinal) : undefined,
    activeQueryId: undefined,
    activeOwnerAttemptId: undefined,
    closed: false,
    historyOwner: `USER#${owner.sub}#BOT#${owner.botId}`,
    historyOrder: `2026-10-24T12:00:00.000Z#${conversationId}`,
    historyLabel: "Resumen de una secuencia científica",
    createdAt: "2026-10-24T12:00:00.000Z",
    updatedAt: "2026-10-24T12:00:00.000Z",
    ...overrides,
  };
}

function reference(ordinal) {
  return { ordinal, queryId: queryId(ordinal) };
}

function summaryVersion({
  summaryId = "summary-version-one",
  throughOrdinal = 20,
  previousSummaryId,
  sourceReferences = Array.from({ length: throughOrdinal }, (_, index) => reference(index + 1)),
  text = "Resumen durable: recipientes frío y ambiente; conservar tres columnas y la secuencia de observación.",
} = {}) {
  return {
    version: 1,
    summaryId,
    throughOrdinal,
    ...(previousSummaryId ? { previousSummaryId } : {}),
    sourceReferences,
    text,
    modelId: "global.anthropic.claude-sonnet-4-6",
    revision: "reviewed-runtime-revision",
    preparedAt: "2026-10-24T14:55:00.000Z",
    inputTokens: 2450,
    countRequestId: "count-summary-001",
    requestId: "summary-request-001",
    metrics: { latencyMs: 1200 },
  };
}

function contextSnapshot(summary, recentReferences) {
  return {
    version: 1,
    summary: summary
      ? { summaryId: summary.summaryId, throughOrdinal: summary.throughOrdinal }
      : undefined,
    recentReferences,
  };
}

function documentContext(text = "La superficie fría permite observar condensación.") {
  return {
    knowledgeBaseId: "kb-summary-dev",
    query: "condensación para segundo año",
    revision: "documents-summary-r1",
    retrievedAt: now,
    status: "results",
    results: [
      {
        text,
        location: { type: "S3", uri: "s3://summary-fixture/condensacion.pdf" },
        metadata: { documentId: "condensacion-01" },
        score: 0.91,
      },
    ],
    requestId: "retrieve-summary-001",
  };
}

function continuationInput({
  baseOrdinal = 24,
  query = "Convertí la secuencia en una tarjeta de cuatro pasos.",
  summary = summaryVersion(),
  snapshot = contextSnapshot(summary, [21, 22, 23, 24].map(reference)),
  refs = [21, 22, 23, 24].map(reference),
  documents = documentContext(),
} = {}) {
  const ordinal = baseOrdinal + 1;
  return {
    ...owner,
    conversationId,
    queryId: queryId(ordinal),
    now,
    ownerAttemptId: `attempt-${ordinal}`,
    resultDeadlineAt: now + 60 * 60 * 1000,
    text: query,
    profileSnapshot,
    ...(documents ? { documentContext: documents } : {}),
    invocation: {
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "reviewed-runtime-revision",
    },
    quota,
    requestFingerprint: `fingerprint-${ordinal}`,
    operation: "message",
    baseOrdinal,
    expectedLastOrdinal: baseOrdinal,
    contextReferences: refs,
    contextSnapshot: snapshot,
    ...(summary ? { summaryCandidate: summary } : {}),
  };
}

function finishAdmittedTurn(db, input, { status, answerText }) {
  const ordinal = input.expectedLastOrdinal + 1;
  const pk = `CONV#${conversationId}`;
  const turnKey = { pk, sk: `TURN#${String(ordinal).padStart(8, "0")}` };
  const turn = db.records.get(keyFor(turnKey));
  expect(turn, "the admitted turn fixture must be durable before it is finished").toBeDefined();
  Object.assign(turn, {
    status,
    phase: status === "completed" ? "complete" : "failed",
    cursor: 1,
    answerManifest: { count: 1, complete: status === "completed" },
    ...(status === "failed" ? { failure: { code: "provider_error" } } : {}),
  });
  db.records.set(keyFor(turnKey), turn);
  const answerKey = {
    pk,
    sk: `TURN#${String(ordinal).padStart(8, "0")}#${input.queryId}#ASSISTANT#00000000`,
  };
  db.records.set(keyFor(answerKey), {
    ...answerKey,
    conversationId,
    ordinal,
    queryId: input.queryId,
    role: "assistant",
    index: 0,
    text: answerText,
  });
  const metaKey = { pk, sk: "META" };
  const meta = db.records.get(keyFor(metaKey));
  delete meta.activeQueryId;
  delete meta.activeOwnerAttemptId;
  db.records.set(keyFor(metaKey), meta);
}

function completedPair(ordinal, { contextReferences = [] } = {}) {
  const id = queryId(ordinal);
  const question = `question-${ordinal}`;
  const answer = `answer-${ordinal}`;
  const pk = `CONV#${conversationId}`;
  const documentCapture = documentContext();
  const items = [
    {
      pk,
      sk: `TURN#${String(ordinal).padStart(8, "0")}`,
      conversationId,
      ...owner,
      ordinal,
      queryId: id,
      status: "completed",
      phase: "complete",
      cursor: 1,
      questionManifest: { count: 1, complete: true },
      answerManifest: { count: 1, complete: true },
      contextManifest: {
        count: contextReferences.length > 0 ? 1 : 0,
        complete: true,
      },
      contextSnapshot: { version: 1, recentReferences: contextReferences },
      documentContextManifest: { count: 1, complete: true },
    },
    {
      pk,
      sk: `TURN#${String(ordinal).padStart(8, "0")}#${id}#USER#00000000`,
      conversationId,
      ordinal,
      queryId: id,
      role: "user",
      index: 0,
      text: question,
    },
    {
      pk,
      sk: `TURN#${String(ordinal).padStart(8, "0")}#${id}#ASSISTANT#00000000`,
      conversationId,
      ordinal,
      queryId: id,
      role: "assistant",
      index: 0,
      text: answer,
    },
    {
      pk,
      sk: `TURN#${String(ordinal).padStart(8, "0")}#DOCUMENT#00000000`,
      conversationId,
      ordinal,
      index: 0,
      text: JSON.stringify(documentCapture),
    },
  ];
  if (contextReferences.length > 0) {
    items.push({
      pk,
      sk: `TURN#${String(ordinal).padStart(8, "0")}#CONTEXT#00000000`,
      conversationId,
      ordinal,
      index: 0,
      text: JSON.stringify(contextReferences),
    });
  }
  return items;
}

function setAssignments(update) {
  const expression = String(update.UpdateExpression ?? "").split(/\bREMOVE\b/i, 1)[0];
  const names = update.ExpressionAttributeNames ?? {};
  const values = update.ExpressionAttributeValues ?? {};
  const fields = {};
  for (const match of expression.matchAll(/(#[A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)/g)) {
    const [, nameToken, valueToken] = match;
    const name = names[nameToken];
    if (name) fields[name] = values[valueToken];
  }
  return fields;
}

function queryRows(records, input) {
  const values = input.ExpressionAttributeValues ?? {};
  const names = input.ExpressionAttributeNames ?? {};
  const skToken = Object.keys(names).find((token) => names[token] === "sk");
  const pk = values[":pk"];
  let rows = [...records.values()].filter((item) => item.pk === pk);
  const expression = String(input.KeyConditionExpression ?? "");
  if (skToken) {
    const prefix = expression.match(
      new RegExp(`begins_with\\s*\\(\\s*${skToken}\\s*,\\s*(:[A-Za-z0-9_]+)\\s*\\)`),
    );
    if (prefix) {
      rows = rows.filter((item) => item.sk.startsWith(String(values[prefix[1]])));
    } else {
      const between = expression.match(
        new RegExp(`${skToken}\\s+BETWEEN\\s+(:[A-Za-z0-9_]+)\\s+AND\\s+(:[A-Za-z0-9_]+)`, "i"),
      );
      const comparison = expression.match(
        new RegExp(`${skToken}\\s*(>=|>|<=|<)\\s*(:[A-Za-z0-9_]+)`),
      );
      if (between) {
        const start = String(values[between[1]]);
        const end = String(values[between[2]]);
        rows = rows.filter((item) => item.sk >= start && item.sk <= end);
      } else if (comparison) {
        const [, operator, token] = comparison;
        const boundary = String(values[token]);
        rows = rows.filter((item) => {
          if (operator === ">") return item.sk > boundary;
          if (operator === ">=") return item.sk >= boundary;
          if (operator === "<") return item.sk < boundary;
          return item.sk <= boundary;
        });
      }
    }
  }
  if (input.ExclusiveStartKey?.sk) {
    rows = rows.filter((item) => item.sk > input.ExclusiveStartKey.sk);
  }
  rows.sort((left, right) => left.sk.localeCompare(right.sk));
  const limit = input.Limit;
  if (Number.isSafeInteger(limit) && rows.length > limit) {
    const page = rows.slice(0, limit);
    return {
      Items: page,
      LastEvaluatedKey: { pk: page.at(-1).pk, sk: page.at(-1).sk },
    };
  }
  return { Items: rows };
}

function makeDatabase(initialItems = [], hooks = {}) {
  const records = new Map(initialItems.map((item) => [keyFor(item), structuredClone(item)]));
  const calls = [];
  const readQueryItems = [];
  const send = async (command) => {
    calls.push(command);
    if (command instanceof GetCommand) {
      if (hooks.get) {
        const response = await hooks.get(command, records);
        if (response !== undefined) return response;
      }
      return { Item: records.get(keyFor(command.input.Key)) };
    }
    if (command instanceof QueryCommand) {
      const response = queryRows(records, command.input);
      readQueryItems.push(...(response.Items ?? []));
      return response;
    }
    if (command instanceof TransactWriteCommand) {
      if (hooks.transaction) return hooks.transaction(command, records);
      for (const action of command.input.TransactItems) {
        if (action.Put?.Item) {
          records.set(keyFor(action.Put.Item), structuredClone(action.Put.Item));
        } else if (action.Update?.Key?.sk === "META") {
          const key = action.Update.Key;
          const previous = records.get(keyFor(key)) ?? { ...key };
          records.set(keyFor(key), { ...previous, ...setAssignments(action.Update) });
        }
      }
      return {};
    }
    throw new Error(`Unexpected DynamoDB command ${command?.constructor?.name}`);
  };
  const documentClient = { send };
  return { documentClient, records, calls, readQueryItems };
}

function makeStore(documentClient) {
  return createConversationStoreAdapter({ documentClient, tableName, now: () => now });
}

function transactions(calls) {
  return calls.filter((command) => command instanceof TransactWriteCommand);
}

function writtenItems(transaction) {
  return transaction.input.TransactItems.flatMap((action) =>
    action.Put?.Item ? [action.Put.Item] : [],
  );
}

function summaryItem(records, summaryId) {
  return [...records.values()].find(
    (item) =>
      item.summaryId === summaryId && item.version === 1 && item.throughOrdinal !== undefined,
  );
}

function usedArchiveRows(items, throughOrdinal) {
  return items.filter((item) => {
    const match = /^TURN#(\d{8})(?:#|$)/.exec(String(item.sk ?? ""));
    return match && Number(match[1]) <= throughOrdinal && item.role;
  });
}

describe("versioned conversation summary storage acceptance", () => {
  beforeAll(async () => {
    if (!existsSync(adapterPath)) return;
    const module = await import(pathToFileURL(adapterPath).href);
    createConversationStoreAdapter = module.createConversationStoreAdapter;
  });

  beforeEach(() => {
    expect(
      typeof createConversationStoreAdapter,
      "producto ausente: expected runtime/conversation-store.ts#createConversationStoreAdapter",
    ).toBe("function");
  });

  it("exports the conversation store used for summary persistence", () => {
    expect(
      existsSync(adapterPath),
      "producto ausente: expected runtime/conversation-store.ts",
    ).toBe(true);
    expect(
      typeof createConversationStoreAdapter,
      "producto ausente: expected createConversationStoreAdapter",
    ).toBe("function");
  });

  it("admits summary, context, originals, document capture, SEND, META and quota atomically within DynamoDB limits", async () => {
    const meta = ownerMeta(24);
    const db = makeDatabase([meta]);
    const candidate = summaryVersion({
      text: `SUMMARY-START-${"s".repeat(420 * 1024)}-SUMMARY-END`,
      sourceReferences: Array.from({ length: 20 }, (_, index) => reference(index + 1)),
    });
    const recent = [21, 22, 23, 24].map(reference);
    const snapshot = contextSnapshot(candidate, recent);
    const input = continuationInput({
      summary: candidate,
      snapshot,
      refs: recent,
      query: `QUESTION-START-${"q".repeat(420 * 1024)}-QUESTION-END`,
      documents: documentContext(`DOCUMENT-START-${"d".repeat(420 * 1024)}-DOCUMENT-END`),
    });
    const store = makeStore(db.documentClient);

    await expect(store.continueTurn(input)).resolves.toMatchObject({
      queryId: input.queryId,
      ordinal: 25,
    });

    const writes = transactions(db.calls);
    expect(writes, "the summary must share the existing admission transaction").toHaveLength(1);
    const transaction = writes[0];
    const actions = transaction.input.TransactItems;
    const puts = writtenItems(transaction);
    const transactionJson = JSON.stringify(transaction.input);
    const metaAction = actions.find(
      (action) => action.Update?.Key?.sk === "META" || action.Put?.Item?.sk === "META",
    );
    const turn = puts.find((item) => item.queryId === input.queryId && item.ordinal === 25);
    const marker = puts.find((item) => item.sk === `SEND#${input.queryId}`);

    expect(metaAction, "META must move to the candidate in the winning transaction").toBeDefined();
    expect(JSON.stringify(metaAction)).toContain(candidate.summaryId);
    expect(turn, "the admitted turn must record the exact context version").toBeDefined();
    expect(turn.contextSnapshot).toEqual(snapshot);
    expect(marker).toMatchObject({
      pk: `USER#${owner.sub}#BOT#${owner.botId}`,
      sk: `SEND#${input.queryId}`,
      ...owner,
      conversationId,
      queryId: input.queryId,
      ordinal: 25,
    });
    expect(actions.some((action) => action.ConditionCheck?.Key?.sk === "QUOTA#POLICY")).toBe(true);
    expect(actions.some((action) => action.Update?.Key?.sk?.startsWith("USAGE#DAY#"))).toBe(true);
    expect(actions.some((action) => action.Update?.Key?.sk?.startsWith("USAGE#MONTH#"))).toBe(true);
    expect(
      actions
        .filter((action) => action.Put?.Item?.role === "user")
        .map(({ Put }) => Put.Item.text)
        .join(""),
    ).toBe(input.text);
    expect(transactionJson).toContain("SUMMARY-START-");
    expect(transactionJson).toContain("-SUMMARY-END");
    expect(transactionJson).toContain("DOCUMENT-START-");
    expect(transactionJson).toContain("-DOCUMENT-END");
    expect(transactionJson).toContain(candidate.sourceReferences[0].queryId);
    expect(transactionJson).toContain(candidate.sourceReferences.at(-1).queryId);
    expect(transactionJson).toContain("retrieve-summary-001");
    expect(db.calls.filter((command) => command instanceof TransactWriteCommand)).toHaveLength(1);
    expect(db.calls.some((command) => command.constructor.name === "PutCommand")).toBe(false);
    expect(db.calls.some((command) => command.constructor.name === "UpdateCommand")).toBe(false);

    expect(actions.length, "a transaction must stay within 100 actions").toBeLessThanOrEqual(100);
    expect(
      puts.every((item) => Buffer.byteLength(JSON.stringify(item), "utf8") < 400 * 1024),
      "each persisted item must stay below 400 KiB",
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(transaction.input), "utf8")).toBeLessThan(
      4 * 1024 * 1024,
    );
    expect(
      puts.some(
        (item) =>
          JSON.stringify(item).includes("SUMMARY-START-") &&
          JSON.stringify(item).includes("-SUMMARY-END"),
      ),
    ).toBe(false);
  });

  it("restores the current summary and only later complete pairs from a fresh adapter", async () => {
    const oldItems = [
      ownerMeta(24),
      ...Array.from({ length: 24 }, (_, index) => completedPair(index + 1)).flat(),
    ];
    const db = makeDatabase(oldItems);
    const candidate = summaryVersion();
    const recent = [21, 22, 23, 24].map(reference);
    const input = continuationInput({
      summary: candidate,
      snapshot: contextSnapshot(candidate, recent),
      refs: recent,
    });
    const firstStore = makeStore(db.documentClient);
    await firstStore.continueTurn(input);
    expect(
      summaryItem(db.records, candidate.summaryId),
      "producto ausente: the admitted summary version must be durable",
    ).toBeDefined();

    db.readQueryItems.length = 0;
    const freshStore = makeStore(db.documentClient);
    const context = await freshStore.readContext({ conversationId });

    expect(JSON.stringify(context.messages)).toContain("question-21");
    expect(JSON.stringify(context.messages)).toContain("answer-24");
    expect(JSON.stringify(context.messages)).not.toContain("question-1");
    expect(context.references).toEqual(recent);
    expect(context.summary).toMatchObject({
      version: 1,
      summaryId: candidate.summaryId,
      throughOrdinal: 20,
      sourceReferences: candidate.sourceReferences,
      text: candidate.text,
    });
    expect(
      usedArchiveRows(db.readQueryItems, 20),
      "readContext must not query originals covered by the summary",
    ).toEqual([]);

    const submission = await freshStore.getSubmission({ ...owner, queryId: input.queryId });
    expect(submission).toMatchObject({ contextSnapshot: input.contextSnapshot });
    expect(submission.contextReferences).toEqual(recent);
    expect(submission.summary).toMatchObject({
      summaryId: candidate.summaryId,
      text: candidate.text,
    });
  });

  it("rolls summaries forward with only new source references and leaves prior versions and originals intact", async () => {
    const firstSummary = summaryVersion({ summaryId: "summary-v1" });
    const oldTurns = Array.from({ length: 24 }, (_, index) => completedPair(index + 1)).flat();
    const db = makeDatabase([ownerMeta(24), ...oldTurns]);
    const firstRecent = [21, 22, 23, 24].map(reference);
    const firstInput = continuationInput({
      summary: firstSummary,
      snapshot: contextSnapshot(firstSummary, firstRecent),
      refs: firstRecent,
    });
    const store = makeStore(db.documentClient);
    await store.continueTurn(firstInput);
    const firstRecord = summaryItem(db.records, firstSummary.summaryId);
    expect(
      firstRecord,
      "producto ausente: summary v1 must be stored as an immutable version",
    ).toBeDefined();
    const firstRecordBefore = structuredClone(firstRecord);

    finishAdmittedTurn(db, firstInput, { status: "completed", answerText: "answer-25" });
    const beforeOriginals = [...db.records.values()]
      .filter(
        (item) => /^TURN#\d{8}(?:#|$)/.test(String(item.sk)) && Number(item.sk.slice(5, 13)) <= 25,
      )
      .sort((left, right) => left.sk.localeCompare(right.sk));

    const nextSummary = summaryVersion({
      summaryId: "summary-v2",
      throughOrdinal: 25,
      previousSummaryId: firstSummary.summaryId,
      sourceReferences: [21, 22, 23, 24, 25].map(reference),
      text: "Resumen v2 que conserva la versión anterior y las decisiones nuevas de los turnos 21 a 25.",
    });
    const nextInput = continuationInput({
      baseOrdinal: 25,
      summary: nextSummary,
      snapshot: contextSnapshot(nextSummary, []),
      refs: [],
      query: "Seguí desde el resumen actualizado.",
      documents: undefined,
    });
    await store.continueTurn(nextInput);

    const nextRecord = summaryItem(db.records, nextSummary.summaryId);
    expect(nextRecord).toMatchObject({
      version: 1,
      summaryId: nextSummary.summaryId,
      throughOrdinal: 25,
      previousSummaryId: firstSummary.summaryId,
      sourceReferences: [21, 22, 23, 24, 25].map(reference),
    });
    expect(nextRecord.sourceReferences.map((ref) => ref.ordinal)).not.toContain(1);
    expect(db.records.get(keyFor({ pk: firstRecord.pk, sk: firstRecord.sk }))).toEqual(
      firstRecordBefore,
    );
    expect(
      transactions(db.calls)
        .at(-1)
        .input.TransactItems.map((action) => JSON.stringify(action))
        .join("\n"),
    ).not.toContain(firstSummary.text);
    const afterOriginals = [...db.records.values()]
      .filter(
        (item) => /^TURN#\d{8}(?:#|$)/.test(String(item.sk)) && Number(item.sk.slice(5, 13)) <= 25,
      )
      .sort((left, right) => left.sk.localeCompare(right.sk));
    expect(afterOriginals).toEqual(beforeOriginals);

    const historicalSubmission = await store.getSubmission({
      ...owner,
      queryId: firstInput.queryId,
    });
    expect(historicalSubmission.contextSnapshot).toEqual(firstInput.contextSnapshot);
    expect(historicalSubmission.summary).toMatchObject({
      summaryId: firstSummary.summaryId,
      throughOrdinal: firstSummary.throughOrdinal,
      text: firstSummary.text,
    });
    expect(historicalSubmission.summary.summaryId).not.toBe(nextSummary.summaryId);
  });

  it("reuses the current summary by reference without writing a second copy", async () => {
    const candidate = summaryVersion({ summaryId: "existing-summary" });
    const db = makeDatabase([
      ownerMeta(24),
      ...Array.from({ length: 24 }, (_, index) => completedPair(index + 1)).flat(),
    ]);
    const recent = [21, 22, 23, 24].map(reference);
    const firstInput = continuationInput({
      summary: candidate,
      snapshot: contextSnapshot(candidate, recent),
      refs: recent,
    });
    const store = makeStore(db.documentClient);
    await store.continueTurn(firstInput);
    expect(
      summaryItem(db.records, candidate.summaryId),
      "reuse requires a durable current summary",
    ).toBeDefined();
    finishAdmittedTurn(db, firstInput, {
      status: "failed",
      answerText: "partial failed answer must not become confirmed context",
    });

    const input = continuationInput({
      baseOrdinal: 25,
      summary: null,
      snapshot: contextSnapshot(candidate, recent),
      refs: recent,
      documents: null,
    });

    await store.continueTurn(input);

    const transaction = transactions(db.calls).at(-1);
    const puts = writtenItems(transaction);
    const turn = puts.find((item) => item.queryId === input.queryId && item.ordinal === 26);
    expect(turn.contextSnapshot).toEqual(input.contextSnapshot);
    expect(puts.some((item) => item.summaryId === candidate.summaryId)).toBe(false);
    expect(JSON.stringify(transaction.input)).not.toContain(candidate.text);
    expect(transaction.input.TransactItems.length).toBeLessThanOrEqual(100);

    const context = await makeStore(db.documentClient).readContext({ conversationId });
    expect(context.summary).toMatchObject({ summaryId: candidate.summaryId, text: candidate.text });
    expect(context.references).toEqual(recent);
    expect(JSON.stringify(context.messages)).not.toContain("partial failed answer");
    const failedSubmission = await store.getSubmission({ ...owner, queryId: firstInput.queryId });
    expect(failedSubmission.contextSnapshot).toEqual(firstInput.contextSnapshot);
    expect(failedSubmission.summary).toMatchObject({
      summaryId: candidate.summaryId,
      text: candidate.text,
    });
  });

  it("rejects a completed turn that omits its current versioned context", async () => {
    const q2 = queryId(2);
    const missingSnapshot = completedPair(2, { contextReferences: [reference(1)] });
    delete missingSnapshot[0].contextSnapshot;
    const marker = {
      pk: `USER#${owner.sub}#BOT#${owner.botId}`,
      sk: `SEND#${q2}`,
      ...owner,
      conversationId,
      queryId: q2,
      requestFingerprint: "legacy-fingerprint",
      operation: "message",
      baseOrdinal: 1,
      ordinal: 2,
      admittedAt: now - 1000,
      resultDeadlineAt: now,
      quotaSnapshot: quota,
    };
    const db = makeDatabase([
      ownerMeta(2, { lastQueryId: q2 }),
      ...completedPair(1),
      ...missingSnapshot,
      marker,
    ]);
    const store = makeStore(db.documentClient);

    await expect(store.readContext({ conversationId })).rejects.toThrow(
      /context snapshot|context references/i,
    );
  });

  it.each([
    "missing version record",
    "missing text fragment",
    "wrong declared version",
    "invalid source reference",
    "summary identity mismatch",
  ])(
    "fails a declared summary instead of falling back to originals when it has %s",
    async (corruption) => {
      const candidate = summaryVersion({
        summaryId: `corrupt-${corruption.replaceAll(" ", "-")}`,
        ...(corruption === "missing text fragment"
          ? { text: `SUMMARY-CORRUPTION-START-${"s".repeat(420 * 1024)}-SUMMARY-CORRUPTION-END` }
          : {}),
      });
      const oldItems = [
        ownerMeta(24),
        ...Array.from({ length: 24 }, (_, index) => completedPair(index + 1)).flat(),
      ];
      const db = makeDatabase(oldItems);
      const recent = [21, 22, 23, 24].map(reference);
      const input = continuationInput({
        summary: candidate,
        snapshot: contextSnapshot(candidate, recent),
        refs: recent,
      });
      await makeStore(db.documentClient).continueTurn(input);
      const stored = summaryItem(db.records, candidate.summaryId);
      expect(stored, "producto ausente: declared summary version must be durable").toBeDefined();
      if (corruption === "missing version record") {
        db.records.delete(keyFor(stored));
      } else if (corruption === "missing text fragment") {
        const fragment = [...db.records.values()].find(
          (item) =>
            keyFor(item) !== keyFor(stored) && JSON.stringify(item).includes("s".repeat(1000)),
        );
        expect(fragment, "the fragmented summary must contain its source text").toBeDefined();
        db.records.delete(keyFor(fragment));
      } else if (corruption === "wrong declared version") {
        db.records.set(keyFor(stored), { ...stored, version: 2 });
      } else if (corruption === "invalid source reference") {
        db.records.set(keyFor(stored), {
          ...stored,
          sourceReferences: [reference(21), reference(21)],
        });
      } else {
        db.records.set(keyFor(stored), {
          ...stored,
          summaryId: "different-summary-than-declared",
        });
      }

      const reader = makeStore(db.documentClient);
      await expect(reader.readContext({ conversationId })).rejects.toBeInstanceOf(Error);
    },
  );

  it("rejects a submission marker that does not belong to the requested identity before reading its conversation", async () => {
    const qid = queryId(25);
    const foreignMarker = {
      pk: `USER#${owner.sub}#BOT#${owner.botId}`,
      sk: `SEND#${qid}`,
      sub: "another-teacher",
      botId: owner.botId,
      conversationId,
      queryId: qid,
      ordinal: 25,
    };
    const db = makeDatabase([], {
      get: (command) =>
        command.input.Key.sk === `SEND#${qid}` ? { Item: foreignMarker } : undefined,
    });

    await expect(
      makeStore(db.documentClient).getSubmission({ ...owner, queryId: qid }),
    ).rejects.toBeInstanceOf(Error);
    expect(db.calls.some((command) => command instanceof QueryCommand)).toBe(false);
  });

  it("does not publish a losing summary candidate after a conditional admission race", async () => {
    const base = ownerMeta(24);
    const advancedMeta = ownerMeta(25, {
      lastQueryId: queryId(25),
      activeQueryId: undefined,
      activeOwnerAttemptId: undefined,
    });
    let metaReads = 0;
    const collision = Object.assign(new Error("conditional transaction conflict"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
    const db = makeDatabase([base], {
      get: (command) => {
        if (command.input.Key.sk === "META") {
          metaReads += 1;
          return { Item: metaReads === 1 ? base : advancedMeta };
        }
        if (command.input.Key.sk === "QUOTA#POLICY") {
          return {
            Item: {
              pk: `BOT#${owner.botId}`,
              sk: "QUOTA#POLICY",
              dailyLimit: 20,
              monthlyLimit: 200,
              revision: quota.policyRevision,
            },
          };
        }
        if (command.input.Key.sk.startsWith("USAGE#")) {
          return { Item: { ...command.input.Key, used: 4 } };
        }
        return undefined;
      },
      transaction: async () => {
        throw collision;
      },
    });
    const loser = summaryVersion({
      summaryId: "summary-loser",
      throughOrdinal: 24,
      sourceReferences: Array.from({ length: 24 }, (_, index) => reference(index + 1)),
      text: "candidate that must not become durable",
    });
    const input = continuationInput({
      summary: loser,
      snapshot: contextSnapshot(loser, []),
      refs: [],
      documents: undefined,
    });

    await expect(makeStore(db.documentClient).continueTurn(input)).rejects.toMatchObject({
      code: "stale_base",
    });
    expect(transactions(db.calls)).toHaveLength(1);
    expect([...db.records.values()].some((item) => item.summaryId === loser.summaryId)).toBe(false);
    expect([...db.records.values()].some((item) => item.text === loser.text)).toBe(false);
  });

  it("rejects a combined summary, references, document capture and question over 4 MiB before sending a transaction", async () => {
    const db = makeDatabase([ownerMeta(24)]);
    const candidate = summaryVersion({
      text: `SUMMARY-${"s".repeat(1450 * 1024)}`,
      sourceReferences: Array.from({ length: 20 }, (_, index) => reference(index + 1)),
    });
    const refs = [21, 22, 23, 24].map(reference);
    const input = continuationInput({
      summary: candidate,
      snapshot: contextSnapshot(candidate, refs),
      refs,
      query: `QUESTION-${"q".repeat(1450 * 1024)}`,
      documents: documentContext(`DOCUMENT-${"d".repeat(1450 * 1024)}`),
    });

    await expect(makeStore(db.documentClient).continueTurn(input)).rejects.toMatchObject({
      code: "storage_capacity_exceeded",
    });
    expect(transactions(db.calls), "capacity must be checked before the atomic write").toHaveLength(
      0,
    );
  });
});
