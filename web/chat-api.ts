import { requestWithRefresh, type PublicConfig } from "./api";
import type { Session } from "./session";
import type { QuotaView } from "../runtime/contracts";

export type ChatRequest = {
  version: 2;
  operation: "start" | "message";
  conversationId: string;
  queryId: string;
  baseOrdinal: number;
  text: string;
};

export type RecoverRequest = {
  version: 2;
  operation: "recover";
  conversationId: string;
  queryId: string;
};

export type ChatSubmissionSnapshot = {
  version: 2;
  conversationId: string;
  queryId: string;
  ordinal: number;
  status: "in_progress" | "completed" | "failed";
  question: string;
  answer: string;
  canContinue: boolean;
  quota?: QuotaView;
};

export type ChatApplicationEvent =
  | {
      type: "accepted";
      conversationId: string;
      queryId: string;
      ordinal: number;
    }
  | { type: "text"; queryId: string; index: number; text: string }
  | { type: "completed"; queryId: string }
  | {
      type: "failed";
      code: string;
      message: string;
      recordStatus: "not_admitted" | "failed" | "unconfirmed";
      queryId?: string;
      quota?: QuotaView;
      canContinue?: boolean;
    };

export type ChatRecordStatus = "not_admitted" | "failed" | "unconfirmed";

export type ChatStreamResult =
  | ChatSubmissionSnapshot
  | { status: "completed"; conversationId: string; queryId: string; ordinal: number }
  | {
      status: "failed";
      code: string;
      message: string;
      recordStatus: ChatRecordStatus;
      queryId?: string;
      quota?: QuotaView;
      canContinue?: boolean;
    };

export type ChatRecoveryResult =
  ChatSubmissionSnapshot | Extract<ChatStreamResult, { status: "failed" }>;

export type StreamChatOptions = {
  onEvent: (event: ChatApplicationEvent) => void;
  isActive: () => boolean;
  signal?: AbortSignal;
};

export type ChatStreamError = Error & {
  code: string;
  status: number;
};

export type ConversationSummary = {
  conversationId: string;
  label: string;
  createdAt?: string;
  updatedAt?: string;
  lastOrdinal: number;
  closed: boolean;
  activeQueryId?: string;
};

export type HideChatConversationResult = {
  conversationId: string;
  hiddenAt: string;
};

export type ConversationTurn = {
  ordinal: number;
  queryId: string;
  status: "in_progress" | "completed" | "failed";
  questionManifest: { count: number; complete: boolean };
  answerManifest: { count: number; complete: boolean };
  cursor: number;
  resultDeadlineAt?: number;
  failure?: { code?: string; message?: string };
};

export type ConversationListPage = {
  conversations: ConversationSummary[];
  nextCursor: string | null;
};

export type ConversationTurnsPage = {
  conversationId: string;
  label?: string;
  createdAt?: string;
  updatedAt?: string;
  throughOrdinal: number;
  closed: boolean;
  canContinue: boolean;
  turns: ConversationTurn[];
  nextCursor: string | null;
};

export type ConversationTextPage = {
  conversationId: string;
  queryId: string;
  ordinal: number;
  role: "user" | "assistant";
  chunks: { index: number; text: string }[];
  complete: boolean;
  nextCursor: string | null;
};

const sessionHeader = "x-amzn-bedrock-agentcore-runtime-session-id";
const contextUnavailableMessage =
  "No pudimos preparar el contexto de esta conversación. Conservamos tu consulta para que puedas reintentarlo.";

function chatError(code: string, status: number, message: string): ChatStreamError {
  return Object.assign(new Error(message), { code, status });
}

function asChatError(error: unknown): ChatStreamError {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error as ChatStreamError;
  }
  return chatError("NETWORK_ERROR", 0, "No pudimos confirmar la respuesta.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function historyError(code: string, status: number, message: string): ChatStreamError {
  return chatError(code, status, message);
}

function cursorValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.length > 0) return value;
  throw historyError("INVALID_RESPONSE", 502, "El historial devolvió una página inválida.");
}

function parseHistoryJson(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value.version !== 1) {
    throw historyError("INVALID_RESPONSE", 502, "El historial devolvió una respuesta inválida.");
  }
  return value;
}

function parseManifest(value: unknown): { count: number; complete: boolean } {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 0 ||
    typeof value.complete !== "boolean"
  ) {
    throw historyError("INVALID_RESPONSE", 502, "El historial devolvió un turno inválido.");
  }
  return { count: value.count as number, complete: value.complete };
}

function optionalHistoryTimestamp(
  payload: Record<string, unknown>,
  field: "createdAt" | "updatedAt",
): string | undefined {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw historyError("INVALID_RESPONSE", 502, "El historial devolvió una conversación inválida.");
  }
  return value;
}

export async function listChatConversations(
  config: PublicConfig,
  session: Session,
  cursor: string | null,
  isActive: () => boolean,
): Promise<ConversationListPage> {
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  const suffix = query.size ? `?${query.toString()}` : "";
  const payload = parseHistoryJson(
    await requestWithRefresh(config, session, `/chat/conversations${suffix}`, {}, isActive),
  );
  if (!Array.isArray(payload.conversations)) {
    throw historyError("INVALID_RESPONSE", 502, "El historial devolvió una lista inválida.");
  }
  const conversations = payload.conversations.map((value): ConversationSummary => {
    if (
      !isRecord(value) ||
      typeof value.conversationId !== "string" ||
      !uuidPattern.test(value.conversationId) ||
      typeof value.label !== "string" ||
      !Number.isSafeInteger(value.lastOrdinal) ||
      (value.lastOrdinal as number) < 0 ||
      typeof value.closed !== "boolean" ||
      (value.activeQueryId !== undefined && typeof value.activeQueryId !== "string") ||
      (value.createdAt !== undefined && typeof value.createdAt !== "string") ||
      (value.updatedAt !== undefined && typeof value.updatedAt !== "string")
    ) {
      throw historyError(
        "INVALID_RESPONSE",
        502,
        "El historial devolvió una conversación inválida.",
      );
    }
    return {
      conversationId: value.conversationId,
      label: value.label,
      lastOrdinal: value.lastOrdinal as number,
      closed: value.closed,
      ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
      ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
      ...(typeof value.activeQueryId === "string" ? { activeQueryId: value.activeQueryId } : {}),
    };
  });
  return { conversations, nextCursor: cursorValue(payload.nextCursor) };
}

export async function hideChatConversation(
  config: PublicConfig,
  session: Session,
  conversationId: string,
  isActive: () => boolean,
): Promise<HideChatConversationResult> {
  if (!uuidPattern.test(conversationId)) {
    throw historyError("INVALID_REQUEST", 400, "No pudimos quitar esta conversación.");
  }
  const payload = parseHistoryJson(
    await requestWithRefresh(
      config,
      session,
      `/chat/conversations/${encodeURIComponent(conversationId)}/hide`,
      { method: "POST" },
      isActive,
    ),
  );
  if (
    payload.conversationId !== conversationId ||
    typeof payload.hiddenAt !== "string" ||
    !payload.hiddenAt.trim() ||
    !Number.isFinite(Date.parse(payload.hiddenAt))
  ) {
    throw historyError("INVALID_RESPONSE", 502, "El historial devolvió una confirmación inválida.");
  }
  return { conversationId, hiddenAt: payload.hiddenAt };
}

export async function readChatConversationMeta(
  config: PublicConfig,
  session: Session,
  conversationId: string,
  isActive: () => boolean,
): Promise<ConversationSummary> {
  if (!uuidPattern.test(conversationId)) {
    throw historyError("INVALID_REQUEST", 400, "No pudimos verificar esta conversación.");
  }
  const payload = parseHistoryJson(
    await requestWithRefresh(
      config,
      session,
      `/chat/conversations/${encodeURIComponent(conversationId)}`,
      {},
      isActive,
    ),
  );
  const createdAt = optionalHistoryTimestamp(payload, "createdAt");
  const updatedAt = optionalHistoryTimestamp(payload, "updatedAt");
  if (
    payload.conversationId !== conversationId ||
    typeof payload.label !== "string" ||
    !payload.label.trim() ||
    !Number.isSafeInteger(payload.lastOrdinal) ||
    (payload.lastOrdinal as number) < 0 ||
    typeof payload.closed !== "boolean" ||
    (payload.activeQueryId !== undefined &&
      (typeof payload.activeQueryId !== "string" || !uuidPattern.test(payload.activeQueryId)))
  ) {
    throw historyError("INVALID_RESPONSE", 502, "El historial devolvió una conversación inválida.");
  }
  return {
    conversationId,
    label: payload.label,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    lastOrdinal: payload.lastOrdinal as number,
    closed: payload.closed,
    ...(typeof payload.activeQueryId === "string" ? { activeQueryId: payload.activeQueryId } : {}),
  };
}

export async function readConversationTurns(
  config: PublicConfig,
  session: Session,
  conversationId: string,
  cursor: string | null,
  isActive: () => boolean,
): Promise<ConversationTurnsPage> {
  if (!uuidPattern.test(conversationId)) {
    throw historyError("INVALID_REQUEST", 400, "No pudimos abrir esta conversación.");
  }
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  const suffix = query.size ? `?${query.toString()}` : "";
  const payload = parseHistoryJson(
    await requestWithRefresh(
      config,
      session,
      `/chat/conversations/${encodeURIComponent(conversationId)}/turns${suffix}`,
      {},
      isActive,
    ),
  );
  if (
    payload.conversationId !== conversationId ||
    !Number.isSafeInteger(payload.throughOrdinal) ||
    (payload.throughOrdinal as number) < 0 ||
    typeof payload.closed !== "boolean" ||
    typeof payload.canContinue !== "boolean" ||
    !Array.isArray(payload.turns)
  ) {
    throw historyError("INVALID_RESPONSE", 502, "El historial devolvió una conversación inválida.");
  }
  if (payload.label !== undefined && (typeof payload.label !== "string" || !payload.label.trim())) {
    throw historyError("INVALID_RESPONSE", 502, "El historial devolvió una conversación inválida.");
  }
  const createdAt = optionalHistoryTimestamp(payload, "createdAt");
  const updatedAt = optionalHistoryTimestamp(payload, "updatedAt");
  const turns = payload.turns.map((value): ConversationTurn => {
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value.ordinal) ||
      (value.ordinal as number) <= 0 ||
      typeof value.queryId !== "string" ||
      !uuidPattern.test(value.queryId) ||
      !["in_progress", "completed", "failed"].includes(String(value.status)) ||
      !Number.isSafeInteger(value.cursor) ||
      (value.cursor as number) < 0 ||
      (value.resultDeadlineAt !== undefined && !Number.isSafeInteger(value.resultDeadlineAt)) ||
      (value.failure !== undefined && !isRecord(value.failure))
    ) {
      throw historyError("INVALID_RESPONSE", 502, "El historial devolvió un turno inválido.");
    }
    const failure = value.failure;
    if (
      failure !== undefined &&
      ((failure.code !== undefined && typeof failure.code !== "string") ||
        (failure.message !== undefined && typeof failure.message !== "string"))
    ) {
      throw historyError("INVALID_RESPONSE", 502, "El historial devolvió un turno inválido.");
    }
    return {
      ordinal: value.ordinal as number,
      queryId: value.queryId,
      status: value.status as ConversationTurn["status"],
      questionManifest: parseManifest(value.questionManifest),
      answerManifest: parseManifest(value.answerManifest),
      cursor: value.cursor as number,
      ...(typeof value.resultDeadlineAt === "number"
        ? { resultDeadlineAt: value.resultDeadlineAt }
        : {}),
      ...(failure
        ? {
            failure: {
              ...(typeof failure.code === "string" ? { code: failure.code } : {}),
              ...(typeof failure.message === "string" ? { message: failure.message } : {}),
            },
          }
        : {}),
    };
  });
  return {
    conversationId,
    ...(typeof payload.label === "string" ? { label: payload.label } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    throughOrdinal: payload.throughOrdinal as number,
    closed: payload.closed,
    canContinue: payload.canContinue,
    turns: [...turns].sort((left, right) => left.ordinal - right.ordinal),
    nextCursor: cursorValue(payload.nextCursor),
  };
}

export async function readConversationTextPage(
  config: PublicConfig,
  session: Session,
  request: {
    conversationId: string;
    ordinal: number;
    queryId: string;
    role: "user" | "assistant";
    throughCursor: number;
    cursor: string | null;
  },
  isActive: () => boolean,
): Promise<ConversationTextPage> {
  const query = new URLSearchParams({
    role: request.role,
    queryId: request.queryId,
    throughCursor: String(request.throughCursor),
  });
  if (request.cursor) query.set("cursor", request.cursor);
  const payload = parseHistoryJson(
    await requestWithRefresh(
      config,
      session,
      `/chat/conversations/${encodeURIComponent(request.conversationId)}/turns/${request.ordinal}/text?${query.toString()}`,
      {},
      isActive,
    ),
  );
  if (
    payload.conversationId !== request.conversationId ||
    payload.queryId !== request.queryId ||
    payload.ordinal !== request.ordinal ||
    payload.role !== request.role ||
    typeof payload.complete !== "boolean" ||
    !Array.isArray(payload.chunks)
  ) {
    throw historyError(
      "INVALID_RESPONSE",
      502,
      "El texto del historial devolvió una página inválida.",
    );
  }
  const chunks = payload.chunks.map((value) => {
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value.index) ||
      (value.index as number) < 0 ||
      typeof value.text !== "string"
    ) {
      throw historyError(
        "INVALID_RESPONSE",
        502,
        "El texto del historial devolvió una página inválida.",
      );
    }
    return { index: value.index as number, text: value.text };
  });
  return {
    conversationId: request.conversationId,
    queryId: request.queryId,
    ordinal: request.ordinal,
    role: request.role,
    chunks,
    complete: payload.complete,
    nextCursor: cursorValue(payload.nextCursor),
  };
}

function runtimeUrl(config: PublicConfig): string {
  if (
    typeof config.runtimeArn !== "string" ||
    !config.runtimeArn.trim() ||
    typeof config.runtimeQualifier !== "string" ||
    !config.runtimeQualifier.trim() ||
    !config.region.trim()
  ) {
    throw chatError("INVALID_CONFIG", 0, "No pudimos cargar el destino del asistente.");
  }
  return (
    `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/` +
    `${encodeURIComponent(config.runtimeArn)}/invocations?qualifier=${encodeURIComponent(config.runtimeQualifier)}`
  );
}

function isQuotaView(value: unknown): value is QuotaView {
  if (!isRecord(value)) return false;
  const periodIsValid = (period: unknown) =>
    isRecord(period) &&
    Number.isSafeInteger(period.used) &&
    (period.used as number) >= 0 &&
    Number.isSafeInteger(period.limit) &&
    (period.limit as number) >= 0 &&
    Number.isSafeInteger(period.resetAt) &&
    typeof period.period === "string";
  return (
    periodIsValid(value.daily) &&
    periodIsValid(value.monthly) &&
    Number.isSafeInteger(value.serverNow) &&
    (value.blockedUntil === null || Number.isSafeInteger(value.blockedUntil)) &&
    typeof value.policyRevision === "string" &&
    value.policyRevision.length > 0
  );
}

function applicationEvent(value: unknown): ChatApplicationEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw chatError("INVALID_RESPONSE", 502, "El asistente devolvió un evento inválido.");
  }
  if (
    value.type === "accepted" &&
    typeof value.conversationId === "string" &&
    typeof value.queryId === "string" &&
    value.queryId.length > 0 &&
    Number.isSafeInteger(value.ordinal) &&
    (value.ordinal as number) > 0
  ) {
    return value as ChatApplicationEvent;
  }
  if (
    value.type === "text" &&
    typeof value.queryId === "string" &&
    value.queryId.length > 0 &&
    Number.isSafeInteger(value.index) &&
    typeof value.text === "string" &&
    value.text.length > 0
  ) {
    return value as ChatApplicationEvent;
  }
  if (value.type === "completed" && typeof value.queryId === "string" && value.queryId.length > 0) {
    return value as ChatApplicationEvent;
  }
  if (
    value.type === "failed" &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    ["not_admitted", "failed", "unconfirmed"].includes(String(value.recordStatus)) &&
    (value.queryId === undefined || typeof value.queryId === "string") &&
    (value.quota === undefined || isQuotaView(value.quota)) &&
    (value.canContinue === undefined || typeof value.canContinue === "boolean")
  ) {
    if (value.code.toLowerCase() === "context_unavailable") {
      return { ...value, message: contextUnavailableMessage } as ChatApplicationEvent;
    }
    return value as ChatApplicationEvent;
  }
  throw chatError("INVALID_RESPONSE", 502, "El asistente devolvió un evento inválido.");
}

function parseSnapshot(
  value: unknown,
  request: ChatRequest | RecoverRequest,
): ChatSubmissionSnapshot {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.conversationId !== request.conversationId ||
    value.queryId !== request.queryId ||
    !Number.isSafeInteger(value.ordinal) ||
    (value.ordinal as number) <= 0 ||
    ("baseOrdinal" in request && value.ordinal !== request.baseOrdinal + 1) ||
    (value.status !== "in_progress" && value.status !== "completed" && value.status !== "failed") ||
    typeof value.question !== "string" ||
    typeof value.answer !== "string" ||
    typeof value.canContinue !== "boolean" ||
    (value.quota !== undefined && !isQuotaView(value.quota)) ||
    ("text" in request && value.question !== request.text)
  ) {
    throw chatError("INVALID_RESPONSE", 502, "El asistente devolvió un envío inválido.");
  }
  return {
    version: 2,
    conversationId: request.conversationId,
    queryId: request.queryId,
    ordinal: value.ordinal as number,
    status: value.status,
    question: value.question,
    answer: value.answer,
    canContinue: value.canContinue,
    ...(value.quota === undefined ? {} : { quota: value.quota }),
  };
}

function parseEventFrame(
  eventName: string,
  data: string[],
  onEvent: (event: ChatApplicationEvent) => ChatStreamResult | undefined,
): ChatStreamResult | undefined {
  if (data.length === 0) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(data.join("\n")) as unknown;
  } catch {
    throw chatError("INVALID_RESPONSE", 502, "El asistente devolvió un evento inválido.");
  }
  const event = applicationEvent(payload);
  if (eventName && eventName !== "message" && eventName !== event.type) {
    throw chatError("INVALID_RESPONSE", 502, "El asistente devolvió eventos incompatibles.");
  }
  return onEvent(event);
}

function parseRecordStatus(value: string): ChatRecordStatus {
  if (value === "not_admitted" || value === "failed" || value === "unconfirmed") return value;
  throw chatError("INVALID_RESPONSE", 502, "El asistente devolvió un estado inválido.");
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidChatRequest(request: ChatRequest) {
  return (
    request.version === 2 &&
    (request.operation === "start" || request.operation === "message") &&
    uuidPattern.test(request.conversationId) &&
    uuidPattern.test(request.queryId) &&
    Number.isSafeInteger(request.baseOrdinal) &&
    request.baseOrdinal >= 0 &&
    (request.operation !== "start" || request.baseOrdinal === 0) &&
    (request.operation !== "message" || request.baseOrdinal > 0) &&
    typeof request.text === "string" &&
    request.text.trim().length > 0
  );
}

function isValidRecoverRequest(request: RecoverRequest) {
  return (
    request.version === 2 &&
    request.operation === "recover" &&
    uuidPattern.test(request.conversationId) &&
    uuidPattern.test(request.queryId)
  );
}

async function postRuntime(
  config: PublicConfig,
  session: Session,
  request: ChatRequest | RecoverRequest,
  options: Pick<StreamChatOptions, "isActive" | "signal">,
  accept: string,
): Promise<Response> {
  const url = runtimeUrl(config);
  const { isActive, signal } = options;
  if (!isActive()) throw chatError("INACTIVE", 0, "La vista del chat ya no está activa.");

  let accessToken = session.accessToken();
  if (!accessToken) throw chatError("UNAUTHORIZED", 401, "Tu sesión venció.");
  const body = JSON.stringify(request);

  const invoke = async (token: string) => {
    if (!isActive()) throw chatError("INACTIVE", 0, "La vista del chat ya no está activa.");
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept,
          [sessionHeader]: request.conversationId,
        },
        body,
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw asChatError(error);
    }
  };

  let response = await invoke(accessToken);
  if (response.status === 401 && isActive()) {
    const restored = await session.restore();
    if (!isActive()) throw chatError("UNAUTHORIZED", 401, "Tu sesión venció.");
    if (!restored) throw chatError("UNAUTHORIZED", 401, "Tu sesión venció.");
    accessToken = restored.accessToken;
    response = await invoke(accessToken);
  }
  if (!isActive()) throw chatError("INACTIVE", 0, "La vista del chat ya no está activa.");
  if (!response.ok) {
    throw chatError(
      response.status === 401 ? "UNAUTHORIZED" : `HTTP_${response.status}`,
      response.status,
      response.status === 401 ? "Tu sesión venció." : "No pudimos iniciar la consulta.",
    );
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw chatError("INVALID_RESPONSE", 502, "El asistente devolvió una respuesta inválida.");
  }
}

function parseFailure(
  value: unknown,
  queryId: string,
): Extract<ChatStreamResult, { status: "failed" }> {
  const event = applicationEvent(value);
  if (event.type !== "failed" || (event.queryId !== undefined && event.queryId !== queryId)) {
    throw chatError("INVALID_RESPONSE", 502, "El asistente devolvió un estado inválido.");
  }
  return {
    status: "failed",
    code: event.code,
    message: event.message,
    recordStatus: event.recordStatus,
    ...(event.queryId ? { queryId: event.queryId } : {}),
    ...(event.quota ? { quota: event.quota } : {}),
    ...(event.canContinue === undefined ? {} : { canContinue: event.canContinue }),
  };
}

export async function streamChat(
  config: PublicConfig,
  session: Session,
  request: ChatRequest,
  { onEvent, isActive, signal }: StreamChatOptions,
): Promise<ChatStreamResult> {
  if (!isValidChatRequest(request)) {
    throw chatError("INVALID_REQUEST", 400, "Escribí una consulta para continuar.");
  }
  const response = await postRuntime(
    config,
    session,
    request,
    { isActive, signal },
    "text/event-stream",
  );
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (contentType.includes("application/json")) {
    const payload = await readJson(response);
    if (isRecord(payload) && payload.version === 2) return parseSnapshot(payload, request);
    return parseFailure(payload, request.queryId);
  }
  if (!contentType.includes("text/event-stream")) {
    throw chatError("INVALID_RESPONSE", 502, "El asistente devolvió una respuesta inválida.");
  }
  if (!response.body)
    throw chatError("INVALID_RESPONSE", 502, "El asistente no inició la respuesta.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let eventName = "";
  let data: string[] = [];
  let accepted: Extract<ChatApplicationEvent, { type: "accepted" }> | null = null;
  let nextTextIndex = 0;
  let terminal: ChatStreamResult | undefined;
  let activeFailure: ChatStreamError | null = null;

  function dispatchFrame() {
    const result = parseEventFrame(eventName, data, (event) => {
      if (!isActive()) throw chatError("INACTIVE", 0, "La vista del chat ya no está activa.");
      if (event.type === "accepted") {
        if (
          accepted ||
          event.conversationId !== request.conversationId ||
          event.queryId !== request.queryId ||
          event.ordinal !== request.baseOrdinal + 1
        ) {
          throw chatError("INVALID_RESPONSE", 502, "El asistente respondió a otra conversación.");
        }
        accepted = event;
        onEvent(event);
        return undefined;
      }
      if (event.type === "text") {
        if (!accepted || event.queryId !== accepted.queryId || event.index !== nextTextIndex) {
          throw chatError("INVALID_RESPONSE", 502, "El asistente envió texto fuera de orden.");
        }
        nextTextIndex += 1;
        onEvent(event);
        return undefined;
      }
      if (event.type === "completed") {
        if (
          !accepted ||
          event.queryId !== accepted.queryId ||
          event.queryId !== request.queryId ||
          nextTextIndex === 0
        ) {
          throw chatError("INVALID_RESPONSE", 502, "El asistente cerró una respuesta inválida.");
        }
        onEvent(event);
        return {
          status: "completed",
          conversationId: accepted.conversationId,
          queryId: accepted.queryId,
          ordinal: accepted.ordinal,
        } satisfies ChatStreamResult;
      }
      if (
        (accepted && event.queryId !== undefined && event.queryId !== accepted.queryId) ||
        (event.queryId !== undefined && event.queryId !== request.queryId)
      ) {
        throw chatError("INVALID_RESPONSE", 502, "El asistente falló otro envío.");
      }
      const recordStatus = parseRecordStatus(event.recordStatus);
      const result = {
        status: "failed",
        code: event.code,
        message: event.message,
        recordStatus,
        ...(event.queryId ? { queryId: event.queryId } : {}),
        ...(event.quota ? { quota: event.quota } : {}),
        ...(event.canContinue === undefined ? {} : { canContinue: event.canContinue }),
      } satisfies ChatStreamResult;
      onEvent(event);
      return result;
    });
    eventName = "";
    data = [];
    if (result) terminal = result;
  }

  function consumeLine(line: string) {
    if (line === "") {
      dispatchFrame();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventName = value;
    else if (field === "data") data.push(value);
  }

  function consumeText(value: string) {
    lineBuffer += value;
    let newline = lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newline + 1);
      consumeLine(line);
      if (terminal) return;
      newline = lineBuffer.indexOf("\n");
    }
  }

  try {
    while (!terminal) {
      if (!isActive()) throw chatError("INACTIVE", 0, "La vista del chat ya no está activa.");
      const { done, value } = await reader.read();
      if (done) break;
      consumeText(decoder.decode(value, { stream: true }));
    }
    if (terminal) return terminal;
    consumeText(decoder.decode());
    if (terminal) return terminal;
    throw chatError("UNCONFIRMED", 0, "No pudimos confirmar que la respuesta haya terminado.");
  } catch (error) {
    activeFailure = asChatError(error);
    try {
      await reader.cancel(activeFailure);
    } catch {
      // A failed or already closed stream has nothing left to cancel.
    }
    throw activeFailure;
  } finally {
    reader.releaseLock();
  }
}

export async function recoverChat(
  config: PublicConfig,
  session: Session,
  request: RecoverRequest,
  options: Pick<StreamChatOptions, "isActive" | "signal">,
): Promise<ChatRecoveryResult> {
  if (!isValidRecoverRequest(request)) {
    throw chatError("INVALID_REQUEST", 400, "No pudimos consultar el estado de la consulta.");
  }
  const response = await postRuntime(config, session, request, options, "application/json");
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw chatError("INVALID_RESPONSE", 502, "El asistente devolvió una respuesta inválida.");
  }
  const payload = await readJson(response);
  if (isRecord(payload) && payload.version === 2) return parseSnapshot(payload, request);
  return parseFailure(payload, request.queryId);
}
