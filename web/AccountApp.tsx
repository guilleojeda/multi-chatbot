import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccountScreen,
  type AccountScreenProps,
  type AccountState,
  type AccountSubmission,
} from "./AccountScreen";
import {
  apiRequest,
  asApiError,
  readPublicConfig,
  requestWithRefresh,
  type PublicConfig,
} from "./api";
import { type Session } from "./session";
import { ProfileApp } from "./ProfileApp";
import { siteConfig } from "../config/site";
import type { ProfileConfig } from "../config/profile";
import {
  ChatScreen,
  type ChatHistoryState,
  type ChatHistoryTurn,
  type ChatScreenState,
} from "./ChatScreen";
import {
  hideChatConversation,
  listChatConversations,
  readChatConversationMeta,
  readConversationTextPage,
  readConversationTurns,
  recoverChat,
  streamChat,
  type ChatRequest,
  type ConversationTurn,
} from "./chat-api";
import {
  clearChatJournal,
  clearChatJournalEntry,
  clearChatJournalForConfiguredBot,
  markChatJournalAdmitted,
  readChatJournals,
  readChatSelection,
  writeChatSelection,
  writePendingChatJournal,
  type ChatJournalEntry,
} from "./chat-journal";
import { parseProfileEnvelope } from "./profile-data";

export type AccountRoute =
  | { kind: "login" }
  | { kind: "recover" }
  | { kind: "chat" }
  | { kind: "profile" }
  | { kind: "invite"; token: string | null };

type RetryOperation = () => Promise<void>;
type RouteIdentity = { key: string; epoch: number };
type HideOperation = {
  conversationId: string;
  ownerKey: string;
  generation: number;
  complete: (confirmed: boolean) => void;
};
type TrackedChatJournalEntry = ChatJournalEntry & { knownNotAdmitted?: boolean };
type HistoryOpeningContext = {
  conversationId: string;
  selectedConversationId: string | null;
  turnsStatus: ChatHistoryState["turnsStatus"];
  turnsError?: string;
};
type ConversationMetaCheck =
  | { kind: "visible"; conversation: Awaited<ReturnType<typeof readChatConversationMeta>> }
  | { kind: "hidden" }
  | { kind: "missing" }
  | { kind: "error"; error: ReturnType<typeof asApiError> };

const recoveryNotice =
  "Si la cuenta está activa y tiene un email verificado, recibirás un código para continuar.";
const passwordResetLoginNotice = "La contraseña se cambió. Iniciá sesión con la nueva contraseña.";

function accountRouteKey(route: AccountRoute) {
  return route.kind === "invite" ? `invite:${route.token || ""}` : route.kind;
}

function chatOwnerKey(identity: { sub: string; botId: string }) {
  return JSON.stringify([identity.sub, identity.botId]);
}

function uuidPatternForHistory(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sameChatJournalScope(left: PublicConfig, right: PublicConfig) {
  return (
    left.region === right.region &&
    left.clientId === right.clientId &&
    left.apiBaseUrl === right.apiBaseUrl &&
    (left.runtimeArn ?? "") === (right.runtimeArn ?? "") &&
    (left.runtimeQualifier ?? "") === (right.runtimeQualifier ?? "") &&
    left.botId === right.botId
  );
}

function sameUnadmittedChatRequest(left: TrackedChatJournalEntry, right: ChatJournalEntry) {
  return (
    !left.admitted &&
    !right.admitted &&
    left.request.conversationId === right.request.conversationId &&
    left.request.queryId === right.request.queryId &&
    left.request.operation === right.request.operation &&
    left.request.baseOrdinal === right.request.baseOrdinal &&
    left.request.text === right.request.text
  );
}

function isValidMemoryJournalForConversation(
  entry: ChatJournalEntry | null,
  conversationId: string,
): entry is ChatJournalEntry {
  if (!entry) return false;
  const { request } = entry;
  if (
    request.version !== 2 ||
    request.conversationId !== conversationId ||
    !uuidPatternForHistory(request.conversationId) ||
    !uuidPatternForHistory(request.queryId) ||
    (request.operation !== "start" && request.operation !== "message") ||
    !Number.isSafeInteger(request.baseOrdinal) ||
    request.baseOrdinal < 0 ||
    (request.operation === "start" && request.baseOrdinal !== 0) ||
    (request.operation === "message" && request.baseOrdinal === 0)
  ) {
    return false;
  }
  if (entry.admitted) {
    return (
      !Object.hasOwn(request, "text") &&
      Number.isSafeInteger(entry.ordinal) &&
      entry.ordinal === request.baseOrdinal + 1
    );
  }
  return "text" in request && typeof request.text === "string" && request.text.trim().length > 0;
}

function emptyChatState(): ChatScreenState {
  return {
    profileStatus: "loading",
    queryStatus: "idle",
    draft: "",
    history: emptyHistoryState(),
  };
}

function emptyHistoryState(): ChatHistoryState {
  return {
    status: "loading",
    conversations: [],
    nextCursor: null,
    loadingMore: false,
    selectedConversationId: null,
    turnsStatus: "idle",
    turns: [],
    turnsNextCursor: null,
    refreshRequired: false,
  };
}

function conversationActivityTime(conversation: ChatHistoryState["conversations"][number]) {
  if (!conversation.updatedAt) return Number.NEGATIVE_INFINITY;
  const updatedAt = Date.parse(conversation.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : Number.NEGATIVE_INFINITY;
}

function sortHistoryConversations(conversations: ChatHistoryState["conversations"]) {
  return [...conversations].sort(
    (left, right) =>
      conversationActivityTime(right) - conversationActivityTime(left) ||
      left.conversationId.localeCompare(right.conversationId),
  );
}

function serverConversationSupersedesLocal(
  local: ChatHistoryState["conversations"][number],
  server: ChatHistoryState["conversations"][number],
) {
  if (server.lastOrdinal !== local.lastOrdinal) return server.lastOrdinal > local.lastOrdinal;
  if (local.closed && !server.closed) return false;
  if (server.closed && !local.closed) return true;
  if (local.pending) return true;

  // Ordinals advance at admission; terminal state can advance at the same ordinal.
  return !server.activeQueryId || Boolean(local.activeQueryId);
}

function mergeHistoryConversations(
  local: Map<string, ChatHistoryState["conversations"][number]>,
  serverPage: ChatHistoryState["conversations"],
  existing: ChatHistoryState["conversations"],
  hiddenConversationIds: ReadonlySet<string> = new Set(),
) {
  const uniqueServerPage = new Map<string, ChatHistoryState["conversations"][number]>();
  for (const conversation of serverPage) {
    if (hiddenConversationIds.has(conversation.conversationId)) continue;
    const previous = uniqueServerPage.get(conversation.conversationId);
    if (!previous || conversation.lastOrdinal >= previous.lastOrdinal) {
      uniqueServerPage.set(conversation.conversationId, conversation);
    }
  }
  const authoritativePage = [...uniqueServerPage.values()];
  const serverById = new Map(
    authoritativePage.map((conversation) => [conversation.conversationId, conversation]),
  );
  for (const [conversationId, server] of serverById) {
    const localConversation = local.get(conversationId);
    if (localConversation && serverConversationSupersedesLocal(localConversation, server)) {
      local.delete(conversationId);
    }
  }
  const localById = new Map(
    [...local].filter(([conversationId]) => !hiddenConversationIds.has(conversationId)),
  );
  const localPreserved = [...localById.values()].filter((conversation) => {
    const server = serverById.get(conversation.conversationId);
    return !server || !serverConversationSupersedesLocal(conversation, server);
  });
  const localPreservedIds = new Set(
    localPreserved.map((conversation) => conversation.conversationId),
  );
  const serverIds = new Set(serverById.keys());
  const preserved = existing.filter(
    (conversation) =>
      !hiddenConversationIds.has(conversation.conversationId) &&
      !serverIds.has(conversation.conversationId) &&
      !localPreservedIds.has(conversation.conversationId),
  );
  const authoritativeServerPage = authoritativePage.filter((conversation) => {
    const localConversation = localById.get(conversation.conversationId);
    return !localConversation || serverConversationSupersedesLocal(localConversation, conversation);
  });
  const merged = new Map<string, ChatHistoryState["conversations"][number]>();
  for (const conversation of [...localPreserved, ...preserved, ...authoritativeServerPage]) {
    const previous = merged.get(conversation.conversationId);
    if (!previous || conversation.lastOrdinal >= previous.lastOrdinal) {
      merged.set(conversation.conversationId, conversation);
    }
  }
  return sortHistoryConversations([...merged.values()]);
}

function historyErrorMessage(code: string, status: number, opening = false) {
  if (code === "CONVERSATION_HIDDEN") return "Esta conversación ya no aparece en tu historial.";
  if (code === "FORBIDDEN" || status === 403) return "No tenés acceso a esta conversación.";
  if (code === "UNAUTHORIZED" || status === 401)
    return "Tu sesión venció. Iniciá sesión nuevamente.";
  if (
    code === "CONVERSATION_UNAVAILABLE" ||
    code === "conversation_unavailable" ||
    status === 404
  ) {
    return "Esta conversación ya no está disponible.";
  }
  if (code === "HISTORY_UNAVAILABLE" || status >= 500) {
    return opening
      ? "No pudimos abrir la conversación. Podés volver a intentarlo."
      : "No pudimos cargar el historial. Podés volver a intentarlo.";
  }
  return opening
    ? "No pudimos abrir esta conversación. Revisá tu conexión e intentá de nuevo."
    : "No pudimos cargar el historial. Revisá tu conexión e intentá de nuevo.";
}

function withHistoryTurn(
  state: ChatScreenState,
  conversationId: string,
  turn: ChatHistoryTurn,
): ChatScreenState {
  const history = state.history;
  if (!history || history.selectedConversationId !== conversationId) return state;
  const turns = history.turns.filter((existing) => existing.queryId !== turn.queryId);
  turns.push(turn);
  turns.sort((left, right) => left.ordinal - right.ordinal);
  return { ...state, history: { ...history, turns } };
}

function submissionHistoryTurn(
  state: ChatScreenState,
  request: ChatRequest,
  overrides: Partial<ChatHistoryTurn>,
): ChatHistoryTurn {
  const existing = state.history?.turns.find((turn) => turn.queryId === request.queryId);
  return {
    ordinal: existing?.ordinal ?? request.baseOrdinal + 1,
    queryId: request.queryId,
    status: existing?.status ?? "in_progress",
    question: existing?.question ?? request.text,
    answer: existing?.answer ?? "",
    questionComplete: existing?.questionComplete ?? true,
    answerComplete: existing?.answerComplete ?? false,
    canContinue: existing?.canContinue ?? false,
    ...existing,
    ...overrides,
  };
}

function pendingConversationLabel(request: Pick<ChatRequest, "operation" | "text">) {
  if (request.operation !== "start") return "Conversación pendiente";
  return request.text.trim().replace(/\s+/g, " ").slice(0, 120) || "Nueva conversación";
}

function isRecoveryIdentityError(code: string) {
  return [
    "InvalidParameterException",
    "NotAuthorizedException",
    "UserNotConfirmedException",
    "UserNotFoundException",
  ].includes(code);
}

function recoveryRequestErrorMessage(code: string) {
  if (code === "NETWORK_ERROR")
    return "No pudimos conectar con el servicio de correo. Revisá tu conexión e intentá de nuevo.";
  if (code === "LimitExceededException" || code === "TooManyRequestsException")
    return "Esperá un momento antes de solicitar otro código.";
  if (code === "CodeDeliveryFailureException")
    return "No pudimos enviar el código. Intentá de nuevo más tarde.";
  if (code === "INVALID_RESPONSE")
    return "No pudimos validar la respuesta. Intentá solicitar el código de nuevo.";
  return "No pudimos solicitar el código. Revisá tu conexión e intentá de nuevo.";
}

function recoveryConfirmErrorMessage(code: string) {
  if (code === "CodeMismatchException")
    return "El código no es correcto. Revisalo e intentá de nuevo.";
  if (code === "ExpiredCodeException")
    return "El código venció. Solicitá uno nuevo y volvé a intentar.";
  if (code === "InvalidPasswordException")
    return "La nueva contraseña no cumple con los requisitos. Elegí otra y volvé a intentar.";
  if (code === "LimitExceededException" || code === "TooManyRequestsException")
    return "Esperá un momento antes de volver a intentar.";
  if (code === "NETWORK_ERROR")
    return "No pudimos conectar con el servicio de cuenta. Revisá tu conexión e intentá de nuevo.";
  if (code === "INVALID_RESPONSE")
    return "No pudimos validar la respuesta. Revisá los datos e intentá de nuevo.";
  if (isRecoveryIdentityError(code))
    return "No pudimos confirmar el cambio. Revisá el email y solicitá un código nuevo.";
  return "No pudimos cambiar la contraseña. Revisá el código e intentá de nuevo.";
}

export function invitationAcceptFailureState({
  kind,
  code,
  status,
  email,
  projectName,
  canSignOut = false,
}: {
  kind: "new" | "existing";
  code: string;
  status: number;
  email: string;
  projectName: string;
  canSignOut?: boolean;
}): AccountState {
  if (kind === "new" && code === "SIGN_IN_REQUIRED") {
    return {
      view: "invite-existing",
      email,
      error: errorMessage(code, status, "accept"),
      projectName,
    };
  }

  const uncertain = status === 0 || status >= 500;
  const denied =
    uncertain ||
    status === 403 ||
    code === "INVALID_INVITATION" ||
    code === "INVITATION_EXPIRED" ||
    code === "INVITATION_USED";
  return {
    view: denied ? "denied" : kind === "new" ? "invite-new" : "invite-existing",
    email,
    error: errorMessage(code, status, "accept"),
    retryable: uncertain,
    canSignOut,
    projectName,
  };
}

function errorMessage(
  code: string,
  status: number,
  context: "inspect" | "accept" | "me" | "config",
) {
  if (context === "config") return "No pudimos cargar la configuración de acceso. Probá de nuevo.";
  if (code === "NETWORK_ERROR" && status === 0)
    return "No pudimos conectar. Revisá tu conexión e intentá de nuevo.";
  if (
    code === "NotAuthorizedException" ||
    code === "UserNotFoundException" ||
    code === "UserNotConfirmedException" ||
    code === "PasswordResetRequiredException"
  )
    return "El email o la contraseña no fueron aceptados.";
  if (code === "MISSING_AUTHENTICATION_RESULT")
    return "La cuenta necesita una acción adicional antes de iniciar sesión.";
  if (code === "INVITATION_EXPIRED")
    return "La invitación venció. Pedí al equipo que te envíe una nueva.";
  if (code === "INVITATION_USED")
    return "Esta invitación ya se utilizó. Iniciá sesión con la cuenta invitada.";
  if (code === "INVALID_INVITATION") return "El enlace de invitación no es válido.";
  if (code === "INVALID_PASSWORD")
    return "La contraseña no cumple con los requisitos. Elegí otra y volvé a intentar.";
  if (code === "SIGN_IN_REQUIRED")
    return "Iniciá sesión con el email al que llegó esta invitación.";
  if (code === "UNAUTHORIZED" || status === 401)
    return "Tu sesión venció. Iniciá sesión nuevamente.";
  if (code === "FORBIDDEN" && context === "inspect")
    return "Esta invitación no es válida para este asistente.";
  if (code === "FORBIDDEN" || status === 403)
    return "Esta cuenta no tiene acceso a este asistente.";
  if (code === "TRY_AGAIN" || status >= 500)
    return "No pudimos completar la operación. Revisá tu conexión e intentá de nuevo.";
  if (context === "me")
    return "No pudimos comprobar tu acceso. Revisá tu conexión e intentá de nuevo.";
  return "No pudimos completar la invitación. Revisá el enlace e intentá de nuevo.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function replaceHash(path: string) {
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search + "#" + path,
  );
}

export function AccountApp({
  route,
  projectName,
  profileConfig = siteConfig.profile,
  getSession,
}: {
  route: AccountRoute;
  projectName: string;
  profileConfig?: ProfileConfig;
  getSession: (config: Pick<PublicConfig, "clientId" | "region">) => Session;
}) {
  const routeKey = accountRouteKey(route);
  const [state, setState] = useState<AccountState>({
    view:
      route.kind === "invite" ? "denied" : route.kind === "recover" ? "recover-request" : "login",
    pending: true,
    projectName,
  });
  const [retryCount, setRetryCount] = useState(0);
  const [chatScreenState, setChatScreenState] = useState<ChatScreenState>(emptyChatState);
  const [chatProfileRetryCount, setChatProfileRetryCount] = useState(0);
  const [chatRecoveryRevision, setChatRecoveryRevision] = useState(0);
  const chatScreenStateRef = useRef(chatScreenState);
  const chatOwnerKeyRef = useRef<string | null>(null);
  const chatConversationIdRef = useRef<string | null>(null);
  const chatEpochRef = useRef(0);
  const chatSelectionEpochRef = useRef(0);
  const historyListGenerationRef = useRef(0);
  const historySelectionGenerationRef = useRef(0);
  const historyListInitializedOwnerRef = useRef<string | null>(null);
  const chatJournalBootstrapOwnerRef = useRef<string | null>(null);
  const chatPendingConversationOpenRef = useRef<{
    ownerKey: string;
    conversationId: string;
  } | null>(null);
  const chatJournalsRef = useRef(new Map<string, TrackedChatJournalEntry>());
  const chatDraftsRef = useRef(new Map<string, string>());
  const localConversationsRef = useRef(
    new Map<string, ChatHistoryState["conversations"][number]>(),
  );
  const pendingHistoryReferenceChecksRef = useRef(new Set<string>());
  const hiddenConversationIdsRef = useRef(new Set<string>());
  const serverConfirmedConversationIdsRef = useRef(new Set<string>());
  const metadataChecksRef = useRef(new Map<string, Promise<ConversationMetaCheck>>());
  const hideOperationRef = useRef<HideOperation | null>(null);
  const hideOperationGenerationRef = useRef(0);
  const historyOpeningContextRef = useRef<HistoryOpeningContext | null>(null);
  const chatProfileSequenceRef = useRef(0);
  const chatRequestRef = useRef<AbortController | null>(null);
  const chatSubmissionInFlightRef = useRef(false);
  const chatJournalRef = useRef<ChatJournalEntry | null>(null);
  const chatJournalOwnerRef = useRef<{
    config: PublicConfig;
    identity: { sub: string; botId: string };
  } | null>(null);
  const chatDisplayedQueryIdRef = useRef<string | null>(null);
  const chatRecoveryGenerationRef = useRef(0);
  const chatRecoveryControllerRef = useRef<AbortController | null>(null);
  const chatRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatRecoveryStopRef = useRef<(() => void) | null>(null);
  const configRef = useRef<PublicConfig | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const retryOperationRef = useRef<RetryOperation | null>(null);
  const authorizedRouteRef = useRef<RouteIdentity | null>(null);
  const currentRouteKeyRef = useRef(routeKey);
  const routeEpochRef = useRef(0);
  if (currentRouteKeyRef.current !== routeKey) {
    currentRouteKeyRef.current = routeKey;
    routeEpochRef.current += 1;
  }
  const mountedRef = useRef(false);
  const initializeSequenceRef = useRef(0);
  const recoverySubmissionInFlightRef = useRef(false);
  const identityGenerationRef = useRef(0);
  const confirmOperationRef = useRef<{ email: string } | null>(null);
  const passwordResetLoginEmailRef = useRef<string | null>(null);

  const setChat = useCallback((next: ChatScreenState) => {
    const history = next.history;
    if (!history) {
      chatScreenStateRef.current = next;
      setChatScreenState(next);
      return;
    }
    const hidden = hiddenConversationIdsRef.current;
    const selectedIsHidden =
      history.selectedConversationId !== null && hidden.has(history.selectedConversationId);
    const conversations = history.conversations
      .filter((conversation) => !hidden.has(conversation.conversationId))
      .map((conversation) => {
        const hasDraft = (chatDraftsRef.current.get(conversation.conversationId) ?? "").length > 0;
        const summary = { ...conversation };
        delete summary.hasDraft;
        return hasDraft ? { ...summary, hasDraft: true } : summary;
      });
    const removal =
      history.removal && hidden.has(history.removal.conversationId) ? undefined : history.removal;
    const safeState: ChatScreenState = {
      ...next,
      ...(selectedIsHidden
        ? {
            queryStatus: "idle" as const,
            draft: "",
            answerComplete: undefined,
            queryId: undefined,
            question: undefined,
            answer: undefined,
            ordinal: undefined,
            canContinue: false,
            queryError: undefined,
            queryErrorCode: undefined,
            recovered: false,
            recoveryLoading: false,
            canRetry: false,
          }
        : {}),
      history: {
        ...history,
        conversations,
        selectedConversationId: selectedIsHidden ? null : history.selectedConversationId,
        ...(selectedIsHidden
          ? {
              turnsStatus: "idle" as const,
              turns: [],
              turnsNextCursor: null,
              loadingEarlier: false,
              openingConversationId: undefined,
              turnsError: undefined,
              refreshRequired: false,
              closed: undefined,
              canContinue: undefined,
              throughOrdinal: undefined,
            }
          : {}),
        ...(removal ? { removal } : { removal: undefined }),
      },
    };
    chatScreenStateRef.current = safeState;
    setChatScreenState(safeState);
  }, []);

  const updateChat = useCallback(
    (update: (current: ChatScreenState) => ChatScreenState) => {
      setChat(update(chatScreenStateRef.current));
    },
    [setChat],
  );

  const setHistory = useCallback(
    (update: (current: ChatHistoryState) => ChatHistoryState) => {
      updateChat((current) => ({
        ...current,
        history: update(current.history ?? emptyHistoryState()),
      }));
    },
    [updateChat],
  );

  const changeChatDraft = useCallback(
    (text: string) => {
      const selectedId = chatScreenStateRef.current.history?.selectedConversationId;
      if (selectedId && hiddenConversationIdsRef.current.has(selectedId)) return;
      chatDraftsRef.current.set(selectedId ?? "__new__", text);
      updateChat((current) => ({
        ...current,
        draft: text,
        history: current.history
          ? {
              ...current.history,
              conversations: current.history.conversations.map((conversation) =>
                conversation.conversationId === selectedId
                  ? { ...conversation, hasDraft: text.length > 0 }
                  : conversation,
              ),
            }
          : undefined,
      }));
    },
    [updateChat],
  );

  const stopChatRecovery = useCallback(() => {
    chatRecoveryGenerationRef.current += 1;
    if (chatRecoveryTimerRef.current !== null) {
      globalThis.clearTimeout(chatRecoveryTimerRef.current);
      chatRecoveryTimerRef.current = null;
    }
    chatRecoveryControllerRef.current?.abort();
    chatRecoveryControllerRef.current = null;
    chatRecoveryStopRef.current?.();
    chatRecoveryStopRef.current = null;
  }, []);

  const clearCurrentChatJournal = useCallback((configToClear?: PublicConfig) => {
    const scope = chatJournalOwnerRef.current;
    if (scope) {
      try {
        clearChatJournal(scope.config, scope.identity);
      } catch {
        // Access revocation still clears the in-memory reference when storage is unavailable.
      }
    }
    if (configToClear) {
      try {
        clearChatJournalForConfiguredBot(configToClear);
      } catch {
        // Access revocation still clears the in-memory reference when storage is unavailable.
      }
    }
    chatJournalRef.current = null;
    chatJournalOwnerRef.current = null;
    chatDisplayedQueryIdRef.current = null;
    chatJournalsRef.current.clear();
    chatDraftsRef.current.clear();
    localConversationsRef.current.clear();
    pendingHistoryReferenceChecksRef.current.clear();
    historyListInitializedOwnerRef.current = null;
    chatJournalBootstrapOwnerRef.current = null;
    chatPendingConversationOpenRef.current = null;
    hiddenConversationIdsRef.current.clear();
    serverConfirmedConversationIdsRef.current.clear();
    metadataChecksRef.current.clear();
    const pendingHideOperation = hideOperationRef.current;
    hideOperationRef.current = null;
    hideOperationGenerationRef.current += 1;
    pendingHideOperation?.complete(false);
    historyOpeningContextRef.current = null;
  }, []);

  // Identity activation leaves an unowned journal available to the recovery effect.
  const invalidateChat = useCallback(
    (configToClear?: PublicConfig) => {
      chatEpochRef.current += 1;
      chatSelectionEpochRef.current += 1;
      historyListGenerationRef.current += 1;
      historySelectionGenerationRef.current += 1;
      chatProfileSequenceRef.current += 1;
      stopChatRecovery();
      chatRequestRef.current?.abort();
      chatRequestRef.current = null;
      chatSubmissionInFlightRef.current = false;
      chatOwnerKeyRef.current = null;
      chatConversationIdRef.current = null;
      chatPendingConversationOpenRef.current = null;
      chatJournalsRef.current.clear();
      chatDraftsRef.current.clear();
      clearCurrentChatJournal(configToClear);
      setChat(emptyChatState());
    },
    [clearCurrentChatJournal, setChat, stopChatRecovery],
  );

  const activateChatIdentity = useCallback(
    (identity: { sub: string; botId: string }) => {
      const nextOwner = chatOwnerKey(identity);
      if (chatOwnerKeyRef.current === nextOwner) return;
      invalidateChat();
      chatOwnerKeyRef.current = nextOwner;
      setChat(emptyChatState());
      const config = configRef.current;
      if (!config || config.botId !== identity.botId) return;

      chatJournalBootstrapOwnerRef.current = nextOwner;
      const owner = { sub: identity.sub, botId: identity.botId };
      let journals = new Map<string, TrackedChatJournalEntry>();
      let selectedId: string | null = null;
      try {
        journals = new Map(readChatJournals(config, owner));
        selectedId = readChatSelection(config, owner);
      } catch {
        // History remains available when this tab cannot use session storage.
      }
      chatJournalsRef.current = journals;
      chatJournalOwnerRef.current = { config, identity: owner };
      if (!selectedId && journals.size > 0) selectedId = journals.keys().next().value ?? null;
      if (selectedId) {
        chatPendingConversationOpenRef.current = {
          ownerKey: nextOwner,
          conversationId: selectedId,
        };
      }
      const current = chatScreenStateRef.current;
      const currentHistory = current.history ?? emptyHistoryState();
      setChat({
        ...current,
        history: {
          ...currentHistory,
          conversations: mergeHistoryConversations(
            localConversationsRef.current,
            currentHistory.conversations,
            [],
            hiddenConversationIdsRef.current,
          ),
          selectedConversationId: selectedId,
          turnsStatus: selectedId ? "loading" : "idle",
          turns: [],
          turnsNextCursor: null,
          refreshRequired: false,
          openingConversationId: undefined,
        },
      });
      chatConversationIdRef.current = selectedId;
    },
    [invalidateChat, setChat],
  );

  const resetChat = useCallback(() => {
    const identity = state.view === "ready" ? state.identity : undefined;
    const config = configRef.current;
    const currentChat = chatScreenStateRef.current;
    const previousConversationId = currentChat.history?.selectedConversationId ?? null;
    if (previousConversationId) {
      chatDraftsRef.current.set(previousConversationId, currentChat.draft || "");
    }
    const capacityRejectedDraft =
      currentChat.queryStatus === "rejected" &&
      ["capacity_exceeded", "storage_capacity_exceeded"].includes(
        currentChat.queryErrorCode?.toLowerCase() || "",
      )
        ? (currentChat.draft ?? "")
        : "";
    chatSelectionEpochRef.current += 1;
    historySelectionGenerationRef.current += 1;
    stopChatRecovery();
    chatRequestRef.current?.abort();
    chatRequestRef.current = null;
    chatSubmissionInFlightRef.current = false;
    chatConversationIdRef.current = null;
    chatJournalRef.current = null;
    chatDisplayedQueryIdRef.current = null;
    chatPendingConversationOpenRef.current = null;
    historyOpeningContextRef.current = null;
    chatDraftsRef.current.set("__new__", capacityRejectedDraft);
    if (identity && config) {
      try {
        writeChatSelection(config, identity, null);
      } catch {
        // A new local conversation still works if selection storage is unavailable.
      }
    }
    updateChat((current) => ({
      profileStatus: current.profileStatus,
      profileError: current.profileError,
      projectName: current.projectName,
      queryStatus: "idle",
      draft: capacityRejectedDraft,
      history: current.history
        ? {
            ...current.history,
            selectedConversationId: null,
            turnsStatus: "idle",
            openingConversationId: undefined,
            turns: [],
            turnsNextCursor: null,
            loadingEarlier: false,
            refreshRequired: false,
            turnsError: undefined,
          }
        : emptyHistoryState(),
    }));
  }, [
    state.view,
    state.view === "ready" ? state.identity : undefined,
    stopChatRecovery,
    updateChat,
  ]);

  function isCurrentRoute(identity: RouteIdentity) {
    return (
      mountedRef.current &&
      currentRouteKeyRef.current === identity.key &&
      routeEpochRef.current === identity.epoch
    );
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(
    () => () => {
      chatEpochRef.current += 1;
      chatProfileSequenceRef.current += 1;
      stopChatRecovery();
      chatRequestRef.current?.abort();
      chatRequestRef.current = null;
      chatSubmissionInFlightRef.current = false;
      chatOwnerKeyRef.current = null;
      chatConversationIdRef.current = null;
    },
    [stopChatRecovery],
  );

  const inspectInvitation = useCallback(
    async (config: PublicConfig, token: string, isActive: () => boolean) => {
      const response = await apiRequest(config, "/account/invitations/inspect", {
        method: "POST",
        body: { token },
      });
      const invitation = isRecord(response) ? response : {};
      if (
        (invitation.kind !== "new" && invitation.kind !== "existing") ||
        typeof invitation.email !== "string"
      ) {
        throw Object.assign(new Error("Invalid invitation response"), {
          code: "INVALID_INVITATION",
          status: 400,
        });
      }
      if (!isActive()) return;
      setState({
        view: invitation.kind === "new" ? "invite-new" : "invite-existing",
        email: invitation.email,
        projectName,
      });
    },
    [projectName],
  );

  const checkMembership = useCallback(
    async (
      config: PublicConfig,
      session: Session,
      email: string | undefined,
      isActive: () => boolean,
    ) => {
      const routeIdentity = {
        key: currentRouteKeyRef.current,
        epoch: routeEpochRef.current,
      };
      authorizedRouteRef.current = null;
      retryOperationRef.current = async () => {
        if (!isActive()) return;
        setState((current) => ({ ...current, pending: true, error: undefined }));
        try {
          const membership = await requestWithRefresh(config, session, "/account/me", {}, isActive);
          if (
            !isRecord(membership) ||
            typeof membership.sub !== "string" ||
            membership.botId !== config.botId
          ) {
            throw Object.assign(new Error("Membership response did not match this assistant"), {
              code: "INVALID_RESPONSE",
              status: 502,
            });
          }
          if (!isActive()) return;
          activateChatIdentity({ sub: membership.sub, botId: membership.botId });
          authorizedRouteRef.current = routeIdentity;
          setState({
            view: "ready",
            identity: {
              sub: membership.sub,
              botId: membership.botId,
              generation: ++identityGenerationRef.current,
            },
            email,
            projectName,
          });
        } catch (error) {
          if (!isActive()) return;
          authorizedRouteRef.current = null;
          const apiError = asApiError(error);
          if (apiError.status === 401 || apiError.status === 403) {
            try {
              clearChatJournalForConfiguredBot(config);
            } catch {
              // Authentication failure still invalidates the in-memory chat state.
            }
            invalidateChat();
          }
          setState({
            view: "denied",
            email,
            error: errorMessage(apiError.code, apiError.status, "me"),
            pending: false,
            retryable: apiError.status !== 403,
            canSignOut: Boolean(session.accessToken()),
            projectName,
          });
        }
      };

      await retryOperationRef.current();
    },
    [activateChatIdentity, invalidateChat, projectName],
  );

  const initialize = useCallback(
    async (isActive: () => boolean) => {
      if (!isActive()) return;
      authorizedRouteRef.current = null;
      retryOperationRef.current = null;
      configRef.current = null;
      setState({
        view:
          route.kind === "invite"
            ? "denied"
            : route.kind === "recover"
              ? "recover-request"
              : "login",
        pending: true,
        projectName,
      });

      try {
        const config = await readPublicConfig();
        if (!isActive()) return;
        configRef.current = config;
        const session = getSession(config);
        sessionRef.current = session;

        if (route.kind === "invite") {
          if (!route.token) {
            throw Object.assign(new Error("Invitation token is missing"), {
              code: "INVALID_INVITATION",
              status: 400,
            });
          }
          await inspectInvitation(config, route.token, isActive);
          return;
        }

        if (route.kind === "recover") {
          if (!isActive()) return;
          setState({
            view: "recover-request",
            pending: false,
            projectName,
          });
          return;
        }

        const pendingReset = confirmOperationRef.current;
        if (pendingReset) {
          setState({
            view: "login",
            email: pendingReset.email,
            pending: true,
            projectName,
          });
          return;
        }

        if (passwordResetLoginEmailRef.current !== null) {
          const email = passwordResetLoginEmailRef.current;
          passwordResetLoginEmailRef.current = null;
          setState({
            view: "login",
            email,
            notice: passwordResetLoginNotice,
            projectName,
          });
          return;
        }

        const restored = await session.restore();
        if (!isActive()) return;
        if (confirmOperationRef.current) {
          setState({
            view: "login",
            email: confirmOperationRef.current.email,
            pending: true,
            projectName,
          });
          return;
        }
        if (passwordResetLoginEmailRef.current !== null) {
          const email = passwordResetLoginEmailRef.current;
          passwordResetLoginEmailRef.current = null;
          setState({ view: "login", email, notice: passwordResetLoginNotice, projectName });
          return;
        }
        if (!restored) {
          try {
            clearChatJournalForConfiguredBot(config);
          } catch {
            // A missing session still invalidates the in-memory chat state.
          }
          invalidateChat();
          setState({
            view: "login",
            pending: false,
            projectName,
          });
          return;
        }
        await checkMembership(config, session, undefined, isActive);
      } catch (error) {
        if (!isActive()) return;
        const apiError = asApiError(error);
        if (apiError.status === 401 || apiError.status === 403) {
          if (configRef.current) {
            try {
              clearChatJournalForConfiguredBot(configRef.current);
            } catch {
              // Authentication failure still invalidates the in-memory chat state.
            }
          }
          invalidateChat();
        }
        const context = configRef.current ? "inspect" : "config";
        setState({
          view: "denied",
          error: errorMessage(apiError.code, apiError.status, context),
          pending: false,
          retryable: apiError.status === 0 || apiError.status >= 500,
          projectName,
        });
      }
    },
    [checkMembership, getSession, inspectInvitation, invalidateChat, projectName, route],
  );

  useEffect(() => {
    let cancelled = false;
    const sequence = ++initializeSequenceRef.current;
    const identity = { key: routeKey, epoch: routeEpochRef.current };
    const isActive = () =>
      !cancelled && sequence === initializeSequenceRef.current && isCurrentRoute(identity);
    void initialize(isActive);
    return () => {
      cancelled = true;
    };
  }, [initialize, retryCount, routeKey]);

  function submit(submission: AccountSubmission) {
    const recoveryAction =
      submission.action === "request-password-reset" ||
      submission.action === "resend-password-reset" ||
      submission.action === "confirm-password-reset";
    if (
      recoverySubmissionInFlightRef.current &&
      (recoveryAction || submission.action === "change-recovery-email")
    ) {
      return Promise.resolve();
    }
    if (confirmOperationRef.current && submission.action === "sign-in") {
      return Promise.resolve();
    }

    const identity = { key: routeKey, epoch: routeEpochRef.current };
    if (recoveryAction) recoverySubmissionInFlightRef.current = true;
    return performSubmit(submission, identity).finally(() => {
      if (recoveryAction) recoverySubmissionInFlightRef.current = false;
    });
  }

  function beginSignIn() {
    invalidateChat();
    authorizedRouteRef.current = null;
    retryOperationRef.current = null;
  }

  async function performSubmit(submission: AccountSubmission, identity: RouteIdentity) {
    const isActive = () => isCurrentRoute(identity);
    if (submission.action === "change-recovery-email") {
      if (!isActive()) return;
      setState((current) => ({
        view: "recover-request",
        email: current.email,
        pending: false,
        projectName,
      }));
      return;
    }

    if (submission.action === "retry") {
      if (retryOperationRef.current && sessionRef.current?.accessToken()) {
        await retryOperationRef.current();
      } else if (isActive()) {
        setRetryCount((count) => count + 1);
      }
      return;
    }

    const session = sessionRef.current;
    const config = configRef.current;
    if (!session || !config) {
      if (!isActive()) return;
      setState({
        view: "denied",
        error: errorMessage("NETWORK_ERROR", 0, "config"),
        pending: false,
        retryable: true,
        projectName,
      });
      return;
    }

    if (
      submission.action === "request-password-reset" ||
      submission.action === "resend-password-reset"
    ) {
      const isResend = submission.action === "resend-password-reset";
      setState((current) => ({
        ...current,
        pending: true,
        pendingAction: isResend ? "resend-reset" : "request-reset",
        error: undefined,
        notice: undefined,
      }));
      try {
        await session.requestPasswordReset(submission.email);
        if (!isActive()) return;
        setState({
          view: "recover-confirm",
          email: submission.email,
          notice: recoveryNotice,
          projectName,
        });
      } catch (error) {
        if (!isActive()) return;
        const apiError = asApiError(error);
        if (isRecoveryIdentityError(apiError.code)) {
          setState({
            view: "recover-confirm",
            email: submission.email,
            notice: recoveryNotice,
            projectName,
          });
          return;
        }
        setState({
          view: isResend ? "recover-confirm" : "recover-request",
          email: submission.email,
          error: recoveryRequestErrorMessage(apiError.code),
          projectName,
        });
      }
      return;
    }

    if (submission.action === "confirm-password-reset") {
      const operation = { email: submission.email };
      confirmOperationRef.current = operation;
      setState((current) => ({
        ...current,
        pending: true,
        pendingAction: "confirm-reset",
        error: undefined,
        notice: undefined,
      }));
      try {
        await session.confirmPasswordReset(submission.email, submission.code, submission.password);
        if (confirmOperationRef.current !== operation) return;
        confirmOperationRef.current = null;
        invalidateChat(configRef.current ?? undefined);
        authorizedRouteRef.current = null;
        retryOperationRef.current = null;
        passwordResetLoginEmailRef.current = submission.email;
        const currentRouteKey = currentRouteKeyRef.current;
        if (!mountedRef.current) return;
        if (currentRouteKey !== "login") {
          window.location.hash = "/login";
          return;
        }
        passwordResetLoginEmailRef.current = null;
        setState({
          view: "login",
          email: submission.email,
          notice: passwordResetLoginNotice,
          projectName,
        });
      } catch (error) {
        if (confirmOperationRef.current !== operation) return;
        confirmOperationRef.current = null;
        if (!mountedRef.current) return;
        const currentRouteKey = currentRouteKeyRef.current;
        if (currentRouteKey === "login") {
          setState({ view: "login", email: submission.email, projectName });
          return;
        }
        if (currentRouteKey !== "recover") {
          setRetryCount((count) => count + 1);
          return;
        }
        const apiError = asApiError(error);
        setState({
          view: "recover-confirm",
          email: submission.email,
          error: recoveryConfirmErrorMessage(apiError.code),
          projectName,
        });
      }
      return;
    }

    if (!isActive()) return;
    setState((current) => ({ ...current, pending: true, error: undefined }));
    const isNewInvitation = submission.action === "accept-new";
    const isExistingInvitation = submission.action === "accept-existing";

    try {
      if (isNewInvitation) {
        if (route.kind !== "invite" || !route.token) {
          throw Object.assign(new Error("Invitation is missing"), {
            code: "INVALID_INVITATION",
            status: 400,
          });
        }
        const acceptance = await apiRequest(config, "/account/invitations/accept", {
          method: "POST",
          body: { token: route.token, password: submission.password },
        });
        if (!isActive()) return;
        if (!isRecord(acceptance) || acceptance.status !== "accepted") {
          throw Object.assign(new Error("Invitation acceptance response was invalid"), {
            code: "INVALID_RESPONSE",
            status: 502,
          });
        }
        replaceHash("/login");
        try {
          beginSignIn();
          await session.signIn(submission.email, submission.password);
          if (!isActive()) return;
          await checkMembership(config, session, submission.email, isActive);
        } catch {
          if (!isActive()) return;
          setState({
            view: "login",
            email: submission.email,
            notice: "Tu cuenta está activa. Iniciá sesión para comprobar el acceso.",
            error: "No pudimos iniciar sesión automáticamente. Volvé a ingresar tu contraseña.",
            projectName,
          });
        }
        return;
      }

      beginSignIn();
      await session.signIn(submission.email, submission.password);
      if (!isActive()) return;

      if (isExistingInvitation) {
        if (route.kind !== "invite" || !route.token) {
          throw Object.assign(new Error("Invitation is missing"), {
            code: "INVALID_INVITATION",
            status: 400,
          });
        }
        await requestWithRefresh(
          config,
          session,
          "/account/invitations/accept",
          {
            method: "POST",
            body: { token: route.token },
          },
          isActive,
        );
        if (!isActive()) return;
        replaceHash("/login");
      }

      await checkMembership(config, session, submission.email, isActive);
    } catch (error) {
      if (!isActive()) return;
      const apiError = asApiError(error);
      if (apiError.status === 401 && !session.accessToken()) {
        setState({
          view: isExistingInvitation ? "invite-existing" : "login",
          email: submission.email,
          error: "El email o la contraseña no fueron aceptados.",
          projectName,
        });
        return;
      }
      if (isNewInvitation || isExistingInvitation) {
        setState(
          invitationAcceptFailureState({
            kind: isNewInvitation ? "new" : "existing",
            code: apiError.code,
            status: apiError.status,
            email: submission.email,
            projectName,
            canSignOut: Boolean(session.accessToken()),
          }),
        );
        return;
      }
      setState({
        view: "login",
        email: submission.email,
        error: errorMessage(apiError.code, apiError.status, "me"),
        retryable: false,
        canSignOut: Boolean(session.accessToken()),
        projectName,
      });
    }
  }

  const signOut = useCallback(() => {
    invalidateChat(configRef.current ?? undefined);
    authorizedRouteRef.current = null;
    setState({
      view: "login",
      pending: false,
      notice: "Cerraste sesión.",
      projectName,
    });
    if (window.location.hash !== "#/login") window.location.hash = "/login";
    void sessionRef.current?.signOut();
  }, [invalidateChat, projectName]);

  const profileUnauthorized = useCallback(() => {
    invalidateChat(configRef.current ?? undefined);
    authorizedRouteRef.current = null;
    setState({
      view: "login",
      pending: false,
      notice: "Tu sesión venció. Iniciá sesión nuevamente.",
      projectName,
    });
    if (window.location.hash !== "#/login") window.location.hash = "/login";
    void sessionRef.current?.signOut();
  }, [invalidateChat, projectName]);

  const profileForbidden = useCallback(() => {
    invalidateChat(configRef.current ?? undefined);
    authorizedRouteRef.current = null;
    setState({
      view: "denied",
      pending: false,
      error: "Esta cuenta no tiene acceso a este asistente.",
      retryable: false,
      canSignOut: Boolean(sessionRef.current?.accessToken()),
      projectName,
    });
  }, [invalidateChat, projectName]);

  const authorizedRouteIsCurrent =
    authorizedRouteRef.current?.key === routeKey &&
    authorizedRouteRef.current.epoch === routeEpochRef.current;
  const apiConfig = configRef.current;
  const session = sessionRef.current;
  const readyIdentity = state.view === "ready" ? state.identity : undefined;

  useEffect(() => {
    if (
      route.kind !== "chat" ||
      !authorizedRouteIsCurrent ||
      state.view !== "ready" ||
      !readyIdentity ||
      !apiConfig ||
      !session ||
      chatOwnerKeyRef.current !== chatOwnerKey(readyIdentity)
    ) {
      return;
    }
    const identity = readyIdentity;
    const identityKey = chatOwnerKey(identity);
    const chatEpoch = chatEpochRef.current;
    const profileSequence = ++chatProfileSequenceRef.current;
    let active = true;
    const isActive = () =>
      active &&
      chatProfileSequenceRef.current === profileSequence &&
      chatEpochRef.current === chatEpoch &&
      chatOwnerKeyRef.current === identityKey;

    setChat({
      ...chatScreenStateRef.current,
      profileStatus: "loading",
      profileError: undefined,
    });
    void requestWithRefresh(apiConfig, session, "/profile", {}, isActive)
      .then((payload) => {
        if (!isActive()) return;
        const profile = parseProfileEnvelope(payload, profileConfig, identity);
        setChat({
          ...chatScreenStateRef.current,
          profileStatus: profile ? "complete" : "incomplete",
          profileError: undefined,
        });
      })
      .catch((error: unknown) => {
        if (!isActive()) return;
        const apiError = asApiError(error);
        if (apiError.status === 401) {
          invalidateChat();
          profileUnauthorized();
          return;
        }
        if (apiError.status === 403) {
          invalidateChat();
          profileForbidden();
          return;
        }
        setChat({
          ...chatScreenStateRef.current,
          profileStatus: "error",
          profileError: "No pudimos cargar tu perfil. Podés reintentar.",
        });
      });

    return () => {
      active = false;
    };
  }, [
    apiConfig,
    authorizedRouteIsCurrent,
    chatProfileRetryCount,
    invalidateChat,
    profileConfig,
    profileForbidden,
    profileUnauthorized,
    readyIdentity,
    route.kind,
    session,
    setChat,
    state.view,
  ]);

  async function readCompleteTurnText(
    conversationId: string,
    turn: ConversationTurn,
    role: "user" | "assistant",
    isActive: () => boolean,
  ) {
    const manifest = role === "user" ? turn.questionManifest : turn.answerManifest;
    const throughCursor = role === "user" ? manifest.count : turn.cursor;
    if (throughCursor === 0) {
      if (role !== "assistant" || turn.status === "in_progress" || manifest.count !== 0) {
        return { text: "", complete: manifest.complete };
      }
      const page = await readConversationTextPage(
        apiConfig!,
        session!,
        {
          conversationId,
          ordinal: turn.ordinal,
          queryId: turn.queryId,
          role,
          throughCursor,
          cursor: null,
        },
        isActive,
      );
      if (page.chunks.length !== 0 || page.nextCursor !== null) {
        throw Object.assign(new Error("History text exceeds the requested empty prefix"), {
          code: "INVALID_RESPONSE",
          status: 502,
        });
      }
      return { text: "", complete: isActive() && manifest.complete && page.complete };
    }
    const chunks: { index: number; text: string }[] = [];
    let cursor: string | null = null;
    let finished = false;
    let transferComplete = false;
    const visitedCursors = new Set<string>();
    while (!finished && isActive()) {
      if (cursor !== null && visitedCursors.has(cursor)) break;
      if (cursor !== null) visitedCursors.add(cursor);
      const page = await readConversationTextPage(
        apiConfig!,
        session!,
        {
          conversationId,
          ordinal: turn.ordinal,
          queryId: turn.queryId,
          role,
          throughCursor,
          cursor,
        },
        isActive,
      );
      if (page.nextCursor !== null && visitedCursors.has(page.nextCursor)) {
        finished = true;
        transferComplete = false;
        break;
      }
      for (const chunk of page.chunks) {
        if (chunk.index !== chunks.length) {
          throw Object.assign(new Error("History text chunks are out of order"), {
            code: "INVALID_RESPONSE",
            status: 502,
          });
        }
        chunks.push(chunk);
      }
      finished = page.nextCursor === null;
      transferComplete = finished && page.complete;
      if (finished) break;
      cursor = page.nextCursor;
    }
    const complete =
      isActive() &&
      finished &&
      transferComplete &&
      chunks.length === throughCursor &&
      chunks.every((chunk, index) => chunk.index === index);
    return { text: chunks.map(({ text }) => text).join(""), complete };
  }

  async function readConversationView(
    conversationId: string,
    cursor: string | null,
    isActive: () => boolean,
  ) {
    let pageCursor = cursor;
    let firstThroughOrdinal: number | undefined;
    let page: Awaited<ReturnType<typeof readConversationTurns>>;
    const presentation: Pick<
      Awaited<ReturnType<typeof readConversationTurns>>,
      "label" | "createdAt" | "updatedAt"
    > = {};
    const visitedCursors = new Set<string>();
    while (true) {
      if (pageCursor !== null) {
        if (visitedCursors.has(pageCursor)) {
          throw Object.assign(new Error("History cursor repeated"), {
            code: "INVALID_RESPONSE",
            status: 502,
          });
        }
        visitedCursors.add(pageCursor);
      }
      page = await readConversationTurns(
        apiConfig!,
        session!,
        conversationId,
        pageCursor,
        isActive,
      );
      firstThroughOrdinal ??= page.throughOrdinal;
      presentation.label ??= page.label;
      presentation.createdAt ??= page.createdAt;
      presentation.updatedAt ??= page.updatedAt;
      if (page.nextCursor !== null && visitedCursors.has(page.nextCursor)) {
        throw Object.assign(new Error("History cursor repeated"), {
          code: "INVALID_RESPONSE",
          status: 502,
        });
      }
      if (page.turns.length > 0 || page.nextCursor === null) break;
      pageCursor = page.nextCursor;
    }
    const turns: ChatHistoryTurn[] = [];
    // Each turn reads user and assistant text in parallel. Two turns per batch cap this
    // page at four concurrent authenticated reads, which avoids API 503s on larger pages.
    for (let offset = 0; offset < page.turns.length; offset += 2) {
      const batch = await Promise.all(
        page.turns.slice(offset, offset + 2).map(async (turn) => {
          const [question, answer] = await Promise.all([
            readCompleteTurnText(conversationId, turn, "user", isActive),
            readCompleteTurnText(conversationId, turn, "assistant", isActive),
          ]);
          if (turn.status === "completed" && answer.complete && !answer.text.trim()) {
            throw Object.assign(new Error("Completed history turn has an empty answer"), {
              code: "INVALID_RESPONSE",
              status: 502,
            });
          }
          return {
            ordinal: turn.ordinal,
            queryId: turn.queryId,
            status: turn.status,
            question: question.text,
            answer: answer.text,
            questionComplete: question.complete,
            answerComplete: answer.complete,
            canContinue: page.canContinue,
            ...(turn.failure ? { failure: turn.failure } : {}),
          };
        }),
      );
      turns.push(...batch);
    }
    return { ...page, ...presentation, throughOrdinal: firstThroughOrdinal!, turns };
  }

  function retireHiddenConversation(
    conversationId: string,
    config: PublicConfig,
    identity: { sub: string; botId: string },
  ) {
    hiddenConversationIdsRef.current.add(conversationId);
    serverConfirmedConversationIdsRef.current.delete(conversationId);
    pendingHistoryReferenceChecksRef.current.delete(conversationId);
    localConversationsRef.current.delete(conversationId);
    chatDraftsRef.current.delete(conversationId);
    chatJournalsRef.current.delete(conversationId);
    if (chatPendingConversationOpenRef.current?.conversationId === conversationId) {
      chatPendingConversationOpenRef.current = null;
    }
    if (chatJournalRef.current?.request.conversationId === conversationId) {
      chatJournalRef.current = null;
      chatJournalOwnerRef.current = null;
    }
    if (chatConversationIdRef.current === conversationId) chatConversationIdRef.current = null;
    try {
      clearChatJournalEntry(config, identity, conversationId);
      if (readChatSelection(config, identity) === conversationId) {
        writeChatSelection(config, identity, null);
      }
    } catch {
      // In-memory exclusion remains authoritative if sessionStorage cannot be changed.
    }

    const current = chatScreenStateRef.current;
    const history = current.history ?? emptyHistoryState();
    const selected = history.selectedConversationId === conversationId;
    const opening = history.openingConversationId === conversationId;
    const openContext = historyOpeningContextRef.current;
    const restoreOpeningContext =
      opening &&
      !selected &&
      openContext?.conversationId === conversationId &&
      openContext.selectedConversationId === history.selectedConversationId
        ? openContext
        : null;
    if (opening) historyOpeningContextRef.current = null;
    if (selected) {
      stopChatRecovery();
      chatRequestRef.current?.abort();
      chatRequestRef.current = null;
      chatSubmissionInFlightRef.current = false;
      chatDisplayedQueryIdRef.current = null;
    }
    const conversations = history.conversations.filter(
      (conversation) => conversation.conversationId !== conversationId,
    );
    const removal =
      history.removal?.conversationId === conversationId ? undefined : history.removal;
    setChat({
      ...current,
      ...(selected
        ? {
            queryStatus: "idle",
            draft: "",
            answerComplete: undefined,
            queryId: undefined,
            question: undefined,
            answer: undefined,
            ordinal: undefined,
            canContinue: false,
            queryError: undefined,
            queryErrorCode: undefined,
            quota: undefined,
            quotaReceivedAt: undefined,
            recovered: false,
            recoveryLoading: false,
            canRetry: false,
          }
        : {}),
      history: {
        ...history,
        conversations,
        selectedConversationId: selected ? null : history.selectedConversationId,
        turnsStatus: selected
          ? "idle"
          : opening
            ? (restoreOpeningContext?.turnsStatus ??
              (history.selectedConversationId
                ? history.turns.length > 0
                  ? "ready"
                  : "idle"
                : "idle"))
            : history.turnsStatus,
        turns: selected ? [] : history.turns,
        turnsNextCursor: selected ? null : history.turnsNextCursor,
        loadingEarlier: selected ? false : history.loadingEarlier,
        openingConversationId:
          history.openingConversationId === conversationId
            ? undefined
            : history.openingConversationId,
        turnsError: selected
          ? undefined
          : opening
            ? restoreOpeningContext?.turnsError
            : history.turnsError,
        refreshRequired: selected ? false : history.refreshRequired,
        ...(conversations.length === 0 && !history.nextCursor && history.status !== "error"
          ? { status: "empty" as const }
          : {}),
        removal,
      },
    });
    const operation = hideOperationRef.current;
    if (
      operation?.conversationId === conversationId &&
      operation.ownerKey === chatOwnerKey(identity)
    ) {
      settleHideOperation(operation, true);
    }
  }

  function settleHideOperation(operation: HideOperation, confirmed: boolean) {
    if (hideOperationRef.current !== operation) return;
    // A confirming META result can settle the UI before the POST transport returns.
    hideOperationRef.current = null;
    hideOperationGenerationRef.current += 1;
    operation.complete(confirmed);
  }

  async function checkConversationMetadata(
    conversationId: string,
    config: PublicConfig,
    session: Session,
    identityKey: string,
  ): Promise<ConversationMetaCheck> {
    if (hiddenConversationIdsRef.current.has(conversationId)) return { kind: "hidden" };
    const checkKey = `${identityKey}:${conversationId}`;
    const previousCheck = metadataChecksRef.current.get(checkKey);
    if (previousCheck) return previousCheck;

    const metadataEpoch = chatEpochRef.current;
    const isCurrentIdentity = () =>
      chatEpochRef.current === metadataEpoch &&
      chatOwnerKeyRef.current === identityKey &&
      currentRouteKeyRef.current === "chat";
    const check = readChatConversationMeta(config, session, conversationId, isCurrentIdentity)
      .then((conversation): ConversationMetaCheck =>
        hiddenConversationIdsRef.current.has(conversationId)
          ? { kind: "hidden" }
          : isCurrentIdentity()
            ? { kind: "visible", conversation }
            : {
                kind: "error",
                error: asApiError(
                  Object.assign(new Error("Inactive conversation lookup"), {
                    code: "INACTIVE",
                    status: 0,
                  }),
                ),
              },
      )
      .catch((error: unknown): ConversationMetaCheck => {
        const apiError = asApiError(error);
        if (apiError.code === "CONVERSATION_HIDDEN") return { kind: "hidden" };
        if (apiError.status === 404) return { kind: "missing" };
        return { kind: "error", error: apiError };
      })
      .finally(() => {
        if (metadataChecksRef.current.get(checkKey) === check) {
          metadataChecksRef.current.delete(checkKey);
        }
      });
    metadataChecksRef.current.set(checkKey, check);
    return check;
  }

  function rememberVerifiedConversation(
    conversation: Awaited<ReturnType<typeof readChatConversationMeta>>,
  ) {
    if (hiddenConversationIdsRef.current.has(conversation.conversationId)) return;
    pendingHistoryReferenceChecksRef.current.delete(conversation.conversationId);
    serverConfirmedConversationIdsRef.current.add(conversation.conversationId);
    const existing =
      localConversationsRef.current.get(conversation.conversationId) ??
      chatScreenStateRef.current.history?.conversations.find(
        (local) => local.conversationId === conversation.conversationId,
      );
    if (!existing || serverConversationSupersedesLocal(existing, conversation)) {
      const draft = chatDraftsRef.current.get(conversation.conversationId) ?? "";
      localConversationsRef.current.set(conversation.conversationId, {
        ...conversation,
        hasDraft: draft.length > 0 || undefined,
      });
    } else {
      localConversationsRef.current.set(conversation.conversationId, existing);
    }
    setHistory((history) => ({
      ...history,
      conversations: mergeHistoryConversations(
        localConversationsRef.current,
        [],
        history.conversations,
        hiddenConversationIdsRef.current,
      ),
    }));
  }

  function showReferenceVerificationError(conversationId: string, message: string) {
    if (hiddenConversationIdsRef.current.has(conversationId)) return;
    pendingHistoryReferenceChecksRef.current.add(conversationId);
    localConversationsRef.current.delete(conversationId);
    if (chatPendingConversationOpenRef.current?.conversationId === conversationId) {
      chatPendingConversationOpenRef.current = null;
    }
    const current = chatScreenStateRef.current;
    const history = current.history ?? emptyHistoryState();
    const selected = history.selectedConversationId === conversationId;
    const opening = history.openingConversationId === conversationId;
    const openContext = historyOpeningContextRef.current;
    const restoreOpeningContext =
      opening &&
      !selected &&
      openContext?.conversationId === conversationId &&
      openContext.selectedConversationId === history.selectedConversationId
        ? openContext
        : null;
    if (historyOpeningContextRef.current?.conversationId === conversationId) {
      historyOpeningContextRef.current = null;
    }
    const conversations =
      history.removal?.conversationId === conversationId
        ? history.conversations
        : history.conversations.filter(
            (conversation) => conversation.conversationId !== conversationId,
          );
    setChat({
      ...current,
      ...(selected
        ? {
            queryStatus: "idle",
            draft: "",
            question: undefined,
            answer: undefined,
            queryId: undefined,
            answerComplete: undefined,
            canContinue: false,
            queryError: undefined,
            queryErrorCode: undefined,
          }
        : {}),
      history: {
        ...history,
        status: "error",
        error: message,
        conversations,
        loadingMore: false,
        selectedConversationId: selected ? null : history.selectedConversationId,
        turnsStatus: selected
          ? "idle"
          : opening
            ? (restoreOpeningContext?.turnsStatus ??
              (history.selectedConversationId
                ? history.turns.length > 0
                  ? "ready"
                  : "idle"
                : "idle"))
            : history.turnsStatus,
        turns: selected ? [] : history.turns,
        turnsNextCursor: selected ? null : history.turnsNextCursor,
        openingConversationId: undefined,
        turnsError: selected
          ? undefined
          : opening
            ? restoreOpeningContext?.turnsError
            : history.turnsError,
      },
    });
  }

  async function verifyLocalReferences(
    page: Awaited<ReturnType<typeof listChatConversations>>,
    config: PublicConfig,
    session: Session,
    identity: { sub: string; botId: string },
    isActive: () => boolean,
    fromStart: boolean,
  ) {
    const pageIds = new Set(page.conversations.map((conversation) => conversation.conversationId));
    for (const conversationId of pageIds) {
      serverConfirmedConversationIdsRef.current.add(conversationId);
      pendingHistoryReferenceChecksRef.current.delete(conversationId);
    }

    const references = new Set<string>([
      ...localConversationsRef.current.keys(),
      ...chatJournalsRef.current.keys(),
      ...(chatScreenStateRef.current.history?.conversations.map(
        (conversation) => conversation.conversationId,
      ) ?? []),
      ...(chatScreenStateRef.current.history?.selectedConversationId
        ? [chatScreenStateRef.current.history.selectedConversationId]
        : []),
      ...[...chatDraftsRef.current.keys()].filter((conversationId) => conversationId !== "__new__"),
      ...pendingHistoryReferenceChecksRef.current,
    ]);
    if (fromStart) {
      for (const conversationId of references) {
        if (!pageIds.has(conversationId)) {
          serverConfirmedConversationIdsRef.current.delete(conversationId);
        }
      }
    }

    const additions: ChatHistoryState["conversations"] = [];
    const errors: string[] = [];
    const identityKey = chatOwnerKey(identity);
    for (const conversationId of references) {
      if (!isActive()) return { inactive: true, additions: [], errors: [] };
      if (pageIds.has(conversationId) || hiddenConversationIdsRef.current.has(conversationId))
        continue;
      const check = await checkConversationMetadata(conversationId, config, session, identityKey);
      if (!isActive()) return { inactive: true, additions: [], errors: [] };
      if (hiddenConversationIdsRef.current.has(conversationId)) continue;
      if (check.kind === "hidden") {
        retireHiddenConversation(conversationId, config, identity);
        continue;
      }
      if (check.kind === "visible") {
        rememberVerifiedConversation(check.conversation);
        const local = localConversationsRef.current.get(conversationId);
        if (local) additions.push(local);
        continue;
      }
      if (check.kind === "missing") {
        const journal = chatJournalsRef.current.get(conversationId);
        if (journal && !journal.admitted && journal.request.operation === "start") {
          pendingHistoryReferenceChecksRef.current.delete(conversationId);
          rememberJournalConversations(new Map([[conversationId, journal]]));
          const local = localConversationsRef.current.get(conversationId);
          if (local) additions.push(local);
          continue;
        }
        localConversationsRef.current.delete(conversationId);
        pendingHistoryReferenceChecksRef.current.add(conversationId);
        errors.push(
          "No pudimos confirmar una referencia de conversación guardada. Actualizá el historial para reintentarlo.",
        );
        continue;
      }
      if (check.error.status === 401 || check.error.status === 403) throw check.error;
      localConversationsRef.current.delete(conversationId);
      pendingHistoryReferenceChecksRef.current.add(conversationId);
      errors.push(
        "No pudimos verificar una referencia de conversación guardada. Actualizá el historial para reintentarlo.",
      );
    }
    return { inactive: false, additions, errors };
  }

  async function selectConversation(conversationId: string): Promise<boolean> {
    const identity = state.view === "ready" ? state.identity : undefined;
    const config = configRef.current;
    const current = chatScreenStateRef.current;
    if (!identity || !config || !sessionRef.current || !uuidPatternForHistory(conversationId)) {
      return false;
    }
    const identityKey = chatOwnerKey(identity);
    if (
      chatOwnerKeyRef.current !== identityKey ||
      hiddenConversationIdsRef.current.has(conversationId)
    ) {
      return false;
    }
    chatPendingConversationOpenRef.current = null;

    const previousSelected = current.history?.selectedConversationId ?? null;
    if (previousSelected !== null) {
      chatDraftsRef.current.set(previousSelected, current.draft || "");
    }
    const currentHistory = current.history ?? emptyHistoryState();
    const priorOpening = historyOpeningContextRef.current;
    const previousOpenContext =
      currentHistory.openingConversationId &&
      priorOpening?.conversationId === currentHistory.openingConversationId
        ? priorOpening
        : {
            selectedConversationId: currentHistory.selectedConversationId,
            turnsStatus: currentHistory.turnsStatus,
            turnsError: currentHistory.turnsError,
          };
    const selectionGeneration = ++historySelectionGenerationRef.current;
    const selectionEpoch = ++chatSelectionEpochRef.current;
    const chatEpoch = chatEpochRef.current;
    stopChatRecovery();
    chatRequestRef.current?.abort();
    chatRequestRef.current = null;
    chatSubmissionInFlightRef.current = false;
    const isActive = () =>
      selectionGeneration === historySelectionGenerationRef.current &&
      selectionEpoch === chatSelectionEpochRef.current &&
      chatEpoch === chatEpochRef.current &&
      chatOwnerKeyRef.current === identityKey &&
      !hiddenConversationIdsRef.current.has(conversationId) &&
      currentRouteKeyRef.current === "chat";
    const isIdentityActive = () =>
      chatEpochRef.current === chatEpoch &&
      chatOwnerKeyRef.current === identityKey &&
      currentRouteKeyRef.current === "chat";
    historyOpeningContextRef.current = {
      conversationId,
      selectedConversationId: previousOpenContext.selectedConversationId,
      turnsStatus: previousOpenContext.turnsStatus,
      turnsError: previousOpenContext.turnsError,
    };
    setHistory((history) => ({
      ...history,
      turnsStatus: "loading",
      openingConversationId: conversationId,
      loadingEarlier: false,
      turnsError: undefined,
    }));

    try {
      const pendingJournal = chatJournalsRef.current.get(conversationId);
      let pendingStartWasVerifiedAbsent = false;
      if (!serverConfirmedConversationIdsRef.current.has(conversationId)) {
        const check = await checkConversationMetadata(
          conversationId,
          config,
          sessionRef.current!,
          identityKey,
        );
        if (!isIdentityActive()) return false;
        if (check.kind === "hidden") {
          retireHiddenConversation(conversationId, config, identity);
          return false;
        }
        if (
          check.kind === "error" &&
          (check.error.status === 401 ||
            check.error.status === 403 ||
            !serverConfirmedConversationIdsRef.current.has(conversationId))
        ) {
          if (check.error.status === 401) {
            invalidateChat(config);
            profileUnauthorized();
            return false;
          }
          if (check.error.status === 403) {
            invalidateChat(config);
            profileForbidden();
            return false;
          }
          if (!isActive()) return false;
          showReferenceVerificationError(
            conversationId,
            "No pudimos verificar esta referencia guardada. Podés actualizar el historial para reintentarlo.",
          );
          return false;
        }
        if (
          check.kind === "missing" &&
          !serverConfirmedConversationIdsRef.current.has(conversationId)
        ) {
          if (
            !pendingJournal ||
            pendingJournal.admitted ||
            pendingJournal.request.operation !== "start"
          ) {
            if (isActive()) {
              showReferenceVerificationError(
                conversationId,
                "No pudimos confirmar que esta conversación exista. Actualizá el historial para verificarlo de nuevo.",
              );
            }
            return false;
          }
          if (!isActive()) return false;
          pendingStartWasVerifiedAbsent = true;
          rememberJournalConversations(new Map([[conversationId, pendingJournal]]));
          setHistory((history) => ({
            ...history,
            status: "ready",
            conversations: mergeHistoryConversations(
              localConversationsRef.current,
              [],
              history.conversations,
              hiddenConversationIdsRef.current,
            ),
            error: undefined,
          }));
        } else if (check.kind === "visible") {
          rememberVerifiedConversation(check.conversation);
          if (!isActive()) return false;
        }
      }
      if (
        pendingStartWasVerifiedAbsent &&
        pendingJournal &&
        !pendingJournal.admitted &&
        pendingJournal.request.operation === "start"
      ) {
        if (historyOpeningContextRef.current?.conversationId === conversationId) {
          historyOpeningContextRef.current = null;
        }
        const request = pendingJournal.request;
        chatJournalRef.current = pendingJournal;
        chatJournalOwnerRef.current = { config, identity };
        chatConversationIdRef.current = conversationId;
        chatDisplayedQueryIdRef.current = request.queryId;
        try {
          writeChatSelection(config, identity, conversationId);
        } catch {
          // The journal remains selectable in this page if selection storage is unavailable.
        }
        setChat({
          ...chatScreenStateRef.current,
          draft: "",
          queryId: request.queryId,
          question: request.text,
          answer: "",
          answerComplete: false,
          ordinal: request.baseOrdinal,
          queryStatus: "unconfirmed",
          canContinue: false,
          canRetry: true,
          recovered: false,
          recoveryLoading: false,
          queryError:
            "No pudimos confirmar si se admitió el envío. Podés consultar su estado o reintentar el mismo pedido.",
          queryErrorCode: "UNCONFIRMED",
          history: {
            ...(chatScreenStateRef.current.history ?? emptyHistoryState()),
            selectedConversationId: conversationId,
            turnsStatus: "ready",
            turns: [],
            turnsNextCursor: null,
            loadingEarlier: false,
            openingConversationId: undefined,
            turnsError: undefined,
            refreshRequired: false,
            closed: false,
            canContinue: false,
            throughOrdinal: request.baseOrdinal,
            error: undefined,
          },
        });
        setChatRecoveryRevision((revision) => revision + 1);
        return true;
      }

      const view = await readConversationView(conversationId, null, isActive);
      if (!isActive()) return false;
      const last = view.turns.at(-1);
      let journal = chatJournalsRef.current.get(conversationId) ?? null;
      const journalIsOlderThanHistory =
        journal?.admitted === true &&
        journal.ordinal !== undefined &&
        last !== undefined &&
        (view.throughOrdinal > journal.ordinal ||
          last.ordinal > journal.ordinal ||
          (last.ordinal === journal.ordinal && last.queryId !== journal.request.queryId));
      if (journalIsOlderThanHistory && journal) {
        clearChatJournalEntry(config, identity, conversationId);
        chatJournalsRef.current.delete(conversationId);
        if (chatJournalRef.current?.request.queryId === journal.request.queryId) {
          chatJournalRef.current = null;
        }
        journal = null;
      }
      chatJournalRef.current = journal;
      chatJournalOwnerRef.current = { config, identity };
      chatConversationIdRef.current = conversationId;
      chatDisplayedQueryIdRef.current = null;

      if (last && (last.status === "completed" || last.status === "failed")) {
        if (journal?.request.queryId === last.queryId) {
          clearChatJournalEntry(config, identity, conversationId);
          chatJournalsRef.current.delete(conversationId);
          chatJournalRef.current = null;
        }
      } else if (
        last?.status === "in_progress" &&
        last.failure?.code !== "unconfirmable" &&
        !journal
      ) {
        const recoveredRequest = {
          version: 2 as const,
          operation: last.ordinal === 1 ? ("start" as const) : ("message" as const),
          conversationId,
          queryId: last.queryId,
          baseOrdinal: last.ordinal - 1,
        };
        const recoveredEntry: ChatJournalEntry = {
          request: recoveredRequest,
          admitted: true,
          ordinal: last.ordinal,
        };
        try {
          markChatJournalAdmitted(config, identity, recoveredRequest, last.ordinal);
        } catch {
          // The authoritative history still permits observation without a local reference.
        }
        chatJournalsRef.current.set(conversationId, recoveredEntry);
        chatJournalRef.current = recoveredEntry;
      }

      try {
        writeChatSelection(config, identity, conversationId);
      } catch {
        // The selected conversation remains available in this page if storage is unavailable.
      }
      const unconfirmable = last?.failure?.code === "unconfirmable";
      const activeWithReference =
        last?.status === "in_progress" &&
        !unconfirmable &&
        chatJournalsRef.current.has(conversationId);
      const queryStatus = unconfirmable
        ? "unconfirmed"
        : activeWithReference
          ? "unconfirmed"
          : last?.status === "completed"
            ? "completed"
            : last?.status === "failed"
              ? "failed"
              : last?.status === "in_progress"
                ? "unconfirmed"
                : "idle";
      const savedDraft = chatDraftsRef.current.get(conversationId) ?? "";
      if (historyOpeningContextRef.current?.conversationId === conversationId) {
        historyOpeningContextRef.current = null;
      }
      setChat({
        ...chatScreenStateRef.current,
        draft: savedDraft,
        question: undefined,
        answer: undefined,
        answerComplete: undefined,
        queryId: undefined,
        ordinal: view.throughOrdinal,
        canContinue: unconfirmable ? false : view.canContinue,
        queryStatus,
        queryError: unconfirmable
          ? "No pudimos confirmar el estado de este envío. El texto visible es un prefijo y este hilo no se puede continuar."
          : undefined,
        queryErrorCode: unconfirmable ? "unconfirmed" : undefined,
        canRetry: false,
        recovered: false,
        recoveryLoading: false,
        history: {
          ...(chatScreenStateRef.current.history ?? emptyHistoryState()),
          selectedConversationId: conversationId,
          turnsStatus: "ready",
          turns: view.turns,
          turnsNextCursor: view.nextCursor,
          refreshRequired: false,
          turnsError: undefined,
          closed: view.closed,
          canContinue: view.canContinue,
          throughOrdinal: view.throughOrdinal,
          openingConversationId: undefined,
          error: undefined,
        },
      });
      ensureConversationVisibleFromHistory(view);
      if (last?.status === "completed" || last?.status === "failed") {
        markLocalConversationTerminal(
          conversationId,
          view.throughOrdinal,
          view.closed,
          last.queryId,
        );
      }
      setChatRecoveryRevision((revision) => revision + 1);
      return true;
    } catch (error) {
      if (!isActive()) return false;
      const apiError = asApiError(error);
      if (apiError.status === 401) {
        invalidateChat(config);
        profileUnauthorized();
        return false;
      }
      if (apiError.status === 403) {
        invalidateChat(config);
        profileForbidden();
        return false;
      }
      if (apiError.code === "CONVERSATION_HIDDEN") {
        retireHiddenConversation(conversationId, config, identity);
        return false;
      }
      if (historyOpeningContextRef.current?.conversationId === conversationId) {
        historyOpeningContextRef.current = null;
      }
      setHistory((history) => ({
        ...history,
        turnsStatus: "error",
        openingConversationId: undefined,
        turnsError: historyErrorMessage(apiError.code, apiError.status, true),
      }));
      setChatRecoveryRevision((revision) => revision + 1);
      return false;
    }
  }

  async function reconcileConversationSnapshot(
    snapshot: Extract<Awaited<ReturnType<typeof recoverChat>>, { version: 2 }>,
    request: Pick<ChatRequest, "conversationId" | "queryId">,
    config: PublicConfig,
    isCurrentSelection: () => boolean,
  ) {
    if (!isCurrentSelection()) return { kind: "inactive" as const };
    const isTerminal = snapshot.status === "completed" || snapshot.status === "failed";
    if (
      conversationSnapshotIsSuperseded(
        request.conversationId,
        snapshot.queryId,
        snapshot.ordinal,
        snapshot.status,
        snapshot.canContinue,
      )
    ) {
      return {
        kind: "needs-reload" as const,
        canContinue: false as const,
        history: undefined,
        historyError: undefined,
      };
    }
    if (!isTerminal || snapshot.canContinue) {
      return {
        kind: "current" as const,
        canContinue: snapshot.canContinue,
        history: undefined,
        historyError: undefined,
      };
    }

    let history: Awaited<ReturnType<typeof readConversationView>> | undefined;
    try {
      history = await readConversationView(request.conversationId, null, isCurrentSelection);
    } catch (error) {
      if (!isCurrentSelection()) return { kind: "inactive" as const };
      const apiError = asApiError(error);
      if (apiError.status === 401 || apiError.status === 403) {
        return { kind: "unauthorized" as const, status: apiError.status };
      }
      if (apiError.code === "CONVERSATION_HIDDEN") {
        const identity = state.view === "ready" ? state.identity : undefined;
        if (identity) retireHiddenConversation(request.conversationId, config, identity);
        return { kind: "inactive" as const };
      }
      return {
        kind: "current" as const,
        canContinue: snapshot.canContinue,
        history: undefined,
        historyError:
          "No pudimos confirmar si el hilo sigue abierto. Volvé a seleccionarlo en el historial para actualizarlo.",
      };
    }
    if (!isCurrentSelection()) return { kind: "inactive" as const };

    const latestTurn = history.turns.at(-1);
    if (
      history.throughOrdinal !== snapshot.ordinal ||
      latestTurn?.queryId !== snapshot.queryId ||
      latestTurn?.status !== snapshot.status
    ) {
      return { kind: "needs-reload" as const, canContinue: false, history };
    }
    return {
      kind: "current" as const,
      canContinue: history.canContinue,
      history,
      historyError: undefined,
    };
  }

  function getObservedConversationSummary(conversationId: string) {
    const local = localConversationsRef.current.get(conversationId);
    const visible = chatScreenStateRef.current.history?.conversations.find(
      (conversation) => conversation.conversationId === conversationId,
    );
    if (!local) return visible;
    if (!visible) return local;
    return serverConversationSupersedesLocal(local, visible) ? visible : local;
  }

  function conversationSnapshotIsSuperseded(
    conversationId: string,
    queryId: string,
    ordinal: number,
    status: "in_progress" | "completed" | "failed",
    canContinue: boolean,
  ) {
    const observed = getObservedConversationSummary(conversationId);
    return Boolean(
      observed &&
      (observed.lastOrdinal > ordinal ||
        (observed.lastOrdinal === ordinal &&
          observed.activeQueryId !== queryId &&
          (observed.activeQueryId !== undefined || status === "in_progress")) ||
        (observed.lastOrdinal === ordinal &&
          observed.closed &&
          (status === "in_progress" || canContinue))),
    );
  }

  function clearSupersededJournal(
    conversationId: string,
    queryId: string,
    config: PublicConfig,
    identity: { sub: string; botId: string },
  ) {
    const journal = chatJournalsRef.current.get(conversationId);
    if (journal?.request.queryId !== queryId) return;
    clearChatJournalEntry(config, identity, conversationId);
    chatJournalsRef.current.delete(conversationId);
    if (chatJournalRef.current?.request.queryId === queryId) chatJournalRef.current = null;
  }

  async function loadMoreHistory(reload = false) {
    const identity = state.view === "ready" ? state.identity : undefined;
    const config = configRef.current;
    const session = sessionRef.current;
    if (!identity || !config || !session || chatOwnerKeyRef.current !== chatOwnerKey(identity)) {
      return;
    }
    const before = chatScreenStateRef.current.history ?? emptyHistoryState();
    const retryFromStart = reload || before.status === "error";
    const cursor = retryFromStart ? null : before.nextCursor;
    if (before.loadingMore || (!retryFromStart && !cursor)) return;
    const generation = ++historyListGenerationRef.current;
    const epoch = chatEpochRef.current;
    const ownerKey = chatOwnerKey(identity);
    const isActive = () =>
      generation === historyListGenerationRef.current &&
      epoch === chatEpochRef.current &&
      chatOwnerKeyRef.current === ownerKey &&
      currentRouteKeyRef.current === "chat";
    setHistory((history) => ({
      ...history,
      status: retryFromStart ? "loading" : history.status,
      loadingMore: true,
      error: undefined,
    }));
    try {
      const page = await listChatConversations(config, session, cursor, isActive);
      if (!isActive()) return;
      const validation = retryFromStart
        ? await verifyLocalReferences(page, config, session, identity, isActive, true)
        : { inactive: false, additions: [], errors: [] };
      if (validation.inactive || !isActive()) return;
      for (const conversation of page.conversations) {
        serverConfirmedConversationIdsRef.current.add(conversation.conversationId);
      }
      const currentHistory = chatScreenStateRef.current.history ?? before;
      const selectedConversationId = currentHistory.selectedConversationId;
      const selectedConversation = selectedConversationId
        ? currentHistory.conversations.find(
            (conversation) => conversation.conversationId === selectedConversationId,
          )
        : undefined;
      const removalConversation = currentHistory.removal
        ? currentHistory.conversations.find(
            (conversation) =>
              conversation.conversationId === currentHistory.removal?.conversationId,
          )
        : undefined;
      const existing = retryFromStart
        ? [
            ...(selectedConversation ? [selectedConversation] : []),
            ...(removalConversation && removalConversation.conversationId !== selectedConversationId
              ? [removalConversation]
              : []),
          ]
        : currentHistory.conversations;
      const conversations = mergeHistoryConversations(
        localConversationsRef.current,
        [...page.conversations, ...validation.additions],
        existing,
        hiddenConversationIdsRef.current,
      );
      historyListInitializedOwnerRef.current = ownerKey;
      setHistory((history) => ({
        ...history,
        status: validation.errors.length
          ? "error"
          : conversations.length === 0 && !page.nextCursor
            ? "empty"
            : "ready",
        conversations,
        nextCursor: page.nextCursor,
        loadingMore: false,
        error: validation.errors[0],
      }));
    } catch (error) {
      if (!isActive()) return;
      const apiError = asApiError(error);
      if (apiError.status === 401) {
        invalidateChat(config);
        profileUnauthorized();
        return;
      }
      if (apiError.status === 403) {
        invalidateChat(config);
        profileForbidden();
        return;
      }
      setHistory((history) => ({
        ...history,
        status: "error",
        loadingMore: false,
        error: historyErrorMessage(apiError.code, apiError.status),
      }));
    }
  }

  async function loadEarlierTurns() {
    const current = chatScreenStateRef.current;
    const conversationId = current.history?.selectedConversationId;
    const cursor = current.history?.turnsNextCursor;
    const identity = state.view === "ready" ? state.identity : undefined;
    const config = configRef.current;
    const session = sessionRef.current;
    if (!conversationId || !cursor || !identity || !config || !session) return;
    const generation = historySelectionGenerationRef.current;
    const selectionEpoch = chatSelectionEpochRef.current;
    const chatEpoch = chatEpochRef.current;
    const ownerKey = chatOwnerKey(identity);
    const isActive = () =>
      generation === historySelectionGenerationRef.current &&
      selectionEpoch === chatSelectionEpochRef.current &&
      chatEpoch === chatEpochRef.current &&
      chatOwnerKeyRef.current === ownerKey &&
      chatScreenStateRef.current.history?.selectedConversationId === conversationId &&
      !hiddenConversationIdsRef.current.has(conversationId);
    setHistory((history) => ({ ...history, loadingEarlier: true, turnsError: undefined }));
    try {
      const page = await readConversationView(conversationId, cursor, isActive);
      if (!isActive()) return;
      const byOrdinal = new Map(
        [...page.turns, ...(chatScreenStateRef.current.history?.turns || [])].map((turn) => [
          turn.ordinal,
          turn,
        ]),
      );
      const turns = [...byOrdinal.values()].sort((left, right) => left.ordinal - right.ordinal);
      setChat({
        ...chatScreenStateRef.current,
        history: {
          ...chatScreenStateRef.current.history!,
          turns,
          turnsNextCursor: page.nextCursor,
          loadingEarlier: false,
        },
      });
    } catch (error) {
      if (!isActive()) return;
      const apiError = asApiError(error);
      if (apiError.status === 401) {
        invalidateChat(config);
        profileUnauthorized();
        return;
      }
      if (apiError.status === 403) {
        invalidateChat(config);
        profileForbidden();
        return;
      }
      if (apiError.code === "CONVERSATION_HIDDEN") {
        retireHiddenConversation(conversationId, config, identity);
        return;
      }
      setHistory((history) => ({
        ...history,
        loadingEarlier: false,
        turnsError: historyErrorMessage(apiError.code, apiError.status, true),
      }));
    }
  }

  useEffect(() => {
    if (
      route.kind !== "chat" ||
      !authorizedRouteIsCurrent ||
      state.view !== "ready" ||
      !readyIdentity ||
      !apiConfig ||
      !session ||
      chatOwnerKeyRef.current !== chatOwnerKey(readyIdentity)
    ) {
      return;
    }
    const pending = chatPendingConversationOpenRef.current;
    if (!pending) return;
    if (pending.ownerKey !== chatOwnerKey(readyIdentity)) {
      chatPendingConversationOpenRef.current = null;
      return;
    }
    chatPendingConversationOpenRef.current = null;
    void selectConversation(pending.conversationId);
  }, [
    apiConfig,
    authorizedRouteIsCurrent,
    chatScreenState.history?.openingConversationId,
    chatScreenState.history?.selectedConversationId,
    chatScreenState.history?.turnsStatus,
    readyIdentity,
    route.kind,
    session,
    state.view,
  ]);

  useEffect(() => {
    if (
      route.kind !== "chat" ||
      !authorizedRouteIsCurrent ||
      state.view !== "ready" ||
      !readyIdentity ||
      !apiConfig ||
      !session ||
      chatOwnerKeyRef.current !== chatOwnerKey(readyIdentity)
    ) {
      return;
    }
    const identity = { sub: readyIdentity.sub, botId: readyIdentity.botId };
    const ownerKey = chatOwnerKey(identity);
    if (
      chatJournalBootstrapOwnerRef.current !== ownerKey ||
      historyListInitializedOwnerRef.current === ownerKey
    ) {
      return;
    }
    const generation = ++historyListGenerationRef.current;
    const chatEpoch = chatEpochRef.current;
    let active = true;
    const isActive = () =>
      active &&
      generation === historyListGenerationRef.current &&
      chatEpoch === chatEpochRef.current &&
      chatOwnerKeyRef.current === ownerKey &&
      currentRouteKeyRef.current === "chat";
    setHistory((history) => ({
      ...history,
      status: "loading",
      loadingMore: false,
      error: undefined,
    }));

    void listChatConversations(apiConfig, session, null, isActive)
      .then(async (page) => {
        if (!isActive()) return;
        const validation = await verifyLocalReferences(
          page,
          apiConfig,
          session,
          identity,
          isActive,
          true,
        );
        if (validation.inactive || !isActive()) return;
        historyListInitializedOwnerRef.current = ownerKey;
        const serverPage = [...page.conversations, ...validation.additions];
        const conversations = mergeHistoryConversations(
          localConversationsRef.current,
          serverPage,
          [],
          hiddenConversationIdsRef.current,
        );
        setHistory((history) => ({
          ...history,
          status: validation.errors.length
            ? "error"
            : conversations.length === 0 && !page.nextCursor
              ? "empty"
              : "ready",
          conversations,
          nextCursor: page.nextCursor,
          loadingMore: false,
          error: validation.errors[0],
        }));
      })
      .catch((error: unknown) => {
        if (!isActive()) return;
        const apiError = asApiError(error);
        if (apiError.status === 401) {
          invalidateChat(apiConfig);
          profileUnauthorized();
          return;
        }
        if (apiError.status === 403) {
          invalidateChat(apiConfig);
          profileForbidden();
          return;
        }
        historyListInitializedOwnerRef.current = ownerKey;
        const currentHistory = chatScreenStateRef.current.history ?? emptyHistoryState();
        const conversations = mergeHistoryConversations(
          localConversationsRef.current,
          [],
          currentHistory.conversations,
          hiddenConversationIdsRef.current,
        );
        setHistory((history) => ({
          ...history,
          status: "error",
          conversations,
          loadingMore: false,
          error: historyErrorMessage(apiError.code, apiError.status),
        }));
      });

    return () => {
      active = false;
    };
  }, [
    apiConfig,
    authorizedRouteIsCurrent,
    invalidateChat,
    profileForbidden,
    profileUnauthorized,
    readyIdentity,
    route.kind,
    session,
    setChat,
    setHistory,
    state.view,
  ]);

  const historyOwnerKey = readyIdentity ? chatOwnerKey(readyIdentity) : null;
  useEffect(() => {
    if (route.kind !== "chat" || !historyOwnerKey) return;
    return () => {
      historyListGenerationRef.current += 1;
      historySelectionGenerationRef.current += 1;
      const history = chatScreenStateRef.current.history;
      if (history?.openingConversationId) {
        chatPendingConversationOpenRef.current = {
          ownerKey: historyOwnerKey,
          conversationId: history.openingConversationId,
        };
      }
      historyOpeningContextRef.current = null;
      setHistory((history) => {
        const openingConversation = Boolean(
          history.openingConversationId && history.turnsStatus === "loading",
        );
        if (
          !history.loadingMore &&
          history.status !== "loading" &&
          !openingConversation &&
          !history.loadingEarlier
        ) {
          return history;
        }
        const hasKnownHistory = history.conversations.length > 0 || history.nextCursor !== null;
        return {
          ...history,
          status:
            history.status === "loading" ? (hasKnownHistory ? "ready" : "empty") : history.status,
          loadingMore: false,
          loadingEarlier: false,
          ...(openingConversation ? { openingConversationId: undefined } : {}),
        };
      });
    };
  }, [historyOwnerKey, route.kind, setHistory]);

  useEffect(() => {
    if (
      route.kind !== "chat" ||
      !authorizedRouteIsCurrent ||
      state.view !== "ready" ||
      !readyIdentity ||
      !apiConfig ||
      !session ||
      chatOwnerKeyRef.current !== chatOwnerKey(readyIdentity)
    ) {
      return;
    }
    const selectedConversationId = chatScreenState.history?.selectedConversationId;
    if (
      !selectedConversationId ||
      chatScreenState.history?.turnsStatus === "loading" ||
      Boolean(chatScreenState.history?.openingConversationId)
    ) {
      return;
    }
    if (chatRequestRef.current && !chatRequestRef.current.signal.aborted) {
      return;
    }

    const recoveryConfig = apiConfig;
    const recoverySession = session;
    if (!recoveryConfig || !recoverySession) return;

    const identity = { sub: readyIdentity.sub, botId: readyIdentity.botId };
    const identityKey = chatOwnerKey(identity);
    const chatEpoch = chatEpochRef.current;
    const selectionEpoch = chatSelectionEpochRef.current;
    const generation = ++chatRecoveryGenerationRef.current;
    let active = true;
    let failures = 0;
    let currentController: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onOnline: (() => void) | null = null;
    const isActive = () =>
      active &&
      generation === chatRecoveryGenerationRef.current &&
      chatEpochRef.current === chatEpoch &&
      selectionEpoch === chatSelectionEpochRef.current &&
      chatScreenStateRef.current.history?.selectedConversationId === selectedConversationId &&
      chatOwnerKeyRef.current === identityKey &&
      !hiddenConversationIdsRef.current.has(selectedConversationId) &&
      currentRouteKeyRef.current === "chat";
    const clearTimer = () => {
      if (timer !== null) globalThis.clearTimeout(timer);
      if (chatRecoveryTimerRef.current === timer) chatRecoveryTimerRef.current = null;
      timer = null;
    };
    const schedule = (delay: number) => {
      if (!isActive() || timer !== null) return;
      timer = globalThis.setTimeout(() => {
        timer = null;
        if (chatRecoveryTimerRef.current !== null) chatRecoveryTimerRef.current = null;
        void poll();
      }, delay);
      chatRecoveryTimerRef.current = timer;
    };
    const stopCycle = () => {
      if (!active) return;
      active = false;
      clearTimer();
      if (onOnline) window.removeEventListener?.("online", onOnline);
      if (chatRecoveryStopRef.current === stopCycle) chatRecoveryStopRef.current = null;
      if (chatRecoveryGenerationRef.current === generation) chatRecoveryGenerationRef.current += 1;
      currentController?.abort();
      if (chatRecoveryControllerRef.current === currentController)
        chatRecoveryControllerRef.current = null;
    };

    let loadedJournals = new Map<string, ChatJournalEntry>();
    let journalStorageUnavailable = false;
    try {
      loadedJournals = readChatJournals(recoveryConfig, identity);
    } catch {
      journalStorageUnavailable = true;
    }

    for (const [conversationId, entry] of loadedJournals) {
      const previous = chatJournalsRef.current.get(conversationId);
      chatJournalsRef.current.set(
        conversationId,
        previous?.knownNotAdmitted && sameUnadmittedChatRequest(previous, entry)
          ? { ...entry, knownNotAdmitted: true }
          : entry,
      );
    }
    const storedLiveJournal = chatJournalsRef.current.get(selectedConversationId) ?? null;
    const liveJournalOwner = chatJournalOwnerRef.current;
    const liveJournal = isValidMemoryJournalForConversation(
      storedLiveJournal,
      selectedConversationId,
    )
      ? storedLiveJournal
      : null;
    const liveJournalHasCurrentOwner =
      liveJournal !== null &&
      liveJournalOwner !== null &&
      chatOwnerKey(liveJournalOwner.identity) === identityKey &&
      chatOwnerKeyRef.current === identityKey &&
      sameChatJournalScope(liveJournalOwner.config, recoveryConfig);
    const loadedJournal =
      loadedJournals.get(selectedConversationId) ??
      (liveJournalHasCurrentOwner ? liveJournal : null);

    if (journalStorageUnavailable && !loadedJournal) {
      setChat({
        ...chatScreenStateRef.current,
        queryError: "No pudimos leer la referencia de recuperación de esta pestaña.",
      });
      return () => {
        active = false;
        clearTimer();
      };
    }

    chatJournalOwnerRef.current = { config: recoveryConfig, identity };
    chatJournalRef.current = loadedJournal;
    if (!loadedJournal) {
      chatConversationIdRef.current = selectedConversationId;
      return () => {
        active = false;
        clearTimer();
      };
    }

    const journal = loadedJournal;
    const request = journal.request;
    const pendingText = journal.admitted ? undefined : journal.request.text;
    chatConversationIdRef.current = request.conversationId;
    const current = chatScreenStateRef.current;
    const newerRejectedQueryAlreadyVisible =
      liveJournalHasCurrentOwner &&
      liveJournal?.admitted === true &&
      liveJournal.request.queryId === request.queryId &&
      liveJournal.request.conversationId === request.conversationId &&
      journal.admitted &&
      current.queryStatus === "rejected" &&
      current.ordinal === journal.ordinal &&
      Boolean(current.history?.turns.length) &&
      Boolean(chatDisplayedQueryIdRef.current) &&
      chatDisplayedQueryIdRef.current !== request.queryId;
    const terminalAlreadyVisible =
      chatDisplayedQueryIdRef.current === request.queryId &&
      (current.queryStatus === "completed" || current.queryStatus === "failed");
    if (terminalAlreadyVisible || newerRejectedQueryAlreadyVisible) {
      return () => {
        active = false;
        clearTimer();
      };
    }

    chatDisplayedQueryIdRef.current = request.queryId;
    setChat({
      ...current,
      queryId: request.queryId,
      queryStatus: journal.admitted ? "streaming" : "unconfirmed",
      question: journal.admitted ? current.question : pendingText,
      answer: journal.admitted ? current.answer || "" : "",
      canContinue: journal.admitted ? current.canContinue : false,
      canRetry: !journal.admitted,
      recovered: false,
      recoveryLoading: true,
      queryError: undefined,
    });

    const applySnapshot = async (
      snapshot: Extract<Awaited<ReturnType<typeof recoverChat>>, { version: 2 }>,
    ) => {
      const isCurrentSelection = () =>
        isActive() &&
        chatScreenStateRef.current.history?.selectedConversationId === request.conversationId &&
        chatJournalRef.current?.request.queryId === request.queryId;
      if (!isCurrentSelection()) return;
      const isTerminal = snapshot.status === "completed" || snapshot.status === "failed";
      if (!hiddenConversationIdsRef.current.has(request.conversationId)) {
        serverConfirmedConversationIdsRef.current.add(request.conversationId);
      }
      const reference = {
        version: 2 as const,
        operation: request.operation,
        conversationId: request.conversationId,
        queryId: request.queryId,
        baseOrdinal: request.baseOrdinal,
      };
      try {
        markChatJournalAdmitted(recoveryConfig, identity, reference, snapshot.ordinal);
      } catch {
        // The snapshot confirms admission; the helper removes plaintext on storage failure.
      }
      const admittedJournal: ChatJournalEntry = {
        request: reference,
        admitted: true,
        ordinal: snapshot.ordinal,
      };
      chatJournalsRef.current.set(request.conversationId, admittedJournal);
      chatJournalRef.current = admittedJournal;
      chatConversationIdRef.current = snapshot.conversationId;

      const reconciliation = await reconcileConversationSnapshot(
        snapshot,
        request,
        recoveryConfig,
        isCurrentSelection,
      );
      if (reconciliation.kind === "inactive") return;
      if (reconciliation.kind === "unauthorized") {
        invalidateChat(recoveryConfig);
        if (reconciliation.status === 401) profileUnauthorized();
        else profileForbidden();
        return;
      }
      if (reconciliation.kind === "needs-reload" && !reconciliation.history) {
        stopCycle();
        clearSupersededJournal(request.conversationId, snapshot.queryId, recoveryConfig, identity);
        await selectConversation(request.conversationId);
        return;
      }
      if (!isCurrentSelection()) return;

      const terminalHistory = reconciliation.history;
      const terminalHistoryError = reconciliation.historyError;
      if (!isCurrentSelection()) return;
      const before = chatScreenStateRef.current;
      if (isTerminal) {
        clearChatJournalEntry(recoveryConfig, identity, request.conversationId);
        chatJournalsRef.current.delete(request.conversationId);
        chatJournalRef.current = null;
      }
      if (
        (before.queryStatus === "completed" || before.queryStatus === "failed") &&
        chatDisplayedQueryIdRef.current === snapshot.queryId &&
        !isTerminal
      ) {
        return;
      }
      chatDisplayedQueryIdRef.current = snapshot.queryId;
      const canContinue = reconciliation.canContinue;
      const nextState: ChatScreenState = {
        ...before,
        queryId: snapshot.queryId,
        question: snapshot.question,
        answer: snapshot.answer,
        answerComplete: true,
        ordinal: snapshot.ordinal,
        canContinue,
        quota: snapshot.quota,
        quotaReceivedAt: snapshot.quota ? performance.now() : undefined,
        queryStatus: snapshot.status === "in_progress" ? "streaming" : snapshot.status,
        queryError: undefined,
        recovered: true,
        recoveryLoading: false,
        canRetry: false,
        ...(before.history?.selectedConversationId === request.conversationId &&
        (terminalHistory || terminalHistoryError)
          ? {
              history: {
                ...before.history,
                ...(terminalHistory
                  ? {
                      closed: terminalHistory.closed,
                      canContinue: terminalHistory.canContinue,
                      throughOrdinal: terminalHistory.throughOrdinal,
                      turns: terminalHistory.turns,
                      turnsNextCursor: terminalHistory.nextCursor,
                      turnsStatus: "ready" as const,
                      turnsError: undefined,
                    }
                  : {}),
                ...(terminalHistoryError ? { turnsError: terminalHistoryError } : {}),
              },
            }
          : {}),
      };
      setChat(
        reconciliation.kind === "needs-reload"
          ? nextState
          : withHistoryTurn(nextState, request.conversationId, {
              ordinal: snapshot.ordinal,
              queryId: snapshot.queryId,
              status: snapshot.status,
              question: snapshot.question,
              answer: snapshot.answer,
              questionComplete: true,
              answerComplete: snapshot.status !== "in_progress",
              canContinue,
            }),
      );
      if (reconciliation.kind === "needs-reload" && terminalHistory) {
        ensureConversationVisibleFromHistory(terminalHistory);
      } else if (isTerminal) {
        if (terminalHistory) {
          markLocalConversationTerminal(
            request.conversationId,
            terminalHistory.throughOrdinal,
            terminalHistory.closed,
            terminalHistory.turns.at(-1)?.queryId,
          );
        } else if (snapshot.canContinue) {
          markLocalConversationTerminal(
            request.conversationId,
            snapshot.ordinal,
            false,
            snapshot.queryId,
          );
        } else if (terminalHistoryError) {
          const existing =
            localConversationsRef.current.get(request.conversationId) ??
            chatScreenStateRef.current.history?.conversations.find(
              (conversation) => conversation.conversationId === request.conversationId,
            );
          if (existing?.activeQueryId === snapshot.queryId) {
            markLocalConversationTerminal(
              request.conversationId,
              snapshot.ordinal,
              existing.closed,
              snapshot.queryId,
            );
          }
        }
      } else {
        updateLocalConversation(
          request.conversationId,
          snapshot.question,
          snapshot.ordinal,
          snapshot.queryId,
          false,
          { recordActivity: false },
        );
      }
      if (reconciliation.kind === "needs-reload") {
        stopCycle();
        await selectConversation(request.conversationId);
      }
    };

    async function poll() {
      if (!isActive() || currentController) return;
      const controller = new AbortController();
      currentController = controller;
      chatRecoveryControllerRef.current = controller;
      try {
        const result = await recoverChat(
          recoveryConfig,
          recoverySession,
          {
            version: 2,
            operation: "recover",
            conversationId: request.conversationId,
            queryId: request.queryId,
          },
          { isActive, signal: controller.signal },
        );
        // The request has already settled. Leave its signal untouched when a terminal
        // snapshot stops the observer; abort only requests that are still in flight.
        if (currentController === controller) currentController = null;
        if (chatRecoveryControllerRef.current === controller)
          chatRecoveryControllerRef.current = null;
        if (!isActive() || chatJournalRef.current?.request.queryId !== request.queryId) return;
        if ("version" in result) {
          failures = 0;
          await applySnapshot(result);
          if (result.status === "in_progress") schedule(1_000);
          else stopCycle();
          return;
        }

        const failureCode = result.code.toLowerCase();
        if (failureCode === "access_denied") {
          invalidateChat();
          profileForbidden();
          return;
        }
        if (failureCode === "unauthorized") {
          invalidateChat();
          profileUnauthorized();
          return;
        }
        if (failureCode === "conversation_hidden") {
          retireHiddenConversation(request.conversationId, recoveryConfig, identity);
          stopCycle();
          return;
        }

        if (
          result.code === "conversation_unavailable" &&
          result.recordStatus === "not_admitted" &&
          !journal.admitted
        ) {
          setChat({
            ...chatScreenStateRef.current,
            queryStatus: "unconfirmed",
            question: pendingText,
            answer: "",
            recovered: false,
            recoveryLoading: false,
            canRetry: true,
            queryError:
              "No pudimos confirmar si se admitió el envío. Todavía no encontramos una referencia; podés reintentar el mismo pedido.",
          });
          stopCycle();
          return;
        }

        if (result.recordStatus === "failed") {
          if (
            conversationSnapshotIsSuperseded(
              request.conversationId,
              result.queryId ?? request.queryId,
              request.baseOrdinal + 1,
              "failed",
              result.canContinue ?? false,
            )
          ) {
            stopCycle();
            void selectConversation(request.conversationId);
            return;
          }
          serverConfirmedConversationIdsRef.current.add(request.conversationId);
          const reference = {
            version: 2 as const,
            operation: request.operation,
            conversationId: request.conversationId,
            queryId: request.queryId,
            baseOrdinal: request.baseOrdinal,
          };
          try {
            markChatJournalAdmitted(recoveryConfig, identity, reference, request.baseOrdinal + 1);
          } catch {
            // The failure response is still displayed; plaintext removal is attempted by the helper.
          }
          chatJournalRef.current = {
            request: reference,
            admitted: true,
            ordinal: request.baseOrdinal + 1,
          };
          chatJournalsRef.current.set(request.conversationId, chatJournalRef.current);
          clearChatJournalEntry(recoveryConfig, identity, request.conversationId);
          chatJournalsRef.current.delete(request.conversationId);
          chatJournalRef.current = null;
          const existingTurn = chatScreenStateRef.current.history?.turns.find(
            (turn) => turn.queryId === request.queryId,
          );
          const nextState: ChatScreenState = {
            ...chatScreenStateRef.current,
            queryId: request.queryId,
            question: journal.admitted ? chatScreenStateRef.current.question : pendingText,
            queryStatus: "failed",
            canContinue: result.canContinue ?? false,
            canRetry: false,
            recovered: true,
            recoveryLoading: false,
            queryError: result.message,
          };
          setChat(
            existingTurn
              ? withHistoryTurn(nextState, request.conversationId, {
                  ...existingTurn,
                  status: "failed",
                  canContinue: result.canContinue ?? false,
                  failure: { code: result.code, message: result.message },
                })
              : nextState,
          );
          markLocalConversationTerminal(
            request.conversationId,
            request.baseOrdinal + 1,
            result.canContinue === false,
            request.queryId,
          );
          stopCycle();
          return;
        }

        setChat({
          ...chatScreenStateRef.current,
          queryId: request.queryId,
          queryStatus: journal.admitted ? "streaming" : "unconfirmed",
          recoveryLoading: false,
          canRetry: false,
          queryError: result.message,
        });
        failures += 1;
        schedule(Math.min(1_000 * 2 ** Math.min(failures - 1, 5), 30_000));
      } catch (error) {
        if (!isActive()) return;
        const apiError = asApiError(error);
        if (apiError.status === 401) {
          invalidateChat();
          profileUnauthorized();
          return;
        }
        if (apiError.status === 403) {
          invalidateChat();
          profileForbidden();
          return;
        }
        failures += 1;
        const currentJournal = chatJournalRef.current;
        const admitted =
          currentJournal?.request.queryId === request.queryId
            ? currentJournal.admitted
            : journal.admitted;
        setChat({
          ...chatScreenStateRef.current,
          queryId: request.queryId,
          queryStatus: admitted ? "streaming" : "unconfirmed",
          recoveryLoading: false,
          canRetry: !admitted,
          queryError: "No pudimos actualizar el estado. Vamos a volver a consultarlo.",
        });
        schedule(Math.min(1_000 * 2 ** Math.min(failures - 1, 5), 30_000));
      } finally {
        if (currentController === controller) currentController = null;
        if (chatRecoveryControllerRef.current === controller)
          chatRecoveryControllerRef.current = null;
      }
    }

    onOnline = () => {
      clearTimer();
      void poll();
    };
    chatRecoveryStopRef.current = stopCycle;
    window.addEventListener?.("online", onOnline);
    void poll();

    return () => {
      stopCycle();
    };
  }, [
    apiConfig,
    authorizedRouteIsCurrent,
    invalidateChat,
    profileForbidden,
    profileUnauthorized,
    readyIdentity,
    route.kind,
    session,
    setChat,
    chatRecoveryRevision,
    chatScreenState.history?.openingConversationId,
    chatScreenState.history?.selectedConversationId,
    chatScreenState.history?.turnsStatus,
    state.view,
  ]);

  function updateLocalConversation(
    conversationId: string,
    question: string,
    ordinal: number,
    activeQueryId: string | null,
    closed = false,
    { recordActivity = true }: { recordActivity?: boolean } = {},
  ) {
    if (hiddenConversationIdsRef.current.has(conversationId)) return;
    const current = chatScreenStateRef.current.history ?? emptyHistoryState();
    const prior =
      localConversationsRef.current.get(conversationId) ??
      current.conversations.find((conversation) => conversation.conversationId === conversationId);
    const label =
      prior?.label || question.trim().replace(/\s+/g, " ").slice(0, 120) || "Nueva conversación";
    const activityAt = recordActivity ? new Date().toISOString() : undefined;
    const summary = {
      ...(prior?.createdAt
        ? { createdAt: prior.createdAt }
        : activityAt
          ? { createdAt: activityAt }
          : {}),
      conversationId,
      label,
      ...(activityAt
        ? { updatedAt: activityAt }
        : prior?.updatedAt
          ? { updatedAt: prior.updatedAt }
          : {}),
      lastOrdinal: Math.max(prior?.lastOrdinal ?? 0, ordinal),
      closed,
      ...(chatDraftsRef.current.get(conversationId) ? { hasDraft: true } : { hasDraft: undefined }),
      ...(activeQueryId ? { activeQueryId } : {}),
    };
    localConversationsRef.current.set(conversationId, summary);
    const remaining = current.conversations.filter(
      (conversation) => conversation.conversationId !== conversationId,
    );
    setHistory((history) => ({
      ...history,
      status: "ready",
      conversations: recordActivity
        ? [summary, ...remaining]
        : mergeHistoryConversations(
            localConversationsRef.current,
            [],
            history.conversations,
            hiddenConversationIdsRef.current,
          ),
      error: undefined,
    }));
  }

  function rememberJournalConversations(journals: Map<string, ChatJournalEntry>) {
    for (const [conversationId, entry] of journals) {
      if (hiddenConversationIdsRef.current.has(conversationId)) continue;
      if (localConversationsRef.current.has(conversationId)) continue;
      localConversationsRef.current.set(
        conversationId,
        entry.admitted
          ? {
              conversationId,
              label: "Conversación en curso",
              lastOrdinal: entry.ordinal,
              closed: false,
              activeQueryId: entry.request.queryId,
            }
          : {
              conversationId,
              label: pendingConversationLabel(entry.request),
              lastOrdinal: entry.request.baseOrdinal,
              closed: false,
              pending: true,
            },
      );
    }
  }

  function updatePendingConversation(request: ChatRequest) {
    if (hiddenConversationIdsRef.current.has(request.conversationId)) return;
    const current = chatScreenStateRef.current.history ?? emptyHistoryState();
    const prior =
      localConversationsRef.current.get(request.conversationId) ??
      current.conversations.find(
        (conversation) => conversation.conversationId === request.conversationId,
      );
    if (prior) {
      localConversationsRef.current.set(request.conversationId, prior);
      return;
    }
    const label = pendingConversationLabel(request);
    const summary = {
      createdAt: new Date().toISOString(),
      conversationId: request.conversationId,
      label,
      updatedAt: new Date().toISOString(),
      lastOrdinal: request.baseOrdinal,
      closed: false,
      pending: true,
    };
    localConversationsRef.current.set(request.conversationId, summary);
    setHistory((history) => ({
      ...history,
      status: "ready",
      conversations: [
        summary,
        ...history.conversations.filter(
          (conversation) => conversation.conversationId !== request.conversationId,
        ),
      ],
      error: undefined,
    }));
  }

  function ensureConversationVisibleFromHistory(
    view: Awaited<ReturnType<typeof readConversationView>>,
  ) {
    if (hiddenConversationIdsRef.current.has(view.conversationId)) return;
    const current = chatScreenStateRef.current.history ?? emptyHistoryState();
    const existing =
      localConversationsRef.current.get(view.conversationId) ??
      current.conversations.find(
        (conversation) => conversation.conversationId === view.conversationId,
      );
    const last = view.turns.at(-1);
    const pendingUnconfirmable =
      !view.closed && last?.status === "in_progress" && last.failure?.code === "unconfirmable";
    const conversation = {
      ...existing,
      conversationId: view.conversationId,
      label: view.label ?? existing?.label ?? "Conversación seleccionada",
      ...(view.createdAt ? { createdAt: view.createdAt } : {}),
      ...(view.updatedAt ? { updatedAt: view.updatedAt } : {}),
      lastOrdinal: view.throughOrdinal,
      closed: view.closed,
      ...(pendingUnconfirmable ? { durable: true } : {}),
      ...(chatDraftsRef.current.get(view.conversationId)
        ? { hasDraft: true }
        : { hasDraft: undefined }),
      activeQueryId:
        last?.status === "in_progress" && last.failure?.code !== "unconfirmable"
          ? last.queryId
          : undefined,
      pending: pendingUnconfirmable || undefined,
    };
    localConversationsRef.current.set(view.conversationId, conversation);
    setHistory((history) => ({
      ...history,
      conversations: mergeHistoryConversations(
        localConversationsRef.current,
        [],
        history.conversations,
        hiddenConversationIdsRef.current,
      ),
    }));
  }

  function markLocalConversationTerminal(
    conversationId: string,
    ordinal: number,
    closed: boolean,
    queryId?: string,
  ) {
    if (hiddenConversationIdsRef.current.has(conversationId)) return;
    const existing = getObservedConversationSummary(conversationId);
    if (!existing) return;
    if (
      conversationSnapshotIsSuperseded(
        conversationId,
        queryId ?? "",
        ordinal,
        closed ? "failed" : "completed",
        !closed,
      )
    ) {
      return;
    }
    const summary = {
      ...existing,
      lastOrdinal: Math.max(existing.lastOrdinal, ordinal),
      closed,
      activeQueryId: undefined,
      pending: undefined,
    };
    localConversationsRef.current.set(conversationId, summary);
    setHistory((current) => ({
      ...current,
      conversations: current.conversations.map((conversation) =>
        conversation.conversationId === conversationId ? summary : conversation,
      ),
    }));
  }

  function hideConversation(conversationId: string): Promise<boolean> {
    const identity = state.view === "ready" ? state.identity : undefined;
    const config = configRef.current;
    const activeSession = sessionRef.current;
    const ownerKey = identity ? chatOwnerKey(identity) : null;
    if (
      !identity ||
      !config ||
      !activeSession ||
      !ownerKey ||
      chatOwnerKeyRef.current !== ownerKey ||
      !uuidPatternForHistory(conversationId)
    ) {
      return Promise.resolve(false);
    }
    if (hiddenConversationIdsRef.current.has(conversationId)) return Promise.resolve(true);
    const currentHistory = chatScreenStateRef.current.history ?? emptyHistoryState();
    const row = currentHistory.conversations.find(
      (conversation) => conversation.conversationId === conversationId,
    );
    if (!row || (row.pending && !row.durable)) return Promise.resolve(false);

    const currentOperation = hideOperationRef.current;
    if (currentOperation) return Promise.resolve(false);
    const currentRemoval = currentHistory.removal;
    if (currentRemoval && currentRemoval.conversationId !== conversationId)
      return Promise.resolve(false);

    let complete!: (confirmed: boolean) => void;
    const completion = new Promise<boolean>((resolve) => {
      complete = resolve;
    });

    const generation = ++hideOperationGenerationRef.current;
    const operation = { conversationId, ownerKey, generation, complete };
    hideOperationRef.current = operation;
    setHistory((history) => ({
      ...history,
      removal: { conversationId, status: "hiding" },
    }));
    const isActive = () =>
      hideOperationRef.current === operation &&
      hideOperationRef.current.generation === generation &&
      chatOwnerKeyRef.current === ownerKey;

    void hideChatConversation(config, activeSession, conversationId, isActive).then(
      () => {
        if (!isActive()) return;
        retireHiddenConversation(conversationId, config, identity);
      },
      (error) => {
        if (!isActive()) return;
        const apiError = asApiError(error);
        if (apiError.status === 401) {
          invalidateChat(config);
          profileUnauthorized();
          return;
        }
        if (apiError.status === 403) {
          invalidateChat(config);
          profileForbidden();
          return;
        }
        if (apiError.code === "CONVERSATION_HIDDEN") {
          retireHiddenConversation(conversationId, config, identity);
          return;
        }
        setHistory((history) => ({
          ...history,
          removal: {
            conversationId,
            status: "unconfirmed",
            error:
              "No pudimos confirmar si se quitó la conversación. Sigue en tu historial hasta resolverlo; podés reintentar de forma segura.",
          },
        }));
        settleHideOperation(operation, false);
      },
    );
    return completion;
  }

  function submitChat(text: string): boolean {
    const identity = state.view === "ready" ? state.identity : undefined;
    const current = chatScreenStateRef.current;
    const ownerKey = identity ? chatOwnerKey(identity) : null;
    const selectedConversationId = current.history?.selectedConversationId ?? null;
    const previousJournal = selectedConversationId
      ? (chatJournalsRef.current.get(selectedConversationId) ?? chatJournalRef.current)
      : chatJournalRef.current;
    const pendingRequestMatches =
      previousJournal !== null &&
      !previousJournal.admitted &&
      previousJournal.request.text === text;
    const retryingUnconfirmed = pendingRequestMatches && current.queryStatus === "unconfirmed";
    const retryingPreAdmissionFailure =
      pendingRequestMatches &&
      current.queryStatus === "rejected" &&
      current.canRetry === true &&
      ["token_count_unavailable", "documents_unavailable", "context_unavailable"].includes(
        current.queryErrorCode?.toLowerCase() || "",
      );
    const retrying = retryingUnconfirmed || retryingPreAdmissionFailure;
    const canStartNewRequest =
      current.queryStatus === "idle" ||
      ((current.queryStatus === "completed" || current.queryStatus === "failed") &&
        current.canContinue !== false) ||
      (current.queryStatus === "rejected" && Boolean(current.quota)) ||
      (current.queryStatus === "rejected" &&
        current.queryErrorCode === "storage_capacity_exceeded");
    const hasUsableContinuationBase =
      current.canContinue === true &&
      typeof current.ordinal === "number" &&
      Number.isSafeInteger(current.ordinal) &&
      current.ordinal > 0;
    if (
      !identity ||
      !ownerKey ||
      !apiConfig ||
      !session ||
      chatOwnerKeyRef.current !== ownerKey ||
      (current.profileStatus !== "complete" && !retrying) ||
      Boolean(
        selectedConversationId &&
        (hiddenConversationIdsRef.current.has(selectedConversationId) ||
          current.history?.removal?.conversationId === selectedConversationId),
      ) ||
      current.history?.turnsStatus === "loading" ||
      (current.history?.turnsStatus === "error" && !retrying && !hasUsableContinuationBase) ||
      Boolean(current.history?.openingConversationId) ||
      (!retrying && !canStartNewRequest) ||
      (previousJournal && !previousJournal.admitted && !retrying) ||
      chatSubmissionInFlightRef.current ||
      (selectedConversationId && current.canContinue === false && !retrying) ||
      !text.trim()
    ) {
      return false;
    }

    const request: ChatRequest = retrying
      ? previousJournal.request
      : {
          version: 2,
          operation: selectedConversationId ? "message" : "start",
          conversationId: selectedConversationId || window.crypto.randomUUID(),
          queryId: window.crypto.randomUUID(),
          baseOrdinal: selectedConversationId
            ? (current.ordinal ??
              current.history?.throughOrdinal ??
              current.history?.turns.at(-1)?.ordinal ??
              0)
            : 0,
          text,
        };
    const { operation, conversationId, queryId, baseOrdinal } = request;
    const withSubmissionTurn = (
      currentState: ChatScreenState,
      overrides: Partial<ChatHistoryTurn>,
    ) =>
      withHistoryTurn(
        currentState,
        conversationId,
        submissionHistoryTurn(currentState, request, overrides),
      );
    try {
      writePendingChatJournal(apiConfig, identity, request);
    } catch {
      setChat({
        ...current,
        queryError: "No pudimos guardar temporalmente la consulta; no se envió al asistente.",
      });
      return false;
    }
    stopChatRecovery();
    const pendingJournal: TrackedChatJournalEntry = { request, admitted: false };
    chatJournalsRef.current.set(conversationId, pendingJournal);
    chatJournalRef.current = pendingJournal;
    chatJournalOwnerRef.current = { config: apiConfig, identity };
    chatDisplayedQueryIdRef.current = queryId;
    chatConversationIdRef.current = conversationId;
    const controller = new AbortController();
    const chatEpoch = chatEpochRef.current;
    const selectionEpoch = chatSelectionEpochRef.current;
    const isActive = () =>
      chatEpochRef.current === chatEpoch &&
      chatSelectionEpochRef.current === selectionEpoch &&
      chatScreenStateRef.current.history?.selectedConversationId === conversationId &&
      chatOwnerKeyRef.current === ownerKey &&
      !hiddenConversationIdsRef.current.has(conversationId) &&
      chatRequestRef.current === controller &&
      !controller.signal.aborted;
    chatSubmissionInFlightRef.current = true;
    chatRequestRef.current = controller;
    chatDraftsRef.current.set(conversationId, text);
    setChat({
      profileStatus: current.profileStatus,
      draft: text,
      queryId,
      queryStatus: "sending",
      question: text,
      answer: "",
      ordinal: current.ordinal,
      quota: undefined,
      quotaReceivedAt: undefined,
      queryError: undefined,
      queryErrorCode: undefined,
      recovered: false,
      recoveryLoading: false,
      canRetry: false,
      history: {
        ...(current.history ?? emptyHistoryState()),
        selectedConversationId: conversationId,
        turnsStatus: current.history?.turnsStatus ?? "idle",
        refreshRequired: false,
      },
    });
    updatePendingConversation(request);

    void streamChat(apiConfig, session, request, {
      signal: controller.signal,
      isActive,
      onEvent: (event) => {
        if (!isActive()) return;
        if (event.type === "failed" && event.code.toLowerCase() === "conversation_hidden") {
          retireHiddenConversation(conversationId, apiConfig, identity);
          return;
        }
        if (
          (event.type === "completed" &&
            conversationSnapshotIsSuperseded(
              conversationId,
              queryId,
              baseOrdinal + 1,
              "completed",
              true,
            )) ||
          (event.type === "failed" &&
            event.recordStatus === "failed" &&
            conversationSnapshotIsSuperseded(
              conversationId,
              event.queryId ?? queryId,
              baseOrdinal + 1,
              "failed",
              event.canContinue ?? false,
            ))
        ) {
          void selectConversation(conversationId);
          return;
        }
        const before = chatScreenStateRef.current;
        if (event.type === "accepted") {
          serverConfirmedConversationIdsRef.current.add(conversationId);
          const admittedRequest = {
            version: 2 as const,
            operation,
            conversationId,
            queryId,
            baseOrdinal,
          };
          try {
            markChatJournalAdmitted(apiConfig, identity, admittedRequest, event.ordinal);
          } catch {
            // The in-memory result remains usable; the helper removes plaintext on failure.
          }
          const admittedJournal: ChatJournalEntry = {
            request: admittedRequest,
            admitted: true,
            ordinal: event.ordinal,
          };
          chatJournalsRef.current.set(conversationId, admittedJournal);
          chatJournalRef.current = admittedJournal;
          chatDraftsRef.current.set(conversationId, "");
          try {
            writeChatSelection(apiConfig, identity, conversationId);
          } catch {
            // Selection is page-local while the current session remains open.
          }
          const nextState: ChatScreenState = {
            ...before,
            queryId,
            queryStatus: "streaming",
            draft: "",
            answerComplete: false,
            ordinal: event.ordinal,
            queryErrorCode: undefined,
            history: {
              ...(before.history ?? emptyHistoryState()),
              selectedConversationId: conversationId,
              throughOrdinal: event.ordinal,
            },
          };
          setChat(
            withSubmissionTurn(nextState, {
              ordinal: event.ordinal,
              status: "in_progress",
              question: text,
              answer: "",
              questionComplete: true,
              answerComplete: false,
              canContinue: false,
              failure: undefined,
            }),
          );
          updateLocalConversation(conversationId, text, event.ordinal, queryId);
        } else if (event.type === "text") {
          const answer = (before.answer || "") + event.text;
          const nextState: ChatScreenState = {
            ...before,
            queryId,
            queryStatus: "streaming",
            answer,
            answerComplete: false,
            queryErrorCode: undefined,
          };
          setChat(
            withSubmissionTurn(nextState, {
              status: "in_progress",
              question: text,
              answer,
              questionComplete: true,
              answerComplete: false,
              canContinue: false,
              failure: undefined,
            }),
          );
        } else if (event.type === "completed") {
          clearChatJournalEntry(apiConfig, identity, conversationId);
          chatJournalsRef.current.delete(conversationId);
          chatJournalRef.current = null;
          updateLocalConversation(conversationId, text, baseOrdinal + 1, null);
          const nextState: ChatScreenState = {
            ...before,
            queryId,
            queryStatus: "completed",
            answerComplete: true,
            canContinue: true,
            queryError: undefined,
            queryErrorCode: undefined,
          };
          setChat(
            withSubmissionTurn(nextState, {
              status: "completed",
              question: text,
              answer: before.answer || "",
              questionComplete: true,
              answerComplete: true,
              canContinue: true,
              failure: undefined,
            }),
          );
          markLocalConversationTerminal(conversationId, baseOrdinal + 1, false, queryId);
        }
      },
    })
      .then(async (result) => {
        if (!isActive()) return;
        if (
          "code" in result &&
          "status" in result &&
          result.status === "failed" &&
          result.code.toLowerCase() === "conversation_hidden"
        ) {
          retireHiddenConversation(conversationId, apiConfig, identity);
          return;
        }
        if (
          !("version" in result) &&
          (result.status === "completed" ||
            (result.status === "failed" && result.recordStatus === "failed"))
        ) {
          const ordinal = result.status === "completed" ? result.ordinal : baseOrdinal + 1;
          const terminalQueryId = result.queryId ?? queryId;
          const canContinue = result.status === "completed" ? true : (result.canContinue ?? false);
          if (
            conversationSnapshotIsSuperseded(
              conversationId,
              terminalQueryId,
              ordinal,
              result.status,
              canContinue,
            )
          ) {
            void selectConversation(conversationId);
            return;
          }
        }
        const before = chatScreenStateRef.current;
        if ("version" in result) {
          const admittedRequest = {
            version: 2 as const,
            operation,
            conversationId,
            queryId,
            baseOrdinal,
          };
          const terminal = result.status === "completed" || result.status === "failed";
          const isCurrentSelection = () =>
            isActive() &&
            chatScreenStateRef.current.history?.selectedConversationId === conversationId &&
            chatDisplayedQueryIdRef.current === queryId;
          serverConfirmedConversationIdsRef.current.add(conversationId);
          try {
            markChatJournalAdmitted(apiConfig, identity, admittedRequest, result.ordinal);
          } catch {
            // The in-memory result remains usable; the helper removes plaintext on failure.
          }
          const admittedJournal: ChatJournalEntry = {
            request: admittedRequest,
            admitted: true,
            ordinal: result.ordinal,
          };
          chatJournalsRef.current.set(conversationId, admittedJournal);
          chatJournalRef.current = admittedJournal;
          if (terminal) {
            clearChatJournalEntry(apiConfig, identity, conversationId);
            chatJournalsRef.current.delete(conversationId);
            chatJournalRef.current = null;
          }
          const reconciliation = await reconcileConversationSnapshot(
            result,
            admittedRequest,
            apiConfig,
            isCurrentSelection,
          );
          if (reconciliation.kind === "inactive") return;
          if (reconciliation.kind === "unauthorized") {
            invalidateChat(apiConfig);
            if (reconciliation.status === 401) profileUnauthorized();
            else profileForbidden();
            return;
          }
          if (reconciliation.kind === "needs-reload" && !reconciliation.history) {
            clearSupersededJournal(conversationId, result.queryId, apiConfig, identity);
            await selectConversation(conversationId);
            return;
          }
          if (!isCurrentSelection()) return;

          const current = chatScreenStateRef.current;
          const canContinue = reconciliation.canContinue;
          const history = current.history ?? emptyHistoryState();
          const reconciledHistory = reconciliation.history
            ? {
                ...history,
                closed: reconciliation.history.closed,
                canContinue: reconciliation.history.canContinue,
                throughOrdinal: reconciliation.history.throughOrdinal,
                turns: reconciliation.history.turns,
                turnsNextCursor: reconciliation.history.nextCursor,
                turnsStatus: "ready" as const,
                turnsError: undefined,
              }
            : reconciliation.historyError
              ? {
                  ...history,
                  throughOrdinal: Math.max(history.throughOrdinal ?? 0, result.ordinal),
                  turnsError: reconciliation.historyError,
                }
              : terminal
                ? {
                    ...history,
                    closed: false,
                    canContinue: true,
                    throughOrdinal: Math.max(history.throughOrdinal ?? 0, result.ordinal),
                    turnsError: undefined,
                  }
                : {
                    ...history,
                    throughOrdinal: Math.max(history.throughOrdinal ?? 0, result.ordinal),
                  };
          chatDraftsRef.current.set(conversationId, "");
          const nextState: ChatScreenState = {
            ...current,
            queryId,
            question: result.question,
            answer: result.answer,
            draft: "",
            answerComplete: true,
            ordinal: result.ordinal,
            canContinue,
            quota: result.quota,
            quotaReceivedAt: result.quota ? performance.now() : undefined,
            queryStatus: result.status === "in_progress" ? "streaming" : result.status,
            queryError: undefined,
            queryErrorCode: undefined,
            recovered: retrying,
            recoveryLoading: false,
            canRetry: false,
            history: {
              ...reconciledHistory,
              selectedConversationId: conversationId,
            },
          };
          setChat(
            reconciliation.kind === "needs-reload"
              ? nextState
              : withSubmissionTurn(nextState, {
                  ordinal: result.ordinal,
                  status: result.status,
                  question: result.question,
                  answer: result.answer,
                  questionComplete: true,
                  answerComplete: result.status !== "in_progress",
                  canContinue,
                  failure: undefined,
                }),
          );
          if (reconciliation.kind === "needs-reload" && reconciliation.history) {
            ensureConversationVisibleFromHistory(reconciliation.history);
          } else if (terminal && reconciliation.history) {
            markLocalConversationTerminal(
              conversationId,
              reconciliation.history.throughOrdinal,
              reconciliation.history.closed,
              result.queryId,
            );
          } else if (terminal && result.canContinue) {
            markLocalConversationTerminal(conversationId, result.ordinal, false, result.queryId);
          } else if (terminal && reconciliation.historyError) {
            const existing =
              localConversationsRef.current.get(conversationId) ??
              current.history?.conversations.find(
                (conversation) => conversation.conversationId === conversationId,
              );
            updateLocalConversation(conversationId, text, result.ordinal, null, existing?.closed);
          } else {
            updateLocalConversation(
              conversationId,
              text,
              result.ordinal,
              result.status === "in_progress" ? result.queryId : null,
              false,
              { recordActivity: false },
            );
          }
          if (reconciliation.kind === "needs-reload") {
            await selectConversation(conversationId);
          }
          return;
        }
        if (result.status === "completed") {
          const admittedRequest = {
            version: 2 as const,
            operation,
            conversationId,
            queryId,
            baseOrdinal,
          };
          try {
            markChatJournalAdmitted(apiConfig, identity, admittedRequest, result.ordinal);
          } catch {
            // The in-memory result remains usable; the helper removes plaintext on failure.
          }
          const admittedJournal: ChatJournalEntry = {
            request: admittedRequest,
            admitted: true,
            ordinal: result.ordinal,
          };
          chatJournalsRef.current.set(conversationId, admittedJournal);
          clearChatJournalEntry(apiConfig, identity, conversationId);
          chatJournalsRef.current.delete(conversationId);
          chatJournalRef.current = null;
          chatDraftsRef.current.set(conversationId, "");
          const nextState: ChatScreenState = {
            ...before,
            queryId,
            queryStatus: "completed",
            draft: "",
            answerComplete: true,
            ordinal: result.ordinal,
            canContinue: true,
            queryError: undefined,
            queryErrorCode: undefined,
            recoveryLoading: false,
            canRetry: false,
            history: {
              ...(before.history ?? emptyHistoryState()),
              selectedConversationId: conversationId,
              throughOrdinal: result.ordinal,
            },
          };
          setChat(
            withSubmissionTurn(nextState, {
              ordinal: result.ordinal,
              status: "completed",
              question: text,
              answer: before.answer || "",
              questionComplete: true,
              answerComplete: true,
              canContinue: true,
              failure: undefined,
            }),
          );
          updateLocalConversation(conversationId, text, result.ordinal, null);
          return;
        }
        const failureCode = result.code.toLowerCase();
        const retryablePreAdmissionFailure =
          ["token_count_unavailable", "documents_unavailable", "context_unavailable"].includes(
            failureCode,
          ) && result.recordStatus === "not_admitted";
        const preserveUnconfirmedJournal =
          retryingUnconfirmed &&
          result.recordStatus === "not_admitted" &&
          failureCode !== "conflict" &&
          failureCode !== "access_denied" &&
          failureCode !== "unauthorized";
        if (failureCode === "access_denied") {
          invalidateChat();
          profileForbidden();
          return;
        }
        if (result.recordStatus === "not_admitted") {
          if (preserveUnconfirmedJournal) {
            // A missing marker during recovery does not prove the original admission ended.
            // Keep its only identity until a later recovery resolves the request.
            chatJournalRef.current = previousJournal;
            chatJournalsRef.current.set(conversationId, previousJournal);
            chatConversationIdRef.current = previousJournal.request.conversationId;
          } else if (retryablePreAdmissionFailure) {
            // Count or document preparation failed before admission. Keep this exact body and ID
            // for an explicit retry, including when the request follows an admitted turn.
            const rejectedJournal: TrackedChatJournalEntry = {
              request,
              admitted: false,
              knownNotAdmitted: true,
            };
            chatJournalRef.current = rejectedJournal;
            chatJournalsRef.current.set(conversationId, rejectedJournal);
            chatConversationIdRef.current = conversationId;
          } else if (previousJournal?.admitted) {
            try {
              markChatJournalAdmitted(
                apiConfig,
                identity,
                previousJournal.request,
                previousJournal.ordinal,
              );
            } catch {
              // The rejected request does not replace the previous durable turn in memory.
            }
            chatJournalRef.current = previousJournal;
            chatJournalsRef.current.set(conversationId, previousJournal);
            chatConversationIdRef.current = previousJournal.request.conversationId;
          } else {
            try {
              clearChatJournalEntry(apiConfig, identity, conversationId);
            } catch {
              // A definitive pre-admission rejection still clears the in-memory reference.
            }
            chatJournalsRef.current.delete(conversationId);
            chatJournalRef.current = null;
            if (operation === "start") {
              chatConversationIdRef.current = null;
              chatDraftsRef.current.delete(conversationId);
              chatDraftsRef.current.set("__new__", text);
              try {
                writeChatSelection(apiConfig, identity, null);
              } catch {
                // The rejected request remains visible in this page.
              }
            }
          }
        } else if (result.recordStatus === "failed") {
          serverConfirmedConversationIdsRef.current.add(conversationId);
          const admittedRequest = {
            version: 2 as const,
            operation,
            conversationId,
            queryId,
            baseOrdinal,
          };
          try {
            markChatJournalAdmitted(apiConfig, identity, admittedRequest, baseOrdinal + 1);
          } catch {
            // The terminal result is still shown; plaintext removal is attempted by the helper.
          }
          const admittedJournal: ChatJournalEntry = {
            request: admittedRequest,
            admitted: true,
            ordinal: baseOrdinal + 1,
          };
          chatJournalsRef.current.set(conversationId, admittedJournal);
          clearChatJournalEntry(apiConfig, identity, conversationId);
          chatJournalsRef.current.delete(conversationId);
          chatJournalRef.current = null;
        }
        const removeRejectedStart =
          operation === "start" &&
          result.recordStatus === "not_admitted" &&
          !preserveUnconfirmedJournal &&
          !retryablePreAdmissionFailure;
        const remainingConversations = removeRejectedStart
          ? (before.history?.conversations ?? []).filter(
              (conversation) => conversation.conversationId !== conversationId,
            )
          : undefined;
        if (removeRejectedStart) {
          localConversationsRef.current.delete(conversationId);
          serverConfirmedConversationIdsRef.current.delete(conversationId);
        }
        const nextState: ChatScreenState = {
          ...before,
          queryId,
          draft: failureCode === "stale_base" ? text : before.draft,
          answerComplete: result.recordStatus === "failed",
          profileStatus: failureCode === "profile_required" ? "incomplete" : before.profileStatus,
          profileError: failureCode === "profile_required" ? undefined : before.profileError,
          queryStatus:
            preserveUnconfirmedJournal || result.recordStatus === "unconfirmed"
              ? "unconfirmed"
              : result.recordStatus === "not_admitted"
                ? "rejected"
                : "failed",
          canContinue: result.canContinue ?? result.recordStatus !== "unconfirmed",
          quota: result.quota,
          quotaReceivedAt: result.quota ? performance.now() : undefined,
          queryError: result.code.toLowerCase() === "quota_exceeded" ? undefined : result.message,
          queryErrorCode: result.code,
          recovered: retrying && result.recordStatus !== "not_admitted",
          recoveryLoading: false,
          canRetry:
            preserveUnconfirmedJournal ||
            (retryablePreAdmissionFailure && !retryingUnconfirmed) ||
            (result.recordStatus === "unconfirmed" && !chatJournalRef.current?.admitted),
          history: {
            ...(before.history ?? emptyHistoryState()),
            ...(removeRejectedStart
              ? {
                  conversations: remainingConversations,
                  status:
                    remainingConversations?.length === 0 && !before.history?.nextCursor
                      ? ("empty" as const)
                      : ("ready" as const),
                }
              : {}),
            selectedConversationId:
              operation === "start" &&
              result.recordStatus === "not_admitted" &&
              !preserveUnconfirmedJournal
                ? null
                : conversationId,
            throughOrdinal:
              result.recordStatus === "failed" ? baseOrdinal + 1 : before.history?.throughOrdinal,
            refreshRequired: failureCode === "stale_base",
          },
        };
        if (result.recordStatus === "failed") {
          setChat(
            withSubmissionTurn(nextState, {
              ordinal: baseOrdinal + 1,
              status: "failed",
              question: text,
              answer: before.answer || "",
              questionComplete: true,
              answerComplete: true,
              canContinue: result.canContinue ?? false,
              failure: { code: result.code, message: result.message },
            }),
          );
        } else {
          setChat(nextState);
        }
        if (failureCode === "stale_base") {
          chatDraftsRef.current.set(conversationId, text);
        }
        if (result.recordStatus === "failed") {
          updateLocalConversation(conversationId, text, baseOrdinal + 1, null, !result.canContinue);
        }
      })
      .catch((error: unknown) => {
        if (!isActive()) return;
        const apiError = asApiError(error);
        if (apiError.status === 401) {
          invalidateChat();
          profileUnauthorized();
          return;
        }
        if (apiError.status === 403) {
          invalidateChat();
          profileForbidden();
          return;
        }
        setChat({
          ...chatScreenStateRef.current,
          queryId,
          queryStatus: "unconfirmed",
          canRetry: Boolean(chatJournalRef.current && !chatJournalRef.current.admitted),
          recoveryLoading: false,
          queryErrorCode: undefined,
          queryError:
            apiError.code === "UNCONFIRMED"
              ? "No pudimos confirmar que la respuesta haya terminado. Vamos a conservar el mismo envío para recuperarlo."
              : "No pudimos confirmar el resultado de esta consulta. Vamos a conservar el mismo envío para recuperarlo.",
        });
      })
      .finally(() => {
        if (chatRequestRef.current !== controller) return;
        chatRequestRef.current = null;
        chatSubmissionInFlightRef.current = false;
        if (
          chatJournalRef.current &&
          (chatScreenStateRef.current.queryStatus === "unconfirmed" ||
            chatScreenStateRef.current.queryStatus === "streaming")
        ) {
          setChatRecoveryRevision((revision) => revision + 1);
        }
      });
    return true;
  }

  function retryChatProfile() {
    setChat({
      ...chatScreenStateRef.current,
      profileStatus: "loading",
      profileError: undefined,
    });
    setChatProfileRetryCount((count) => count + 1);
  }

  function copyChatAnswer(text: string) {
    if (!navigator.clipboard?.writeText) {
      return Promise.reject(new Error("Clipboard unavailable"));
    }
    return navigator.clipboard.writeText(text);
  }

  const screenProps: AccountScreenProps = {
    state,
    onSubmit: submit,
    onSignOut: signOut,
  };
  if (
    route.kind === "chat" &&
    authorizedRouteIsCurrent &&
    state.view === "ready" &&
    state.identity
  ) {
    const apiConfig = configRef.current;
    const session = sessionRef.current;
    if (!apiConfig || !session) return <AccountScreen {...screenProps} />;
    const visibleChatState =
      chatOwnerKeyRef.current === chatOwnerKey(state.identity) ? chatScreenState : emptyChatState();
    const visibleChatHistory = visibleChatState.history;
    const chatScreenStateWithJournalActivity = visibleChatHistory
      ? {
          ...visibleChatState,
          history: {
            ...visibleChatHistory,
            conversations: visibleChatHistory.conversations.map((conversation) => {
              const journal = chatJournalsRef.current.get(conversation.conversationId);
              return journal &&
                !journal.admitted &&
                !journal.knownNotAdmitted &&
                journal.request.conversationId === conversation.conversationId
                ? { ...conversation, pendingQueryId: journal.request.queryId }
                : conversation;
            }),
          },
        }
      : visibleChatState;
    return (
      <ChatScreen
        state={{ ...chatScreenStateWithJournalActivity, projectName }}
        onSubmit={submitChat}
        onSignOut={signOut}
        onRetryProfile={retryChatProfile}
        onReset={resetChat}
        onCopy={copyChatAnswer}
        onSelectConversation={selectConversation}
        onLoadMoreHistory={loadMoreHistory}
        onRefreshHistory={() => loadMoreHistory(true)}
        onLoadEarlierTurns={loadEarlierTurns}
        onDraftChange={changeChatDraft}
        onHideConversation={hideConversation}
      />
    );
  }

  if (
    route.kind === "profile" &&
    authorizedRouteIsCurrent &&
    state.view === "ready" &&
    state.identity
  ) {
    const apiConfig = configRef.current;
    const session = sessionRef.current;
    if (!apiConfig || !session) {
      return <AccountScreen {...screenProps} />;
    }
    return (
      <ProfileApp
        key={JSON.stringify([state.identity.sub, state.identity.botId, state.identity.generation])}
        config={profileConfig}
        apiConfig={apiConfig}
        session={session}
        identity={state.identity}
        projectName={projectName}
        onSignOut={signOut}
        onUnauthorized={profileUnauthorized}
        onForbidden={profileForbidden}
      />
    );
  }
  return <AccountScreen {...screenProps} />;
}
