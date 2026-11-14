export const DOCUMENT_MAX_BYTES = 50_000_000;

export const DOCUMENT_CONTENT_TYPES = {
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} as const;

export type DocumentAction = "upload" | "replace" | "withdraw" | "reprocess";
export type DocumentOperationStatus =
  "awaiting_upload" | "pending_start" | "processing" | "completed" | "failed" | "unconfirmed";
export type DocumentOperationStage = "upload" | "validation" | "source" | "ingestion" | "result";
export type DocumentProcessingStatus = "processing" | "completed" | "failed" | "unconfirmed";

export type DocumentFileInput = {
  name: string;
  sizeBytes: number;
  sha256: string;
};

export type DocumentErrorView = {
  code: string;
  message: string;
};

export type DocumentOperationView = {
  operationId: string;
  documentId: string;
  action: DocumentAction;
  documentName?: string;
  status: DocumentOperationStatus;
  stage: DocumentOperationStage;
  revision: string;
  updatedAt: string;
  canRetry: boolean;
  error?: DocumentErrorView;
};

export type DocumentView = {
  documentId: string;
  name: string;
  sizeBytes: number;
  revision: string;
  updatedAt: string;
  canReplace: boolean;
  canRetry: boolean;
  processing: {
    status: DocumentProcessingStatus;
    operationId: string;
    error?: DocumentErrorView;
  };
};

export type DocumentListView = {
  botId: string;
  documents: DocumentView[];
  nextCursor: string | null;
  activeOperation: DocumentOperationView | null;
  lastOperation: DocumentOperationView | null;
};

export type DocumentUploadView = {
  url: string;
  fields: Record<string, string>;
  expiresAt: number;
};

export type DocumentOperationResponse = {
  botId: string;
  operation: DocumentOperationView;
  upload?: DocumentUploadView;
};

export function isDocumentAction(value: unknown): value is DocumentAction {
  return value === "upload" || value === "replace" || value === "withdraw" || value === "reprocess";
}

export function documentContentTypeForName(name: string): string | null {
  const extension = name.toLowerCase().split(".").at(-1);
  if (!extension || !Object.hasOwn(DOCUMENT_CONTENT_TYPES, extension)) return null;
  return DOCUMENT_CONTENT_TYPES[extension as keyof typeof DOCUMENT_CONTENT_TYPES];
}

export function isUtf8TextDocument(name: string): boolean {
  const extension = name.toLowerCase().split(".").at(-1);
  return extension === "txt" || extension === "md" || extension === "html";
}

export function isValidDocumentFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    new TextEncoder().encode(value).byteLength <= 255 &&
    value.trim() === value &&
    !/[\\/\u0000-\u001f\u007f]/.test(value) &&
    value !== "." &&
    value !== ".." &&
    documentContentTypeForName(value) !== null
  );
}

export function validateDocumentFile(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["file"];
  const file = value as Record<string, unknown>;
  const fields: string[] = [];
  if (!isValidDocumentFileName(file.name)) {
    fields.push("name");
  }
  if (!Number.isSafeInteger(file.sizeBytes) || (file.sizeBytes as number) < 1) {
    fields.push("sizeBytes");
  }
  if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    fields.push("sha256");
  }
  return fields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorView(value: unknown): value is DocumentErrorView {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string";
}

function isDocumentOperationStatus(value: unknown): value is DocumentOperationStatus {
  return (
    value === "awaiting_upload" ||
    value === "pending_start" ||
    value === "processing" ||
    value === "completed" ||
    value === "failed" ||
    value === "unconfirmed"
  );
}

function isDocumentOperationStage(value: unknown): value is DocumentOperationStage {
  return (
    value === "upload" ||
    value === "validation" ||
    value === "source" ||
    value === "ingestion" ||
    value === "result"
  );
}

function isProcessingStatus(value: unknown): value is DocumentProcessingStatus {
  return (
    value === "processing" || value === "completed" || value === "failed" || value === "unconfirmed"
  );
}

export function parseDocumentOperationView(value: unknown): DocumentOperationView | null {
  if (
    !isRecord(value) ||
    typeof value.operationId !== "string" ||
    typeof value.documentId !== "string" ||
    !isDocumentAction(value.action) ||
    !isDocumentOperationStatus(value.status) ||
    !isDocumentOperationStage(value.stage) ||
    (value.documentName !== undefined && !isValidDocumentFileName(value.documentName)) ||
    typeof value.revision !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    typeof value.canRetry !== "boolean" ||
    (value.error !== undefined && !isErrorView(value.error))
  ) {
    return null;
  }
  return {
    operationId: value.operationId,
    documentId: value.documentId,
    action: value.action,
    ...(value.documentName !== undefined ? { documentName: value.documentName } : {}),
    status: value.status,
    stage: value.stage,
    revision: value.revision,
    updatedAt: value.updatedAt,
    canRetry: value.canRetry,
    ...(value.error ? { error: value.error as DocumentErrorView } : {}),
  };
}

export function parseDocumentView(value: unknown): DocumentView | null {
  if (
    !isRecord(value) ||
    typeof value.documentId !== "string" ||
    typeof value.name !== "string" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 1 ||
    typeof value.revision !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    typeof value.canReplace !== "boolean" ||
    typeof value.canRetry !== "boolean" ||
    !isRecord(value.processing) ||
    !isProcessingStatus(value.processing.status) ||
    typeof value.processing.operationId !== "string" ||
    (value.processing.error !== undefined && !isErrorView(value.processing.error))
  ) {
    return null;
  }
  return {
    documentId: value.documentId,
    name: value.name,
    sizeBytes: value.sizeBytes as number,
    revision: value.revision,
    updatedAt: value.updatedAt,
    canReplace: value.canReplace,
    canRetry: value.canRetry,
    processing: {
      status: value.processing.status,
      operationId: value.processing.operationId,
      ...(value.processing.error ? { error: value.processing.error as DocumentErrorView } : {}),
    },
  };
}

export function parseDocumentListView(value: unknown): DocumentListView | null {
  if (
    !isRecord(value) ||
    typeof value.botId !== "string" ||
    !Array.isArray(value.documents) ||
    !value.documents.every((document) => parseDocumentView(document) !== null) ||
    !(value.nextCursor === null || typeof value.nextCursor === "string") ||
    !(value.activeOperation === null || parseDocumentOperationView(value.activeOperation)) ||
    !(value.lastOperation === null || parseDocumentOperationView(value.lastOperation))
  ) {
    return null;
  }
  return {
    botId: value.botId,
    documents: value.documents.map((document) => parseDocumentView(document) as DocumentView),
    nextCursor: value.nextCursor,
    activeOperation:
      value.activeOperation === null
        ? null
        : (parseDocumentOperationView(value.activeOperation) as DocumentOperationView),
    lastOperation:
      value.lastOperation === null
        ? null
        : (parseDocumentOperationView(value.lastOperation) as DocumentOperationView),
  };
}
