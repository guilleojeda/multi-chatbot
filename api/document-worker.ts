import { createHash } from "node:crypto";
import {
  DOCUMENT_MAX_BYTES,
  documentContentTypeForName,
  isUtf8TextDocument,
  validateDocumentFile,
} from "../config/documents.js";
import { isValidOperationId } from "./access.js";
import type { DocumentBotResources } from "./document-config.js";
import type {
  DocumentOperationRecord,
  DocumentRecord,
  DocumentSourceRecord,
  DocumentStore,
} from "./document-store.js";

export type DocumentWorkerStep =
  "validate" | "promote" | "start-ingestion" | "observe-ingestion" | "finish";

type DocumentWorkerResult = {
  status: "ready" | "waiting" | "completed" | "failed" | "unconfirmed";
  error?: { code: string; message: string };
};

type ObjectHead = {
  contentLength: number | undefined;
  checksumSHA256: string | null;
};

type DocumentObjects = {
  head(input: { bucket: string; key: string }): Promise<ObjectHead | null>;
  get(input: { bucket: string; key: string }): Promise<AsyncIterable<Uint8Array>>;
  copy(input: {
    sourceBucket: string;
    sourceKey: string;
    destinationBucket: string;
    destinationKey: string;
  }): Promise<{ etag?: string }>;
  delete(input: { bucket: string; key: string }): Promise<void>;
};

type IngestionDocumentStatus =
  | "STARTING"
  | "PENDING"
  | "IN_PROGRESS"
  | "INDEXED"
  | "PARTIALLY_INDEXED"
  | "METADATA_PARTIALLY_INDEXED"
  | "METADATA_UPDATE_FAILED"
  | "FAILED"
  | "NOT_FOUND"
  | "ABSENT"
  | "DELETED"
  | "IGNORED"
  | "DELETING"
  | "DELETE_IN_PROGRESS";

type Ingestion = {
  start(input: {
    knowledgeBaseId: string;
    dataSourceId: string;
    clientToken: string;
    description: string;
  }): Promise<{ jobId?: string }>;
  get(input: { knowledgeBaseId: string; dataSourceId: string; jobId: string }): Promise<{
    jobId?: string;
    status?: string;
    statistics?: { numberOfDocumentsFailed?: number };
    failureReasons?: string[];
  } | null>;
  getDocument(input: {
    knowledgeBaseId: string;
    dataSourceId: string;
    sourceUri: string;
  }): Promise<{ status: IngestionDocumentStatus; sourceUri: string } | null>;
};

type IngestionJob = NonNullable<Awaited<ReturnType<Ingestion["get"]>>>;

type WorkerResources = Pick<
  DocumentBotResources,
  | "botId"
  | "uploadBucketName"
  | "documentBucketName"
  | "incomingPrefix"
  | "preparedPrefix"
  | "knowledgeBaseId"
  | "dataSourceId"
>;

type WorkerOptions = {
  stores: Record<string, DocumentStore>;
  resourcesByBot: Record<string, WorkerResources>;
  objects: DocumentObjects;
  ingestion: Ingestion;
  now?: () => number;
};

const SAFE_ERRORS = {
  invalidDocument: {
    code: "INVALID_DOCUMENT",
    message:
      "El archivo debe contener texto UTF-8 válido y no vacío en los formatos textuales admitidos.",
  },
  uploadMismatch: {
    code: "UPLOAD_MISMATCH",
    message: "El archivo recibido no coincide con el tamaño o la integridad registrados.",
  },
  effectUnconfirmed: {
    code: "EFFECT_UNCONFIRMED",
    message:
      "No pudimos confirmar un cambio en el almacenamiento. La operación conserva su reserva.",
  },
  observationUnconfirmed: {
    code: "OBSERVATION_UNCONFIRMED",
    message:
      "No pudimos confirmar el resultado del procesamiento. La operación conserva su reserva.",
  },
  ingestionFailed: {
    code: "INGESTION_FAILED",
    message: "La Knowledge Base no pudo procesar el documento. Puedes reintentar el procesamiento.",
  },
  sourceFailed: {
    code: "SOURCE_UPDATE_FAILED",
    message: "No se pudo completar el cambio de fuentes. Puedes reintentar la operación.",
  },
  invalidState: {
    code: "STATE_CHANGED",
    message: "El estado documental cambió y la operación no pudo continuar.",
  },
} as const;

function ingestionFailureError(job: IngestionJob): { code: string; message: string } {
  const reasons = Array.isArray(job.failureReasons)
    ? job.failureReasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  const extractionFailure = reasons.some((reason) =>
    /could not be parsed|could not be extracted|unable to extract|unsupported (?:file )?format|not (?:in|a) (?:a )?supported format|properly formatted/i.test(
      reason,
    ),
  );
  const accessFailure = reasons.some((reason) =>
    /access denied|permission denied|not authorized|unauthori[sz]ed|unable to access|failed to access|could not access/i.test(
      reason,
    ),
  );
  const failureCount = job.statistics?.numberOfDocumentsFailed;
  const knownFailureCount =
    typeof failureCount === "number" && Number.isSafeInteger(failureCount) && failureCount >= 0
      ? failureCount
      : undefined;
  const countMessage =
    knownFailureCount === undefined ? "" : ` Documentos con error: ${knownFailureCount}.`;

  if (extractionFailure) {
    return {
      code: SAFE_ERRORS.ingestionFailed.code,
      message:
        "La sincronización no pudo extraer o interpretar el contenido de uno o más archivos preparados. Revisá su formato y contenido; reemplazalos si hace falta antes de reintentar el procesamiento." +
        countMessage,
    };
  }
  if (accessFailure) {
    return {
      code: SAFE_ERRORS.ingestionFailed.code,
      message:
        "La sincronización no pudo acceder a la fuente. Solicitá una revisión técnica antes de reintentar el procesamiento." +
        countMessage,
    };
  }
  if (reasons.length > 0 || knownFailureCount !== undefined) {
    return {
      code: SAFE_ERRORS.ingestionFailed.code,
      message:
        "La sincronización falló. No se pudo clasificar la causa; solicitá una revisión técnica antes de reintentar el procesamiento." +
        countMessage,
    };
  }
  return SAFE_ERRORS.ingestionFailed;
}

class InvalidDocumentError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorName(error: unknown): string | undefined {
  return isRecord(error) && typeof error.name === "string" ? error.name : undefined;
}

function errorStatusCode(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.$metadata)) return undefined;
  const statusCode = error.$metadata.httpStatusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function isUncertainEffect(error: unknown): boolean {
  const name = errorName(error) ?? "";
  const statusCode = errorStatusCode(error);
  if (statusCode !== undefined) return statusCode >= 500;
  if (/timeout|network|abort|connection|requesttimeout/i.test(name)) return true;
  if (name.length === 0) return true;
  if (
    /accessdenied|nosuchbucket|nosuchkey|notfound|validation|invalid|forbidden|unauthorized|badrequest/i.test(
      name,
    )
  ) {
    return false;
  }
  return true;
}

function isThrottledOrBusy(error: unknown): boolean {
  return [
    "ConflictException",
    "ThrottlingException",
    "TooManyRequestsException",
    "ServiceQuotaExceededException",
  ].includes(errorName(error) ?? "");
}

function isTerminalJobStatus(status: string | undefined): boolean {
  return status === "COMPLETE" || status === "FAILED" || status === "STOPPED";
}

function statusIsAbsent(status: string): boolean {
  return status === "ABSENT" || status === "DELETED";
}

function statusIsDeleting(status: string): boolean {
  return status === "DELETING" || status === "DELETE_IN_PROGRESS";
}

function safeText(value: string): string {
  return value.replaceAll("\\", "/").replace(/[\u0000-\u001f\u007f]/g, "");
}

function safeKey(key: unknown, prefix: string): key is string {
  return (
    typeof key === "string" &&
    key.startsWith(prefix) &&
    key.length > prefix.length &&
    !/[\\\u0000-\u001f\u007f]/.test(key) &&
    !key.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
  );
}

function sourceUri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

function sourceFromKey(
  bucket: string,
  key: string,
  sizeBytes: number,
  sha256: string,
): DocumentSourceRecord {
  return {
    status: "confirmed",
    bucket,
    key,
    uri: sourceUri(bucket, key),
    sizeBytes,
    sha256,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function pendingKeysOf(document: DocumentRecord): string[] {
  return Array.isArray(document.pendingRemovalKeys) ? document.pendingRemovalKeys : [];
}

function preparedUris(
  resources: WorkerResources,
  operation: DocumentOperationRecord,
  uris: readonly string[],
): string[] | null {
  const values = unique(uris);
  const prefix = `s3://${resources.documentBucketName}/${resources.preparedPrefix}`;
  if (
    values.length !== uris.length ||
    values.length === 0 ||
    values.some((uri) => {
      if (!uri.startsWith(prefix)) return true;
      const key = uri.slice(`s3://${resources.documentBucketName}/`.length);
      return (
        !safeKey(key, resources.preparedPrefix) ||
        !key.startsWith(`${resources.preparedPrefix}${operation.documentId}/`)
      );
    })
  ) {
    return null;
  }
  return values;
}

function fileFor(operation: DocumentOperationRecord) {
  if (!operation.file) return null;
  const invalidFields = validateDocumentFile(operation.file);
  const contentType = documentContentTypeForName(operation.file.name);
  if (
    invalidFields.length > 0 ||
    operation.file.sizeBytes > DOCUMENT_MAX_BYTES ||
    !contentType ||
    (operation.file.contentType !== undefined && operation.file.contentType !== contentType)
  ) {
    return null;
  }
  return { ...operation.file, contentType };
}

function expectedIncomingKey(
  resources: WorkerResources,
  operation: DocumentOperationRecord,
): string | null {
  const key = operation.uploadKey;
  if (!safeKey(key, resources.incomingPrefix)) return null;
  const keySegments = key.slice(resources.incomingPrefix.length).split("/");
  return keySegments.length === 2 ? key : null;
}

function expectedPreparedKey(
  resources: WorkerResources,
  operation: DocumentOperationRecord,
): string | null {
  const key = operation.candidateKey;
  const candidatePrefix = `${resources.preparedPrefix}${encodeURIComponent(operation.documentId)}/${encodeURIComponent(operation.revision)}/`;
  return safeKey(key, resources.preparedPrefix) &&
    key.startsWith(candidatePrefix) &&
    key.slice(candidatePrefix.length).length > 0 &&
    !key.slice(candidatePrefix.length).includes("/")
    ? key
    : null;
}

function matchesExpectedDocument(
  document: DocumentRecord,
  operation: DocumentOperationRecord,
): boolean {
  if (typeof operation.expectedRevision === "string") {
    return document.revision === operation.expectedRevision;
  }
  const ownerOperationId = document.ownerOperationId;
  if (typeof ownerOperationId === "string" && ownerOperationId !== operation.operationId)
    return false;
  const expectedSource = operation.source;
  if (expectedSource === null) return document.source === null;
  if (!expectedSource || !document.source) return ownerOperationId === undefined;
  return sameSourceIdentity(document.source, expectedSource);
}

function sameSourceIdentity(
  left: NonNullable<DocumentRecord["source"]>,
  right: NonNullable<DocumentOperationRecord["source"]>,
): boolean {
  return (
    left.bucket === right.bucket &&
    left.key === right.key &&
    left.uri === right.uri &&
    left.sha256 === right.sha256 &&
    (left.sizeBytes === undefined ||
      right.sizeBytes === undefined ||
      left.sizeBytes === right.sizeBytes)
  );
}

function validStoredSource(
  resources: WorkerResources,
  operation: DocumentOperationRecord,
  source: DocumentRecord["source"] | DocumentOperationRecord["source"],
): source is DocumentSourceRecord {
  return (
    source !== null &&
    source !== undefined &&
    source.bucket === resources.documentBucketName &&
    safeKey(source.key, resources.preparedPrefix) &&
    source.key.startsWith(`${resources.preparedPrefix}${operation.documentId}/`) &&
    source.uri === sourceUri(resources.documentBucketName, source.key) &&
    /^[a-f0-9]{64}$/.test(source.sha256) &&
    Number.isSafeInteger(source.sizeBytes) &&
    source.sizeBytes > 0 &&
    source.sizeBytes <= DOCUMENT_MAX_BYTES
  );
}

function stableClientToken(botId: string, operationId: string): string {
  return createHash("sha256")
    .update(`multi-chatbot:document-ingestion:v1\0${botId}\0${operationId}`)
    .digest("hex");
}

function validClientToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 33 && value.length <= 256;
}

async function streamFile(
  stream: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  requireText: boolean,
): Promise<{ sizeBytes: number; sha256: string; hasText: boolean }> {
  const digest = createHash("sha256");
  const decoder = requireText ? new TextDecoder("utf-8", { fatal: true }) : null;
  let sizeBytes = 0;
  let hasText = false;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new InvalidDocumentError();
    sizeBytes += chunk.byteLength;
    if (sizeBytes > expectedBytes || sizeBytes > DOCUMENT_MAX_BYTES)
      throw new InvalidDocumentError();
    digest.update(chunk);
    if (decoder) {
      try {
        if (/\S/u.test(decoder.decode(chunk, { stream: true }))) hasText = true;
      } catch {
        throw new InvalidDocumentError();
      }
    }
  }
  if (decoder) {
    try {
      if (/\S/u.test(decoder.decode())) hasText = true;
    } catch {
      throw new InvalidDocumentError();
    }
  }
  return { sizeBytes, sha256: digest.digest("hex"), hasText };
}

export function createDocumentWorker({
  stores,
  resourcesByBot,
  objects,
  ingestion,
  now = Date.now,
}: WorkerOptions) {
  async function updateUnconfirmed(
    store: DocumentStore,
    operation: DocumentOperationRecord,
    error: { code: string; message: string },
  ): Promise<DocumentWorkerResult> {
    await store.updateOperation({
      operationId: operation.operationId,
      patch: { status: "unconfirmed", error, updatedAt: now() },
    });
    return { status: "unconfirmed", error };
  }

  async function finishTerminal(
    store: DocumentStore,
    operation: DocumentOperationRecord,
    outcome: "completed" | "failed",
    error?: { code: string; message: string },
    source?: DocumentSourceRecord | null,
    pendingRemovalKeys?: string[],
  ): Promise<DocumentWorkerResult> {
    const updated: DocumentOperationRecord = {
      ...operation,
      ...(source !== undefined ? { source } : {}),
      ...(pendingRemovalKeys !== undefined ? { pendingRemovalKeys } : {}),
      status: outcome,
      stage: "result",
      outcome,
      canRetry: outcome === "failed",
      updatedAt: now(),
      ...(error ? { error } : { error: undefined }),
    };
    const confirmed = await store.finishOperation({
      operationId: operation.operationId,
      outcome,
      operation: updated,
    });
    if (!confirmed) return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    return outcome === "completed"
      ? { status: "completed" }
      : { status: "failed", ...(error ? { error } : {}) };
  }

  async function failBeforeEffects(
    store: DocumentStore,
    operation: DocumentOperationRecord,
    error: { code: string; message: string },
  ): Promise<DocumentWorkerResult> {
    return finishTerminal(store, operation, "failed", error);
  }

  async function validateUpload(
    resources: WorkerResources,
    store: DocumentStore,
    operation: DocumentOperationRecord,
  ): Promise<DocumentWorkerResult> {
    const file = fileFor(operation);
    if (!file) return failBeforeEffects(store, operation, SAFE_ERRORS.invalidDocument);
    const key = expectedIncomingKey(resources, operation);
    if (!key) return failBeforeEffects(store, operation, SAFE_ERRORS.uploadMismatch);
    let receipt: ObjectHead | null;
    try {
      receipt = await objects.head({ bucket: resources.uploadBucketName, key });
    } catch {
      return updateUnconfirmed(store, operation, SAFE_ERRORS.observationUnconfirmed);
    }
    const expectedChecksum = Buffer.from(file.sha256, "hex").toString("base64");
    if (
      !receipt ||
      receipt.contentLength !== file.sizeBytes ||
      receipt.checksumSHA256 !== expectedChecksum
    ) {
      return failBeforeEffects(store, operation, SAFE_ERRORS.uploadMismatch);
    }

    let stream: AsyncIterable<Uint8Array>;
    try {
      stream = await objects.get({ bucket: resources.uploadBucketName, key });
    } catch {
      return updateUnconfirmed(store, operation, SAFE_ERRORS.observationUnconfirmed);
    }
    let observed: { sizeBytes: number; sha256: string; hasText: boolean };
    try {
      observed = await streamFile(stream, file.sizeBytes, isUtf8TextDocument(file.name));
    } catch (error) {
      if (error instanceof InvalidDocumentError) {
        return failBeforeEffects(store, operation, SAFE_ERRORS.invalidDocument);
      }
      return updateUnconfirmed(store, operation, SAFE_ERRORS.observationUnconfirmed);
    }
    if (
      observed.sizeBytes !== file.sizeBytes ||
      observed.sha256 !== file.sha256 ||
      (isUtf8TextDocument(file.name) && !observed.hasText)
    ) {
      return failBeforeEffects(
        store,
        operation,
        observed.sizeBytes === file.sizeBytes && observed.sha256 === file.sha256
          ? SAFE_ERRORS.invalidDocument
          : SAFE_ERRORS.uploadMismatch,
      );
    }
    const saved = await store.updateOperation({
      operationId: operation.operationId,
      patch: { status: "processing", stage: "source", error: undefined, updatedAt: now() },
    });
    if (!saved) return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    return { status: "ready" };
  }

  async function validateOperation(
    resources: WorkerResources,
    store: DocumentStore,
    operation: DocumentOperationRecord,
  ): Promise<DocumentWorkerResult> {
    if (operation.action === "upload" || operation.action === "replace") {
      if (operation.action === "replace") {
        const document = await store.getDocument({ documentId: operation.documentId });
        if (
          !document ||
          document.state !== "active" ||
          !matchesExpectedDocument(document, operation) ||
          pendingKeysOf(document).length > 0 ||
          !validStoredSource(resources, operation, operation.source ?? document.source)
        ) {
          return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
        }
      }
      return validateUpload(resources, store, operation);
    }

    if (operation.action === "reprocess") {
      const document = await store.getDocument({ documentId: operation.documentId });
      if (
        !document ||
        document.state !== "active" ||
        !matchesExpectedDocument(document, operation) ||
        !validStoredSource(resources, operation, operation.source ?? document.source)
      ) {
        return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
      }
      const saved = await store.updateOperation({
        operationId: operation.operationId,
        patch: { status: "processing", stage: "source", error: undefined, updatedAt: now() },
      });
      return saved
        ? { status: "ready" }
        : { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    }

    const document = await store.getDocument({ documentId: operation.documentId });
    const uris = operation.sourceUrisToObserve;
    if (
      !document ||
      document.state !== "active" ||
      !matchesExpectedDocument(document, operation) ||
      !Array.isArray(uris) ||
      !preparedUris(resources, operation, uris)
    ) {
      return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
    }
    const saved = await store.updateOperation({
      operationId: operation.operationId,
      patch: { status: "processing", stage: "source", error: undefined, updatedAt: now() },
    });
    return saved
      ? { status: "ready" }
      : { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
  }

  async function loadDocument(
    store: DocumentStore,
    operation: DocumentOperationRecord,
  ): Promise<DocumentRecord | null> {
    return store.getDocument({ documentId: operation.documentId });
  }

  async function recordSource(
    store: DocumentStore,
    operation: DocumentOperationRecord,
    source: DocumentSourceRecord | null,
    pendingRemovalKeys: string[],
  ): Promise<boolean> {
    return store.recordSource({
      operationId: operation.operationId,
      source,
      pendingRemovalKeys: unique(pendingRemovalKeys),
    });
  }

  async function deletePreparedKey(input: {
    resources: WorkerResources;
    store: DocumentStore;
    operation: DocumentOperationRecord;
    source: DocumentSourceRecord | null;
    key: string;
    pendingRemovalKeys: string[];
  }): Promise<DocumentWorkerResult | null> {
    const { resources, store, operation, source, key, pendingRemovalKeys } = input;
    if (!safeKey(key, resources.preparedPrefix)) {
      return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
    }
    try {
      await objects.delete({ bucket: resources.documentBucketName, key });
    } catch (error) {
      if (isUncertainEffect(error)) {
        return updateUnconfirmed(store, operation, SAFE_ERRORS.effectUnconfirmed);
      }
      const recorded = await recordSource(store, operation, source, pendingRemovalKeys);
      if (!recorded) return { status: "unconfirmed", error: SAFE_ERRORS.effectUnconfirmed };
      return finishTerminal(
        store,
        operation,
        "failed",
        SAFE_ERRORS.sourceFailed,
        source,
        pendingRemovalKeys,
      );
    }

    const nextPending = pendingRemovalKeys.filter((pendingKey) => pendingKey !== key);
    const nextSource = source?.key === key ? null : source;
    const recorded = await recordSource(store, operation, nextSource, nextPending);
    if (!recorded) return { status: "unconfirmed", error: SAFE_ERRORS.effectUnconfirmed };
    return null;
  }

  async function promoteOperation(
    resources: WorkerResources,
    store: DocumentStore,
    operation: DocumentOperationRecord,
  ): Promise<DocumentWorkerResult> {
    const document = await loadDocument(store, operation);
    if (operation.action === "upload" || operation.action === "replace") {
      const file = fileFor(operation);
      const incomingKey = file ? expectedIncomingKey(resources, operation) : null;
      const candidateKey = file ? expectedPreparedKey(resources, operation) : null;
      if (!file || !incomingKey || !candidateKey) {
        return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
      }
      if (operation.action === "replace") {
        if (
          !document ||
          document.state !== "active" ||
          !matchesExpectedDocument(document, operation) ||
          pendingKeysOf(document).length > 0 ||
          !validStoredSource(resources, operation, operation.source ?? document.source)
        ) {
          return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
        }
      }
      const oldSource = operation.action === "replace" ? (document?.source ?? null) : null;
      let copied: { etag?: string };
      try {
        copied = await objects.copy({
          sourceBucket: resources.uploadBucketName,
          sourceKey: incomingKey,
          destinationBucket: resources.documentBucketName,
          destinationKey: candidateKey,
        });
      } catch (error) {
        if (isUncertainEffect(error)) {
          return updateUnconfirmed(store, operation, SAFE_ERRORS.effectUnconfirmed);
        }
        return failBeforeEffects(store, operation, SAFE_ERRORS.sourceFailed);
      }
      void copied;
      const promoted = sourceFromKey(
        resources.documentBucketName,
        candidateKey,
        file.sizeBytes,
        file.sha256,
      );
      const pendingAfterCopy = oldSource ? [oldSource.key] : [];
      const savedNewSource = await recordSource(store, operation, promoted, pendingAfterCopy);
      if (!savedNewSource) {
        return { status: "unconfirmed", error: SAFE_ERRORS.effectUnconfirmed };
      }
      if (oldSource) {
        const deletion = await deletePreparedKey({
          resources,
          store,
          operation,
          source: promoted,
          key: oldSource.key,
          pendingRemovalKeys: pendingAfterCopy,
        });
        if (deletion) return deletion;
      }
      const staged = await store.updateOperation({
        operationId: operation.operationId,
        patch: { status: "processing", stage: "ingestion", error: undefined, updatedAt: now() },
      });
      return staged
        ? { status: "ready" }
        : { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    }

    if (operation.action === "withdraw") {
      if (
        !document ||
        document.state !== "active" ||
        !matchesExpectedDocument(document, operation) ||
        !Array.isArray(operation.sourceUrisToObserve) ||
        !preparedUris(resources, operation, operation.sourceUrisToObserve)
      ) {
        return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
      }
      let currentSource: DocumentSourceRecord | null = document.source;
      let pendingKeys = unique(pendingKeysOf(document));
      if (currentSource && !validStoredSource(resources, operation, currentSource)) {
        return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
      }
      const keys = unique([...(currentSource ? [currentSource.key] : []), ...pendingKeys]);
      const expectedUris = keys.map((key) => sourceUri(resources.documentBucketName, key));
      if (expectedUris.some((uri) => !operation.sourceUrisToObserve?.includes(uri))) {
        return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
      }
      for (const key of keys) {
        const failed = await deletePreparedKey({
          resources,
          store,
          operation,
          source: currentSource,
          key,
          pendingRemovalKeys: pendingKeys,
        });
        if (failed) return failed;
        if (currentSource?.key === key) currentSource = null;
        pendingKeys = pendingKeys.filter((pendingKey) => pendingKey !== key);
      }
      const saved = await store.updateOperation({
        operationId: operation.operationId,
        patch: { status: "processing", stage: "ingestion", error: undefined, updatedAt: now() },
      });
      return saved
        ? { status: "ready" }
        : { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    }

    if (
      !document ||
      document.state !== "active" ||
      !matchesExpectedDocument(document, operation) ||
      !validStoredSource(resources, operation, operation.source ?? document.source)
    ) {
      return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
    }
    const currentSource = document.source;
    let pendingKeys = unique(pendingKeysOf(document));
    for (const key of pendingKeys) {
      const failed = await deletePreparedKey({
        resources,
        store,
        operation,
        source: currentSource,
        key,
        pendingRemovalKeys: pendingKeys,
      });
      if (failed) return failed;
      pendingKeys = pendingKeys.filter((pendingKey) => pendingKey !== key);
    }
    const saved = await store.updateOperation({
      operationId: operation.operationId,
      patch: { status: "processing", stage: "ingestion", error: undefined, updatedAt: now() },
    });
    return saved
      ? { status: "ready" }
      : { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
  }

  async function startIngestion(
    resources: WorkerResources,
    store: DocumentStore,
    operation: DocumentOperationRecord,
  ): Promise<DocumentWorkerResult> {
    if (operation.ingestionJobId) return { status: "ready" };
    const document = await loadDocument(store, operation);
    if (!document || document.state !== "active") {
      if (operation.action === "withdraw" && document?.state === "active") {
        // A failed withdrawal keeps its document active while the source is absent.
      } else {
        return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
      }
    }
    if (document && pendingKeysOf(document).length > 0) {
      return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
    }
    if (operation.action === "withdraw") {
      if (
        document?.source !== null ||
        !preparedUris(resources, operation, operation.sourceUrisToObserve ?? [])
      ) {
        return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
      }
    } else if (
      !document ||
      !validStoredSource(resources, operation, operation.source ?? document.source)
    ) {
      return failBeforeEffects(store, operation, SAFE_ERRORS.invalidState);
    }

    const persistedToken = operation.ingestionClientToken;
    const token = persistedToken ?? stableClientToken(resources.botId, operation.operationId);
    if (!validClientToken(token)) {
      return updateUnconfirmed(store, operation, SAFE_ERRORS.observationUnconfirmed);
    }
    if (!persistedToken) {
      let tokenSaved: boolean;
      try {
        tokenSaved = await store.updateOperation({
          operationId: operation.operationId,
          patch: {
            ingestionClientToken: token,
            status: "processing",
            stage: "ingestion",
            updatedAt: now(),
          },
        });
      } catch {
        let current: DocumentOperationRecord | null;
        try {
          current = await store.getOperation({ operationId: operation.operationId });
        } catch {
          return { status: "waiting" };
        }
        if (current?.ingestionClientToken === token) {
          tokenSaved = true;
        } else if (current?.status === "processing") {
          try {
            tokenSaved = await store.updateOperation({
              operationId: operation.operationId,
              patch: {
                ingestionClientToken: token,
                status: "processing",
                stage: "ingestion",
                updatedAt: now(),
              },
            });
          } catch {
            return { status: "waiting" };
          }
        } else {
          return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
        }
      }
      if (!tokenSaved) return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    }

    let started: { jobId?: string };
    try {
      started = await ingestion.start({
        knowledgeBaseId: resources.knowledgeBaseId,
        dataSourceId: resources.dataSourceId,
        clientToken: token,
        description: safeText(`multi-chatbot ${resources.botId} ${operation.operationId}`).slice(
          0,
          200,
        ),
      });
    } catch (error) {
      if (isThrottledOrBusy(error)) return { status: "waiting" };
      if (isUncertainEffect(error)) {
        return { status: "waiting" };
      }
      return failBeforeEffects(store, operation, SAFE_ERRORS.ingestionFailed);
    }
    if (typeof started.jobId !== "string" || started.jobId.length === 0) {
      return { status: "waiting" };
    }
    let savedJob: boolean;
    try {
      savedJob = await store.recordIngestionJob({
        operationId: operation.operationId,
        jobId: started.jobId,
      });
    } catch {
      let latest: DocumentOperationRecord | null;
      try {
        latest = await store.getOperation({ operationId: operation.operationId });
      } catch {
        return { status: "waiting" };
      }
      if (latest?.ingestionJobId === started.jobId) return { status: "ready" };
      if (!latest || latest.status !== "processing") {
        return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
      }
      try {
        savedJob = await store.recordIngestionJob({
          operationId: operation.operationId,
          jobId: started.jobId,
        });
      } catch {
        return { status: "waiting" };
      }
    }
    if (!savedJob) return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    return { status: "ready" };
  }

  async function inspectJob(
    resources: WorkerResources,
    operation: DocumentOperationRecord,
    document: DocumentRecord,
  ): Promise<{
    status: "waiting" | "ready" | "failed" | "unconfirmed";
    error?: { code: string; message: string };
  }> {
    if (!operation.ingestionJobId) {
      return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    }
    let job: Awaited<ReturnType<Ingestion["get"]>>;
    try {
      job = await ingestion.get({
        knowledgeBaseId: resources.knowledgeBaseId,
        dataSourceId: resources.dataSourceId,
        jobId: operation.ingestionJobId,
      });
    } catch {
      return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    }
    if (!job?.status) return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    if (job.status === "STARTING" || job.status === "IN_PROGRESS" || job.status === "STOPPING") {
      return { status: "waiting" };
    }
    if (!isTerminalJobStatus(job.status)) {
      return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    }
    if (job.status === "FAILED" || job.status === "STOPPED") {
      return { status: "failed", error: ingestionFailureError(job) };
    }
    if (!job.statistics || !Number.isInteger(job.statistics.numberOfDocumentsFailed)) {
      return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    }
    if (job.statistics.numberOfDocumentsFailed !== 0) {
      return { status: "failed", error: ingestionFailureError(job) };
    }

    const uris =
      operation.action === "withdraw"
        ? preparedUris(resources, operation, operation.sourceUrisToObserve ?? [])
        : (() => {
            const source =
              document.source && validStoredSource(resources, operation, document.source)
                ? document.source
                : operation.source;
            return validStoredSource(resources, operation, source) ? [source.uri] : null;
          })();
    if (!uris) return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
    let waiting = false;
    for (const uri of uris) {
      let observed: Awaited<ReturnType<Ingestion["getDocument"]>>;
      try {
        observed = await ingestion.getDocument({
          knowledgeBaseId: resources.knowledgeBaseId,
          dataSourceId: resources.dataSourceId,
          sourceUri: uri,
        });
      } catch {
        return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
      }
      if (!observed || observed.sourceUri !== uri) {
        return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
      }
      if (operation.action === "withdraw") {
        if (statusIsDeleting(observed.status)) {
          waiting = true;
        } else if (!statusIsAbsent(observed.status)) {
          return { status: "failed", error: SAFE_ERRORS.ingestionFailed };
        }
      } else if (observed.status !== "INDEXED") {
        if (statusIsDeleting(observed.status)) waiting = true;
        else if (
          observed.status === "PARTIALLY_INDEXED" ||
          observed.status === "METADATA_PARTIALLY_INDEXED" ||
          observed.status === "METADATA_UPDATE_FAILED" ||
          observed.status === "FAILED" ||
          observed.status === "IGNORED"
        ) {
          return { status: "failed", error: SAFE_ERRORS.ingestionFailed };
        } else {
          return { status: "unconfirmed", error: SAFE_ERRORS.observationUnconfirmed };
        }
      }
    }
    return waiting ? { status: "waiting" } : { status: "ready" };
  }

  async function observeIngestion(
    resources: WorkerResources,
    store: DocumentStore,
    operation: DocumentOperationRecord,
  ): Promise<DocumentWorkerResult> {
    const document = await loadDocument(store, operation);
    if (!document) return updateUnconfirmed(store, operation, SAFE_ERRORS.observationUnconfirmed);
    const observation = await inspectJob(resources, operation, document);
    if (observation.status === "unconfirmed") {
      return updateUnconfirmed(
        store,
        operation,
        observation.error ?? SAFE_ERRORS.observationUnconfirmed,
      );
    }
    if (observation.status === "failed") {
      return { status: "failed", error: observation.error ?? SAFE_ERRORS.ingestionFailed };
    }
    if (observation.status === "ready") return { status: "completed" };
    return { status: observation.status };
  }

  async function finishIngestion(
    resources: WorkerResources,
    store: DocumentStore,
    operation: DocumentOperationRecord,
  ): Promise<DocumentWorkerResult> {
    const document = await loadDocument(store, operation);
    if (!document) return updateUnconfirmed(store, operation, SAFE_ERRORS.observationUnconfirmed);
    const observation = await inspectJob(resources, operation, document);
    if (observation.status === "waiting") {
      return updateUnconfirmed(store, operation, SAFE_ERRORS.observationUnconfirmed);
    }
    if (observation.status === "unconfirmed") {
      return updateUnconfirmed(
        store,
        operation,
        observation.error ?? SAFE_ERRORS.observationUnconfirmed,
      );
    }
    if (observation.status === "failed") {
      return finishTerminal(
        store,
        operation,
        "failed",
        observation.error ?? SAFE_ERRORS.ingestionFailed,
        document.source,
        pendingKeysOf(document),
      );
    }
    if (operation.action === "withdraw" && document.source !== null) {
      return updateUnconfirmed(store, operation, SAFE_ERRORS.observationUnconfirmed);
    }
    const completionSource =
      document.source && validStoredSource(resources, operation, document.source)
        ? document.source
        : (operation.source ?? document.source);
    return finishTerminal(
      store,
      operation,
      "completed",
      undefined,
      completionSource,
      pendingKeysOf(document),
    );
  }

  return {
    async run(input: { botId: string; operationId: string; step: DocumentWorkerStep }) {
      if (
        !isRecord(input) ||
        typeof input.botId !== "string" ||
        !isValidOperationId(input.operationId) ||
        !["validate", "promote", "start-ingestion", "observe-ingestion", "finish"].includes(
          input.step,
        )
      ) {
        throw new TypeError("Document worker input is invalid.");
      }
      const store = stores[input.botId];
      const resources = resourcesByBot[input.botId];
      if (!store || !resources || (resources.botId && resources.botId !== input.botId)) {
        throw new TypeError("Document worker chatbot is not configured.");
      }
      let operation: DocumentOperationRecord | null;
      try {
        operation = await store.getOperation({ operationId: input.operationId });
      } catch {
        return {
          status: "unconfirmed",
          error: SAFE_ERRORS.observationUnconfirmed,
        } satisfies DocumentWorkerResult;
      }
      if (!operation || operation.operationId !== input.operationId) {
        return { status: "failed", error: SAFE_ERRORS.invalidState } satisfies DocumentWorkerResult;
      }
      if (operation.status === "completed") return { status: "completed" };
      if (operation.status === "failed") {
        return {
          status: "failed",
          ...(operation.error ? { error: operation.error } : {}),
        } satisfies DocumentWorkerResult;
      }
      if (operation.status === "unconfirmed") {
        return {
          status: "unconfirmed",
          error: operation.error ?? SAFE_ERRORS.observationUnconfirmed,
        } satisfies DocumentWorkerResult;
      }
      if (operation.status !== "processing") {
        return { status: "failed", error: SAFE_ERRORS.invalidState } satisfies DocumentWorkerResult;
      }
      try {
        switch (input.step) {
          case "validate":
            return await validateOperation(resources, store, operation);
          case "promote":
            return await promoteOperation(resources, store, operation);
          case "start-ingestion":
            return await startIngestion(resources, store, operation);
          case "observe-ingestion":
            return await observeIngestion(resources, store, operation);
          case "finish":
            return await finishIngestion(resources, store, operation);
        }
      } catch {
        const stageError =
          input.step === "validate" || input.step === "observe-ingestion" || input.step === "finish"
            ? SAFE_ERRORS.observationUnconfirmed
            : SAFE_ERRORS.effectUnconfirmed;
        return updateUnconfirmed(store, operation, stageError);
      }
    },
  };
}
