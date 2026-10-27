import { accessTokenSubject } from "./auth.js";

type QueryParameters = Record<string, string | undefined>;

type HistoryListInput = {
  sub: string;
  botId: string;
  limit: number;
  cursor?: string;
};

type HistoryTurnsInput = HistoryListInput & { conversationId: string };
type ConversationInput = { sub: string; botId: string; conversationId: string };

type HistoryTextInput = {
  sub: string;
  botId: string;
  conversationId: string;
  ordinal: number;
  queryId: string;
  role: "user" | "assistant";
  throughCursor?: number;
  cursor?: string;
};

type ChatHistoryStore = {
  listConversations(input: HistoryListInput): Promise<unknown>;
  readTurns(input: HistoryTurnsInput): Promise<unknown>;
  readText(input: HistoryTextInput): Promise<unknown>;
  hideConversation(input: ConversationInput): Promise<unknown>;
  readConversationMeta(input: ConversationInput): Promise<unknown>;
};

type HistoryHandlerDependencies = {
  botId: string;
  store: ChatHistoryStore;
  getMembership(input: { sub: string; botId: string }): Promise<boolean>;
};

type HttpEvent = {
  rawPath?: string;
  queryStringParameters?: QueryParameters;
  rawQueryString?: string;
  requestContext?: {
    http?: { method?: string; path?: string };
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
};

type ApiResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

type Route =
  | { kind: "list" }
  | { kind: "hide" | "meta"; conversationId: string }
  | { kind: "turns"; conversationId: string }
  | { kind: "text"; conversationId: string; ordinal: number };

type PreparedRequest =
  | { kind: "list"; input: HistoryListInput }
  | { kind: "hide"; input: ConversationInput }
  | { kind: "meta"; input: ConversationInput }
  | { kind: "turns"; input: HistoryTurnsInput }
  | { kind: "text"; input: HistoryTextInput };

const listPath = "/api/chat/conversations";
const maxCursorLength = 8192;
const defaultPageSize = 20;
const maxPageSize = 100;
const maxEnvelopeBytes = 3 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicTurnStatuses = new Set(["in_progress", "completed", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(statusCode: number, value: Record<string, unknown>): ApiResponse {
  const response: ApiResponse = {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(value),
  };
  if (Buffer.byteLength(JSON.stringify(response), "utf8") <= maxEnvelopeBytes) return response;
  return {
    statusCode: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify({
      code: "HISTORY_UNAVAILABLE",
      message: "No pudimos cargar esta página del historial. Intentá de nuevo.",
    }),
  };
}

function errorResponse(statusCode: number, code: string, message: string): ApiResponse {
  return jsonResponse(statusCode, { code, message });
}

function routeFor(path: string, method: string): Route | null {
  const hideMatch = /^\/api\/chat\/conversations\/([^/]+)\/hide$/.exec(path);
  if (method === "POST" && hideMatch) {
    return { kind: "hide", conversationId: decodePathSegment(hideMatch[1]) };
  }
  if (method !== "GET") return null;
  if (path === listPath) return { kind: "list" };
  const metaMatch = /^\/api\/chat\/conversations\/([^/]+)$/.exec(path);
  if (metaMatch) return { kind: "meta", conversationId: decodePathSegment(metaMatch[1]) };

  const textMatch = /^\/api\/chat\/conversations\/([^/]+)\/turns\/(\d+)\/text$/.exec(path);
  if (textMatch) {
    const conversationId = decodePathSegment(textMatch[1]);
    return { kind: "text", conversationId, ordinal: Number(textMatch[2]) };
  }

  const turnsMatch = /^\/api\/chat\/conversations\/([^/]+)\/turns$/.exec(path);
  if (turnsMatch) {
    return { kind: "turns", conversationId: decodePathSegment(turnsMatch[1]) };
  }

  return null;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function getQuery(event: HttpEvent, name: string): string | undefined {
  const direct = event.queryStringParameters?.[name];
  if (direct !== undefined) return direct;
  if (typeof event.rawQueryString !== "string" || event.rawQueryString.length === 0) {
    return undefined;
  }
  return new URLSearchParams(event.rawQueryString).get(name) ?? undefined;
}

function parseCursor(value: string | undefined): string | undefined | null {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > maxCursorLength || value.trim() !== value) return null;
  return value;
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined || value.length === 0) return defaultPageSize;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maxPageSize ? parsed : null;
}

function optionalCursor(value: Record<string, unknown>): { nextCursor?: string } {
  if (value.nextCursor === undefined) return {};
  if (typeof value.nextCursor !== "string" || value.nextCursor.length === 0) {
    throw new TypeError("History store returned an invalid continuation cursor.");
  }
  return { nextCursor: value.nextCursor };
}

function optionalTimestamp(value: Record<string, unknown>, key: string): Record<string, string> {
  const timestamp = value[key];
  if (timestamp === undefined) return {};
  if (typeof timestamp !== "string" || timestamp.length === 0) {
    throw new TypeError("History store returned an invalid timestamp.");
  }
  return { [key]: timestamp };
}

function optionalHistoryLabel(value: Record<string, unknown>): Record<string, string> {
  const label = value.label;
  if (label === undefined) return {};
  if (typeof label !== "string" || !label.trim()) {
    throw new TypeError("History store returned an invalid conversation label.");
  }
  return { label };
}

function normalizeListResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.conversations)) {
    throw new TypeError("History store returned an invalid conversation page.");
  }
  return {
    version: 1,
    conversations: value.conversations.map(normalizeConversationSummary),
    ...optionalCursor(value),
  };
}

function normalizeConversationSummary(entry: unknown): Record<string, unknown> {
  if (
    !isRecord(entry) ||
    typeof entry.conversationId !== "string" ||
    !uuidPattern.test(entry.conversationId) ||
    typeof entry.label !== "string" ||
    !Number.isSafeInteger(entry.lastOrdinal) ||
    Number(entry.lastOrdinal) < 1 ||
    typeof entry.closed !== "boolean"
  ) {
    throw new TypeError("History store returned an invalid conversation descriptor.");
  }
  const activeQueryId = entry.activeQueryId;
  if (
    activeQueryId !== undefined &&
    (typeof activeQueryId !== "string" || !uuidPattern.test(activeQueryId))
  ) {
    throw new TypeError("History store returned an invalid active query identifier.");
  }
  return {
    conversationId: entry.conversationId,
    label: entry.label,
    ...optionalTimestamp(entry, "createdAt"),
    ...optionalTimestamp(entry, "updatedAt"),
    lastOrdinal: entry.lastOrdinal,
    closed: entry.closed,
    ...(typeof activeQueryId === "string" ? { activeQueryId } : {}),
  };
}

function normalizeManifest(value: unknown): { count: number; complete: boolean } {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.count) ||
    Number(value.count) < 0 ||
    typeof value.complete !== "boolean"
  ) {
    throw new TypeError("History store returned an invalid turn manifest.");
  }
  return { count: Number(value.count), complete: value.complete };
}

function normalizeMetaResult(value: unknown, conversationId: string): Record<string, unknown> {
  if (!isRecord(value) || value.version !== 1 || value.conversationId !== conversationId) {
    throw new TypeError("History store returned invalid conversation metadata.");
  }
  return { version: 1, ...normalizeConversationSummary(value) };
}

function normalizeHideResult(value: unknown, conversationId: string): Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.conversationId !== conversationId ||
    typeof value.hiddenAt !== "string" ||
    !Number.isFinite(Date.parse(value.hiddenAt))
  ) {
    throw new TypeError("History store did not confirm the conversation removal.");
  }
  return { version: 1, conversationId, hiddenAt: value.hiddenAt };
}

function normalizeTurnsResult(value: unknown, conversationId: string): Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.conversationId !== conversationId ||
    !Number.isSafeInteger(value.throughOrdinal) ||
    Number(value.throughOrdinal) < 0 ||
    typeof value.closed !== "boolean" ||
    typeof value.canContinue !== "boolean" ||
    !Array.isArray(value.turns)
  ) {
    throw new TypeError("History store returned an invalid turn page.");
  }
  const turns = value.turns.map((entry) => {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.ordinal) ||
      Number(entry.ordinal) < 1 ||
      typeof entry.queryId !== "string" ||
      !uuidPattern.test(entry.queryId) ||
      typeof entry.status !== "string" ||
      !publicTurnStatuses.has(entry.status) ||
      !Number.isSafeInteger(entry.cursor) ||
      Number(entry.cursor) < 0
    ) {
      throw new TypeError("History store returned an invalid turn descriptor.");
    }
    const failure = entry.failure;
    if (failure !== undefined && (!isRecord(failure) || typeof failure.code !== "string")) {
      throw new TypeError("History store returned an invalid public turn failure.");
    }
    const resultDeadlineAt = entry.resultDeadlineAt;
    if (
      resultDeadlineAt !== undefined &&
      (typeof resultDeadlineAt !== "number" || !Number.isFinite(resultDeadlineAt))
    ) {
      throw new TypeError("History store returned an invalid result deadline.");
    }
    return {
      ordinal: entry.ordinal,
      queryId: entry.queryId,
      status: entry.status,
      questionManifest: normalizeManifest(entry.questionManifest),
      answerManifest: normalizeManifest(entry.answerManifest),
      cursor: entry.cursor,
      ...(typeof resultDeadlineAt === "number" ? { resultDeadlineAt } : {}),
      ...(isRecord(failure) ? { failure: { code: failure.code } } : {}),
    };
  });
  return {
    version: 1,
    conversationId,
    ...optionalHistoryLabel(value),
    ...optionalTimestamp(value, "createdAt"),
    ...optionalTimestamp(value, "updatedAt"),
    throughOrdinal: value.throughOrdinal,
    closed: value.closed,
    canContinue: value.canContinue,
    turns,
    ...optionalCursor(value),
  };
}

function normalizeTextResult(
  value: unknown,
  request: { conversationId: string; ordinal: number; queryId: string; role: "user" | "assistant" },
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.conversationId !== request.conversationId ||
    value.ordinal !== request.ordinal ||
    value.queryId !== request.queryId ||
    value.role !== request.role ||
    !Array.isArray(value.chunks) ||
    typeof value.complete !== "boolean"
  ) {
    throw new TypeError("History store returned an invalid text page.");
  }
  const chunks = value.chunks.map((entry) => {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.index) ||
      Number(entry.index) < 0 ||
      typeof entry.text !== "string"
    ) {
      throw new TypeError("History store returned an invalid text chunk.");
    }
    return { index: Number(entry.index), text: entry.text };
  });
  return {
    version: 1,
    conversationId: request.conversationId,
    queryId: request.queryId,
    ordinal: request.ordinal,
    role: request.role,
    chunks,
    complete: value.complete,
    ...optionalCursor(value),
  };
}

function storeErrorResponse(error: unknown): ApiResponse {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  switch (code) {
    case "invalid_cursor":
      return errorResponse(400, "INVALID_CURSOR", "El cursor del historial no es válido.");
    case "invalid_request":
      return errorResponse(400, "INVALID_REQUEST", "La solicitud del historial no es válida.");
    case "forbidden":
      return errorResponse(403, "FORBIDDEN", "No tenés acceso a esta conversación.");
    case "conversation_unavailable":
      return errorResponse(404, "NOT_FOUND", "No encontramos esa conversación.");
    case "conversation_hidden":
      return errorResponse(
        404,
        "CONVERSATION_HIDDEN",
        "Esta conversación fue quitada del historial.",
      );
    case "history_unavailable":
      return errorResponse(
        503,
        "HISTORY_UNAVAILABLE",
        "No pudimos cargar el historial. Intentá de nuevo.",
      );
    default:
      return errorResponse(500, "INTERNAL_ERROR", "No pudimos completar la solicitud.");
  }
}

export function createChatHistoryHandler({
  botId,
  store,
  getMembership,
}: HistoryHandlerDependencies) {
  return async function handler(event: HttpEvent): Promise<ApiResponse> {
    const method = event.requestContext?.http?.method?.toUpperCase() || "";
    const path = event.requestContext?.http?.path || event.rawPath || "";
    const route = routeFor(path, method);
    if (!route) return errorResponse(404, "NOT_FOUND", "No encontramos esa ruta.");

    const claims = event.requestContext?.authorizer?.jwt?.claims;
    const sub = accessTokenSubject(claims);
    if (!sub) return errorResponse(401, "UNAUTHORIZED", "Iniciá sesión para continuar.");

    let prepared: PreparedRequest;
    if (route.kind === "hide" || route.kind === "meta") {
      if (!uuidPattern.test(route.conversationId)) {
        return errorResponse(400, "INVALID_REQUEST", "La solicitud del historial no es válida.");
      }
      prepared = { kind: route.kind, input: { sub, botId, conversationId: route.conversationId } };
    } else if (route.kind === "text") {
      const role = getQuery(event, "role");
      const queryId = getQuery(event, "queryId");
      const throughCursorValue = getQuery(event, "throughCursor");
      const throughCursor =
        throughCursorValue === undefined || throughCursorValue.length === 0
          ? undefined
          : /^\d+$/.test(throughCursorValue)
            ? Number(throughCursorValue)
            : Number.NaN;
      const cursor = parseCursor(getQuery(event, "cursor"));
      if (
        !uuidPattern.test(route.conversationId) ||
        !Number.isSafeInteger(route.ordinal) ||
        route.ordinal <= 0 ||
        (role !== "user" && role !== "assistant") ||
        typeof queryId !== "string" ||
        !uuidPattern.test(queryId) ||
        (throughCursor !== undefined &&
          (!Number.isSafeInteger(throughCursor) || throughCursor < 0)) ||
        cursor === null
      ) {
        return errorResponse(400, "INVALID_REQUEST", "La solicitud del historial no es válida.");
      }
      prepared = {
        kind: "text",
        input: {
          sub,
          botId,
          conversationId: route.conversationId,
          ordinal: route.ordinal,
          queryId,
          role,
          ...(throughCursor !== undefined ? { throughCursor } : {}),
          ...(cursor ? { cursor } : {}),
        },
      };
    } else {
      const cursor = parseCursor(getQuery(event, "cursor"));
      const limit = parseLimit(getQuery(event, "limit"));
      if (cursor === null || limit === null) {
        return errorResponse(400, "INVALID_REQUEST", "La solicitud del historial no es válida.");
      }
      if (route.kind === "turns" && !uuidPattern.test(route.conversationId)) {
        return errorResponse(400, "INVALID_REQUEST", "La solicitud del historial no es válida.");
      }
      const input: HistoryListInput = {
        sub,
        botId,
        limit,
        ...(cursor ? { cursor } : {}),
      };
      prepared =
        route.kind === "turns"
          ? { kind: "turns", input: { ...input, conversationId: route.conversationId } }
          : { kind: "list", input };
    }

    let member: boolean;
    try {
      member = await getMembership({ sub, botId });
    } catch {
      return errorResponse(
        503,
        "HISTORY_UNAVAILABLE",
        "No pudimos cargar el historial. Intentá de nuevo.",
      );
    }
    if (!member)
      return errorResponse(403, "FORBIDDEN", "Esta cuenta no tiene acceso a este proyecto.");

    try {
      if (prepared.kind === "hide") {
        return jsonResponse(
          200,
          normalizeHideResult(
            await store.hideConversation(prepared.input),
            prepared.input.conversationId,
          ),
        );
      }
      if (prepared.kind === "meta") {
        return jsonResponse(
          200,
          normalizeMetaResult(
            await store.readConversationMeta(prepared.input),
            prepared.input.conversationId,
          ),
        );
      }
      if (prepared.kind === "list") {
        return jsonResponse(
          200,
          normalizeListResult(await store.listConversations(prepared.input)),
        );
      }
      if (prepared.kind === "turns") {
        return jsonResponse(
          200,
          normalizeTurnsResult(
            await store.readTurns(prepared.input),
            prepared.input.conversationId,
          ),
        );
      }
      const result = await store.readText(prepared.input);
      return jsonResponse(200, normalizeTextResult(result, prepared.input));
    } catch (error) {
      return storeErrorResponse(error);
    }
  };
}
