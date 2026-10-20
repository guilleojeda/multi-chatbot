import type { PublicConfig } from "./api";
import type { Session } from "./session";

export type ChatRequest = {
  operation: "start" | "message";
  conversationId: string;
  text: string;
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
    };

type ChatRecordStatus = "not_admitted" | "failed" | "unconfirmed";

export type ChatStreamResult =
  | { status: "completed"; conversationId: string; queryId: string; ordinal: number }
  | {
      status: "failed";
      code: string;
      message: string;
      recordStatus: ChatRecordStatus;
      queryId?: string;
    };

export type StreamChatOptions = {
  onEvent: (event: ChatApplicationEvent) => void;
  isActive: () => boolean;
  signal?: AbortSignal;
};

export type ChatStreamError = Error & {
  code: string;
  status: number;
  refreshFailed?: boolean;
};

const sessionHeader = "x-amzn-bedrock-agentcore-runtime-session-id";

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
    (value.queryId === undefined || typeof value.queryId === "string")
  ) {
    return value as ChatApplicationEvent;
  }
  throw chatError("INVALID_RESPONSE", 502, "El asistente devolvió un evento inválido.");
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

export async function streamChat(
  config: PublicConfig,
  session: Session,
  request: ChatRequest,
  { onEvent, isActive, signal }: StreamChatOptions,
): Promise<ChatStreamResult> {
  const url = runtimeUrl(config);
  if (!request.conversationId || !request.text.trim()) {
    throw chatError("INVALID_REQUEST", 400, "Escribí una consulta para continuar.");
  }
  if (!isActive()) throw chatError("INACTIVE", 0, "La vista del chat ya no está activa.");

  let accessToken = session.accessToken();
  if (!accessToken) throw chatError("UNAUTHORIZED", 401, "Tu sesión venció.");

  const body = JSON.stringify({
    version: 1,
    operation: request.operation,
    conversationId: request.conversationId,
    text: request.text,
  });

  const invoke = async (token: string) => {
    if (!isActive()) throw chatError("INACTIVE", 0, "La vista del chat ya no está activa.");
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "text/event-stream",
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
    let restored;
    try {
      restored = await session.restore();
    } catch (error) {
      const refreshError = asChatError(error);
      throw Object.assign(refreshError, { refreshFailed: true });
    }
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
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
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
        if (accepted || event.conversationId !== request.conversationId) {
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
        if (!accepted || event.queryId !== accepted.queryId || nextTextIndex === 0) {
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
      if (accepted && event.queryId !== undefined && event.queryId !== accepted.queryId) {
        throw chatError("INVALID_RESPONSE", 502, "El asistente falló otro envío.");
      }
      const recordStatus = parseRecordStatus(event.recordStatus);
      const result = {
        status: "failed",
        code: event.code,
        message: event.message,
        recordStatus,
        ...(event.queryId ? { queryId: event.queryId } : {}),
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
