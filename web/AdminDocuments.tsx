import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  DOCUMENT_CONTENT_TYPES,
  DOCUMENT_MAX_BYTES,
  parseDocumentListView,
  parseDocumentOperationView,
  type DocumentAction,
  type DocumentListView,
  type DocumentOperationView,
  type DocumentUploadView,
  type DocumentView,
  validateDocumentFile,
} from "../config/documents";
import {
  documentAdministrations,
  type AdminPublicConfig,
  type DocumentIntentBody,
} from "./admin-api";
import type { Session } from "./session";

type AdminDocumentsProps = {
  botId: string;
  projectName: string;
  config: AdminPublicConfig;
  session: Session;
  onAuthorizationError: (status: number) => void;
};

type Notice = { kind: "status" | "error"; text: string };
type PendingIntent = {
  operationId: string;
  file: File | null;
  body: DocumentIntentBody | null;
  target: DocumentView | null;
};
type UploadReceipt = {
  operation: DocumentOperationView;
  ticket: DocumentUploadView;
  file: File;
};
type DocumentFileIssue = "DOCUMENT_TOO_LARGE" | "DOCUMENT_EMPTY" | "INVALID_DOCUMENT_NAME";

const acceptedExtensions = Object.keys(DOCUMENT_CONTENT_TYPES)
  .map((extension) => `.${extension}`)
  .join(",");
const withdrawnMessage =
  "Retirada procesada. El chat puede tardar unos minutos en reflejar el cambio. Las respuestas anteriores se conservan";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTerminal(operation: DocumentOperationView | null): boolean {
  return operation?.status === "completed" || operation?.status === "failed";
}

function operationNotice(operation: DocumentOperationView): Notice {
  if (operation.status === "completed") {
    return {
      kind: "status",
      text:
        operation.action === "withdraw"
          ? withdrawnMessage
          : "Procesamiento completado. Los cambios pueden tardar unos minutos en aparecer en el chat.",
    };
  }
  if (operation.status === "failed") {
    return {
      kind: "error",
      text: operation.error?.message || "No se pudo completar el procesamiento del documento.",
    };
  }
  if (operation.status === "pending_start") {
    return {
      kind: "status",
      text: "El servidor confirmó que falta iniciar el procesamiento. Podés reintentar el inicio.",
    };
  }
  if (operation.status === "unconfirmed") {
    return {
      kind: "error",
      text: "No pudimos confirmar el resultado. Consultá el estado antes de otra acción.",
    };
  }
  return {
    kind: "status",
    text:
      operation.action === "withdraw"
        ? "Retirando el documento…"
        : "El procesamiento está en curso. Podés salir; continuará en el servidor.",
  };
}

function operationResponse(
  value: unknown,
  botId: string,
  expectedOperationId: string,
  expectedAction?: DocumentAction,
  expectedDocumentId?: string,
): DocumentOperationView {
  if (!isRecord(value) || value.botId !== botId) throw new Error("INVALID_RESPONSE");
  const operation = parseDocumentOperationView(value.operation);
  if (
    !operation ||
    !operation.documentId ||
    operation.operationId !== expectedOperationId ||
    (expectedAction && operation.action !== expectedAction) ||
    (expectedDocumentId && operation.documentId !== expectedDocumentId)
  ) {
    throw new Error("INVALID_RESPONSE");
  }
  return operation;
}

function uploadTicket(value: unknown): DocumentUploadView {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    !isRecord(value.fields) ||
    !Object.entries(value.fields).every(
      ([name, field]) => Boolean(name) && typeof field === "string",
    )
  ) {
    throw new Error("INVALID_RESPONSE");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("INVALID_RESPONSE");
  }
  if (url.protocol !== "https:" || value.expiresAt <= Date.now()) {
    throw new Error("INVALID_RESPONSE");
  }
  return {
    url: value.url,
    fields: value.fields as Record<string, string>,
    expiresAt: value.expiresAt,
  };
}

function makeOperationId(): string {
  if (typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(file: File): Promise<string> {
  const digest = await window.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1_000_000) return `${sizeBytes.toLocaleString("es-AR")} bytes`;
  return `${(sizeBytes / 1_000_000).toLocaleString("es-AR", { maximumFractionDigits: 1 })} MB`;
}

function documentFileIssue(file: File): DocumentFileIssue | null {
  if (file.size > DOCUMENT_MAX_BYTES) return "DOCUMENT_TOO_LARGE";
  const invalidFields = validateDocumentFile({
    name: file.name,
    sizeBytes: file.size,
    sha256: "0".repeat(64),
  });
  if (invalidFields.includes("name")) return "INVALID_DOCUMENT_NAME";
  if (invalidFields.includes("sizeBytes")) return "DOCUMENT_EMPTY";
  return null;
}

function documentFileIssueMessage(issue: DocumentFileIssue): string {
  if (issue === "DOCUMENT_TOO_LARGE") {
    return "El archivo supera el límite de 50.000.000 bytes (50 MB). Elegí un archivo más pequeño.";
  }
  if (issue === "DOCUMENT_EMPTY") return "El archivo está vacío. Elegí un archivo con contenido.";
  return "El formato del archivo no está admitido. Elegí TXT, MD, HTML, DOC, DOCX, CSV, XLS, XLSX o PDF.";
}

function isDocumentFileIssue(value: unknown): value is DocumentFileIssue {
  return (
    value === "DOCUMENT_TOO_LARGE" ||
    value === "DOCUMENT_EMPTY" ||
    value === "INVALID_DOCUMENT_NAME"
  );
}

function errorStatus(error: unknown): number {
  return error instanceof Error && "status" in error && typeof error.status === "number"
    ? error.status
    : 0;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

function errorNotice(error: unknown, fallback: string): Notice {
  const code = errorCode(error);
  const status = errorStatus(error);
  if (error instanceof Error && error.message === "INVALID_RESPONSE") {
    return {
      kind: "error",
      text: "El servidor devolvió una respuesta documental inválida. Actualizá para volver a consultar.",
    };
  }
  if (status === 409 || code === "STATE_CHANGED") {
    return {
      kind: "error",
      text: "El documento cambió. Actualizamos la lista; revisá la revisión vigente antes de volver a intentarlo.",
    };
  }
  if (status === 503 || code === "DOCUMENT_OPERATION_UNCONFIRMED" || status === 0) {
    return {
      kind: "error",
      text: "No pudimos confirmar el resultado. Consultá el estado antes de decidir otra acción.",
    };
  }
  return { kind: "error", text: fallback };
}

export function AdminDocuments({
  botId,
  projectName,
  config,
  session,
  onAuthorizationError,
}: AdminDocumentsProps) {
  const [list, setList] = useState<DocumentListView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNoticeState] = useState<Notice | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [replacementTarget, setReplacementTarget] = useState<DocumentView | null>(null);
  const [operation, setOperation] = useState<DocumentOperationView | null>(null);
  const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null);
  const [uploadReceipt, setUploadReceipt] = useState<UploadReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingWithdraw, setConfirmingWithdraw] = useState<string | null>(null);
  const [visible, setVisible] = useState(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const alertRef = useRef<HTMLParagraphElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const withdrawTriggerRef = useRef<HTMLButtonElement | null>(null);
  const withdrawConfirmationRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingWithdrawRef = useRef(false);
  const mountedRef = useRef(false);
  const mutationRef = useRef(false);
  const listEpochRef = useRef(0);
  const hasLoadedListRef = useRef(false);
  const operationReadEpochRef = useRef(0);
  const readAbortRef = useRef<AbortController | null>(null);
  const activeOperationRef = useRef<DocumentOperationView | null>(null);
  const pendingIntentRef = useRef<PendingIntent | null>(null);
  const uploadReceiptRef = useRef<UploadReceipt | null>(null);
  const handledTerminalRef = useRef<string | null>(null);
  const api = documentAdministrations(config, session, botId, () => mountedRef.current);
  const setNotice = (next: Notice | null) => {
    if (mountedRef.current) setNoticeState(next);
  };

  const setPending = (pending: PendingIntent | null) => {
    pendingIntentRef.current = pending;
    if (mountedRef.current) setPendingIntent(pending);
  };

  const setReceipt = (receipt: UploadReceipt | null) => {
    uploadReceiptRef.current = receipt;
    if (mountedRef.current) setUploadReceipt(receipt);
  };

  const setCurrentOperation = (next: DocumentOperationView | null) => {
    activeOperationRef.current = next;
    if (mountedRef.current) setOperation(next);
  };

  const markAuthorizationFailure = (error: unknown) => {
    const status = errorStatus(error);
    if (mountedRef.current && (status === 401 || status === 403)) onAuthorizationError(status);
  };

  const abortRead = () => {
    readAbortRef.current?.abort();
    readAbortRef.current = null;
  };

  const applyList = (next: DocumentListView, append: boolean) => {
    if (!mountedRef.current) return;
    hasLoadedListRef.current = true;
    setList((current) => {
      if (!append || !current) return next;
      const merged = new Map(current.documents.map((item) => [item.documentId, item]));
      for (const item of next.documents) merged.set(item.documentId, item);
      return { ...next, documents: [...merged.values()] };
    });
    const nextOperation = next.activeOperation ?? next.lastOperation;
    if (next.activeOperation) {
      setCurrentOperation(next.activeOperation);
      setNotice(operationNotice(next.activeOperation));
    } else if (
      next.lastOperation &&
      (!activeOperationRef.current ||
        activeOperationRef.current.operationId === next.lastOperation.operationId)
    ) {
      setCurrentOperation(next.lastOperation);
      if (!isTerminal(next.lastOperation)) setNotice(operationNotice(next.lastOperation));
    } else if (activeOperationRef.current && !isTerminal(activeOperationRef.current)) {
      setCurrentOperation(null);
    }
    if (nextOperation && isTerminal(nextOperation)) {
      applyTerminalNotice(nextOperation);
    } else if (activeOperationRef.current && isTerminal(activeOperationRef.current)) {
      return;
    } else if (!activeOperationRef.current && !next.documents.length && !next.lastOperation) {
      setNotice({
        kind: "status",
        text: "Todavía no hay documentos preparados para este chatbot.",
      });
    } else if (!next.activeOperation && !next.lastOperation) {
      setNotice(null);
    }
  };

  const applyTerminalNotice = (finished: DocumentOperationView) => {
    const key = `${finished.operationId}:${finished.status}`;
    if (handledTerminalRef.current === key && finished.status === "failed") return;
    handledTerminalRef.current = key;
    setNotice(operationNotice(finished));
    if (finished.status === "completed" && finished.action === "replace") {
      setReplacementTarget(null);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const readList = async (cursor?: string | null, append = false) => {
    const ticket = ++listEpochRef.current;
    abortRead();
    const controller = new AbortController();
    readAbortRef.current = controller;
    if (mountedRef.current) {
      if (append) setLoadingMore(true);
      else setLoading(true);
      if (!append && !hasLoadedListRef.current) {
        setNotice({ kind: "status", text: "Consultando documentos…" });
      }
    }
    try {
      const value = await api.list(cursor, controller.signal);
      if (!mountedRef.current || ticket !== listEpochRef.current || controller.signal.aborted)
        return;
      const parsed = parseDocumentListView(value);
      if (!parsed || parsed.botId !== botId) throw new Error("INVALID_RESPONSE");
      applyList(parsed, append);
    } catch (error) {
      if (!mountedRef.current || ticket !== listEpochRef.current || controller.signal.aborted)
        return;
      markAuthorizationFailure(error);
      setNotice({
        kind: "error",
        text:
          error instanceof Error && error.message === "INVALID_RESPONSE"
            ? "El servidor devolvió una respuesta documental inválida. Actualizá para volver a consultar."
            : "No pudimos cargar los documentos. Revisá la conexión e intentá actualizar la lista.",
      });
    } finally {
      if (readAbortRef.current === controller) readAbortRef.current = null;
      if (mountedRef.current && ticket === listEpochRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  const readOperation = async (operationId: string, expectedAction?: DocumentAction) => {
    const ticket = ++operationReadEpochRef.current;
    abortRead();
    const controller = new AbortController();
    readAbortRef.current = controller;
    try {
      const value = await api.get(operationId, controller.signal);
      if (
        !mountedRef.current ||
        ticket !== operationReadEpochRef.current ||
        controller.signal.aborted
      )
        return null;
      const expectedDocumentId =
        activeOperationRef.current?.operationId === operationId
          ? activeOperationRef.current.documentId
          : undefined;
      const next = operationResponse(value, botId, operationId, expectedAction, expectedDocumentId);
      setCurrentOperation(next);
      if (isTerminal(next)) {
        applyTerminalNotice(next);
        if (mountedRef.current) await readList();
      } else if (next.status === "pending_start") {
        setNotice({
          kind: "status",
          text: "El servidor confirmó que falta iniciar el procesamiento. Podés reintentar el inicio.",
        });
      } else if (next.status === "unconfirmed") {
        setNotice({
          kind: "error",
          text: "No pudimos confirmar el resultado. Consultá el estado antes de otra acción.",
        });
      } else {
        setNotice(operationNotice(next));
      }
      return next;
    } catch (error) {
      if (
        !mountedRef.current ||
        ticket !== operationReadEpochRef.current ||
        controller.signal.aborted
      )
        return null;
      markAuthorizationFailure(error);
      setNotice(errorNotice(error, "No pudimos consultar el estado del procesamiento."));
      return null;
    } finally {
      if (readAbortRef.current === controller) readAbortRef.current = null;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void readList();
    const onVisibilityChange = () => {
      const isVisible = document.visibilityState !== "hidden";
      setVisible(isVisible);
      if (!isVisible) abortRead();
      else {
        const active = activeOperationRef.current;
        if (active && !isTerminal(active)) {
          void readOperation(active.operationId, active.action);
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mountedRef.current = false;
      listEpochRef.current += 1;
      operationReadEpochRef.current += 1;
      abortRead();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // A mounted panel belongs to one selected chatbot and one signed-in identity.
  }, []);

  useEffect(() => {
    if (notice?.kind !== "error") return;
    queueMicrotask(() => {
      if (mountedRef.current) alertRef.current?.focus();
    });
  }, [notice]);

  useLayoutEffect(() => {
    if (confirmingWithdraw) {
      withdrawConfirmationRef.current?.focus();
      wasConfirmingWithdrawRef.current = true;
    } else if (wasConfirmingWithdrawRef.current) {
      withdrawTriggerRef.current?.focus();
      wasConfirmingWithdrawRef.current = false;
    }
  }, [confirmingWithdraw]);

  useEffect(() => {
    if (!operation || isTerminal(operation) || !visible || !mountedRef.current) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "hidden" && mountedRef.current) {
        void readOperation(operation.operationId, operation.action);
      }
    }, 5_000);
    return () => window.clearTimeout(timer);
    // readOperation is intentionally refreshed from the current operation each poll.
  }, [operation, visible]);

  const hasActiveOperation = Boolean(
    list?.activeOperation || (operation && !isTerminal(operation)),
  );
  const actionLocked = busy || mutationRef.current || Boolean(pendingIntent) || hasActiveOperation;

  const prepareIntent = async (pending: PendingIntent) => {
    if (mutationRef.current) return;
    mutationRef.current = true;
    if (mountedRef.current) {
      setBusy(true);
      setNotice({
        kind: "status",
        text: pending.file ? "Calculando la huella del archivo…" : "Preparando la operación…",
      });
    }
    let requestBody = pending.body;
    try {
      if (!requestBody) {
        if (!pending.file) throw new Error("INVALID_RESPONSE");
        const fileIssue = documentFileIssue(pending.file);
        if (fileIssue) throw new Error(fileIssue);
        const digest = await sha256(pending.file);
        const file = { name: pending.file.name, sizeBytes: pending.file.size, sha256: digest };
        const body: DocumentIntentBody = pending.target
          ? {
              operationId: pending.operationId,
              action: "replace",
              documentId: pending.target.documentId,
              expectedRevision: pending.target.revision,
              file,
            }
          : { operationId: pending.operationId, action: "upload", file };
        const hashed = { ...pending, body };
        setPending(hashed);
        requestBody = body;
      }
      if (!requestBody) throw new Error("INVALID_RESPONSE");
      const currentBody = requestBody;
      const request = await api.createIntent(currentBody);
      const operationView = operationResponse(
        request,
        botId,
        pending.operationId,
        currentBody.action,
        currentBody.documentId,
      );
      const expectsUpload = currentBody.action === "upload" || currentBody.action === "replace";
      if (operationView.status !== (expectsUpload ? "awaiting_upload" : "pending_start")) {
        throw new Error("INVALID_RESPONSE");
      }
      if (!expectsUpload && isRecord(request) && request.upload !== undefined) {
        throw new Error("INVALID_RESPONSE");
      }
      setPending(null);
      setCurrentOperation(operationView);
      setNotice(operationNotice(operationView));

      if (expectsUpload) {
        if (!isRecord(request) || request.upload === undefined) throw new Error("INVALID_RESPONSE");
        if (!pending.file) throw new Error("INVALID_RESPONSE");
        const ticket = uploadTicket(request.upload);
        const receipt = { operation: operationView, ticket, file: pending.file };
        setReceipt(receipt);
        await transferFile(receipt);
      } else {
        await startOperation(operationView);
      }
    } catch (error) {
      const code = errorCode(error);
      const status = errorStatus(error);
      markAuthorizationFailure(error);
      if (error instanceof Error && isDocumentFileIssue(error.message)) {
        setNotice({ kind: "error", text: documentFileIssueMessage(error.message) });
        setPending(null);
      } else if (error instanceof Error && error.message === "INVALID_RESPONSE") {
        setPending(null);
        setNotice(
          errorNotice(
            error,
            "El servidor devolvió datos documentales no válidos. No se iniciará la operación.",
          ),
        );
      } else if (status === 409 && code === "DOCUMENT_OPERATION_ACTIVE") {
        setPending(null);
        setNotice({
          kind: "error",
          text: "Ya hay una operación documental en curso para este chatbot. Actualizamos la lista.",
        });
        if (mountedRef.current) await readList();
      } else if (status === 409 || code === "STATE_CHANGED") {
        setPending(null);
        setNotice(
          errorNotice(
            error,
            "El documento cambió. Actualizamos la lista; revisá la revisión vigente.",
          ),
        );
        if (mountedRef.current) await readList();
      } else if (status === 0 || status >= 500 || code === "DOCUMENT_OPERATION_UNCONFIRMED") {
        if (requestBody) setPending({ ...pending, body: requestBody });
        setNotice(
          errorNotice(
            error,
            "No pudimos registrar la operación. Podés reintentar la misma intención.",
          ),
        );
      } else {
        setPending(null);
        setNotice(errorNotice(error, "No pudimos registrar la operación documental."));
      }
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const transferFile = async (receipt: UploadReceipt) => {
    if (mountedRef.current) {
      setNotice({ kind: "status", text: "Subiendo el archivo preparado…" });
      setBusy(true);
    }
    const form = new FormData();
    for (const [name, value] of Object.entries(receipt.ticket.fields)) form.append(name, value);
    form.append("file", receipt.file);
    let response: Response;
    try {
      response = await fetch(receipt.ticket.url, { method: "POST", body: form });
    } catch {
      if (mountedRef.current) {
        setNotice({
          kind: "error",
          text: "No se confirmó la transferencia. Podés reintentar la subida del mismo archivo.",
        });
      }
      return;
    }
    if (!response.ok) {
      if (mountedRef.current) {
        setNotice({
          kind: "error",
          text: "La transferencia no fue confirmada por el almacenamiento. Podés reintentar la subida del mismo archivo.",
        });
      }
      return;
    }
    await startOperation(receipt.operation);
  };

  const startOperation = async (source: DocumentOperationView) => {
    if (mountedRef.current) {
      setNotice({ kind: "status", text: "Iniciando el procesamiento…" });
      setBusy(true);
    }
    try {
      const value = await api.start(source.operationId);
      const started = operationResponse(
        value,
        botId,
        source.operationId,
        source.action,
        source.documentId,
      );
      setCurrentOperation({ ...started, status: "unconfirmed" });
      setNotice({
        kind: "status",
        text: "Inicio confirmado. Consultando el resultado del procesamiento…",
      });
      if (mountedRef.current) {
        await readOperation(started.operationId, started.action);
      }
    } catch (error) {
      const status = errorStatus(error);
      markAuthorizationFailure(error);
      if (status === 409 && errorCode(error) === "DOCUMENT_OPERATION_ACTIVE") {
        if (mountedRef.current) await readList();
        setNotice({
          kind: "error",
          text: "Otra operación documental empezó para este chatbot. Actualizamos la lista para confirmar el estado.",
        });
        return;
      }
      if (status === 409 || errorCode(error) === "STATE_CHANGED") {
        if (mountedRef.current) await readList();
        setNotice(
          errorNotice(
            error,
            "El documento cambió antes de iniciar. Actualizamos la lista sin reenviar la operación.",
          ),
        );
        return;
      }
      setCurrentOperation({ ...source, status: "unconfirmed" });
      setNotice({
        kind: "error",
        text: "No pudimos confirmar el inicio. Consultá el estado antes de volver a iniciar.",
      });
      if (mountedRef.current) await readOperation(source.operationId, source.action);
    }
  };

  const retryUpload = async () => {
    const receipt = uploadReceiptRef.current;
    if (!receipt || mutationRef.current) return;
    mutationRef.current = true;
    setBusy(true);
    try {
      await transferFile(receipt);
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSelectedFile(event.currentTarget.files?.[0] ?? null);
    setNotice(null);
  };

  const beginFileOperation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (actionLocked || !selectedFile) return;
    const fileIssue = documentFileIssue(selectedFile);
    if (fileIssue) {
      setNotice({ kind: "error", text: documentFileIssueMessage(fileIssue) });
      return;
    }
    const pending: PendingIntent = {
      operationId: makeOperationId(),
      file: selectedFile,
      body: null,
      target: replacementTarget,
    };
    setPending(pending);
    await prepareIntent(pending);
  };

  const beginNonFileOperation = async (
    action: "withdraw" | "reprocess",
    documentId: string,
    expectedRevision: string,
  ) => {
    if (actionLocked) return;
    const operationId = makeOperationId();
    const pending: PendingIntent = {
      operationId,
      file: null,
      body: { operationId, action, documentId, expectedRevision },
      target: null,
    };
    setPending(pending);
    await prepareIntent(pending);
  };

  const retryUncertainIntent = async () => {
    const pending = pendingIntentRef.current;
    if (!pending?.body || mutationRef.current) return;
    await prepareIntent(pending);
  };

  const retryConfirmedStart = async () => {
    const current = activeOperationRef.current;
    if (!current || current.status !== "pending_start" || mutationRef.current) return;
    mutationRef.current = true;
    setBusy(true);
    try {
      await startOperation(current);
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const checkCurrentOperation = async () => {
    const current = activeOperationRef.current;
    if (!current || mutationRef.current) return;
    await readOperation(current.operationId, current.action);
  };

  const retryFailedOperation = async (document?: DocumentView) => {
    const failed =
      list?.lastOperation?.status === "failed"
        ? list.lastOperation
        : operation?.status === "failed"
          ? operation
          : null;
    if (!failed?.canRetry || actionLocked) return;
    if (failed.action === "withdraw") {
      const target =
        document ?? list?.documents.find((item) => item.documentId === failed.documentId);
      await beginNonFileOperation(
        "withdraw",
        failed.documentId,
        target?.revision ?? failed.revision,
      );
      return;
    }
    const target =
      document ?? list?.documents.find((item) => item.documentId === failed.documentId);
    await beginNonFileOperation(
      "reprocess",
      target?.documentId ?? failed.documentId,
      target?.revision ?? failed.revision,
    );
  };

  const confirmWithdraw = async (target: DocumentView) => {
    setConfirmingWithdraw(null);
    await beginNonFileOperation("withdraw", target.documentId, target.revision);
  };

  const beginReplacement = (target: DocumentView) => {
    if (actionLocked || !target.canReplace) return;
    setReplacementTarget(target);
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setNotice({ kind: "status", text: `Elegí el archivo que reemplazará ${target.name}.` });
  };

  const cancelReplacement = () => {
    if (busy || pendingIntent) return;
    setReplacementTarget(null);
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setNotice(null);
  };

  const refresh = () => {
    void readList();
  };

  const activeOperation =
    list?.activeOperation ?? (operation && !isTerminal(operation) ? operation : null);
  const activeOperationDocumentName = activeOperation
    ? (activeOperation.documentName ??
      list?.documents.find((document) => document.documentId === activeOperation.documentId)?.name)
    : undefined;
  const locked = busy || Boolean(pendingIntent) || Boolean(activeOperation);
  const activeOperationHeading = activeOperation
    ? activeOperation.status === "awaiting_upload"
      ? "Recepción pendiente"
      : activeOperation.status === "pending_start"
        ? "Pendiente de inicio"
        : activeOperation.status === "unconfirmed"
          ? "Resultado sin confirmar"
          : activeOperation.action === "withdraw"
            ? "Retirando documento"
            : "Operación documental en curso"
    : "";
  const activeOperationDetail = activeOperation
    ? activeOperation.status === "awaiting_upload"
      ? "El archivo todavía se está transfiriendo. La operación no empezó."
      : activeOperation.status === "pending_start"
        ? "El servidor confirmó que la ejecución todavía no empezó."
        : activeOperation.status === "unconfirmed"
          ? "No sabemos si el procesamiento comenzó. Consultá el estado antes de otra acción."
          : "Las acciones de este chatbot quedan deshabilitadas hasta que termine."
    : "";
  const activeOperationStage =
    activeOperation?.status === "processing"
      ? {
          upload: "Recepción del archivo",
          validation: "Validando el documento",
          source: "Actualizando la fuente",
          ingestion: "Procesando el contenido",
          result: "Confirmando el resultado",
        }[activeOperation.stage]
      : null;
  const last = list?.lastOperation;
  const retryableOperation =
    last?.status === "failed" ? last : operation?.status === "failed" ? operation : null;
  const items = list?.documents ?? [];

  return (
    <section className="admin-documents" aria-labelledby="admin-documents-title">
      <div className="admin-card admin-documents__intro">
        <div className="admin-card__heading">
          <span className="admin-step">03</span>
          <div>
            <h2 id="admin-documents-title">Documentos</h2>
            <p>Administrá los archivos preparados que usa {projectName} en las búsquedas nuevas.</p>
          </div>
        </div>
        <p className="admin-documents__guidance">
          Se admiten TXT, MD, HTML, DOC, DOCX, CSV, XLS, XLSX y PDF de hasta 50 MB. Las imágenes
          relevantes deben estar transcritas.
        </p>
      </div>

      <div className="admin-card admin-documents__upload">
        <h3>
          {replacementTarget
            ? `Reemplazar ${replacementTarget.name}`
            : "Cargar un documento preparado"}
        </h3>
        <form
          className="admin-documents__form"
          onSubmit={(event) => void beginFileOperation(event)}
        >
          <label htmlFor="admin-document-file">Documento preparado</label>
          <input
            ref={fileInputRef}
            id="admin-document-file"
            name="document"
            type="file"
            accept={acceptedExtensions}
            onChange={onFileChange}
            disabled={locked}
          />
          {selectedFile ? (
            <p className="admin-documents__file-summary">
              {selectedFile.name} · {formatFileSize(selectedFile.size)}
            </p>
          ) : null}
          <div className="admin-documents__actions">
            <button className="admin-button" type="submit" disabled={locked || !selectedFile}>
              {replacementTarget ? "Reemplazar y procesar" : "Cargar y procesar"}
            </button>
            {replacementTarget ? (
              <button
                className="admin-button admin-button--quiet"
                type="button"
                disabled={locked}
                onClick={cancelReplacement}
              >
                Cancelar reemplazo
              </button>
            ) : null}
          </div>
        </form>
      </div>

      {notice ? (
        <p
          ref={notice.kind === "error" ? alertRef : undefined}
          className={`admin-message admin-documents__notice${notice.kind === "error" ? " admin-message--error" : ""}`}
          role={notice.kind === "error" ? "alert" : "status"}
          tabIndex={notice.kind === "error" ? -1 : undefined}
        >
          {notice.text}
        </p>
      ) : null}

      {pendingIntent && !busy ? (
        <div className="admin-documents__recovery">
          <p>
            La recepción de la intención no se confirmó. Conservamos el mismo archivo y operación.
          </p>
          <button
            className="admin-button"
            type="button"
            onClick={() => void retryUncertainIntent()}
          >
            Reintentar intención
          </button>
        </div>
      ) : null}

      {uploadReceipt && operation?.status === "awaiting_upload" && !busy ? (
        <div className="admin-documents__recovery">
          <p>La transferencia no se confirmó. Podés repetirla con el mismo archivo.</p>
          <button className="admin-button" type="button" onClick={() => void retryUpload()}>
            Reintentar subida
          </button>
        </div>
      ) : null}

      {operation?.status === "pending_start" ? (
        <div className="admin-documents__recovery">
          <p>El servidor confirmó que el procesamiento todavía no empezó.</p>
          <button
            className="admin-button"
            type="button"
            disabled={busy}
            onClick={() => void retryConfirmedStart()}
          >
            Reintentar inicio
          </button>
        </div>
      ) : null}
      {operation?.status === "unconfirmed" ? (
        <div className="admin-documents__recovery">
          <button
            className="admin-button admin-button--quiet"
            type="button"
            disabled={busy}
            onClick={() => void checkCurrentOperation()}
          >
            Consultar estado
          </button>
        </div>
      ) : null}

      {activeOperation ? (
        <div className="admin-documents__active" role="status">
          <strong>{activeOperationHeading}</strong>
          {activeOperationDocumentName ? (
            <span>Documento: {activeOperationDocumentName}</span>
          ) : null}
          {activeOperationStage ? <span>{activeOperationStage}</span> : null}
          <p>{activeOperationDetail}</p>
        </div>
      ) : null}

      <section
        className="admin-card admin-documents__list"
        aria-labelledby="admin-documents-list-title"
      >
        <div className="admin-documents__list-heading">
          <div>
            <h3 id="admin-documents-list-title">Documentos vigentes</h3>
            <p>La lista muestra los documentos que el chatbot puede usar en búsquedas nuevas.</p>
          </div>
          <button
            className="admin-button admin-button--quiet"
            type="button"
            disabled={loading || busy}
            onClick={refresh}
          >
            Actualizar lista
          </button>
        </div>
        {loading && !list ? <p role="status">Consultando documentos…</p> : null}
        {!loading && list && items.length === 0 ? (
          <p className="admin-empty">Todavía no hay documentos preparados para este chatbot.</p>
        ) : null}
        {items.length > 0 ? (
          <ul className="admin-documents__items">
            {items.map((item) => {
              const matchingOperation = last?.documentId === item.documentId ? last : null;
              const failed = item.processing.status === "failed";
              const retryAvailable = Boolean(matchingOperation?.canRetry && failed);
              const rowProcessing = activeOperation?.documentId === item.documentId;
              return (
                <li className="admin-documents__item" key={item.documentId}>
                  <div className="admin-documents__item-main">
                    <h4>{item.name}</h4>
                    <p>
                      {formatFileSize(item.sizeBytes)} · Actualizado{" "}
                      {new Date(item.updatedAt).toLocaleDateString("es-AR")}
                    </p>
                    <p className="admin-documents__item-status">
                      {rowProcessing || item.processing.status === "processing"
                        ? "Procesamiento en curso"
                        : item.processing.status === "completed"
                          ? "Disponible para búsquedas nuevas"
                          : item.processing.status === "failed"
                            ? "Procesamiento con error"
                            : "Resultado sin confirmar"}
                    </p>
                    {item.processing.error ? (
                      <p className="admin-documents__item-error">{item.processing.error.message}</p>
                    ) : null}
                  </div>
                  <div className="admin-documents__item-actions">
                    <button
                      className="admin-button admin-button--quiet"
                      type="button"
                      aria-label={`Reemplazar ${item.name}`}
                      disabled={locked || !item.canReplace}
                      onClick={() => beginReplacement(item)}
                    >
                      Reemplazar
                    </button>
                    <button
                      className="admin-button admin-button--quiet"
                      type="button"
                      aria-label={`Retirar ${item.name}`}
                      disabled={locked}
                      onClick={(event) => {
                        withdrawTriggerRef.current = event.currentTarget;
                        setConfirmingWithdraw(item.documentId);
                      }}
                    >
                      Retirar
                    </button>
                    {retryAvailable ? (
                      <button
                        className="admin-button admin-button--quiet"
                        type="button"
                        disabled={locked}
                        onClick={() => void retryFailedOperation(item)}
                      >
                        Reintentar procesamiento
                      </button>
                    ) : null}
                  </div>
                  {confirmingWithdraw === item.documentId ? (
                    <div
                      className="admin-documents__confirm"
                      role="group"
                      aria-label={`Confirmar retirada de ${item.name}`}
                    >
                      <p>
                        Las búsquedas futuras dejarán de usar <strong>{item.name}</strong>. Las
                        respuestas anteriores se conservan.
                      </p>
                      <div className="admin-documents__actions">
                        <button
                          ref={withdrawConfirmationRef}
                          className="admin-button"
                          type="button"
                          disabled={locked}
                          onClick={() => void confirmWithdraw(item)}
                        >
                          Confirmar retirada
                        </button>
                        <button
                          className="admin-button admin-button--quiet"
                          type="button"
                          disabled={locked}
                          onClick={() => {
                            setConfirmingWithdraw(null);
                          }}
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {list?.nextCursor ? (
          <button
            className="admin-button admin-documents__more"
            type="button"
            disabled={loadingMore || locked}
            onClick={() => void readList(list.nextCursor, true)}
          >
            {loadingMore ? "Cargando…" : "Cargar más documentos"}
          </button>
        ) : null}
      </section>

      {retryableOperation?.canRetry &&
      !items.some((item) => item.documentId === retryableOperation.documentId) &&
      !locked ? (
        <div className="admin-documents__recovery">
          <p>
            {retryableOperation.error?.message ||
              "El documento necesita otro intento para completar el procesamiento."}
          </p>
          <button
            className="admin-button"
            type="button"
            onClick={() => void retryFailedOperation()}
          >
            Reintentar procesamiento
          </button>
        </div>
      ) : null}

      {retryableOperation?.canRetry ? (
        <span className="admin-documents__sr-only" aria-live="polite">
          {retryableOperation.error?.message}
        </span>
      ) : null}
      {loading && list ? (
        <span className="admin-documents__sr-only">Actualizando documentos…</span>
      ) : null}
    </section>
  );
}
