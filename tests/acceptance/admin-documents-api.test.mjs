import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAdminHandler } from "../../api/admin.ts";
import {
  phase11AdminClaims,
  phase11AdminEvent,
  phase11AdminGroup,
  phase11BotId,
  phase11Now,
  phase11Operation,
  phase11ResponseBody,
} from "../support/phase11-documents-backend.mjs";

const pathFor = (suffix) => `/api/admin/bots/${phase11BotId}/${suffix}`;
const tokenExpiresAt = phase11Now + 60_000;
const uploadKeyFor = (operationId, name) =>
  `incoming/${createHash("sha256").update(operationId).digest("hex")}/${createHash("sha256")
    .update(name)
    .digest("hex")}.${name.toLowerCase().split(".").at(-1)}`;

function makeApi(documentAdministrations, { bots = [phase11BotId] } = {}) {
  const configuredBots = bots.map((botId) => ({
    botId,
    projectName: botId,
    siteUrl: `https://${botId}.example.test/`,
  }));
  return createAdminHandler({
    config: {
      clientId: "admin-client",
      adminGroup: phase11AdminGroup,
      sender: null,
      invitationTtlMs: 60_000,
      bots: configuredBots,
    },
    stores: Object.fromEntries(bots.map((botId) => [botId, {}])),
    documentAdministrations,
    identity: { getUserByEmail: vi.fn(), createUser: vi.fn() },
    mail: { sendInvitation: vi.fn() },
    now: () => phase11Now,
    randomBytes: vi.fn(() => Buffer.alloc(32)),
  });
}

function routePort(overrides = {}) {
  return {
    list: vi.fn(async ({ cursor }) => ({
      documents: [],
      nextCursor: cursor === "page-2" ? null : "page-2",
      activeOperation: null,
      lastOperation: null,
    })),
    createIntent: vi.fn(async ({ operationId, action }) => ({
      operation: phase11Operation({ operationId, action }),
      upload: undefined,
    })),
    start: vi.fn(async ({ operationId }) => ({
      operation: phase11Operation({ operationId, status: "processing", stage: "validation" }),
      startConfirmed: true,
    })),
    get: vi.fn(async ({ operationId }) => ({
      operation: phase11Operation({ operationId }),
    })),
    ...overrides,
  };
}

function loadDocumentAdministration() {
  return import("../../api/document-administration.ts").then((module) => {
    expect(
      typeof module.createDocumentAdministration,
      "Expected the production api/document-administration.ts#createDocumentAdministration factory",
    ).toBe("function");
    return module.createDocumentAdministration;
  });
}

describe("document administration HTTP routing", () => {
  it("checks admin authorization and the server bot catalog before calling document services", async () => {
    const documents = routePort();
    const handler = makeApi({ [phase11BotId]: documents });

    const noBearer = await handler(
      phase11AdminEvent({ method: "GET", path: pathFor("documents"), token: null }),
    );
    const wrongGroup = await handler(
      phase11AdminEvent({
        method: "GET",
        path: pathFor("documents"),
        claims: phase11AdminClaims({ groups: ["teacher"] }),
      }),
    );
    const unknownBot = await handler(
      phase11AdminEvent({
        method: "GET",
        path: "/api/admin/bots/other/documents",
      }),
    );

    expect(noBearer.statusCode).toBe(401);
    expect(wrongGroup.statusCode).toBe(403);
    expect(unknownBot.statusCode).toBe(404);
    expect(documents.list).not.toHaveBeenCalled();
    expect(documents.createIntent).not.toHaveBeenCalled();
    expect(documents.start).not.toHaveBeenCalled();
    expect(documents.get).not.toHaveBeenCalled();
  });

  it("routes listing, intent, start, and operation reads without caching or replaying a GET", async () => {
    const documents = routePort();
    const handler = makeApi({ [phase11BotId]: documents });
    const operationId = "operation-7";

    const listing = await handler(
      phase11AdminEvent({
        method: "GET",
        path: pathFor("documents"),
        query: { cursor: "page-1" },
      }),
    );
    const intent = await handler(
      phase11AdminEvent({
        method: "POST",
        path: pathFor("document-operations"),
        body: {
          operationId,
          action: "upload",
          file: { name: "lesson.txt", sizeBytes: 12, sha256: "a".repeat(64) },
        },
      }),
    );
    const started = await handler(
      phase11AdminEvent({
        method: "POST",
        path: pathFor(`document-operations/${operationId}/start`),
        body: {},
      }),
    );
    const read = await handler(
      phase11AdminEvent({
        method: "GET",
        path: pathFor(`document-operations/${operationId}`),
      }),
    );

    expect(documents.list).toHaveBeenCalledWith(expect.objectContaining({ cursor: "page-1" }));
    expect(documents.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        action: "upload",
        actorSub: "admin-sub",
        tokenExpiresAt,
      }),
    );
    expect(documents.start).toHaveBeenCalledWith(expect.objectContaining({ operationId }));
    expect(documents.get).toHaveBeenCalledWith(expect.objectContaining({ operationId }));
    for (const response of [listing, intent, started, read]) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(phase11ResponseBody(listing)).toMatchObject({ botId: phase11BotId });
    expect(phase11ResponseBody(intent)).toMatchObject({ botId: phase11BotId });
    expect(phase11ResponseBody(read)).toMatchObject({ botId: phase11BotId });
    expect(typeof phase11ResponseBody(intent).operation.updatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(phase11ResponseBody(intent).operation.updatedAt))).toBe(true);
    expect(documents.get).toHaveBeenCalledOnce();
    expect(documents.start).toHaveBeenCalledOnce();
  });

  it("rejects malformed JSON and a nonempty start body before service effects", async () => {
    const documents = routePort();
    const handler = makeApi({ [phase11BotId]: documents });

    const malformed = await handler({
      ...phase11AdminEvent({ method: "POST", path: pathFor("document-operations") }),
      body: "{",
    });
    const badStart = await handler(
      phase11AdminEvent({
        method: "POST",
        path: pathFor("document-operations/operation-8/start"),
        body: { sourceKey: "prepared/attacker/file.txt" },
      }),
    );

    expect(malformed.statusCode).toBe(400);
    expect(badStart.statusCode).toBe(400);
    expect(documents.createIntent).not.toHaveBeenCalled();
    expect(documents.start).not.toHaveBeenCalled();
  });
});

describe("document intention acceptance through the real admin composition", () => {
  it("validates declared file details and signs the server-selected incoming destination", async () => {
    const createDocumentAdministration = await loadDocumentAdministration();
    const store = {
      listDocuments: vi.fn(async () => ({
        documents: [
          {
            documentId: "failed-document",
            state: "active",
            name: "lesson-failed.txt",
            sizeBytes: 12,
            revision: "revision-failed",
            updatedAt: phase11Now,
            source: null,
            pendingRemovalKeys: [],
            canRetry: true,
            processing: {
              status: "failed",
              operationId: "failed-A",
              error: { code: "INGESTION_FAILED", message: "La fuente requiere reproceso." },
            },
          },
        ],
        nextCursor: "next-page",
        activeOperation: phase11Operation({
          operationId: "reprocess-active",
          documentId: "document-1",
          action: "reprocess",
          status: "pending_start",
          stage: "source",
        }),
        lastOperation: null,
      })),
      createIntent: vi.fn(async (input) => ({
        created: true,
        operation: phase11Operation({
          operationId: input.operationId,
          documentId: input.documentId,
          action: input.action,
          revision: input.candidateRevision,
          file: input.file,
          uploadKey: input.uploadKey,
        }),
      })),
      getOperation: vi.fn(async () => null),
      getDocument: vi.fn(async ({ documentId }) =>
        documentId === "document-1"
          ? {
              documentId,
              state: "active",
              name: "lesson.txt",
              revision: "revision-9",
              source: {
                status: "confirmed",
                bucket: "prepared-docentes",
                key: "prepared/document-1/revision-9/lesson.txt",
                uri: "s3://prepared-docentes/prepared/document-1/revision-9/lesson.txt",
                sha256: "d".repeat(64),
                sizeBytes: 12,
              },
              pendingRemovalKeys: ["prepared/document-1/revision-8/lesson-old.txt"],
            }
          : null,
      ),
      reserveOperation: vi.fn(),
      recordSource: vi.fn(),
      recordIngestionJob: vi.fn(),
      updateOperation: vi.fn(async () => true),
      finishOperation: vi.fn(),
    };
    const uploadSigner = {
      createPost: vi.fn(async (input) => ({
        url: "https://s3.example.test/",
        fields: { key: input.key, "x-amz-checksum-algorithm": "SHA256" },
        expiresAt: input.expiresAt,
      })),
    };
    const service = createDocumentAdministration({
      botId: phase11BotId,
      store,
      uploadBucketName: "temporary-docentes",
      documentBucketName: "prepared-docentes",
      incomingPrefix: "incoming/",
      preparedPrefix: "prepared/",
      uploadSigner,
      objects: { head: vi.fn() },
      execution: { start: vi.fn(), get: vi.fn() },
      now: () => phase11Now,
      randomUUID: vi.fn(() => "candidate-revision"),
    });
    const handler = makeApi({ [phase11BotId]: service });
    const body = {
      operationId: "upload-9",
      action: "upload",
      file: { name: "Lesson notes.txt", sizeBytes: 50_000_000, sha256: "b".repeat(64) },
    };

    const accepted = await handler(
      phase11AdminEvent({ method: "POST", path: pathFor("document-operations"), body }),
    );
    const signerInput = uploadSigner.createPost.mock.calls[0]?.[0];

    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(phase11ResponseBody(accepted).operation.documentName).toBe("Lesson notes.txt");
    expect(store.createIntent).toHaveBeenCalledOnce();
    expect(uploadSigner.createPost).toHaveBeenCalledOnce();
    expect(signerInput).toMatchObject({
      bucket: "temporary-docentes",
      name: "Lesson notes.txt",
      sizeBytes: 50_000_000,
      sha256: "b".repeat(64),
      contentType: "text/plain",
      expiresAt: Math.min(phase11Now + 5 * 60_000, tokenExpiresAt),
    });
    expect(store.createIntent.mock.invocationCallOrder[0]).toBeLessThan(
      uploadSigner.createPost.mock.invocationCallOrder[0],
    );
    expect(signerInput.bucket).not.toBe("prepared-docentes");
    expect(signerInput.key).toMatch(/^incoming\//);
    expect(signerInput.key.split("/")).not.toContain("..");
    expect(phase11ResponseBody(accepted).upload.fields.key).toBe(signerInput.key);

    const readsBeforeList = store.getOperation.mock.calls.length;
    const listing = await handler(phase11AdminEvent({ method: "GET", path: pathFor("documents") }));
    expect(listing.statusCode).toBe(200);
    expect(phase11ResponseBody(listing).documents).toMatchObject([
      {
        documentId: "failed-document",
        canRetry: true,
        processing: { status: "failed", operationId: "failed-A" },
      },
    ]);
    expect(phase11ResponseBody(listing).documents[0]).not.toHaveProperty("source");
    expect(store.getOperation).toHaveBeenCalledTimes(readsBeforeList);
    expect(phase11ResponseBody(listing).nextCursor).toBe("next-page");
    expect(phase11ResponseBody(listing).activeOperation).toMatchObject({
      action: "reprocess",
      documentId: "document-1",
      documentName: "lesson.txt",
    });

    const formats = ["txt", "md", "html", "doc", "docx", "csv", "xls", "xlsx", "pdf"];
    for (const extension of formats) {
      const response = await handler(
        phase11AdminEvent({
          method: "POST",
          path: pathFor("document-operations"),
          body: {
            operationId: `format-${extension}`,
            action: "upload",
            file: {
              name: `prepared.${extension}`,
              sizeBytes: 1,
              sha256: "c".repeat(64),
            },
          },
        }),
      );
      expect(response.statusCode, `Expected .${extension} to be accepted`).toBe(201);
    }

    const reprocess = await handler(
      phase11AdminEvent({
        method: "POST",
        path: pathFor("document-operations"),
        body: {
          operationId: "reprocess-1",
          action: "reprocess",
          documentId: "document-1",
          expectedRevision: "revision-9",
        },
      }),
    );
    expect(reprocess.statusCode).toBe(201);
    expect(uploadSigner.createPost).toHaveBeenCalledTimes(formats.length + 1);

    store.getOperation.mockResolvedValueOnce(
      phase11Operation({ operationId: "upload-9", action: "upload", uploadKey: signerInput.key }),
    );
    const read = await handler(
      phase11AdminEvent({
        method: "GET",
        path: pathFor("document-operations/upload-9"),
      }),
    );
    expect(read.statusCode).toBe(200);
    expect(uploadSigner.createPost).toHaveBeenCalledTimes(formats.length + 1);
    expect(phase11ResponseBody(read).operation.operationId).toBe("upload-9");
    expect(store.createIntent.mock.calls.at(-1)[0]).toMatchObject({
      operationId: "reprocess-1",
      action: "reprocess",
      documentId: "document-1",
      expectedRevision: "revision-9",
    });

    for (const invalidBody of [
      { ...body, file: { ...body.file, sizeBytes: 50_000_001 } },
      { ...body, file: { ...body.file, sizeBytes: 0 } },
      { ...body, file: { ...body.file, sha256: "not-a-checksum" } },
      { ...body, file: { ...body.file, name: "lesson.exe" } },
      { ...body, sourceKey: "prepared/other-bot/file.txt" },
    ]) {
      const invalid = await handler(
        phase11AdminEvent({
          method: "POST",
          path: pathFor("document-operations"),
          body: invalidBody,
        }),
      );
      expect([400, 413]).toContain(invalid.statusCode);
    }
    const createdIntentCount = formats.length + 2;
    expect(store.createIntent).toHaveBeenCalledTimes(createdIntentCount);
    expect(uploadSigner.createPost).toHaveBeenCalledTimes(formats.length + 1);
  });

  it("checks the uploaded receipt before reserving, recovers a lost execution ACK with the same canonical input, and keeps GET read-only", async () => {
    const createDocumentAdministration = await loadDocumentAdministration();
    const fileBytes = Buffer.from("A prepared lesson.", "utf8");
    const digest = createHash("sha256").update(fileBytes).digest("hex");
    const operation = phase11Operation({
      operationId: "start-10",
      documentId: "document-10",
      action: "upload",
      status: "awaiting_upload",
      stage: "upload",
      revision: "candidate-10",
      file: { name: "lesson.txt", sizeBytes: fileBytes.byteLength, sha256: digest },
      uploadKey: uploadKeyFor("start-10", "lesson.txt"),
    });
    let storedOperation = structuredClone(operation);
    const store = {
      listDocuments: vi.fn(async () => ({ documents: [], nextCursor: null })),
      getOperation: vi.fn(async () => structuredClone(storedOperation)),
      getDocument: vi.fn(async () => null),
      createIntent: vi.fn(),
      reserveOperation: vi.fn(async (input) => {
        storedOperation = {
          ...storedOperation,
          executionName: input.executionName,
          executionInput: input.executionInput,
          status: "processing",
        };
        return { reserved: true, operation: structuredClone(storedOperation) };
      }),
      recordSource: vi.fn(),
      recordIngestionJob: vi.fn(),
      updateOperation: vi.fn(async () => true),
      finishOperation: vi.fn(),
    };
    let receipt = null;
    const objects = {
      head: vi.fn(async () => receipt),
    };
    const executions = new Map();
    const execution = {
      start: vi.fn(async ({ name, input }) => {
        if (!executions.has(name)) {
          executions.set(name, { input, status: "RUNNING" });
          throw Object.assign(new Error("StartExecution acknowledgement lost"), {
            name: "TimeoutError",
          });
        }
        throw Object.assign(new Error("Execution already exists"), {
          name: "ExecutionAlreadyExists",
        });
      }),
      get: vi.fn(async ({ name }) => executions.get(name) ?? null),
    };
    const service = createDocumentAdministration({
      botId: phase11BotId,
      store,
      uploadBucketName: "temporary-docentes",
      documentBucketName: "prepared-docentes",
      incomingPrefix: "incoming/",
      preparedPrefix: "prepared/",
      uploadSigner: { createPost: vi.fn() },
      objects,
      execution,
      now: () => phase11Now,
      randomUUID: vi.fn(() => "unused-revision"),
    });
    const handler = makeApi({ [phase11BotId]: service });
    const startPath = pathFor("document-operations/start-10/start");

    const beforeUpload = await handler(
      phase11AdminEvent({ method: "POST", path: startPath, body: {} }),
    );
    expect(beforeUpload.statusCode).toBe(409);
    expect(phase11ResponseBody(beforeUpload)).toMatchObject({ code: "UPLOAD_NOT_READY" });
    expect(store.reserveOperation).not.toHaveBeenCalled();
    expect(execution.start).not.toHaveBeenCalled();

    receipt = {
      contentLength: fileBytes.byteLength + 1,
      checksumSHA256: Buffer.from(digest, "hex").toString("base64"),
    };
    const mismatch = await handler(
      phase11AdminEvent({ method: "POST", path: startPath, body: {} }),
    );
    expect(mismatch.statusCode).toBe(400);
    expect(phase11ResponseBody(mismatch)).toMatchObject({
      code: "INVALID_INPUT",
      fields: ["file"],
    });
    expect(store.reserveOperation).not.toHaveBeenCalled();
    expect(execution.start).not.toHaveBeenCalled();

    receipt = {
      contentLength: fileBytes.byteLength,
      checksumSHA256: Buffer.from(digest, "hex").toString("base64"),
    };
    store.reserveOperation.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Document operation already active"), {
        code: "DOCUMENT_OPERATION_ACTIVE",
      });
    });
    const activeConflict = await handler(
      phase11AdminEvent({ method: "POST", path: startPath, body: {} }),
    );
    expect(activeConflict.statusCode).toBe(409);
    expect(phase11ResponseBody(activeConflict)).toMatchObject({
      code: "DOCUMENT_OPERATION_ACTIVE",
    });
    expect(execution.start).not.toHaveBeenCalled();

    const firstStart = await handler(
      phase11AdminEvent({ method: "POST", path: startPath, body: {} }),
    );
    const replay = await handler(phase11AdminEvent({ method: "POST", path: startPath, body: {} }));
    const startsBeforeRead = execution.start.mock.calls.length;
    const read = await handler(
      phase11AdminEvent({
        method: "GET",
        path: pathFor("document-operations/start-10"),
      }),
    );

    expect([202, 503]).toContain(firstStart.statusCode);
    expect(replay.statusCode).toBe(202);
    expect(phase11ResponseBody(replay).operation.status).toBe("processing");
    expect(objects.head).toHaveBeenCalledWith({
      bucket: "temporary-docentes",
      key: operation.uploadKey,
    });
    expect(store.reserveOperation).toHaveBeenCalled();
    expect(execution.start).toHaveBeenCalled();
    const startInputs = execution.start.mock.calls.map(([input]) => input);
    const normalizeInput = (input) => (typeof input === "string" ? JSON.parse(input) : input);
    expect(new Set(startInputs.map(({ name }) => name)).size).toBe(1);
    for (const { input } of startInputs) {
      expect(normalizeInput(input)).toEqual(normalizeInput(startInputs[0].input));
    }
    expect(normalizeInput(startInputs[0].input)).toEqual({
      botId: phase11BotId,
      operationId: "start-10",
      step: "validate",
    });
    expect(executions).toHaveProperty("size", 1);
    expect(read.statusCode).toBe(200);
    expect(execution.start).toHaveBeenCalledTimes(startsBeforeRead);
    expect(store.reserveOperation.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("accepts replace/withdraw on the observed revision, rejects stale or unavailable targets, and never uploads for withdrawal", async () => {
    const createDocumentAdministration = await loadDocumentAdministration();
    const source = {
      status: "confirmed",
      bucket: "prepared-docentes",
      key: "prepared/document-current/revision-current/lesson-a.txt",
      uri: "s3://prepared-docentes/prepared/document-current/revision-current/lesson-a.txt",
      sha256: "a".repeat(64),
      sizeBytes: 10,
    };
    const docs = new Map([
      [
        "document-current",
        {
          documentId: "document-current",
          state: "active",
          name: "lesson-a.txt",
          sizeBytes: 10,
          revision: "revision-current",
          updatedAt: new Date(phase11Now).toISOString(),
          source,
          pendingRemovalKeys: [],
          processing: { status: "completed", operationId: "prior-op" },
        },
      ],
      [
        "document-pending",
        {
          documentId: "document-pending",
          state: "active",
          name: "lesson-pending.txt",
          sizeBytes: 10,
          revision: "revision-pending",
          source,
          pendingRemovalKeys: ["prepared/document-pending/old/orphan.txt"],
        },
      ],
      [
        "document-withdrawn",
        {
          documentId: "document-withdrawn",
          state: "withdrawn",
          name: "lesson-old.txt",
          revision: "revision-retired",
          source: null,
          pendingRemovalKeys: [],
        },
      ],
      [
        "document-withdraw-retry",
        {
          documentId: "document-withdraw-retry",
          state: "active",
          name: "lesson-retired.txt",
          sizeBytes: 18,
          revision: "revision-retry",
          source: null,
          pendingRemovalKeys: [],
          lastOperationId: "withdraw-failed-1",
        },
      ],
    ]);
    const priorRemovalUris = [
      "s3://prepared-docentes/prepared/document-withdraw-retry/revision-5/lesson.txt",
      "s3://prepared-docentes/prepared/document-withdraw-retry/revision-4/lesson-old.txt",
    ];
    const priorWithdrawal = phase11Operation({
      operationId: "withdraw-failed-1",
      documentId: "document-withdraw-retry",
      action: "withdraw",
      status: "failed",
      stage: "result",
      revision: "revision-retry",
      sourceUrisToObserve: priorRemovalUris,
    });
    const replacementOperation = phase11Operation({
      operationId: "replace-valid",
      documentId: "document-current",
      action: "replace",
      status: "awaiting_upload",
      stage: "upload",
      revision: "revision-candidate",
      file: { name: "lesson-b.txt", sizeBytes: 14, sha256: "b".repeat(64) },
      uploadKey: "incoming/document-current/revision-candidate/lesson-b.txt",
    });
    const withdrawalOperation = phase11Operation({
      operationId: "withdraw-valid",
      documentId: "document-current",
      action: "withdraw",
      status: "pending_start",
      stage: "source",
      revision: "revision-current",
      expectedRevision: "revision-current",
    });
    const pendingWithdrawalOperation = phase11Operation({
      operationId: "withdraw-pending",
      documentId: "document-pending",
      action: "withdraw",
      status: "pending_start",
      stage: "source",
      revision: "revision-pending",
    });
    const retryWithdrawalOperation = phase11Operation({
      operationId: "withdraw-retry-2",
      documentId: "document-withdraw-retry",
      action: "withdraw",
      status: "pending_start",
      stage: "source",
      revision: "revision-retry",
      sourceUrisToObserve: priorRemovalUris,
    });
    const operations = new Map([
      [priorWithdrawal.operationId, priorWithdrawal],
      [withdrawalOperation.operationId, withdrawalOperation],
    ]);
    const store = {
      listDocuments: vi.fn(async () => ({ documents: [], nextCursor: null })),
      getOperation: vi.fn(async ({ operationId }) => operations.get(operationId) ?? null),
      getDocument: vi.fn(async ({ documentId }) => docs.get(documentId) ?? null),
      createIntent: vi
        .fn()
        .mockResolvedValueOnce({ created: true, operation: replacementOperation })
        .mockResolvedValueOnce({ created: true, operation: withdrawalOperation })
        .mockResolvedValueOnce({ created: true, operation: pendingWithdrawalOperation })
        .mockResolvedValueOnce({ created: true, operation: retryWithdrawalOperation })
        .mockResolvedValueOnce({ created: false, operation: withdrawalOperation }),
      reserveOperation: vi.fn(async ({ operationId }) => ({
        reserved: true,
        operation: operations.get(operationId),
      })),
      recordSource: vi.fn(),
      recordIngestionJob: vi.fn(),
      updateOperation: vi.fn(async () => true),
      finishOperation: vi.fn(),
    };
    const uploadSigner = {
      createPost: vi.fn(async (input) => ({
        url: "https://s3.example.test/",
        fields: { key: input.key, "x-amz-checksum-algorithm": "SHA256" },
        expiresAt: input.expiresAt,
      })),
    };
    const objects = { head: vi.fn(async () => null) };
    const execution = {
      start: vi.fn(async ({ name }) => ({ executionArn: `arn:example:execution:${name}` })),
      get: vi.fn(async () => null),
    };
    const service = createDocumentAdministration({
      botId: phase11BotId,
      store,
      uploadBucketName: "temporary-docentes",
      documentBucketName: "prepared-docentes",
      incomingPrefix: "incoming/",
      preparedPrefix: "prepared/",
      uploadSigner,
      objects,
      execution,
      now: () => phase11Now,
      randomUUID: vi.fn(() => "revision-candidate"),
    });
    const handler = makeApi({ [phase11BotId]: service });
    const operationsPath = pathFor("document-operations");
    const replacementBody = {
      operationId: "replace-valid",
      action: "replace",
      documentId: "document-current",
      expectedRevision: "revision-current",
      file: { name: "lesson-b.txt", sizeBytes: 14, sha256: "b".repeat(64) },
    };
    const replacement = await handler(
      phase11AdminEvent({ method: "POST", path: operationsPath, body: replacementBody }),
    );
    expect(replacement.statusCode).toBe(201);
    expect(phase11ResponseBody(replacement).operation).toMatchObject({
      operationId: "replace-valid",
      action: "replace",
      documentId: "document-current",
    });
    expect(store.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "replace-valid",
        action: "replace",
        documentId: "document-current",
        expectedRevision: "revision-current",
        file: expect.objectContaining(replacementBody.file),
      }),
    );
    expect(uploadSigner.createPost).toHaveBeenCalledOnce();

    const withdrawalBody = {
      operationId: "withdraw-valid",
      action: "withdraw",
      documentId: "document-current",
      expectedRevision: "revision-current",
    };
    const withdrawal = await handler(
      phase11AdminEvent({ method: "POST", path: operationsPath, body: withdrawalBody }),
    );
    expect(withdrawal.statusCode).toBe(201);
    expect(phase11ResponseBody(withdrawal).operation).toMatchObject({
      operationId: "withdraw-valid",
      action: "withdraw",
      documentId: "document-current",
    });
    expect(phase11ResponseBody(withdrawal)).not.toHaveProperty("upload");
    expect(store.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "withdraw-valid",
        action: "withdraw",
        documentId: "document-current",
        expectedRevision: "revision-current",
      }),
    );
    expect(store.createIntent.mock.calls.at(-1)[0]).not.toHaveProperty("file");
    expect(uploadSigner.createPost).toHaveBeenCalledOnce();

    const pendingWithdrawalBody = {
      operationId: "withdraw-pending",
      action: "withdraw",
      documentId: "document-pending",
      expectedRevision: "revision-pending",
    };
    const pendingWithdrawal = await handler(
      phase11AdminEvent({
        method: "POST",
        path: operationsPath,
        body: pendingWithdrawalBody,
      }),
    );
    expect(pendingWithdrawal.statusCode).toBe(201);
    expect(phase11ResponseBody(pendingWithdrawal)).not.toHaveProperty("upload");
    expect(uploadSigner.createPost).toHaveBeenCalledOnce();
    expect(objects.head).not.toHaveBeenCalled();

    const retryWithdrawalBody = {
      operationId: "withdraw-retry-2",
      action: "withdraw",
      documentId: "document-withdraw-retry",
      expectedRevision: "revision-retry",
    };
    const retryWithdrawal = await handler(
      phase11AdminEvent({
        method: "POST",
        path: operationsPath,
        body: retryWithdrawalBody,
      }),
    );
    expect(retryWithdrawal.statusCode).toBe(201);
    expect(phase11ResponseBody(retryWithdrawal).operation).toMatchObject({
      operationId: "withdraw-retry-2",
      action: "withdraw",
    });
    expect(phase11ResponseBody(retryWithdrawal).operation).not.toHaveProperty(
      "sourceUrisToObserve",
    );
    expect(phase11ResponseBody(retryWithdrawal).operation).not.toHaveProperty("source");
    expect(phase11ResponseBody(retryWithdrawal).operation).not.toHaveProperty("pendingRemovalKeys");
    expect(store.createIntent.mock.calls.at(-1)[0]).toMatchObject({
      operationId: "withdraw-retry-2",
      action: "withdraw",
      documentId: "document-withdraw-retry",
      expectedRevision: "revision-retry",
      sourceUrisToObserve: priorRemovalUris,
    });
    expect(phase11ResponseBody(retryWithdrawal)).not.toHaveProperty("upload");
    expect(uploadSigner.createPost).toHaveBeenCalledOnce();
    expect(objects.head).not.toHaveBeenCalled();

    const startPath = pathFor("document-operations/withdraw-valid/start");
    const started = await handler(phase11AdminEvent({ method: "POST", path: startPath, body: {} }));
    expect(started.statusCode).toBe(202);
    expect(objects.head).not.toHaveBeenCalled();
    expect(uploadSigner.createPost).toHaveBeenCalledOnce();
    expect(execution.start).toHaveBeenCalledOnce();

    const getOperation = await handler(
      phase11AdminEvent({ method: "GET", path: pathFor("document-operations/withdraw-valid") }),
    );
    const replay = await handler(
      phase11AdminEvent({ method: "POST", path: operationsPath, body: withdrawalBody }),
    );
    expect(getOperation.statusCode).toBe(200);
    expect(phase11ResponseBody(replay).operation.operationId).toBe("withdraw-valid");
    expect(execution.start).toHaveBeenCalledOnce();
    expect(store.reserveOperation).toHaveBeenCalledOnce();
    expect(store.reserveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "withdraw-valid",
        sourceUrisToObserve: [source.uri],
      }),
    );
    expect(objects.head).not.toHaveBeenCalled();
    expect(uploadSigner.createPost).toHaveBeenCalledOnce();

    const writesBeforeInvalid = store.createIntent.mock.calls.length;
    for (const [documentId, expectedRevision, expectedStatus] of [
      ["document-current", "revision-stale", 409],
      ["document-pending", "revision-pending", 409],
      ["document-withdrawn", "revision-retired", 409],
      ["foreign-document", "revision-current", 404],
    ]) {
      const invalid = await handler(
        phase11AdminEvent({
          method: "POST",
          path: operationsPath,
          body: {
            operationId: `replace-invalid-${documentId}`,
            action: "replace",
            documentId,
            expectedRevision,
            file: { name: "lesson-b.txt", sizeBytes: 14, sha256: "b".repeat(64) },
          },
        }),
      );
      expect(invalid.statusCode).toBe(expectedStatus);
    }
    const staleWithdrawal = await handler(
      phase11AdminEvent({
        method: "POST",
        path: operationsPath,
        body: {
          operationId: "withdraw-stale",
          action: "withdraw",
          documentId: "document-current",
          expectedRevision: "revision-stale",
        },
      }),
    );
    const withdrawnAgain = await handler(
      phase11AdminEvent({
        method: "POST",
        path: operationsPath,
        body: {
          operationId: "withdraw-again",
          action: "withdraw",
          documentId: "document-withdrawn",
          expectedRevision: "revision-retired",
        },
      }),
    );
    const invalidWithdrawal = await handler(
      phase11AdminEvent({
        method: "POST",
        path: operationsPath,
        body: { ...withdrawalBody, operationId: "withdraw-with-file", file: replacementBody.file },
      }),
    );
    expect(staleWithdrawal.statusCode).toBe(409);
    expect(withdrawnAgain.statusCode).toBe(409);
    expect(invalidWithdrawal.statusCode).toBe(400);
    expect(store.createIntent).toHaveBeenCalledTimes(writesBeforeInvalid);
    expect(uploadSigner.createPost).toHaveBeenCalledOnce();
    expect(objects.head).not.toHaveBeenCalled();
  });

  it("preserves caller document and expected revision when replaying an existing operation ID", async () => {
    const existing = phase11Operation({
      operationId: "replace-replay",
      action: "replace",
      documentId: "document-original",
      revision: "revision-candidate",
      expectedRevision: "revision-1",
      status: "awaiting_upload",
      stage: "upload",
      file: { name: "lesson.txt", sizeBytes: 12, sha256: "a".repeat(64) },
      uploadKey: "incoming/receipt-original.txt",
    });
    const store = {
      listDocuments: vi.fn(),
      getOperation: vi.fn(async () => existing),
      getDocument: vi.fn(),
      createIntent: vi.fn(async () => ({ created: false, operation: existing })),
      reserveOperation: vi.fn(),
      recordSource: vi.fn(),
      recordIngestionJob: vi.fn(),
      updateOperation: vi.fn(async () => true),
      finishOperation: vi.fn(),
    };
    const createDocumentAdministration = await loadDocumentAdministration();
    const service = createDocumentAdministration({
      botId: phase11BotId,
      store,
      uploadBucketName: "temporary-docentes",
      documentBucketName: "prepared-docentes",
      incomingPrefix: "incoming/",
      preparedPrefix: "prepared/",
      uploadSigner: {
        createPost: vi.fn(async (input) => ({
          url: "https://s3.example.test/",
          fields: { key: input.key },
          expiresAt: input.expiresAt,
        })),
      },
      objects: { head: vi.fn() },
      execution: { start: vi.fn(), get: vi.fn() },
      now: () => phase11Now,
      randomUUID: vi.fn(() => "unused-revision"),
    });

    await service.createIntent({
      operationId: "replace-replay",
      action: "replace",
      documentId: "document-new-request",
      expectedRevision: "revision-2",
      file: { name: "lesson.txt", sizeBytes: 12, sha256: "a".repeat(64) },
      actorSub: "admin-sub",
      tokenExpiresAt,
    });

    expect(store.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "replace-replay",
        action: "replace",
        documentId: "document-new-request",
        expectedRevision: "revision-2",
      }),
    );
  });

  it("projects an unavailable or terminal Step Functions execution as unconfirmed without changing the receipt", async () => {
    const operation = phase11Operation({
      operationId: "execution-observation-1",
      action: "upload",
      status: "processing",
      stage: "validation",
      executionName: "doc-1",
      executionInput: {
        botId: phase11BotId,
        operationId: "execution-observation-1",
        step: "validate",
      },
    });
    const store = {
      listDocuments: vi.fn(),
      getOperation: vi.fn(async () => operation),
      getDocument: vi.fn(),
      createIntent: vi.fn(),
      reserveOperation: vi.fn(),
      recordSource: vi.fn(),
      recordIngestionJob: vi.fn(),
      updateOperation: vi.fn(),
      finishOperation: vi.fn(),
    };
    const execution = {
      start: vi.fn(),
      get: vi.fn(async () => ({
        executionArn: "arn:example:execution:doc-1",
        status: "TIMED_OUT",
        input: JSON.stringify(operation.executionInput),
      })),
    };
    const createDocumentAdministration = await loadDocumentAdministration();
    const service = createDocumentAdministration({
      botId: phase11BotId,
      store,
      uploadBucketName: "temporary-docentes",
      documentBucketName: "prepared-docentes",
      incomingPrefix: "incoming/",
      preparedPrefix: "prepared/",
      uploadSigner: { createPost: vi.fn() },
      objects: { head: vi.fn() },
      execution,
      now: () => phase11Now,
      randomUUID: vi.fn(),
    });
    const handler = makeApi({ [phase11BotId]: service });

    const response = await handler(
      phase11AdminEvent({
        method: "GET",
        path: pathFor("document-operations/execution-observation-1"),
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(phase11ResponseBody(response).operation.status).toBe("unconfirmed");
    expect(execution.get).toHaveBeenCalledWith({ name: "doc-1" });
    expect(execution.start).not.toHaveBeenCalled();
    expect(store.updateOperation).not.toHaveBeenCalled();
    expect(store.finishOperation).not.toHaveBeenCalled();
  });

  it("allows only an explicit start to reuse the same identity after Describe confirms absence", async () => {
    const operation = phase11Operation({
      operationId: "execution-observation-2",
      action: "upload",
      status: "processing",
      stage: "validation",
      executionName: "doc-2",
      executionInput: {
        botId: phase11BotId,
        operationId: "execution-observation-2",
        step: "validate",
      },
    });
    const store = {
      listDocuments: vi.fn(),
      getOperation: vi.fn(async () => operation),
      getDocument: vi.fn(),
      createIntent: vi.fn(),
      reserveOperation: vi.fn(),
      recordSource: vi.fn(),
      recordIngestionJob: vi.fn(),
      updateOperation: vi.fn(async () => true),
      finishOperation: vi.fn(),
    };
    const execution = {
      get: vi.fn(async () => null),
      start: vi.fn(async () => ({ executionArn: "arn:example:execution:doc-2" })),
    };
    const createDocumentAdministration = await loadDocumentAdministration();
    const service = createDocumentAdministration({
      botId: phase11BotId,
      store,
      uploadBucketName: "temporary-docentes",
      documentBucketName: "prepared-docentes",
      incomingPrefix: "incoming/",
      preparedPrefix: "prepared/",
      uploadSigner: { createPost: vi.fn() },
      objects: { head: vi.fn() },
      execution,
      now: () => phase11Now,
      randomUUID: vi.fn(),
    });
    const handler = makeApi({ [phase11BotId]: service });

    const read = await handler(
      phase11AdminEvent({
        method: "GET",
        path: pathFor("document-operations/execution-observation-2"),
      }),
    );
    expect(phase11ResponseBody(read).operation.status).toBe("pending_start");
    expect(execution.start).not.toHaveBeenCalled();

    const started = await handler(
      phase11AdminEvent({
        method: "POST",
        path: pathFor("document-operations/execution-observation-2/start"),
        body: {},
      }),
    );

    expect(started.statusCode).toBe(202);
    expect(execution.start).toHaveBeenCalledWith({
      name: "doc-2",
      input: operation.executionInput,
    });
    expect(store.reserveOperation).not.toHaveBeenCalled();
    expect(store.updateOperation).toHaveBeenCalledWith({
      operationId: operation.operationId,
      patch: { executionArn: "arn:example:execution:doc-2", status: "processing" },
    });
  });

  it("does not start an execution when reservation reports a concurrent terminal result", async () => {
    const pending = phase11Operation({
      operationId: "terminal-race",
      action: "withdraw",
      status: "pending_start",
      stage: "source",
      documentId: "document-terminal-race",
      revision: "revision-1",
      expectedRevision: "revision-1",
    });
    const completed = phase11Operation({
      ...pending,
      status: "completed",
      stage: "result",
    });
    const store = {
      listDocuments: vi.fn(),
      getOperation: vi.fn(async () => pending),
      getDocument: vi.fn(async () => ({
        documentId: pending.documentId,
        state: "active",
        name: "lesson.txt",
        sizeBytes: 12,
        revision: pending.revision,
        updatedAt: phase11Now,
        source: {
          status: "confirmed",
          bucket: "prepared-docentes",
          key: "prepared/document-terminal-race/revision-1/lesson.txt",
          uri: "s3://prepared-docentes/prepared/document-terminal-race/revision-1/lesson.txt",
          sizeBytes: 12,
          sha256: "a".repeat(64),
        },
        pendingRemovalKeys: [],
      })),
      createIntent: vi.fn(),
      reserveOperation: vi.fn(async () => ({ reserved: false, operation: completed })),
      recordSource: vi.fn(),
      recordIngestionJob: vi.fn(),
      updateOperation: vi.fn(),
      finishOperation: vi.fn(),
    };
    const execution = {
      start: vi.fn(),
      get: vi.fn(),
    };
    const createDocumentAdministration = await loadDocumentAdministration();
    const service = createDocumentAdministration({
      botId: phase11BotId,
      store,
      uploadBucketName: "temporary-docentes",
      documentBucketName: "prepared-docentes",
      incomingPrefix: "incoming/",
      preparedPrefix: "prepared/",
      uploadSigner: { createPost: vi.fn() },
      objects: { head: vi.fn() },
      execution,
      now: () => phase11Now,
      randomUUID: vi.fn(),
    });
    const handler = makeApi({ [phase11BotId]: service });

    const response = await handler(
      phase11AdminEvent({
        method: "POST",
        path: pathFor("document-operations/terminal-race/start"),
        body: {},
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(phase11ResponseBody(response).operation.status).toBe("completed");
    expect(store.reserveOperation).toHaveBeenCalledOnce();
    expect(execution.start).not.toHaveBeenCalled();
    expect(execution.get).not.toHaveBeenCalled();
  });
});
