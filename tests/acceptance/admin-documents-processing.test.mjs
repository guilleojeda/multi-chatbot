import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  phase11BotId,
  phase11Now,
  phase11Operation,
} from "../support/phase11-documents-backend.mjs";

const operationId = "operation-1";
const documentId = "document-1";
const revision = "revision-1";
const uploadBucketName = "temporary-docentes";
const documentBucketName = "prepared-docentes";
const expectedKey = `prepared/${documentId}/${revision}/lesson.txt`;
const expectedUri = `s3://${documentBucketName}/${expectedKey}`;
const textBytes = Buffer.from("The lesson closes with an individual reflection.\n", "utf8");
const replacementBytes = Buffer.from("The lesson closes with a group reflection.\n", "utf8");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const s3Checksum = (bytes) => Buffer.from(sha256(bytes), "hex").toString("base64");
const uploadKeyFor = (operationId, name) => {
  const extension = name.split(".").at(-1).toLowerCase();
  return `incoming/${sha256(Buffer.from(operationId, "utf8"))}/${sha256(Buffer.from(name, "utf8"))}.${extension}`;
};
const uploadKey = uploadKeyFor(operationId, "lesson.txt");
const replacementUploadKey = uploadKeyFor("replace-1", "lesson-b.txt");
const oldSource = {
  bucket: documentBucketName,
  key: "prepared/document-1/revision-1/lesson-a.txt",
  uri: `s3://${documentBucketName}/prepared/document-1/revision-1/lesson-a.txt`,
  sizeBytes: textBytes.byteLength,
  sha256: sha256(textBytes),
};
const replacementSource = {
  bucket: documentBucketName,
  key: "prepared/document-1/revision-2/lesson-b.txt",
  uri: `s3://${documentBucketName}/prepared/document-1/revision-2/lesson-b.txt`,
  sizeBytes: replacementBytes.byteLength,
  sha256: sha256(replacementBytes),
};

function uploadOperation(overrides = {}) {
  return phase11Operation({
    operationId,
    documentId,
    action: "upload",
    status: "processing",
    stage: "validation",
    revision,
    file: {
      name: "lesson.txt",
      sizeBytes: textBytes.byteLength,
      sha256: sha256(textBytes),
      contentType: "text/plain",
    },
    uploadKey,
    candidateKey: expectedKey,
    ...overrides,
  });
}

function replaceOperation(overrides = {}) {
  return uploadOperation({
    operationId: "replace-1",
    action: "replace",
    status: "processing",
    stage: "validation",
    revision: "revision-2",
    file: {
      name: "lesson-b.txt",
      sizeBytes: replacementBytes.byteLength,
      sha256: sha256(replacementBytes),
      contentType: "text/plain",
    },
    uploadKey: replacementUploadKey,
    candidateKey: replacementSource.key,
    ...overrides,
  });
}

function withdrawOperation({
  operationId: id = "withdraw-1",
  source = oldSource,
  pendingRemovalKeys = [],
  ...overrides
} = {}) {
  return phase11Operation({
    operationId: id,
    documentId,
    action: "withdraw",
    status: "processing",
    stage: "source",
    revision: "revision-1",
    source: structuredClone(source),
    pendingRemovalKeys: [...pendingRemovalKeys],
    ...overrides,
  });
}

function activeDocument(
  source = oldSource,
  pendingRemovalKeys = [],
  documentRevision = "revision-1",
) {
  return {
    documentId,
    state: "active",
    name: source?.key.endsWith("lesson-b.txt") ? "lesson-b.txt" : "lesson-a.txt",
    revision: documentRevision,
    source,
    pendingRemovalKeys: [...pendingRemovalKeys],
  };
}

function confirmedUploadOperation(overrides = {}) {
  return uploadOperation({
    status: "processing",
    stage: "ingestion",
    source: {
      status: "confirmed",
      bucket: documentBucketName,
      key: expectedKey,
      uri: expectedUri,
      sizeBytes: textBytes.byteLength,
      sha256: sha256(textBytes),
    },
    ...overrides,
  });
}

function confirmedDocument() {
  return {
    documentId,
    state: "active",
    name: "lesson.txt",
    revision,
    pendingRemovalKeys: [],
    source: {
      status: "confirmed",
      bucket: documentBucketName,
      key: expectedKey,
      uri: expectedUri,
      sizeBytes: textBytes.byteLength,
      sha256: sha256(textBytes),
    },
  };
}

function makeStore({ operation = uploadOperation(), document = null, overrides = {} } = {}) {
  const calls = [];
  let currentOperation = structuredClone(operation);
  let currentDocument = document ? structuredClone(document) : null;
  const store = {
    listDocuments: vi.fn(async (input) => {
      calls.push(["listDocuments", input]);
      return { documents: [], nextCursor: null };
    }),
    getOperation: vi.fn(async (input) => {
      calls.push(["getOperation", input]);
      return input.operationId === currentOperation.operationId
        ? structuredClone(currentOperation)
        : null;
    }),
    getDocument: vi.fn(async (input) => {
      calls.push(["getDocument", input]);
      return currentDocument ? structuredClone(currentDocument) : null;
    }),
    createIntent: vi.fn(async (input) => {
      calls.push(["createIntent", input]);
      return { created: true, operation: structuredClone(operation) };
    }),
    reserveOperation: vi.fn(async (input) => {
      calls.push(["reserveOperation", input]);
      return { reserved: true, operation: structuredClone(operation) };
    }),
    recordSource: vi.fn(async (input) => {
      calls.push(["recordSource", input]);
      if (currentDocument) {
        currentDocument = {
          ...currentDocument,
          source: input.source,
          pendingRemovalKeys: [...input.pendingRemovalKeys],
        };
      }
      return true;
    }),
    recordIngestionJob: vi.fn(async (input) => {
      calls.push(["recordIngestionJob", input]);
      if (input.jobId) currentOperation.ingestionJobId = input.jobId;
      return true;
    }),
    updateOperation: vi.fn(async (input) => {
      calls.push(["updateOperation", input]);
      const patch =
        input.patch && typeof input.patch === "object"
          ? input.patch
          : Object.fromEntries(Object.entries(input).filter(([key]) => key !== "operationId"));
      currentOperation = { ...currentOperation, ...structuredClone(patch) };
      return true;
    }),
    finishOperation: vi.fn(async (input) => {
      calls.push(["finishOperation", input]);
      if (input.outcome) currentOperation.outcome = input.outcome;
      if (input.operation) currentOperation = structuredClone(input.operation);
      else if (input.outcome) currentOperation.status = input.outcome;
      return true;
    }),
    ...overrides,
  };
  return { store, calls };
}

function makeObjects({
  bytes = textBytes,
  contentLength = bytes.byteLength,
  copy,
  head,
  get,
  remove,
} = {}) {
  return {
    head: vi.fn(async (input) =>
      head ? head(input) : { contentLength, checksumSHA256: s3Checksum(bytes) },
    ),
    get: vi.fn(async () => (get ? get() : Readable.from([bytes]))),
    copy: vi.fn(copy || (async () => ({ etag: "prepared-etag" }))),
    delete: vi.fn(remove || (async () => ({}))),
  };
}

function makeIngestion(overrides = {}) {
  return {
    start: vi.fn(async () => ({ jobId: "ingestion-job-1" })),
    get: vi.fn(async () => ({ status: "COMPLETE", statistics: { numberOfDocumentsFailed: 0 } })),
    getDocument: vi.fn(async () => ({ status: "INDEXED", sourceUri: expectedUri })),
    ...overrides,
  };
}

async function loadWorker() {
  const module = await import("../../api/document-worker.ts");
  expect(
    typeof module.createDocumentWorker,
    "Expected the production api/document-worker.ts#createDocumentWorker factory",
  ).toBe("function");
  return module.createDocumentWorker;
}

async function makeWorkerContext({
  operation = uploadOperation(),
  document = null,
  objects = makeObjects(),
  ingestion = makeIngestion(),
  storeOverrides = {},
} = {}) {
  const { store, calls } = makeStore({ operation, document, overrides: storeOverrides });
  const worker = await makeWorkerWithStore({ store, objects, ingestion });
  return { worker, store, calls, objects, ingestion };
}

async function makeWorkerWithStore({
  store,
  objects = makeObjects(),
  ingestion = makeIngestion(),
}) {
  const createDocumentWorker = await loadWorker();
  return createDocumentWorker({
    stores: { [phase11BotId]: store },
    resourcesByBot: {
      [phase11BotId]: {
        uploadBucketName,
        documentBucketName,
        incomingPrefix: "incoming/",
        preparedPrefix: "prepared/",
        knowledgeBaseId: "kb-docentes",
        dataSourceId: "source-docentes",
      },
    },
    objects,
    ingestion,
    now: () => phase11Now,
  });
}

async function makeWorkerWithDynamoStore({ operation, document, ingestion }) {
  const tableName = "documents-docentes";
  const partition = `BOT#${phase11BotId}`;
  const rows = new Map(
    [
      {
        pk: partition,
        sk: `OPERATION#${operation.operationId}`,
        botId: phase11BotId,
        ...operation,
      },
      { pk: partition, sk: `DOCUMENT#${document.documentId}`, botId: phase11BotId, ...document },
      {
        pk: partition,
        sk: "CONTROL",
        botId: phase11BotId,
        activeOperationId: operation.operationId,
      },
    ].map((row) => [`${row.pk}\u0000${row.sk}`, row]),
  );
  const rowKey = (key) => `${key.pk}\u0000${key.sk}`;
  const applyUpdate = (update) => {
    const row = rows.get(rowKey(update.Key));
    if (!row) throw new Error(`Missing test row ${update.Key.sk}`);
    const names = update.ExpressionAttributeNames || {};
    const values = update.ExpressionAttributeValues || {};
    const resolveName = (name) => names[name] || name;
    const [setClause = "", removeClause = ""] = update.UpdateExpression.split(" REMOVE ");
    for (const assignment of setClause
      .replace(/^SET\s+/, "")
      .split(", ")
      .filter(Boolean)) {
      const [name, value] = assignment.split(" = ");
      row[resolveName(name)] = structuredClone(values[value]);
    }
    for (const name of removeClause.split(", ").filter(Boolean)) delete row[resolveName(name)];
  };
  const documentClient = {
    async send(command) {
      if (command instanceof GetCommand) {
        const item = rows.get(rowKey(command.input.Key));
        return item ? { Item: structuredClone(item) } : {};
      }
      if (command instanceof QueryCommand) {
        return {
          Items: [...rows.values()]
            .filter(
              (row) =>
                row.pk === command.input.ExpressionAttributeValues[":pk"] &&
                row.sk.startsWith(command.input.ExpressionAttributeValues[":prefix"]),
            )
            .sort((left, right) => left.sk.localeCompare(right.sk))
            .map((row) => structuredClone(row)),
        };
      }
      if (command instanceof TransactWriteCommand) {
        const updates = command.input.TransactItems.flatMap((item) =>
          item.Update ? [item.Update] : [],
        );
        for (const update of updates) {
          const row = rows.get(rowKey(update.Key));
          if (!row) throw new Error(`Missing test row ${update.Key.sk}`);
          const values = update.ExpressionAttributeValues || {};
          const names = update.ExpressionAttributeNames || {};
          const ownerField = names["#owner"];
          if (ownerField && row[ownerField] !== values[":owner"]) {
            throw new Error(`Unexpected test owner for ${update.Key.sk}`);
          }
          const activeField = names["#active"];
          if (activeField && row[activeField] !== values[":owner"]) {
            throw new Error(`Unexpected active test owner for ${update.Key.sk}`);
          }
        }
        updates.forEach(applyUpdate);
        return {};
      }
      throw new Error(`Unexpected test command: ${command.constructor.name}`);
    },
  };
  const { createDocumentStore } = await import("../../api/document-store.ts");
  const store = createDocumentStore({
    documentClient,
    tableName,
    botId: phase11BotId,
    now: () => phase11Now,
  });
  const worker = await makeWorkerWithStore({ store, ingestion });
  return { worker, store };
}

function run(worker, step, opId = operationId) {
  return worker.run({ botId: phase11BotId, operationId: opId, step });
}

describe("document worker acceptance with controlled S3 and Bedrock boundaries", () => {
  it("validates the received object bytes and promotes them to the server-selected prepared URI", async () => {
    const objects = makeObjects();
    const { worker, store } = await makeWorkerContext({ objects });

    await run(worker, "validate");
    await run(worker, "promote");

    expect(objects.head).toHaveBeenCalledWith({
      bucket: uploadBucketName,
      key: uploadKey,
    });
    expect(objects.get).toHaveBeenCalledWith({
      bucket: uploadBucketName,
      key: uploadKey,
    });
    expect(objects.copy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBucket: uploadBucketName,
        sourceKey: uploadKey,
        destinationBucket: documentBucketName,
        destinationKey: expectedKey,
      }),
    );
    expect(store.recordSource).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        source: expect.objectContaining({
          key: expectedKey,
          uri: expectedUri,
          sha256: sha256(textBytes),
        }),
      }),
    );
  });

  it("copies replacement B to a new key and removes A before starting sync", async () => {
    const objects = makeObjects({ bytes: replacementBytes });
    const ingestion = makeIngestion({
      getDocument: vi.fn(async ({ sourceUri }) => ({ status: "INDEXED", sourceUri })),
    });
    const { worker, store } = await makeWorkerContext({
      operation: replaceOperation({ source: oldSource }),
      document: activeDocument(oldSource),
      objects,
      ingestion,
    });

    const validation = await run(worker, "validate", "replace-1");
    expect(validation).toMatchObject({ status: "ready" });
    await run(worker, "promote", "replace-1");

    expect(objects.copy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBucket: uploadBucketName,
        sourceKey: replacementUploadKey,
        destinationBucket: documentBucketName,
        destinationKey: replacementSource.key,
      }),
    );
    expect(objects.delete).toHaveBeenCalledWith({
      bucket: documentBucketName,
      key: oldSource.key,
    });
    expect(store.recordSource).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "replace-1",
        source: expect.objectContaining(replacementSource),
        pendingRemovalKeys: [],
      }),
    );
    expect(objects.copy.mock.invocationCallOrder[0]).toBeLessThan(
      objects.delete.mock.invocationCallOrder[0],
    );
    expect(objects.delete.mock.invocationCallOrder[0]).toBeLessThan(
      store.recordSource.mock.invocationCallOrder.at(-1),
    );
    expect(ingestion.start).not.toHaveBeenCalled();

    await run(worker, "start-ingestion", "replace-1");
    expect(store.recordSource.mock.invocationCallOrder.at(-1)).toBeLessThan(
      ingestion.start.mock.invocationCallOrder[0],
    );
    const observed = await run(worker, "observe-ingestion", "replace-1");
    expect(observed).toMatchObject({ status: "completed" });
    const completed = await run(worker, "finish", "replace-1");
    expect(completed).toMatchObject({ status: "completed" });
    expect(ingestion.getDocument).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docentes",
      dataSourceId: "source-docentes",
      sourceUri: replacementSource.uri,
    });
  });

  it("rejects invalid replacement B without changing the current source A", async () => {
    const invalidBytes = Buffer.from([0xc3, 0x28]);
    const operation = replaceOperation({
      file: {
        name: "lesson-b.txt",
        sizeBytes: invalidBytes.byteLength,
        sha256: sha256(invalidBytes),
        contentType: "text/plain",
      },
    });
    const objects = makeObjects({ bytes: invalidBytes });
    const { worker, store } = await makeWorkerContext({
      operation,
      document: activeDocument(oldSource),
      objects,
    });

    const result = await run(worker, "validate", "replace-1");
    const currentDocument = await store.getDocument({ documentId });

    expect(result).toMatchObject({ status: "failed", error: { code: "INVALID_DOCUMENT" } });
    expect(currentDocument.source).toEqual(oldSource);
    expect(currentDocument.pendingRemovalKeys).toEqual([]);
    expect(objects.copy).not.toHaveBeenCalled();
    expect(objects.delete).not.toHaveBeenCalled();
    expect(store.recordSource).not.toHaveBeenCalled();
  });

  it("retains replacement B and A as pending after confirmed delete failure and does not sync", async () => {
    const objects = makeObjects({
      bytes: replacementBytes,
      remove: vi.fn(async () => {
        throw Object.assign(new Error("S3 refused deleting the old source"), {
          name: "AccessDenied",
        });
      }),
    });
    const { worker, store, ingestion } = await makeWorkerContext({
      operation: replaceOperation({ source: oldSource }),
      document: activeDocument(oldSource),
      objects,
      ingestion: makeIngestion(),
    });
    await run(worker, "validate", "replace-1");

    const result = await run(worker, "promote", "replace-1");
    const documentAfterPartialEffects = await store.getDocument({ documentId });

    expect(result).toMatchObject({ status: "failed" });
    expect(objects.copy).toHaveBeenCalledOnce();
    expect(objects.delete).toHaveBeenCalledOnce();
    expect(store.recordSource).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "replace-1",
        source: expect.objectContaining(replacementSource),
        pendingRemovalKeys: [oldSource.key],
      }),
    );
    expect(documentAfterPartialEffects.source).toMatchObject(replacementSource);
    expect(documentAfterPartialEffects.pendingRemovalKeys).toEqual([oldSource.key]);
    expect(objects.copy.mock.invocationCallOrder[0]).toBeLessThan(
      objects.delete.mock.invocationCallOrder[0],
    );
    expect(ingestion.start).not.toHaveBeenCalled();

    const retried = await run(worker, "start-ingestion", "replace-1");
    expect(retried).toMatchObject({ status: "failed" });
    expect(ingestion.start).not.toHaveBeenCalled();
  });

  it("cleans a confirmed replacement's pending A during reprocess without copying B again", async () => {
    const operation = phase11Operation({
      operationId: "reprocess-pending-1",
      documentId,
      action: "reprocess",
      status: "processing",
      stage: "source",
      revision: "revision-2",
      source: replacementSource,
      pendingRemovalKeys: [oldSource.key],
    });
    const objects = makeObjects();
    const { worker, store, ingestion } = await makeWorkerContext({
      operation,
      document: activeDocument(replacementSource, [oldSource.key], "revision-2"),
      objects,
    });

    await run(worker, "validate", operation.operationId);
    await run(worker, "promote", operation.operationId);

    expect(objects.head).not.toHaveBeenCalled();
    expect(objects.get).not.toHaveBeenCalled();
    expect(objects.copy).not.toHaveBeenCalled();
    expect(objects.delete).toHaveBeenCalledExactlyOnceWith({
      bucket: documentBucketName,
      key: oldSource.key,
    });
    expect(store.recordSource).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: operation.operationId,
        source: expect.objectContaining(replacementSource),
        pendingRemovalKeys: [],
      }),
    );
    await run(worker, "start-ingestion", operation.operationId);
    expect(objects.delete.mock.invocationCallOrder[0]).toBeLessThan(
      ingestion.start.mock.invocationCallOrder[0],
    );
    expect(ingestion.start).toHaveBeenCalledOnce();
  });

  it.each(["DELETED", "ABSENT"])(
    "completes withdrawal only after every prior URI is %s, the job is COMPLETE, and failed is zero",
    async (documentStatus) => {
      const extraPendingKey = "prepared/document-1/revision-0/lesson-c.txt";
      const extraPendingUri = `s3://${documentBucketName}/${extraPendingKey}`;
      const pendingRemovalKeys = [
        oldSource.key,
        replacementSource.key,
        extraPendingKey,
        oldSource.key,
      ];
      const expectedUris = [replacementSource.uri, oldSource.uri, extraPendingUri];
      const operation = withdrawOperation({
        source: replacementSource,
        pendingRemovalKeys,
        sourceUrisToObserve: expectedUris,
      });
      const ingestion = makeIngestion({
        getDocument: vi.fn(async ({ sourceUri }) => ({ status: documentStatus, sourceUri })),
      });
      const objects = makeObjects();
      const { worker, store } = await makeWorkerContext({
        operation,
        document: activeDocument(replacementSource, pendingRemovalKeys, "revision-2"),
        objects,
        ingestion,
      });

      await run(worker, "promote", operation.operationId);

      const expectedKeys = [replacementSource.key, oldSource.key, extraPendingKey];
      const deletedKeys = objects.delete.mock.calls.map(([input]) => input.key);
      expect(deletedKeys).toHaveLength(expectedKeys.length);
      expect(new Set(deletedKeys)).toEqual(new Set(expectedKeys));
      expect(
        objects.delete.mock.calls.every(([input]) => input.bucket === documentBucketName),
      ).toBe(true);
      expect(operation.sourceUrisToObserve).toHaveLength(expectedUris.length);
      expect(new Set(operation.sourceUrisToObserve)).toEqual(new Set(expectedUris));
      expect(store.recordSource).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: operation.operationId,
          source: null,
          pendingRemovalKeys: [],
        }),
      );
      expect(objects.delete.mock.invocationCallOrder.at(-1)).toBeLessThan(
        store.recordSource.mock.invocationCallOrder.at(-1),
      );
      expect(objects.copy).not.toHaveBeenCalled();
      expect(objects.head).not.toHaveBeenCalled();
      expect(objects.get).not.toHaveBeenCalled();

      const documentAfterDelete = await store.getDocument({ documentId });
      expect(documentAfterDelete.source).toBeNull();
      expect(documentAfterDelete.pendingRemovalKeys).toEqual([]);
      const durableOperation = await store.getOperation({ operationId: operation.operationId });
      expect(new Set(durableOperation.sourceUrisToObserve)).toEqual(new Set(expectedUris));

      await run(worker, "start-ingestion", operation.operationId);
      expect(objects.delete.mock.invocationCallOrder.at(-1)).toBeLessThan(
        ingestion.start.mock.invocationCallOrder[0],
      );
      const restartedWorker = await makeWorkerWithStore({ store, objects, ingestion });
      await run(restartedWorker, "observe-ingestion", operation.operationId);
      const result = await run(restartedWorker, "finish", operation.operationId);

      expect(result).toMatchObject({ status: "completed" });
      expect(ingestion.start).toHaveBeenCalledOnce();
      expect(ingestion.get).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "ingestion-job-1" }),
      );
      expect(ingestion.getDocument.mock.calls.map(([input]) => input.sourceUri)).toEqual(
        expect.arrayContaining(expectedUris),
      );
      expect(store.finishOperation).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: operation.operationId, outcome: "completed" }),
      );
    },
  );

  it("keeps withdrawal unconfirmed and reserved after an uncertain delete without retry or sync", async () => {
    const pendingRemovalKeys = [oldSource.key];
    const operation = withdrawOperation({
      source: replacementSource,
      pendingRemovalKeys,
      sourceUrisToObserve: [replacementSource.uri, oldSource.uri],
    });
    const objects = makeObjects({
      remove: vi.fn(async () => {
        throw Object.assign(new Error("DeleteObject acknowledgement timed out"), {
          name: "TimeoutError",
        });
      }),
    });
    const { worker, store, ingestion } = await makeWorkerContext({
      operation,
      document: activeDocument(replacementSource, pendingRemovalKeys, "revision-2"),
      objects,
      ingestion: makeIngestion(),
    });

    const result = await run(worker, "promote", operation.operationId);
    const currentDocument = await store.getDocument({ documentId });
    const durableOperation = await store.getOperation({ operationId: operation.operationId });

    expect(result).toMatchObject({
      status: "unconfirmed",
      error: { code: "EFFECT_UNCONFIRMED" },
    });
    expect(objects.delete).toHaveBeenCalledOnce();
    expect(new Set(durableOperation.sourceUrisToObserve)).toEqual(
      new Set([replacementSource.uri, oldSource.uri]),
    );
    expect(objects.copy).not.toHaveBeenCalled();
    expect(store.recordSource).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: null, pendingRemovalKeys: [] }),
    );
    expect(currentDocument.source).toEqual(replacementSource);
    expect(currentDocument.pendingRemovalKeys).toEqual(pendingRemovalKeys);
    expect(store.finishOperation).not.toHaveBeenCalled();
    expect(ingestion.start).not.toHaveBeenCalled();
  });

  it.each(["null result", "read failure"])(
    "does not treat a withdrawal observation %s as confirmed absence",
    async (readCase) => {
      const operation = withdrawOperation({
        source: oldSource,
        sourceUrisToObserve: [oldSource.uri],
      });
      const ingestion = makeIngestion({
        getDocument: vi.fn(async () => {
          if (readCase === "read failure") throw new Error("Bedrock document read unavailable");
          return null;
        }),
      });
      const { worker, store } = await makeWorkerContext({
        operation,
        document: activeDocument(oldSource),
        ingestion,
      });

      await run(worker, "promote", operation.operationId);
      await run(worker, "start-ingestion", operation.operationId);
      const result = await run(worker, "observe-ingestion", operation.operationId);

      expect(ingestion.getDocument).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docentes",
        dataSourceId: "source-docentes",
        sourceUri: oldSource.uri,
      });
      expect(result).toMatchObject({ status: "unconfirmed" });
      expect(store.finishOperation).not.toHaveBeenCalled();
      expect(
        store.updateOperation.mock.calls.some(([input]) => {
          const patch = input.patch ?? input;
          return patch.status === "unconfirmed";
        }),
      ).toBe(true);
    },
  );

  it("finishes a terminal failed withdrawal with a new withdraw using the retained source receipt", async () => {
    const sourceUrisToObserve = [oldSource.uri, replacementSource.uri];
    const operation = withdrawOperation({
      operationId: "withdraw-retry-2",
      source: null,
      pendingRemovalKeys: [],
      sourceUrisToObserve,
      priorOperationId: "withdraw-failed-1",
    });
    const document = {
      documentId,
      state: "active",
      name: "lesson-b.txt",
      revision: "revision-2",
      source: null,
      pendingRemovalKeys: [],
      lastOperationId: "withdraw-failed-1",
    };
    const ingestion = makeIngestion({
      getDocument: vi.fn(async ({ sourceUri }) => ({ status: "DELETED", sourceUri })),
    });
    const objects = makeObjects();
    const { worker, store } = await makeWorkerContext({ operation, document, objects, ingestion });

    const promotion = await run(worker, "promote", operation.operationId);
    expect(promotion).toMatchObject({ status: "ready" });
    expect(objects.delete).not.toHaveBeenCalled();
    expect(objects.copy).not.toHaveBeenCalled();
    expect(objects.head).not.toHaveBeenCalled();
    expect(objects.get).not.toHaveBeenCalled();
    expect(await store.getOperation({ operationId: operation.operationId })).toMatchObject({
      operationId: "withdraw-retry-2",
      sourceUrisToObserve,
    });

    await run(worker, "start-ingestion", operation.operationId);
    const restartedWorker = await makeWorkerWithStore({ store, objects, ingestion });
    await run(restartedWorker, "observe-ingestion", operation.operationId);
    const result = await run(restartedWorker, "finish", operation.operationId);

    expect(result).toMatchObject({ status: "completed" });
    expect(ingestion.getDocument.mock.calls.map(([input]) => input.sourceUri)).toEqual(
      expect.arrayContaining(sourceUrisToObserve),
    );
    expect(store.finishOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: operation.operationId, outcome: "completed" }),
    );
  });

  it("decodes valid UTF-8 when a multibyte character is split across streamed chunks", async () => {
    const chunks = [
      Buffer.from("A caf"),
      Buffer.from([0xc3]),
      Buffer.from([0xa9]),
      Buffer.from(" lesson"),
    ];
    const completeBytes = Buffer.concat(chunks);
    const operation = uploadOperation({
      file: {
        name: "lesson.txt",
        sizeBytes: completeBytes.byteLength,
        sha256: sha256(completeBytes),
        contentType: "text/plain",
      },
    });
    const objects = makeObjects({
      bytes: completeBytes,
      get: () => Readable.from(chunks),
    });
    const { worker } = await makeWorkerContext({ operation, objects });

    const result = await run(worker, "validate");

    expect(result).toMatchObject({ status: "ready" });
    expect(objects.get).toHaveBeenCalledOnce();
  });

  it("counts and hashes a streamed 50,000,000-byte file without buffering the fixture", async () => {
    const sizeBytes = 50_000_000;
    const chunk = Buffer.alloc(1_000_000, 0x61);
    const digest = createHash("sha256");
    for (let index = 0; index < sizeBytes / chunk.byteLength; index += 1) digest.update(chunk);
    const expectedHash = digest.digest("hex");
    let streamedBytes = 0;
    async function* generatedChunks() {
      for (let index = 0; index < sizeBytes / chunk.byteLength; index += 1) {
        streamedBytes += chunk.byteLength;
        yield chunk;
      }
    }
    const operation = uploadOperation({
      file: {
        name: "large-lesson.txt",
        sizeBytes,
        sha256: expectedHash,
        contentType: "text/plain",
      },
    });
    const objects = makeObjects({
      bytes: Buffer.alloc(0),
      contentLength: sizeBytes,
      head: async () => ({
        contentLength: sizeBytes,
        checksumSHA256: Buffer.from(expectedHash, "hex").toString("base64"),
      }),
      get: () => Readable.from(generatedChunks()),
    });
    const { worker } = await makeWorkerContext({ operation, objects });

    const result = await run(worker, "validate");

    expect(result).toMatchObject({ status: "ready" });
    expect(streamedBytes).toBe(sizeBytes);
    expect(objects.copy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "invalid UTF-8",
      Buffer.from([0xc3, 0x28]),
      undefined,
      sha256(Buffer.from([0xc3, 0x28])),
      "INVALID_DOCUMENT",
    ],
    [
      "blank text",
      Buffer.from(" \n\t", "utf8"),
      undefined,
      sha256(Buffer.from(" \n\t", "utf8")),
      "INVALID_DOCUMENT",
    ],
    ["declared checksum mismatch", textBytes, undefined, "f".repeat(64), "UPLOAD_MISMATCH"],
    [
      "declared size mismatch",
      textBytes,
      textBytes.byteLength + 1,
      sha256(textBytes),
      "UPLOAD_MISMATCH",
    ],
  ])(
    "returns a specific failed result for %s before preparing any destination object",
    async (_label, bytes, contentLength, declaredHash, expectedErrorCode) => {
      const objects = makeObjects({ bytes, contentLength: contentLength ?? bytes.byteLength });
      const operation = uploadOperation({
        file: {
          name: "lesson.txt",
          sizeBytes: contentLength ?? bytes.byteLength,
          sha256: declaredHash,
          contentType: "text/plain",
        },
      });
      const { worker, store } = await makeWorkerContext({ operation, objects });

      const result = await run(worker, "validate");

      expect(result).toMatchObject({ status: "failed", error: { code: expectedErrorCode } });
      const persistedFailure =
        store.updateOperation.mock.calls.some(
          ([input]) => input?.status === "failed" || input?.patch?.status === "failed",
        ) || store.finishOperation.mock.calls.some(([input]) => input?.outcome === "failed");
      expect(persistedFailure).toBe(true);
      expect(objects.copy).not.toHaveBeenCalled();
      expect(store.recordSource).not.toHaveBeenCalled();
    },
  );

  it("uses one promotion producer and preserves the reservation when an S3 write is uncertain", async () => {
    const objects = makeObjects({
      copy: vi.fn(async () => {
        throw Object.assign(new Error("copy acknowledgement timed out"), { name: "TimeoutError" });
      }),
    });
    const { worker, store } = await makeWorkerContext({ objects });
    await run(worker, "validate");

    const result = await run(worker, "promote");

    expect(result).toMatchObject({ status: "unconfirmed", error: { code: "EFFECT_UNCONFIRMED" } });
    expect(objects.copy).toHaveBeenCalledOnce();
    expect(store.recordSource).not.toHaveBeenCalled();
    expect(store.finishOperation).not.toHaveBeenCalled();
    expect(store.updateOperation.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("uses a stable ingestion token across worker contexts, records the observed job ID, and requires COMPLETE, zero failures, and the expected INDEXED URI", async () => {
    const jobsByToken = new Map();
    const ingestion = makeIngestion({
      start: vi.fn(async ({ clientToken }) => {
        if (!jobsByToken.has(clientToken)) jobsByToken.set(clientToken, "ingestion-job-1");
        return { jobId: jobsByToken.get(clientToken) };
      }),
    });
    const first = await makeWorkerContext({
      operation: confirmedUploadOperation(),
      document: confirmedDocument(),
      ingestion,
    });
    await run(first.worker, "start-ingestion");
    const restarted = await makeWorkerContext({
      operation: confirmedUploadOperation(),
      document: confirmedDocument(),
      ingestion,
    });
    await run(restarted.worker, "start-ingestion");
    await run(first.worker, "observe-ingestion");
    const result = await run(first.worker, "finish");

    expect(result).toMatchObject({ status: "completed" });
    expect(ingestion.start).toHaveBeenCalledTimes(2);
    const startInputs = ingestion.start.mock.calls.map(([input]) => input);
    expect(startInputs[0].clientToken).toBeTruthy();
    expect(startInputs[1].clientToken).toBe(startInputs[0].clientToken);
    expect(jobsByToken.size).toBe(1);
    expect(startInputs[0]).toMatchObject({
      knowledgeBaseId: "kb-docentes",
      dataSourceId: "source-docentes",
    });
    expect(first.store.recordIngestionJob).toHaveBeenCalledWith(
      expect.objectContaining({ operationId, jobId: "ingestion-job-1" }),
    );
    expect(ingestion.get).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "ingestion-job-1" }),
    );
    expect(ingestion.getDocument).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docentes",
      dataSourceId: "source-docentes",
      sourceUri: expectedUri,
    });
    expect(first.store.finishOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId, outcome: "completed" }),
    );
  });

  it("persists a bounded extraction diagnosis from the Bedrock failure reason through the real store and CONTROL read path", async () => {
    const rawReason =
      "Ignored 1 files as the content could not be parsed. Check that the document is properly formatted. Then retry your request. [Files: s3://prepared-docentes/prepared/document-1/revision-1/Locked.pdf]. Call to Customer Source did not succeed.";
    const ingestion = makeIngestion({
      get: vi.fn(async () => ({
        status: "COMPLETE",
        statistics: { numberOfDocumentsFailed: 1 },
        failureReasons: [JSON.stringify([rawReason])],
      })),
    });
    const { worker, store } = await makeWorkerWithDynamoStore({
      operation: {
        ...confirmedUploadOperation({ stage: "ingestion", ingestionJobId: "ingestion-job-1" }),
        ownerOperationId: operationId,
      },
      document: { ...confirmedDocument(), ownerOperationId: operationId, updatedAt: phase11Now },
      ingestion,
    });

    const result = await run(worker, "finish");
    const persistedOperation = await store.getOperation({ operationId });
    const page = await store.listDocuments({ cursor: null, limit: 10 });

    expect(result).toMatchObject({ status: "failed", error: { code: "INGESTION_FAILED" } });
    expect(result.error.message).toMatch(/extraer o interpretar/i);
    expect(result.error.message).toMatch(/archivos preparados/i);
    expect(result.error.message).toMatch(/Revisá/i);
    expect(result.error.message).toMatch(/reemplazalos si hace falta antes de reintentar/i);
    expect(result.error.message).toContain("Documentos con error: 1.");
    expect(result.error.message).not.toMatch(/\bjob\b/i);
    expect(result.error.message).not.toMatch(
      /Locked\.pdf|s3:\/\/|Customer Source|could not be parsed/i,
    );
    expect(result.error.message).not.toMatch(/cifrad|encrypted/i);
    expect(persistedOperation).toMatchObject({
      status: "failed",
      canRetry: true,
      error: result.error,
    });
    expect(page.activeOperation).toBeNull();
    expect(page.lastOperation).toMatchObject({
      operationId,
      status: "failed",
      error: result.error,
    });
    expect(page.documents[0].processing).toMatchObject({
      status: "failed",
      operationId,
      error: result.error,
    });
    expect(JSON.stringify({ persistedOperation, page })).not.toContain(rawReason);
    expect(JSON.stringify({ persistedOperation, page })).not.toContain("Locked.pdf");
  });

  it.each([
    [
      "access failure",
      "Access denied while reading s3://private-bucket/private/name.pdf",
      1,
      /(?=.*revisión técnica)(?=.*Documentos con error: 1)(?=.*Solicitá)/i,
      /s3:\/\/|private-bucket|Access denied/i,
    ],
    [
      "encrypted-only cause",
      "The source document is encrypted and cannot be processed",
      1,
      /(?=.*no se pudo clasificar la causa)(?=.*Documentos con error: 1)(?=.*solicitá)/i,
      /encrypted|cifrad|extraer|formato/i,
    ],
    [
      "unknown adversarial cause",
      "TOKEN=secret <script>alert(1)</script> s3://private-bucket/name.pdf",
      2,
      /(?=.*Documentos con error: 2)(?=.*causa)(?=.*solicitá)/i,
      /TOKEN|secret|<script>|s3:\/\/|private-bucket/i,
    ],
  ])(
    "classifies %s without copying provider text into the stored diagnostic",
    async (_label, failureReason, failureCount, expectedMessage, forbiddenMessage) => {
      const ingestion = makeIngestion({
        get: vi.fn(async () => ({
          status: "COMPLETE",
          statistics: { numberOfDocumentsFailed: failureCount },
          failureReasons: [failureReason],
        })),
      });
      const { worker, store } = await makeWorkerContext({
        operation: confirmedUploadOperation({
          stage: "ingestion",
          ingestionJobId: "ingestion-job-1",
        }),
        document: confirmedDocument(),
        ingestion,
      });

      const result = await run(worker, "finish");
      const persistedOperation = await store.getOperation({ operationId });

      expect(result).toMatchObject({ status: "failed", error: { code: "INGESTION_FAILED" } });
      expect(result.error.message).toMatch(expectedMessage);
      expect(result.error.message).not.toMatch(forbiddenMessage);
      expect(persistedOperation.error).toEqual(result.error);
      expect(store.finishOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          operation: expect.objectContaining({ canRetry: true, error: result.error }),
        }),
      );
    },
  );

  it("keeps the existing generic ingestion error when a terminal failed job has no failure statistics or reasons", async () => {
    const ingestion = makeIngestion({
      get: vi.fn(async () => ({ status: "FAILED" })),
    });
    const { worker, store } = await makeWorkerContext({
      operation: confirmedUploadOperation({
        stage: "ingestion",
        ingestionJobId: "ingestion-job-1",
      }),
      document: confirmedDocument(),
      ingestion,
    });

    const result = await run(worker, "finish");
    const persistedOperation = await store.getOperation({ operationId });

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "INGESTION_FAILED",
        message:
          "La Knowledge Base no pudo procesar el documento. Puedes reintentar el procesamiento.",
      },
    });
    expect(persistedOperation.error).toEqual(result.error);
    expect(persistedOperation.canRetry).toBe(true);
    expect(store.finishOperation).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "partial",
      { status: "COMPLETE", statistics: { numberOfDocumentsFailed: 0 } },
      { status: "PARTIALLY_INDEXED", sourceUri: expectedUri },
      "failed",
      true,
    ],
    [
      "missing failure statistics",
      { status: "COMPLETE", statistics: {} },
      { status: "INDEXED", sourceUri: expectedUri },
      "unconfirmed",
      false,
    ],
    [
      "failed documents",
      { status: "COMPLETE", statistics: { numberOfDocumentsFailed: 1 } },
      { status: "INDEXED", sourceUri: expectedUri },
      "failed",
      true,
    ],
    [
      "corrupt document",
      {
        status: "COMPLETE",
        statistics: { numberOfDocumentsFailed: 0 },
        failureReasons: ["The content could not be parsed."],
      },
      { status: "FAILED", sourceUri: expectedUri },
      "failed",
      true,
      "La Knowledge Base no pudo procesar el documento. Puedes reintentar el procesamiento.",
    ],
    [
      "missing document status",
      { status: "COMPLETE", statistics: { numberOfDocumentsFailed: 0 } },
      null,
      "unconfirmed",
      false,
    ],
    [
      "different source URI",
      { status: "COMPLETE", statistics: { numberOfDocumentsFailed: 0 } },
      { status: "INDEXED", sourceUri: "s3://prepared-docentes/prepared/other/revision/file.txt" },
      "unconfirmed",
      false,
    ],
  ])(
    "classifies %s ingestion observations and keeps uncertain ownership reserved",
    async (
      _label,
      job,
      indexedDocument,
      expectedStatus,
      releasesReservation,
      expectedErrorMessage,
    ) => {
      const ingestion = makeIngestion({
        get: vi.fn(async () => job),
        getDocument: vi.fn(async () => indexedDocument),
      });
      const { worker, store } = await makeWorkerContext({
        operation: confirmedUploadOperation(),
        document: confirmedDocument(),
        ingestion,
      });

      await run(worker, "start-ingestion");
      await run(worker, "observe-ingestion");
      const result = await run(worker, "finish");

      expect(result).toMatchObject({ status: expectedStatus });
      if (expectedErrorMessage) {
        expect(result.error).toEqual({ code: "INGESTION_FAILED", message: expectedErrorMessage });
      }
      if (releasesReservation) {
        expect(store.finishOperation).toHaveBeenCalledOnce();
        expect(store.finishOperation.mock.calls[0][0].outcome).toBe("failed");
      } else {
        expect(store.finishOperation).not.toHaveBeenCalled();
        expect(
          store.updateOperation.mock.calls.some(
            ([input]) => input?.status === "unconfirmed" || input?.patch?.status === "unconfirmed",
          ),
        ).toBe(true);
      }
    },
  );

  it("retains source effects and bot reservation when ingestion observation is unknown", async () => {
    const ingestion = makeIngestion({
      get: vi.fn(async () => {
        throw new Error("Bedrock observation unavailable");
      }),
    });
    const { worker, store } = await makeWorkerContext({
      operation: confirmedUploadOperation(),
      document: confirmedDocument(),
      ingestion,
    });
    await run(worker, "start-ingestion");

    const result = await run(worker, "observe-ingestion");

    expect(result).toMatchObject({
      status: "unconfirmed",
      error: { code: "OBSERVATION_UNCONFIRMED" },
    });
    expect(store.recordIngestionJob).toHaveBeenCalled();
    expect(store.finishOperation).not.toHaveBeenCalled();
    expect(store.updateOperation.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it.each([
    ["a busy Knowledge Base", "ConflictException"],
    ["a lost StartIngestionJob acknowledgement", "TimeoutError"],
  ])(
    "waits and retries after %s with the same persisted idempotency token",
    async (_label, errorName) => {
      const start = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("Ingestion start was not confirmed"), { name: errorName }),
        )
        .mockResolvedValueOnce({ jobId: "ingestion-job-1" });
      const ingestion = makeIngestion({ start });
      const { worker, store } = await makeWorkerContext({
        operation: confirmedUploadOperation(),
        document: confirmedDocument(),
        ingestion,
      });
      store.updateOperation.mockRejectedValueOnce(
        Object.assign(new Error("DynamoDB acknowledgement was lost"), { name: "TimeoutError" }),
      );
      store.recordIngestionJob.mockRejectedValueOnce(
        Object.assign(new Error("DynamoDB acknowledgement was lost"), { name: "TimeoutError" }),
      );

      await expect(run(worker, "start-ingestion")).resolves.toMatchObject({ status: "waiting" });
      const persisted = await store.getOperation({ operationId });
      expect(persisted.ingestionClientToken).toMatch(/^[a-f0-9]{64}$/);
      await expect(run(worker, "start-ingestion")).resolves.toMatchObject({ status: "ready" });

      expect(start).toHaveBeenCalledTimes(2);
      expect(start.mock.calls[0][0].clientToken).toBe(start.mock.calls[1][0].clientToken);
      expect(store.recordIngestionJob).toHaveBeenCalledTimes(2);
      expect(store.recordIngestionJob.mock.calls.map(([input]) => input)).toEqual([
        { operationId, jobId: "ingestion-job-1" },
        { operationId, jobId: "ingestion-job-1" },
      ]);
    },
  );

  it("reprocesses a confirmed source without copying the file or invoking a model", async () => {
    const operation = phase11Operation({
      operationId: "reprocess-1",
      documentId,
      action: "reprocess",
      status: "processing",
      stage: "ingestion",
      revision,
      source: {
        status: "confirmed",
        bucket: documentBucketName,
        key: expectedKey,
        uri: expectedUri,
        sizeBytes: textBytes.byteLength,
        sha256: sha256(textBytes),
      },
    });
    const document = {
      documentId,
      name: "lesson.txt",
      sizeBytes: textBytes.byteLength,
      revision,
      state: "active",
      pendingRemovalKeys: [],
      source: {
        status: "confirmed",
        bucket: documentBucketName,
        key: expectedKey,
        uri: expectedUri,
        sizeBytes: textBytes.byteLength,
        sha256: sha256(textBytes),
      },
    };
    const objects = makeObjects();
    const ingestion = makeIngestion();
    const { worker, store } = await makeWorkerContext({ operation, document, objects, ingestion });

    await run(worker, "validate", operation.operationId);
    await run(worker, "promote", operation.operationId);
    await run(worker, "start-ingestion", operation.operationId);

    expect(objects.head).not.toHaveBeenCalled();
    expect(objects.get).not.toHaveBeenCalled();
    expect(objects.copy).not.toHaveBeenCalled();
    expect(store.recordSource).not.toHaveBeenCalled();
    expect(ingestion.start).toHaveBeenCalledOnce();
    expect(ingestion.start.mock.calls[0][0]).toMatchObject({ dataSourceId: "source-docentes" });
  });

  it("does not let a late terminal result overwrite a newer operation owner", async () => {
    const storeOverrides = {
      finishOperation: vi.fn(async () => false),
    };
    const { worker, store } = await makeWorkerContext({
      operation: confirmedUploadOperation(),
      document: confirmedDocument(),
      storeOverrides,
    });
    await run(worker, "start-ingestion");
    await run(worker, "observe-ingestion");
    const updatesBeforeFinish = store.updateOperation.mock.calls.length;
    const result = await run(worker, "finish");

    expect(store.finishOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId, outcome: "completed" }),
    );
    expect(result).toMatchObject({ status: "unconfirmed" });
    expect(store.updateOperation).toHaveBeenCalledTimes(updatesBeforeFinish);
  });
});
