import { createHash } from "node:crypto";
import {
  DOCUMENT_MAX_BYTES,
  documentContentTypeForName,
  isValidDocumentFileName,
  validateDocumentFile,
  type DocumentAction,
  type DocumentErrorView,
  type DocumentFileInput,
  type DocumentListView,
  type DocumentOperationResponse,
  type DocumentOperationView,
  type DocumentUploadView,
  type DocumentView,
} from "../config/documents.js";
import { isValidOperationId } from "./access.js";
import type {
  CreateDocumentIntentInput,
  DocumentOperationRecord,
  DocumentRecord,
  DocumentStore,
} from "./document-store.js";

type UploadSigner = {
  createPost(input: {
    bucket: string;
    key: string;
    name: string;
    sizeBytes: number;
    sha256: string;
    contentType: string;
    expiresAt: number;
  }): Promise<DocumentUploadView>;
};

type Objects = {
  head(input: { bucket: string; key: string }): Promise<null | {
    contentLength: number;
    checksumSHA256: string;
  }>;
};

type Execution = {
  start(input: {
    name: string;
    input: { botId: string; operationId: string; step: "validate" | "promote" };
  }): Promise<{
    executionArn?: string;
    status?: string;
    input?: string | Record<string, unknown>;
  }>;
  get(input: { name: string }): Promise<null | {
    executionArn?: string;
    status?: string;
    input?: string | Record<string, unknown>;
  }>;
};

export type DocumentAdministration = {
  list(input: {
    cursor: string | null;
    limit?: number;
    actorSub?: string;
  }): Promise<DocumentListView>;
  createIntent(input: {
    operationId: string;
    action: DocumentAction;
    file?: DocumentFileInput;
    documentId?: string;
    expectedRevision?: string;
    actorSub: string;
    tokenExpiresAt: number;
  }): Promise<DocumentOperationResponse>;
  start(input: { operationId: string; actorSub?: string }): Promise<{
    operation: DocumentOperationView;
    startConfirmed: boolean;
  }>;
  get(input: { operationId: string; actorSub?: string }): Promise<{
    operation: DocumentOperationView;
  }>;
};

type CreateOptions = {
  botId: string;
  store: DocumentStore;
  uploadBucketName: string;
  documentBucketName: string;
  incomingPrefix: string;
  preparedPrefix: string;
  uploadSigner: UploadSigner;
  objects: Objects;
  execution: Execution;
  now: () => number;
  randomUUID: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorWithCode(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorWithFields(
  code: string,
  message: string,
  fields: string[],
): Error & { code: string; fields: string[] } {
  return Object.assign(errorWithCode(code, message), { fields });
}

function updatedAt(value: number | string): string {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("Document record has an invalid timestamp.");
  return new Date(time).toISOString();
}

function publicOperation(
  operation: DocumentOperationRecord,
  documentName?: string,
): DocumentOperationView {
  if (
    typeof operation.operationId !== "string" ||
    typeof operation.documentId !== "string" ||
    !["upload", "replace", "withdraw", "reprocess"].includes(operation.action) ||
    ![
      "awaiting_upload",
      "pending_start",
      "processing",
      "completed",
      "failed",
      "unconfirmed",
    ].includes(operation.status) ||
    !["upload", "validation", "source", "ingestion", "result"].includes(operation.stage) ||
    typeof operation.revision !== "string" ||
    (typeof operation.updatedAt !== "string" && typeof operation.updatedAt !== "number") ||
    typeof operation.canRetry !== "boolean"
  ) {
    throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The operation record is invalid.");
  }
  const operationDocumentName = operation.file?.name ?? documentName;
  if (
    (operation.file && operation.action !== "upload" && operation.action !== "replace") ||
    (operationDocumentName !== undefined && !isValidDocumentFileName(operationDocumentName))
  ) {
    throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The operation record is invalid.");
  }
  const error = operation.error && isRecord(operation.error) ? operation.error : undefined;
  const errorView: DocumentErrorView | undefined =
    error && typeof error.code === "string" && typeof error.message === "string"
      ? { code: error.code, message: error.message }
      : undefined;
  return {
    operationId: operation.operationId,
    documentId: operation.documentId,
    action: operation.action,
    ...(operationDocumentName !== undefined ? { documentName: operationDocumentName } : {}),
    status: operation.status,
    stage: operation.stage,
    revision: operation.revision,
    updatedAt: updatedAt(operation.updatedAt),
    canRetry: operation.canRetry,
    ...(errorView ? { error: errorView } : {}),
  };
}

function publicDocument(document: DocumentRecord): DocumentView {
  if (
    typeof document.documentId !== "string" ||
    typeof document.name !== "string" ||
    !Number.isSafeInteger(document.sizeBytes) ||
    typeof document.revision !== "string" ||
    document.state !== "active" ||
    !Array.isArray(document.pendingRemovalKeys) ||
    !document.processing ||
    !["processing", "completed", "failed", "unconfirmed"].includes(document.processing.status) ||
    typeof document.processing.operationId !== "string" ||
    document.processing.operationId.length === 0
  ) {
    throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The document record is invalid.");
  }
  const processing = document.processing;
  const errorView = processing.error;
  return {
    documentId: document.documentId,
    name: document.name,
    sizeBytes: document.sizeBytes,
    revision: document.revision,
    updatedAt: updatedAt(document.updatedAt),
    canReplace:
      document.state === "active" &&
      document.pendingRemovalKeys.length === 0 &&
      document.canReplace !== false,
    canRetry: document.canRetry === true,
    processing: {
      status: processing.status,
      operationId: processing.operationId,
      ...(errorView ? { error: { code: errorView.code, message: errorView.message } } : {}),
    },
  };
}

function canonicalExecutionName(botId: string, operationId: string): string {
  const digest = createHash("sha256").update(`${botId}\0${operationId}`).digest("hex");
  return `doc-${digest}`;
}

function uriFor(bucket: string, key: string): string {
  return `s3://${bucket}/${key.replace(/^\/+/, "")}`;
}

function sourceUrisFor(document: DocumentRecord, documentBucketName: string): string[] {
  const uris = [...(document.sourceUrisToObserve ?? [])];
  if (document.source?.uri) uris.push(document.source.uri);
  for (const key of document.pendingRemovalKeys) {
    uris.push(key.startsWith("s3://") ? key : uriFor(documentBucketName, key));
  }
  return [...new Set(uris)];
}

function sameExecutionInput(
  actual: string | Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
): boolean {
  if (!actual || !expected) return false;
  try {
    const parsed = typeof actual === "string" ? JSON.parse(actual) : actual;
    return JSON.stringify(parsed) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

type ExecutionObservation =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "running"; executionArn?: string }
  | { kind: "terminal" }
  | { kind: "contradictory" };

const UNCONFIRMED_EXECUTION: DocumentErrorView = {
  code: "DOCUMENT_OPERATION_UNCONFIRMED",
  message:
    "No pudimos confirmar el resultado de la ejecución. Consultá el estado antes de iniciar otro cambio.",
};

export function createDocumentAdministration(options: CreateOptions): DocumentAdministration {
  const {
    botId,
    store,
    uploadBucketName,
    documentBucketName,
    incomingPrefix,
    preparedPrefix,
    uploadSigner,
    objects,
    execution,
    now,
    randomUUID,
  } = options;

  function uploadKeyFor(operationId: string, name: string): string {
    const operationHash = createHash("sha256").update(operationId).digest("hex");
    const nameHash = createHash("sha256").update(name).digest("hex");
    const extension = name.toLowerCase().split(".").at(-1);
    if (!extension || !documentContentTypeForName(name)) {
      throw errorWithCode("INVALID_INPUT", "The document name is invalid.");
    }
    return `${incomingPrefix}${operationHash}/${nameHash}.${extension}`;
  }

  function candidateKeyFor(operation: DocumentOperationRecord): string | undefined {
    if (!operation.file) return undefined;
    return `${preparedPrefix}${encodeURIComponent(operation.documentId)}/${encodeURIComponent(operation.revision)}/${encodeURIComponent(operation.file.name)}`;
  }

  async function signIntent(
    operation: DocumentOperationRecord,
    tokenExpiresAt: number,
  ): Promise<DocumentUploadView> {
    if (!operation.file || !operation.uploadKey) {
      throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The upload intent is missing its receipt.");
    }
    const expiresAt = Math.min(now() + 5 * 60_000, tokenExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
      throw errorWithCode("UNAUTHORIZED", "The administrator token has expired.");
    }
    try {
      return await uploadSigner.createPost({
        bucket: uploadBucketName,
        key: operation.uploadKey,
        name: operation.file.name,
        sizeBytes: operation.file.sizeBytes,
        sha256: operation.file.sha256,
        contentType:
          operation.file.contentType ??
          documentContentTypeForName(operation.file.name) ??
          "application/octet-stream",
        expiresAt,
      });
    } catch {
      throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The upload permission is unavailable.");
    }
  }

  async function observeExecution(
    operation: DocumentOperationRecord,
  ): Promise<ExecutionObservation> {
    if (!operation.executionName || !operation.executionInput) return { kind: "contradictory" };
    let observed: Awaited<ReturnType<Execution["get"]>>;
    try {
      observed = await execution.get({ name: operation.executionName });
    } catch {
      return { kind: "unavailable" };
    }
    if (!observed) return { kind: "absent" };
    if (!sameExecutionInput(observed.input, operation.executionInput)) {
      return { kind: "contradictory" };
    }
    if (observed.status === "RUNNING") {
      return {
        kind: "running",
        ...(observed.executionArn ? { executionArn: observed.executionArn } : {}),
      };
    }
    if (
      ["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED", "PENDING_REDRIVE"].includes(
        observed.status ?? "",
      )
    ) {
      return { kind: "terminal" };
    }
    return { kind: "contradictory" };
  }

  async function publicOperationView(
    operation: DocumentOperationRecord,
    knownDocument?: DocumentRecord | null,
  ): Promise<DocumentOperationView> {
    let documentName = operation.file?.name;
    if (
      documentName === undefined &&
      operation.action !== "upload" &&
      operation.status !== "completed" &&
      operation.status !== "failed"
    ) {
      let document = knownDocument;
      if (document === undefined) {
        document = await store.getDocument({ documentId: operation.documentId }).catch(() => {
          throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The document record is unavailable.");
        });
      }
      documentName = document?.name;
    }
    return publicOperation(operation, documentName);
  }

  function projectExecution(
    operation: DocumentOperationRecord,
    observation: ExecutionObservation,
  ): DocumentOperationRecord {
    if (operation.status === "unconfirmed") {
      return {
        ...operation,
        error: operation.error ?? UNCONFIRMED_EXECUTION,
      };
    }
    if (observation.kind === "running") {
      return {
        ...operation,
        status: "processing",
        error: undefined,
      };
    }
    if (observation.kind === "absent") {
      return {
        ...operation,
        status: "pending_start",
        error: undefined,
      };
    }
    return {
      ...operation,
      status: "unconfirmed",
      outcome: "unconfirmed",
      error: operation.error ?? UNCONFIRMED_EXECUTION,
    };
  }

  return {
    async list({ cursor, limit = 50 }) {
      try {
        const page = await store.listDocuments({ cursor, limit });
        const activeObservation =
          page.activeOperation &&
          (page.activeOperation.status === "processing" ||
            page.activeOperation.status === "unconfirmed")
            ? await observeExecution(page.activeOperation)
            : null;
        const activeOperation =
          page.activeOperation && activeObservation
            ? projectExecution(page.activeOperation, activeObservation)
            : page.activeOperation;
        return {
          botId,
          documents: page.documents
            .filter((document) => document.state === "active")
            .map(publicDocument),
          nextCursor: page.nextCursor,
          activeOperation: activeOperation
            ? await publicOperationView(
                activeOperation,
                page.documents.find(
                  (document) => document.documentId === activeOperation.documentId,
                ),
              )
            : null,
          lastOperation: page.lastOperation
            ? await publicOperationView(
                page.lastOperation,
                page.documents.find(
                  (document) => document.documentId === page.lastOperation?.documentId,
                ),
              )
            : null,
        };
      } catch (error) {
        if (isRecord(error) && error.code === "INVALID_INPUT") throw error;
        throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The document list is unavailable.");
      }
    },

    async createIntent(input) {
      const { operationId, action, actorSub, tokenExpiresAt } = input;
      if (
        !isValidOperationId(operationId) ||
        typeof actorSub !== "string" ||
        actorSub.length === 0
      ) {
        throw errorWithCode("INVALID_INPUT", "The operation identity is invalid.");
      }
      if (!Number.isSafeInteger(tokenExpiresAt) || tokenExpiresAt <= now()) {
        throw errorWithCode("UNAUTHORIZED", "The administrator token has expired.");
      }
      const uploadAction = action === "upload" || action === "replace";
      if (uploadAction) {
        if (!input.file) throw errorWithCode("INVALID_INPUT", "A file is required.");
        const invalidFields = validateDocumentFile(input.file);
        if (input.file.sizeBytes > DOCUMENT_MAX_BYTES) {
          throw errorWithCode("FILE_TOO_LARGE", "Documents may contain at most 50,000,000 bytes.");
        }
        if (invalidFields.length > 0) {
          throw errorWithFields(
            "INVALID_INPUT",
            "The document details are invalid.",
            invalidFields,
          );
        }
      } else if (input.file) {
        throw errorWithCode("INVALID_INPUT", "This action does not accept a file.");
      }

      const existing = await store.getOperation({ operationId }).catch(() => {
        throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The operation record is unavailable.");
      });
      let document: DocumentRecord | null = null;
      if (existing) {
        if (existing.action !== action) {
          throw errorWithCode(
            "STATE_CHANGED",
            "The operation ID already belongs to another action.",
          );
        }
      } else if (action !== "upload") {
        if (typeof input.documentId !== "string" || typeof input.expectedRevision !== "string") {
          throw errorWithCode("INVALID_INPUT", "A document and expected revision are required.");
        }
        document = await store.getDocument({ documentId: input.documentId }).catch(() => {
          throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The document record is unavailable.");
        });
        if (!document) throw errorWithCode("NOT_FOUND", "The document was not found.");
        if (document.state !== "active" || document.revision !== input.expectedRevision) {
          throw errorWithCode("STATE_CHANGED", "The document revision changed.");
        }
        if (action === "replace" && document.pendingRemovalKeys.length > 0) {
          throw errorWithCode("STATE_CHANGED", "Pending source removal must be resolved first.");
        }
        if (action === "reprocess" && !document.source) {
          throw errorWithCode("STATE_CHANGED", "The current document source is unavailable.");
        }
      }

      const documentId =
        action === "upload"
          ? (existing?.documentId ?? randomUUID())
          : (input.documentId ?? existing?.documentId ?? randomUUID());
      const revision =
        existing?.revision ??
        (action === "upload" || action === "replace" ? randomUUID() : (document?.revision ?? ""));
      const file = input.file
        ? {
            ...input.file,
            contentType: documentContentTypeForName(input.file.name) ?? "application/octet-stream",
          }
        : undefined;
      let sourceUrisToObserve =
        existing?.sourceUrisToObserve ??
        (action === "withdraw" && document
          ? sourceUrisFor(document, documentBucketName)
          : undefined);
      if (
        !existing &&
        action === "withdraw" &&
        document &&
        sourceUrisToObserve?.length === 0 &&
        document.lastOperationId
      ) {
        const priorWithdrawal = await store
          .getOperation({
            operationId: document.lastOperationId,
          })
          .catch(() => {
            throw errorWithCode(
              "DOCUMENTS_UNAVAILABLE",
              "The previous withdrawal receipt is unavailable.",
            );
          });
        if (priorWithdrawal?.action === "withdraw") {
          sourceUrisToObserve = priorWithdrawal.sourceUrisToObserve ?? [];
        }
      }
      const intent: CreateDocumentIntentInput = {
        operationId,
        action,
        actorSub,
        tokenExpiresAt,
        documentId,
        expectedRevision: input.expectedRevision ?? null,
        candidateRevision: revision,
        ...(file ? { file } : {}),
        ...(existing?.uploadKey
          ? { uploadKey: existing.uploadKey }
          : uploadAction && file
            ? { uploadKey: uploadKeyFor(operationId, file.name) }
            : {}),
        ...(sourceUrisToObserve ? { sourceUrisToObserve } : {}),
      };
      let result: { created: boolean; operation: DocumentOperationRecord };
      try {
        result = await store.createIntent(intent);
      } catch (error) {
        if (isRecord(error) && typeof error.code === "string") throw error;
        throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The operation could not be recorded.");
      }
      const upload =
        result.operation.action === "upload" || result.operation.action === "replace"
          ? await signIntent(result.operation, tokenExpiresAt)
          : undefined;
      return {
        botId,
        operation: await publicOperationView(result.operation, document ?? undefined),
        ...(upload ? { upload } : {}),
      };
    },

    async start({ operationId }) {
      if (!isValidOperationId(operationId))
        throw errorWithCode("INVALID_INPUT", "The operation ID is invalid.");
      let operation = await store.getOperation({ operationId }).catch(() => {
        throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The operation record is unavailable.");
      });
      if (!operation) throw errorWithCode("NOT_FOUND", "The operation was not found.");
      if (operation.status === "completed" || operation.status === "failed") {
        return { operation: await publicOperationView(operation), startConfirmed: true };
      }

      const uploadAction = operation.action === "upload" || operation.action === "replace";
      if (operation.status === "awaiting_upload" && uploadAction) {
        if (!operation.uploadKey || !operation.file) {
          throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The upload intent is incomplete.");
        }
        let receipt: Awaited<ReturnType<Objects["head"]>>;
        try {
          receipt = await objects.head({ bucket: uploadBucketName, key: operation.uploadKey });
        } catch {
          throw errorWithCode(
            "DOCUMENTS_UNAVAILABLE",
            "The uploaded document could not be checked.",
          );
        }
        if (!receipt) throw errorWithCode("UPLOAD_NOT_READY", "The upload has not arrived yet.");
        const expectedChecksum = Buffer.from(operation.file.sha256, "hex").toString("base64");
        if (
          receipt.contentLength !== operation.file.sizeBytes ||
          receipt.checksumSHA256 !== expectedChecksum
        ) {
          throw errorWithFields(
            "INVALID_INPUT",
            "The uploaded document does not match its declaration.",
            ["file"],
          );
        }
      }

      if (operation.status === "unconfirmed") {
        return {
          operation: await publicOperationView(
            projectExecution(operation, await observeExecution(operation)),
          ),
          startConfirmed: false,
        };
      }
      if (operation.status === "processing") {
        const observation = await observeExecution(operation);
        if (observation.kind === "running") {
          return {
            operation: await publicOperationView(projectExecution(operation, observation)),
            startConfirmed: true,
          };
        }
        if (
          observation.kind === "unavailable" ||
          observation.kind === "terminal" ||
          observation.kind === "contradictory"
        ) {
          return {
            operation: await publicOperationView(projectExecution(operation, observation)),
            startConfirmed: false,
          };
        }
        if (!operation.executionName || !operation.executionInput) {
          return { operation: await publicOperationView(operation), startConfirmed: false };
        }
        // Reuse the durable name and exact input after an ambiguous acknowledgement.
        try {
          const started = await execution.start({
            name: operation.executionName,
            input: operation.executionInput,
          });
          if (started.status && started.status !== "RUNNING") {
            return {
              operation: await publicOperationView(
                projectExecution(operation, { kind: "terminal" }),
              ),
              startConfirmed: false,
            };
          }
          if (started.executionArn) {
            const saved = await store.updateOperation({
              operationId,
              patch: { executionArn: started.executionArn, status: "processing" },
            });
            if (!saved) {
              const current = await store.getOperation({ operationId }).catch(() => null);
              if (current && (current.status === "completed" || current.status === "failed")) {
                return { operation: await publicOperationView(current), startConfirmed: true };
              }
              return {
                operation: await publicOperationView(
                  projectExecution(operation, { kind: "unavailable" }),
                ),
                startConfirmed: false,
              };
            }
            operation = {
              ...operation,
              status: "processing",
              executionArn: started.executionArn,
              error: undefined,
            };
          }
          return { operation: await publicOperationView(operation), startConfirmed: true };
        } catch {
          const recovered = await observeExecution(operation);
          if (recovered.kind === "running") {
            return {
              operation: await publicOperationView(projectExecution(operation, recovered)),
              startConfirmed: true,
            };
          }
          return {
            operation: await publicOperationView(projectExecution(operation, recovered)),
            startConfirmed: false,
          };
        }
      }

      const document =
        operation.action === "upload"
          ? null
          : await store.getDocument({ documentId: operation.documentId }).catch(() => {
              throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The document record is unavailable.");
            });
      if (operation.action !== "upload" && !document) {
        throw errorWithCode("NOT_FOUND", "The document was not found.");
      }
      if (
        document &&
        (document.state !== "active" || document.revision !== operation.expectedRevision)
      ) {
        throw errorWithCode("STATE_CHANGED", "The document revision changed.");
      }
      if (operation.action === "reprocess" && document && !document.source) {
        throw errorWithCode("STATE_CHANGED", "The current document source is unavailable.");
      }
      if (operation.action === "replace" && document && document.pendingRemovalKeys.length > 0) {
        throw errorWithCode("STATE_CHANGED", "Pending source removal must be resolved first.");
      }
      const sourceUrisToObserve =
        operation.action === "withdraw" && document
          ? sourceUrisFor(document, documentBucketName)
          : operation.sourceUrisToObserve;
      const executionName = canonicalExecutionName(botId, operationId);
      const executionInput = {
        botId,
        operationId,
        step: (uploadAction ? "validate" : "promote") as "validate" | "promote",
      };
      let candidateKey: string | undefined;
      if (uploadAction) candidateKey = candidateKeyFor(operation);
      let reservation;
      try {
        reservation = await store.reserveOperation({
          operationId,
          documentId: operation.documentId,
          action: operation.action,
          expectedRevision: operation.expectedRevision ?? null,
          ...(operation.revision ? { candidateRevision: operation.revision } : {}),
          ...(candidateKey ? { candidateKey } : {}),
          ...(sourceUrisToObserve ? { sourceUrisToObserve } : {}),
          executionName,
          executionInput,
        });
      } catch (error) {
        if (isRecord(error) && typeof error.code === "string") throw error;
        throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The operation could not be reserved.");
      }
      operation = reservation.operation;
      if (!reservation.reserved) {
        if (operation.status === "completed" || operation.status === "failed") {
          return {
            operation: await publicOperationView(operation, document),
            startConfirmed: true,
          };
        }
        const observed = await observeExecution(operation);
        return {
          operation: await publicOperationView(projectExecution(operation, observed), document),
          startConfirmed: operation.status === "processing" && observed.kind === "running",
        };
      }
      try {
        const started = await execution.start({ name: executionName, input: executionInput });
        if (started.status && started.status !== "RUNNING") {
          return {
            operation: await publicOperationView(
              projectExecution(operation, { kind: "terminal" }),
              document,
            ),
            startConfirmed: false,
          };
        }
        if (started.executionArn) {
          const saved = await store.updateOperation({
            operationId,
            patch: { executionArn: started.executionArn },
          });
          if (!saved) {
            const current = await store.getOperation({ operationId }).catch(() => null);
            if (current && (current.status === "completed" || current.status === "failed")) {
              return {
                operation: await publicOperationView(current, document),
                startConfirmed: true,
              };
            }
            return {
              operation: await publicOperationView(
                projectExecution(operation, { kind: "unavailable" }),
                document,
              ),
              startConfirmed: false,
            };
          }
          operation = { ...operation, executionArn: started.executionArn };
        }
        return {
          operation: await publicOperationView(operation, document),
          startConfirmed: true,
        };
      } catch {
        const recovered = await observeExecution(operation);
        if (recovered.kind === "running") {
          if (recovered.executionArn) {
            await store
              .updateOperation({
                operationId,
                patch: { executionArn: recovered.executionArn },
              })
              .catch(() => false);
          }
          return {
            operation: await publicOperationView(projectExecution(operation, recovered), document),
            startConfirmed: true,
          };
        }
        return {
          operation: await publicOperationView(projectExecution(operation, recovered), document),
          startConfirmed: false,
        };
      }
    },

    async get({ operationId }) {
      if (!isValidOperationId(operationId))
        throw errorWithCode("INVALID_INPUT", "The operation ID is invalid.");
      const operation = await store.getOperation({ operationId }).catch(() => {
        throw errorWithCode("DOCUMENTS_UNAVAILABLE", "The operation record is unavailable.");
      });
      if (!operation) throw errorWithCode("NOT_FOUND", "The operation was not found.");
      const projected =
        operation.status === "processing" || operation.status === "unconfirmed"
          ? projectExecution(operation, await observeExecution(operation))
          : operation;
      return { operation: await publicOperationView(projected) };
    },
  };
}
