import {
  GetCommand,
  DeleteCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  phase11BotId,
  phase11CommandRecorder,
  phase11Now,
  phase11Operation,
} from "../support/phase11-documents-backend.mjs";

const tableName = "documents-docentes";
const operationId = "operation-1";
const documentId = "document-1";

async function loadStore() {
  const module = await import("../../api/document-store.ts");
  expect(
    typeof module.createDocumentStore,
    "Expected the production api/document-store.ts#createDocumentStore adapter",
  ).toBe("function");
  return module.createDocumentStore;
}

function expanded(command, property) {
  const names = command.input.ExpressionAttributeNames || {};
  return (command.input[property] || "").replace(/#[a-zA-Z0-9_]+/g, (name) => names[name] || name);
}

function transactionOf(commands) {
  const command = commands.find((entry) => entry instanceof TransactWriteCommand);
  expect(
    command,
    "Expected one DynamoDB transaction for the conditional store operation",
  ).toBeTruthy();
  return command;
}

function transactWrites(command) {
  return command.input.TransactItems.flatMap((item) => {
    if (item.Put) return [{ kind: "Put", ...item.Put }];
    if (item.Update) return [{ kind: "Update", ...item.Update }];
    if (item.Delete) return [{ kind: "Delete", ...item.Delete }];
    if (item.ConditionCheck) return [{ kind: "ConditionCheck", ...item.ConditionCheck }];
    return [];
  });
}

function writesFrom(commands) {
  return commands.flatMap((command) => {
    if (command instanceof PutCommand) return [{ kind: "Put", ...command.input }];
    if (command instanceof UpdateCommand) return [{ kind: "Update", ...command.input }];
    if (command instanceof DeleteCommand) return [{ kind: "Delete", ...command.input }];
    if (command instanceof TransactWriteCommand) return transactWrites(command);
    return [];
  });
}

function conditionSummary(write) {
  return `${expanded({ input: write }, "ConditionExpression")} ${JSON.stringify(
    write.ExpressionAttributeValues || {},
  )}`;
}

describe("document DynamoDB store acceptance", () => {
  it("lists only document rows by bot and sort-key prefix, using an opaque continuation cursor", async () => {
    const document = {
      pk: `BOT#${phase11BotId}`,
      sk: "DOCUMENT#document-1",
      documentId,
      state: "active",
      name: "lesson.txt",
      sizeBytes: 20,
      revision: "revision-1",
      pendingRemovalKeys: [],
      canReplace: true,
      updatedAt: phase11Now,
      processing: { status: "completed", operationId },
    };
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof QueryCommand) {
        return {
          Items: [document],
          LastEvaluatedKey: { pk: document.pk, sk: document.sk },
        };
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });

    const page = await store.listDocuments({ cursor: null, limit: 1 });
    const followingPage = await store.listDocuments({ cursor: page.nextCursor, limit: 1 });

    const queries = recorder.commands.filter((command) => command instanceof QueryCommand);
    const query = queries[0];
    expect(query).toBeTruthy();
    expect(recorder.commands.some((command) => command instanceof ScanCommand)).toBe(false);
    expect(expanded(query, "KeyConditionExpression")).toMatch(/pk.*begins_with\(sk/);
    expect(JSON.stringify(query.input.ExpressionAttributeValues)).toContain(`BOT#${phase11BotId}`);
    expect(JSON.stringify(query.input.ExpressionAttributeValues)).toContain("DOCUMENT#");
    expect(query.input.Limit).toBe(1);
    expect(page.documents).toMatchObject([{ documentId, name: "lesson.txt", sizeBytes: 20 }]);
    expect(typeof page.documents[0].updatedAt).toBe("string");
    expect(typeof page.nextCursor).toBe("string");
    expect(page.documents[0]).not.toHaveProperty("sourceUri");
    expect(page.documents[0]).not.toHaveProperty("uploadUrl");
    expect(queries).toHaveLength(2);
    expect(queries[1].input.ExclusiveStartKey).toEqual({ pk: document.pk, sk: document.sk });
    expect(followingPage.documents).toHaveLength(1);
  });

  it("omits withdrawn tombstones from current documents while preserving the last withdrawal result", async () => {
    const botPartition = `BOT#${phase11BotId}`;
    const active = {
      pk: botPartition,
      sk: "DOCUMENT#document-active",
      documentId: "document-active",
      state: "active",
      name: "lesson-current.txt",
      sizeBytes: 20,
      revision: "revision-5",
      pendingRemovalKeys: [],
      canReplace: true,
      updatedAt: phase11Now,
      processing: { status: "completed", operationId: "upload-current" },
    };
    const pendingCleanup = {
      pk: botPartition,
      sk: "DOCUMENT#document-pending-cleanup",
      documentId: "document-pending-cleanup",
      state: "active",
      name: "lesson-pending.txt",
      sizeBytes: 22,
      revision: "revision-6",
      pendingRemovalKeys: ["prepared/document-pending-cleanup/old/orphan.txt"],
      updatedAt: phase11Now,
      processing: { status: "failed", operationId: "replace-partial" },
    };
    const withdrawn = {
      pk: botPartition,
      sk: "DOCUMENT#document-withdrawn",
      documentId: "document-withdrawn",
      state: "withdrawn",
      name: "lesson-retired.txt",
      sizeBytes: 18,
      revision: "revision-4",
      pendingRemovalKeys: [],
      updatedAt: phase11Now - 1,
      lastOperationId: "withdraw-4",
    };
    const lastOperation = {
      pk: botPartition,
      sk: "OPERATION#withdraw-4",
      operationId: "withdraw-4",
      documentId: "document-withdrawn",
      action: "withdraw",
      status: "completed",
      stage: "result",
      revision: "revision-4",
      updatedAt: phase11Now,
      canRetry: false,
    };
    const control = {
      pk: botPartition,
      sk: "CONTROL",
      lastOperationId: "withdraw-4",
    };
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof QueryCommand) return { Items: [withdrawn, active, pendingCleanup] };
      if (command instanceof GetCommand) {
        const item = command.input.Key.sk === "CONTROL" ? control : lastOperation;
        return { Item: item };
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });

    const page = await store.listDocuments({ cursor: null, limit: 10 });

    expect(page.documents.map(({ documentId }) => documentId)).toEqual([
      "document-active",
      "document-pending-cleanup",
    ]);
    expect(page.documents[0]).toMatchObject({ canReplace: true });
    expect(page.documents[1]).toMatchObject({ canReplace: false });
    expect(page.lastOperation).toMatchObject({
      operationId: "withdraw-4",
      documentId: "document-withdrawn",
      action: "withdraw",
      status: "completed",
    });
  });

  it("creates one durable intent with a canonical fingerprint and rejects a reused ID with different input", async () => {
    const rows = new Map();
    const createdKeys = [];
    let createWriteCount = 0;
    const getRow = (table, key) => rows.get(`${table}\u0000${key.pk}\u0000${key.sk}`);
    const putRow = (table, item) => rows.set(`${table}\u0000${item.pk}\u0000${item.sk}`, item);
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof GetCommand) {
        const Item = getRow(command.input.TableName, command.input.Key);
        return Item ? { Item } : {};
      }
      if (command instanceof PutCommand || command instanceof TransactWriteCommand) {
        createWriteCount += 1;
        const items =
          command instanceof PutCommand
            ? [{ TableName: command.input.TableName, Item: command.input.Item }]
            : command.input.TransactItems.flatMap((entry) => (entry.Put ? [entry.Put] : []));
        createdKeys.push(items.map((entry) => entry.Item.sk));
        if (createWriteCount > 1) {
          throw Object.assign(new Error("Conditional write was not applied"), {
            name:
              command instanceof PutCommand
                ? "ConditionalCheckFailedException"
                : "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          });
        }
        for (const entry of items) putRow(entry.TableName, entry.Item);
        return {};
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });
    const firstInput = {
      operationId,
      action: "upload",
      actorSub: "admin-sub",
      tokenExpiresAt: phase11Now + 60_000,
      file: { name: "lesson.txt", sizeBytes: 12, sha256: "a".repeat(64) },
      uploadKey: "incoming/operation-1/lesson.txt",
      candidateRevision: "revision-1",
    };

    const created = await store.createIntent(firstInput);
    const replayed = await store.createIntent({
      ...firstInput,
      actorSub: "admin-sub-rotated",
      tokenExpiresAt: phase11Now + 20_000,
    });

    expect(created.operation.operationId).toBe(operationId);
    expect(replayed.operation).toEqual(created.operation);
    expect(replayed.created).toBe(false);
    expect(created.operation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(recorder.commands.some((command) => command instanceof ScanCommand)).toBe(false);
    expect(createdKeys.flat()).toContain(`OPERATION#${operationId}`);
    await expect(
      store.createIntent({
        ...firstInput,
        file: { ...firstInput.file, sha256: "b".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "STATE_CHANGED" });
    expect(createWriteCount).toBe(1);
  });

  it("reserves the bot only when a reprocess still sees the expected document revision", async () => {
    const operation = {
      pk: `BOT#${phase11BotId}`,
      sk: `OPERATION#${operationId}`,
      ...phase11Operation({
        operationId,
        documentId,
        action: "reprocess",
        status: "pending_start",
        revision: "revision-0",
        expectedRevision: "revision-0",
      }),
    };
    const document = {
      pk: `BOT#${phase11BotId}`,
      sk: `DOCUMENT#${documentId}`,
      documentId,
      state: "active",
      revision: "revision-0",
      updatedAt: phase11Now,
      source: {
        status: "confirmed",
        bucket: "prepared-docentes",
        key: "prepared/document-1/revision-0/lesson.txt",
        uri: "s3://prepared-docentes/prepared/document-1/revision-0/lesson.txt",
        sizeBytes: 20,
        sha256: "a".repeat(64),
      },
      pendingRemovalKeys: [],
    };
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof GetCommand) {
        if (command.input.Key.sk === `OPERATION#${operationId}`) return { Item: operation };
        if (command.input.Key.sk === `DOCUMENT#${documentId}`) return { Item: document };
        if (command.input.Key.sk === "CONTROL") {
          return { Item: { pk: `BOT#${phase11BotId}`, sk: "CONTROL" } };
        }
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });
    const executionInput = { botId: phase11BotId, operationId, step: "validate" };

    await store.reserveOperation({
      operationId,
      documentId,
      action: "reprocess",
      expectedRevision: "revision-0",
      executionName: "docentes-operation-1",
      executionInput: { ...executionInput, step: "promote" },
    });

    const transaction = transactionOf(recorder.commands);
    const writes = transactWrites(transaction);
    const expressions = writes.map(conditionSummary).join("\n");
    const serialized = JSON.stringify(writes);
    expect(transaction.input.TransactItems.length).toBeGreaterThanOrEqual(2);
    expect(
      writes.some((write) => JSON.stringify(write.Key || write.Item).includes("CONTROL")),
    ).toBe(true);
    expect(expressions).toMatch(/attribute_not_exists|operationId|owner/i);
    expect(expressions).toContain("revision-0");
    expect(serialized).toContain("docentes-operation-1");
    expect(serialized).toContain(JSON.stringify({ ...executionInput, step: "promote" }));
    expect(serialized).not.toContain("expiresAt");
    expect(JSON.stringify(transaction.input)).toContain(`BOT#${phase11BotId}`);
    const operationUpdate = writes.find((write) =>
      JSON.stringify(write.Key).includes(`OPERATION#${operationId}`),
    );
    const documentUpdate = writes.find((write) =>
      JSON.stringify(write.Key).includes(`DOCUMENT#${documentId}`),
    );
    expect(operationUpdate.UpdateExpression).not.toContain("candidateKey");
    expect(JSON.stringify(operationUpdate.ExpressionAttributeValues)).not.toContain('"candidate"');
    expect(documentUpdate.ConditionExpression).toContain("#source.#sourceStatus");
  });

  it("stores a new upload's candidate key before the worker can promote the object", async () => {
    const operation = {
      pk: `BOT#${phase11BotId}`,
      sk: `OPERATION#${operationId}`,
      ...phase11Operation({
        operationId,
        documentId,
        action: "upload",
        status: "awaiting_upload",
      }),
    };
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof GetCommand) {
        if (command.input.Key.sk === `OPERATION#${operationId}`) return { Item: operation };
        if (command.input.Key.sk === "CONTROL") {
          return { Item: { pk: `BOT#${phase11BotId}`, sk: "CONTROL" } };
        }
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });

    await store.reserveOperation({
      operationId,
      documentId,
      action: "upload",
      expectedRevision: null,
      candidateRevision: "revision-1",
      candidateKey: "prepared/document-1/revision-1/lesson.txt",
      executionName: "docentes-operation-1",
      executionInput: { botId: phase11BotId, operationId, step: "validate" },
    });

    const transaction = transactionOf(recorder.commands);
    const writes = transactWrites(transaction);
    expect(JSON.stringify(writes)).toContain("prepared/document-1/revision-1/lesson.txt");
    expect(JSON.stringify(transaction.input)).toContain(`BOT#${phase11BotId}`);
    expect(writes.map(conditionSummary).join("\n")).toMatch(/attribute_not_exists|revision/i);
  });

  it("guards a replace reservation against pending removals that appear after the read", async () => {
    const operation = {
      pk: `BOT#${phase11BotId}`,
      sk: `OPERATION#${operationId}`,
      ...phase11Operation({
        operationId,
        documentId,
        action: "replace",
        status: "awaiting_upload",
        expectedRevision: "revision-0",
      }),
    };
    const document = {
      pk: `BOT#${phase11BotId}`,
      sk: `DOCUMENT#${documentId}`,
      documentId,
      state: "active",
      revision: "revision-0",
      updatedAt: phase11Now,
      source: {
        status: "confirmed",
        bucket: "prepared-docentes",
        key: "prepared/document-1/revision-0/lesson.txt",
        uri: "s3://prepared-docentes/prepared/document-1/revision-0/lesson.txt",
        sizeBytes: 20,
        sha256: "a".repeat(64),
      },
      pendingRemovalKeys: [],
    };
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof GetCommand) {
        if (command.input.Key.sk === `OPERATION#${operationId}`) return { Item: operation };
        if (command.input.Key.sk === `DOCUMENT#${documentId}`) return { Item: document };
        if (command.input.Key.sk === "CONTROL") {
          return { Item: { pk: `BOT#${phase11BotId}`, sk: "CONTROL" } };
        }
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });

    await store.reserveOperation({
      operationId,
      documentId,
      action: "replace",
      expectedRevision: "revision-0",
      candidateRevision: "revision-1",
      candidateKey: "prepared/document-1/revision-1/lesson.txt",
      executionName: "docentes-operation-1",
      executionInput: { botId: phase11BotId, operationId, step: "validate" },
    });

    const transaction = transactionOf(recorder.commands);
    const documentUpdate = transactWrites(transaction).find((write) =>
      JSON.stringify(write.Key).includes(`DOCUMENT#${documentId}`),
    );
    expect(documentUpdate.ConditionExpression).toContain("size(#pendingKeys)");
    expect(documentUpdate.ConditionExpression).toContain("attribute_not_exists(#pendingKeys)");
    expect(documentUpdate.ExpressionAttributeValues[":emptyList"]).toBe(0);
  });

  it("records source:null without marking the document withdrawn before sync confirmation", async () => {
    const operationId = "withdraw-7";
    const documentKey = { pk: `BOT#${phase11BotId}`, sk: `DOCUMENT#${documentId}` };
    const operationKey = { pk: `BOT#${phase11BotId}`, sk: `OPERATION#${operationId}` };
    const operation = {
      ...operationKey,
      operationId,
      documentId,
      action: "withdraw",
      status: "processing",
      revision: "revision-3",
      updatedAt: phase11Now,
    };
    const document = {
      ...documentKey,
      documentId,
      state: "active",
      revision: "revision-3",
      updatedAt: phase11Now,
      source: { bucket: "prepared-docentes", key: "prepared/document-1/revision-3/lesson.txt" },
      pendingRemovalKeys: ["prepared/document-1/revision-2/old.txt"],
      name: "lesson.txt",
      sizeBytes: 10,
    };
    const control = {
      pk: `BOT#${phase11BotId}`,
      sk: "CONTROL",
      activeOperationId: operationId,
    };
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof GetCommand) {
        const bySortKey = {
          CONTROL: control,
          [`OPERATION#${operationId}`]: operation,
          [`DOCUMENT#${documentId}`]: document,
        };
        const Item = bySortKey[command.input.Key.sk];
        return Item ? { Item } : {};
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });

    await store.recordSource({
      operationId,
      source: null,
      pendingRemovalKeys: [],
    });

    const writes = writesFrom(recorder.commands);
    const documentWrite = writes.find((write) =>
      JSON.stringify(write.Key || write.Item).includes(`DOCUMENT#${documentId}`),
    );
    expect(documentWrite).toBeTruthy();
    expect(writes.some((write) => write.kind === "Delete")).toBe(false);
    expect(JSON.stringify(documentWrite)).not.toContain("withdrawn");
    expect(JSON.stringify(documentWrite)).toContain("revision-3");
    expect(JSON.stringify(documentWrite)).toContain("pendingRemovalKeys");
    expect(
      writes.some(
        (write) =>
          JSON.stringify(write.Key || write.Item).includes("CONTROL") &&
          conditionSummary(write).includes(operationId),
      ),
    ).toBe(true);
  });

  it("creates a durable withdrawn tombstone only when the withdrawal result completes", async () => {
    const operationId = "withdraw-completed-8";
    const documentKey = { pk: `BOT#${phase11BotId}`, sk: `DOCUMENT#${documentId}` };
    const operationKey = { pk: `BOT#${phase11BotId}`, sk: `OPERATION#${operationId}` };
    const operation = {
      ...operationKey,
      operationId,
      documentId,
      action: "withdraw",
      status: "processing",
      revision: "revision-8",
      sourceUrisToObserve: ["s3://prepared-docentes/prepared/document-1/revision-8/current.txt"],
      updatedAt: phase11Now,
    };
    const document = {
      ...documentKey,
      documentId,
      state: "active",
      revision: "revision-8",
      updatedAt: phase11Now,
      source: null,
      pendingRemovalKeys: [],
      name: "lesson.txt",
      sizeBytes: 10,
    };
    const control = {
      pk: `BOT#${phase11BotId}`,
      sk: "CONTROL",
      activeOperationId: operationId,
    };
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof GetCommand) {
        const bySortKey = {
          CONTROL: control,
          [`OPERATION#${operationId}`]: operation,
          [`DOCUMENT#${documentId}`]: document,
        };
        const Item = bySortKey[command.input.Key.sk];
        return Item ? { Item } : {};
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });

    await store.finishOperation({
      operationId,
      outcome: "completed",
      operation: {
        ...phase11Operation({
          operationId,
          documentId,
          action: "withdraw",
          status: "completed",
          stage: "result",
          revision: "revision-8",
        }),
        sourceUrisToObserve: operation.sourceUrisToObserve,
      },
    });

    const writes = writesFrom(recorder.commands);
    const documentWrite = writes.find((write) =>
      JSON.stringify(write.Key || write.Item).includes(`DOCUMENT#${documentId}`),
    );
    expect(documentWrite).toBeTruthy();
    expect(writes.some((write) => write.kind === "Delete")).toBe(false);
    expect(JSON.stringify(documentWrite)).toContain("withdrawn");
    expect(JSON.stringify(documentWrite)).toContain("revision-8");
    expect(documentWrite.ExpressionAttributeNames["#last"]).toBe("lastOperationId");
    expect(documentWrite.ExpressionAttributeValues[":last"]).toBe(operationId);
  });

  it("retains the removal receipt and active row when the withdrawal sync fails", async () => {
    const operationId = "withdraw-failed-9";
    const uri = "s3://prepared-docentes/prepared/document-1/revision-9/lesson.txt";
    const operationKey = { pk: `BOT#${phase11BotId}`, sk: `OPERATION#${operationId}` };
    const operation = {
      ...operationKey,
      operationId,
      documentId,
      action: "withdraw",
      status: "processing",
      revision: "revision-9",
      sourceUrisToObserve: [uri],
      updatedAt: phase11Now,
    };
    const document = {
      pk: `BOT#${phase11BotId}`,
      sk: `DOCUMENT#${documentId}`,
      documentId,
      state: "active",
      revision: "revision-9",
      updatedAt: phase11Now,
      source: null,
      pendingRemovalKeys: [],
      name: "lesson.txt",
      sizeBytes: 10,
    };
    const control = {
      pk: `BOT#${phase11BotId}`,
      sk: "CONTROL",
      activeOperationId: operationId,
    };
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof GetCommand) {
        const bySortKey = {
          CONTROL: control,
          [`OPERATION#${operationId}`]: operation,
          [`DOCUMENT#${documentId}`]: document,
        };
        const Item = bySortKey[command.input.Key.sk];
        return Item ? { Item } : {};
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });

    await store.finishOperation({
      operationId,
      outcome: "failed",
      operation: {
        ...phase11Operation({
          operationId,
          documentId,
          action: "withdraw",
          status: "failed",
          stage: "result",
          revision: "revision-9",
        }),
        sourceUrisToObserve: [uri],
      },
    });

    const writes = writesFrom(recorder.commands);
    expect(writes.some((write) => write.kind === "Delete")).toBe(false);
    const documentWrite = writes.find((write) =>
      JSON.stringify(write.Key || write.Item).includes(`DOCUMENT#${documentId}`),
    );
    if (documentWrite) expect(JSON.stringify(documentWrite)).not.toContain("withdrawn");
    expect(JSON.stringify(writes)).toContain(uri);
    expect(JSON.stringify(writes)).toContain(`OPERATION#${operationId}`);
  });

  it("reserves the withdrawal URI receipt under the expected revision and active owner before worker effects", async () => {
    const operationId = "withdraw-receipt-1";
    const sourceUrisToObserve = [
      "s3://prepared-docentes/prepared/document-1/revision-3/current.txt",
      "s3://prepared-docentes/prepared/document-1/revision-2/pending-a.txt",
      "s3://prepared-docentes/prepared/document-1/revision-1/pending-b.txt",
    ];
    const operation = {
      pk: `BOT#${phase11BotId}`,
      sk: `OPERATION#${operationId}`,
      operationId,
      documentId,
      action: "withdraw",
      status: "pending_start",
      expectedRevision: "revision-9",
      revision: "revision-9",
      updatedAt: phase11Now,
    };
    const document = {
      pk: `BOT#${phase11BotId}`,
      sk: `DOCUMENT#${documentId}`,
      documentId,
      state: "active",
      revision: "revision-9",
      updatedAt: phase11Now,
      pendingRemovalKeys: [],
    };
    const control = { pk: `BOT#${phase11BotId}`, sk: "CONTROL" };
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof GetCommand) {
        const bySortKey = {
          CONTROL: control,
          [`OPERATION#${operationId}`]: operation,
          [`DOCUMENT#${documentId}`]: document,
        };
        const Item = bySortKey[command.input.Key.sk];
        return Item ? { Item } : {};
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });

    await store.reserveOperation({
      operationId,
      documentId,
      action: "withdraw",
      expectedRevision: "revision-9",
      sourceUrisToObserve,
      executionName: "docentes-withdraw-receipt-1",
      executionInput: { botId: phase11BotId, operationId, step: "promote" },
    });

    const writes = writesFrom(recorder.commands);
    const transaction = transactionOf(recorder.commands);
    expect(JSON.stringify(writes)).toContain(`OPERATION#${operationId}`);
    expect(JSON.stringify(writes)).toContain("sourceUrisToObserve");
    expect(writes.map(conditionSummary).join("\n")).toContain("revision-9");
    for (const uri of sourceUrisToObserve) expect(JSON.stringify(writes)).toContain(uri);
    expect(writes.some((write) => write.kind === "Delete")).toBe(false);
    expect(transaction.input.TransactItems.length).toBeGreaterThanOrEqual(2);
    expect(
      writes.some(
        (write) =>
          JSON.stringify(write.Key || write.Item).includes("CONTROL") &&
          conditionSummary(write).includes(operationId),
      ),
    ).toBe(true);
  });

  it("releases the reservation only with a condition for the operation that still owns CONTROL", async () => {
    const operation = {
      pk: `BOT#${phase11BotId}`,
      sk: `OPERATION#${operationId}`,
      operationId,
      documentId,
      action: "upload",
      status: "processing",
      revision: "revision-1",
      ownerOperationId: operationId,
      updatedAt: phase11Now,
    };
    const document = {
      pk: `BOT#${phase11BotId}`,
      sk: `DOCUMENT#${documentId}`,
      documentId,
      state: "active",
      name: "lesson.txt",
      sizeBytes: 20,
      revision: "revision-1",
      updatedAt: phase11Now,
      source: {
        status: "confirmed",
        bucket: "prepared-docentes",
        key: "prepared/document-1/revision-1/lesson.txt",
        uri: "s3://prepared-docentes/prepared/document-1/revision-1/lesson.txt",
        sizeBytes: 20,
        sha256: "a".repeat(64),
      },
      pendingRemovalKeys: [],
      ownerOperationId: operationId,
    };
    const control = {
      pk: `BOT#${phase11BotId}`,
      sk: "CONTROL",
      activeOperationId: operationId,
    };
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof GetCommand) {
        const rows = {
          CONTROL: control,
          [`OPERATION#${operationId}`]: operation,
          [`DOCUMENT#${documentId}`]: document,
        };
        const Item = rows[command.input.Key.sk];
        return Item ? { Item } : {};
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });

    await store.finishOperation({
      operationId,
      outcome: "completed",
      operation: phase11Operation({ operationId, status: "completed", stage: "result" }),
    });

    const transaction = transactionOf(recorder.commands);
    const writes = transactWrites(transaction);
    expect(writes.map(conditionSummary).join("\n")).toMatch(/operation-1/);
    expect(JSON.stringify(writes)).toContain("CONTROL");
    expect(JSON.stringify(writes)).toContain(`OPERATION#${operationId}`);
  });

  it("rejects a late operation update unless the same operation still owns CONTROL and is nonterminal", async () => {
    const recorder = phase11CommandRecorder(async (command) => {
      if (command instanceof TransactWriteCommand) {
        throw Object.assign(new Error("The operation is no longer active"), {
          name: "TransactionCanceledException",
          CancellationReasons: [
            { Code: "ConditionalCheckFailed" },
            { Code: "ConditionalCheckFailed" },
          ],
        });
      }
      return {};
    });
    const createDocumentStore = await loadStore();
    const store = createDocumentStore({
      documentClient: recorder.documentClient,
      tableName,
      botId: phase11BotId,
      now: () => phase11Now,
    });

    const applied = await store.updateOperation({
      operationId,
      patch: { status: "processing", executionArn: "late-execution-arn" },
    });

    expect(applied).toBe(false);
    const transaction = transactionOf(recorder.commands);
    const writes = transactWrites(transaction);
    const ownerCheck = writes.find((write) => JSON.stringify(write.Key).includes("CONTROL"));
    const operationUpdate = writes.find((write) =>
      JSON.stringify(write.Key).includes(`OPERATION#${operationId}`),
    );
    expect(ownerCheck.ConditionExpression).toContain("activeOperationId");
    expect(JSON.stringify(ownerCheck.ExpressionAttributeValues)).toContain(operationId);
    expect(operationUpdate.ConditionExpression).toMatch(/completed/);
    expect(operationUpdate.ConditionExpression).toMatch(/failed/);
    expect(JSON.stringify(operationUpdate.ExpressionAttributeValues)).toContain(
      "late-execution-arn",
    );
  });
});
