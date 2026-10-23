import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const adapterPath = path.join(projectRoot, "runtime/conversation-store.ts");
const tableName = "conversations-aurora-dev";
const conversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const queryId = "a4bfbc9f-3699-4e93-b120-a03c0204bc67";
const continuationId = "fcdd5a71-b6db-4ad9-a2c3-934cb56fe749";
const owner = { sub: "teacher-123", botId: "bot-aurora" };
const now = Date.parse("2026-10-19T16:00:00.000Z");
const profileSnapshot = {
  sub: owner.sub,
  botId: owner.botId,
  fields: {
    educationLevels: [{ id: "secundario", label: "Secundario" }],
    subjects: ["Matemática"],
  },
  responsePreferenceIds: ["ready-material"],
  promptTexts: ["Incluí materiales completos y listos para usar."],
  updatedAt: "2026-10-18T12:00:00.000Z",
  configurationRevision: "reviewed-revision-123",
};

let createConversationStoreAdapter;

function makeStore() {
  const records = new Map();
  const keyFor = ({ pk, sk }) => `${pk}\u0000${sk}`;
  const send = vi.fn(async (command) => {
    if (command instanceof GetCommand) {
      return { Item: records.get(keyFor(command.input.Key)) };
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues ?? {};
      const items = [...records.values()].filter((item) => item.pk === values[":pk"]);
      const prefix = values[":prefix"];
      return {
        Items: items
          .filter((item) => !prefix || item.sk.startsWith(prefix))
          .sort((left, right) => left.sk.localeCompare(right.sk)),
      };
    }
    if (command instanceof TransactWriteCommand) {
      for (const action of command.input.TransactItems) {
        if (action.Put?.Item) records.set(keyFor(action.Put.Item), action.Put.Item);
      }
      return {};
    }
    throw new Error(`unexpected DynamoDB command ${command?.constructor?.name}`);
  });
  const documentClient = { send };
  return {
    documentClient,
    records,
    store: createConversationStoreAdapter({ documentClient, tableName, now: () => now }),
  };
}

function startInput(overrides = {}) {
  return {
    ...owner,
    conversationId,
    queryId,
    now,
    ownerAttemptId: "attempt-admitted",
    resultDeadlineAt: now + 60 * 60 * 1000,
    text: "Armá una actividad de porcentajes.",
    profileSnapshot,
    invocation: {
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "reviewed-revision-123",
    },
    quota: {
      daily: {
        used: 4,
        limit: 20,
        resetAt: Date.parse("2026-10-20T03:00:00.000Z"),
        period: "2026-10-19",
      },
      monthly: {
        used: 37,
        limit: 200,
        resetAt: Date.parse("2026-11-01T03:00:00.000Z"),
        period: "2026-10",
      },
      serverNow: now,
      blockedUntil: null,
      policyRevision: "policy-r7",
    },
    requestFingerprint: "sha256:stable-request-fingerprint",
    ...overrides,
  };
}

function documentContext(overrides = {}) {
  return {
    knowledgeBaseId: "kb-docentes-dev",
    query: "Porcentajes para segundo año",
    revision: "documents-r14",
    retrievedAt: "2026-10-19T16:00:00.000Z",
    status: "results",
    results: [
      {
        text: "Una proporción compara dos cantidades mediante una razón equivalente.",
        location: { type: "S3", uri: "s3://internal-docs/porcentajes.pdf" },
        metadata: { documentId: "porcentajes-01", subject: "Matemática" },
        score: 0.91,
      },
    ],
    requestId: "retrieve-request-17",
    ...overrides,
  };
}

function transactionCommands(documentClient) {
  return documentClient.send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof TransactWriteCommand);
}

function turnRecord(records, ordinal) {
  return [...records.values()].find(
    (item) =>
      item.pk === `CONV#${conversationId}` &&
      item.sk === `TURN#${String(ordinal).padStart(8, "0")}`,
  );
}

describe("document context in the DynamoDB conversation store", () => {
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

  it("admits the exact document capture with the question, turn, marker, and existing quota updates", async () => {
    const { documentClient, store, records } = makeStore();
    const capture = documentContext();

    await expect(store.startTurn(startInput({ documentContext: capture }))).resolves.toMatchObject({
      queryId,
      ordinal: 1,
    });

    const transactions = transactionCommands(documentClient);
    expect(transactions).toHaveLength(1);
    const actions = transactions[0].input.TransactItems;
    const written = actions.flatMap((action) => (action.Put?.Item ? [action.Put.Item] : []));
    const marker = written.find((item) => item.sk === `SEND#${queryId}`);
    expect(marker).toMatchObject({
      pk: `USER#${owner.sub}#BOT#${owner.botId}`,
      sk: `SEND#${queryId}`,
      ...owner,
      conversationId,
      queryId,
      requestFingerprint: "sha256:stable-request-fingerprint",
    });
    expect(written).toEqual(expect.arrayContaining([expect.objectContaining({ sk: "META" })]));
    expect(written).toEqual(
      expect.arrayContaining([expect.objectContaining({ queryId, profileSnapshot })]),
    );
    expect(actions.some(({ Update }) => Update?.Key?.sk?.startsWith("USAGE#DAY#"))).toBe(true);
    expect(actions.some(({ Update }) => Update?.Key?.sk?.startsWith("USAGE#MONTH#"))).toBe(true);
    expect(actions.every((action) => !action.Put || action.Put.TableName === tableName)).toBe(true);

    const snapshot = await store.getSubmission({ ...owner, queryId });
    expect(snapshot?.documentContext).toEqual(capture);
    expect(snapshot).toMatchObject({ question: "Armá una actividad de porcentajes.", ordinal: 1 });
    expect(records.size).toBeGreaterThan(4);
  });

  it("captures an empty successful retrieval distinctly from a legacy turn with no document manifest", async () => {
    const emptyStore = makeStore();
    const emptyCapture = documentContext({ status: "empty", results: [] });
    await emptyStore.store.startTurn(startInput({ documentContext: emptyCapture }));
    const emptySnapshot = await emptyStore.store.getSubmission({ ...owner, queryId });
    expect(emptySnapshot?.documentContext).toEqual(emptyCapture);

    const legacyStore = makeStore();
    await legacyStore.store.startTurn(startInput());
    const legacySnapshot = await legacyStore.store.getSubmission({ ...owner, queryId });
    expect(legacySnapshot).not.toHaveProperty("documentContext");
    expect(turnRecord(legacyStore.records, 1)).not.toHaveProperty("documentContextManifest");
  });

  it("stores each continuation's own document capture with its exact context references", async () => {
    const { store, records } = makeStore();
    records.set(`CONV#${conversationId}\u0000META`, {
      pk: `CONV#${conversationId}`,
      sk: "META",
      conversationId,
      ...owner,
      lastOrdinal: 1,
      lastQueryId: queryId,
      closed: false,
    });
    records.set(`CONV#${conversationId}\u0000TURN#00000001`, {
      pk: `CONV#${conversationId}`,
      sk: "TURN#00000001",
      conversationId,
      ...owner,
      queryId,
      ordinal: 1,
      status: "completed",
      phase: "complete",
      questionManifest: { count: 1, complete: true },
      answerManifest: { count: 1, complete: true },
      contextManifest: { count: 0, complete: true },
      cursor: 1,
    });
    const capture = documentContext({
      query: "Qué plantea la segunda explicación sobre porcentajes",
      revision: "documents-r15",
      results: [
        {
          text: "La segunda propuesta inicia con equivalencias y representaciones visuales.",
          location: { type: "S3", uri: "s3://internal-docs/representaciones.pdf" },
          metadata: { documentId: "representaciones-02" },
          score: 0.84,
        },
      ],
    });
    await store.continueTurn(
      startInput({
        queryId: continuationId,
        text: "¿Qué plantea la segunda explicación?",
        documentContext: capture,
        requestFingerprint: "sha256:continuation-fingerprint",
        ownerAttemptId: "attempt-continuation",
        expectedLastOrdinal: 1,
        contextReferences: [{ ordinal: 1, queryId }],
      }),
    );

    const snapshot = await store.getSubmission({ ...owner, queryId: continuationId });
    expect(snapshot?.ordinal).toBe(2);
    expect(snapshot?.contextReferences).toEqual([{ ordinal: 1, queryId }]);
    expect(snapshot?.documentContext).toEqual(capture);
  });

  it("fragments a large document capture across transaction items and reconstructs it exactly", async () => {
    const { documentClient, store } = makeStore();
    const capture = documentContext({
      results: [
        {
          text: "x".repeat(1200 * 1024),
          location: { type: "S3", uri: "s3://internal-docs/large.txt" },
          metadata: { documentId: "large" },
          score: 0.9,
        },
      ],
    });

    await store.startTurn(startInput({ documentContext: capture }));

    const transactions = transactionCommands(documentClient);
    expect(transactions).toHaveLength(1);
    const puts = transactions[0].input.TransactItems.flatMap((action) =>
      action.Put?.Item ? [action.Put.Item] : [],
    );
    const documentPayloadItems = puts.filter((item) =>
      JSON.stringify(item).includes("x".repeat(1000)),
    );
    expect(documentPayloadItems.length).toBeGreaterThan(1);
    expect(
      puts.every((item) => Buffer.byteLength(JSON.stringify(item), "utf8") <= 400 * 1024),
    ).toBe(true);

    const snapshot = await store.getSubmission({ ...owner, queryId });
    expect(snapshot?.documentContext).toEqual(capture);
  });

  it("fails recovery when a declared document manifest has a missing fragment", async () => {
    const { store, records } = makeStore();
    await store.startTurn(startInput({ documentContext: documentContext() }));

    const turn = turnRecord(records, 1);
    expect(turn?.documentContextManifest).toEqual(
      expect.objectContaining({ count: expect.any(Number), complete: true }),
    );
    if (!turn?.documentContextManifest) return;
    turn.documentContextManifest.count += 1;

    await expect(store.getSubmission({ ...owner, queryId })).rejects.toThrow(
      /document|manifest|fragment/i,
    );
  });

  it("rejects document payloads that exceed the transaction budget without staging or partial admission", async () => {
    const { documentClient, store } = makeStore();
    const oversized = documentContext({
      results: [
        {
          text: "x".repeat(4 * 1024 * 1024),
          location: { type: "S3", uri: "s3://internal-docs/large.txt" },
          metadata: { documentId: "large" },
          score: 0.9,
        },
      ],
    });

    await expect(store.startTurn(startInput({ documentContext: oversized }))).rejects.toMatchObject(
      {
        code: "storage_capacity_exceeded",
      },
    );
    expect(transactionCommands(documentClient)).toHaveLength(0);
    expect(
      documentClient.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand),
    ).toBe(false);
  });
});
