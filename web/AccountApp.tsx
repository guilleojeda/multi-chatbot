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
import { ChatScreen, type ChatScreenState, type PreviousChatTurn } from "./ChatScreen";
import { recoverChat, streamChat, type ChatRequest } from "./chat-api";
import {
  clearChatJournal,
  clearChatJournalForConfiguredBot,
  markChatJournalAdmitted,
  readChatJournal,
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

const recoveryNotice =
  "Si la cuenta está activa y tiene un email verificado, recibirás un código para continuar.";
const passwordResetLoginNotice = "La contraseña se cambió. Iniciá sesión con la nueva contraseña.";

function accountRouteKey(route: AccountRoute) {
  return route.kind === "invite" ? `invite:${route.token || ""}` : route.kind;
}

function chatOwnerKey(identity: { sub: string; botId: string }) {
  return JSON.stringify([identity.sub, identity.botId]);
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

function emptyChatState(): ChatScreenState {
  return { profileStatus: "loading", queryStatus: "idle" };
}

function priorTurnsIncludingCurrent(state: ChatScreenState): PreviousChatTurn[] {
  const previousTurns = [...(state.previousTurns || [])];
  if (state.question && (state.queryStatus === "completed" || state.queryStatus === "failed")) {
    previousTurns.push({
      question: state.question,
      answer: state.answer || "",
      status: state.queryStatus,
    });
  }
  return previousTurns;
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
    chatScreenStateRef.current = next;
    setChatScreenState(next);
  }, []);

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
  }, []);

  // Identity activation leaves an unowned journal available to the recovery effect.
  const invalidateChat = useCallback(
    (configToClear?: PublicConfig) => {
      chatEpochRef.current += 1;
      chatProfileSequenceRef.current += 1;
      stopChatRecovery();
      chatRequestRef.current?.abort();
      chatRequestRef.current = null;
      chatSubmissionInFlightRef.current = false;
      chatOwnerKeyRef.current = null;
      chatConversationIdRef.current = null;
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
    },
    [invalidateChat, setChat],
  );

  const resetChat = useCallback(() => {
    chatEpochRef.current += 1;
    stopChatRecovery();
    chatRequestRef.current?.abort();
    chatRequestRef.current = null;
    chatSubmissionInFlightRef.current = false;
    chatConversationIdRef.current = null;
    clearCurrentChatJournal(configRef.current ?? undefined);
    setChat({ profileStatus: "loading", queryStatus: "idle" });
    setChatProfileRetryCount((count) => count + 1);
  }, [clearCurrentChatJournal, setChat, stopChatRecovery]);

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
    if (chatRequestRef.current && !chatRequestRef.current.signal.aborted) {
      return;
    }

    const recoveryConfig = apiConfig;
    const recoverySession = session;
    if (!recoveryConfig || !recoverySession) return;

    const identity = { sub: readyIdentity.sub, botId: readyIdentity.botId };
    const identityKey = chatOwnerKey(identity);
    const chatEpoch = chatEpochRef.current;
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
      chatOwnerKeyRef.current === identityKey &&
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

    let loadedJournal: ChatJournalEntry | null;
    try {
      loadedJournal = readChatJournal(recoveryConfig, identity);
    } catch {
      setChat({
        ...chatScreenStateRef.current,
        queryError: "No pudimos leer la referencia de recuperación de esta pestaña.",
      });
      return () => {
        active = false;
        clearTimer();
      };
    }

    const liveJournal = chatJournalRef.current;
    const liveJournalOwner = chatJournalOwnerRef.current;
    const liveJournalHasCurrentOwner =
      liveJournal !== null &&
      liveJournalOwner !== null &&
      chatOwnerKey(liveJournalOwner.identity) === identityKey &&
      chatOwnerKeyRef.current === identityKey &&
      sameChatJournalScope(liveJournalOwner.config, recoveryConfig);
    if (!loadedJournal && liveJournalHasCurrentOwner) loadedJournal = liveJournal;

    chatJournalOwnerRef.current = { config: recoveryConfig, identity };
    chatJournalRef.current = loadedJournal;
    if (!loadedJournal) {
      chatConversationIdRef.current = null;
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
      Boolean(current.previousTurns?.length) &&
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
      queryStatus: journal.admitted ? "streaming" : "unconfirmed",
      question: journal.admitted ? current.question : pendingText,
      answer: journal.admitted ? current.answer || "" : "",
      canContinue: journal.admitted ? current.canContinue : false,
      canRetry: !journal.admitted,
      recovered: false,
      recoveryLoading: true,
      queryError: undefined,
    });

    const applySnapshot = (
      snapshot: Extract<Awaited<ReturnType<typeof recoverChat>>, { version: 2 }>,
    ) => {
      if (!isActive() || chatJournalRef.current?.request.queryId !== request.queryId) return;
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
        // The current page can still render the authorized snapshot; the helper removes plaintext on failure.
      }
      chatJournalRef.current = {
        request: reference,
        admitted: true,
        ordinal: snapshot.ordinal,
      };
      chatConversationIdRef.current = snapshot.conversationId;
      const before = chatScreenStateRef.current;
      const isTerminal = snapshot.status === "completed" || snapshot.status === "failed";
      if (
        (before.queryStatus === "completed" || before.queryStatus === "failed") &&
        chatDisplayedQueryIdRef.current === snapshot.queryId &&
        !isTerminal
      ) {
        return;
      }
      chatDisplayedQueryIdRef.current = snapshot.queryId;
      setChat({
        ...before,
        question: snapshot.question,
        answer: snapshot.answer,
        ordinal: snapshot.ordinal,
        canContinue: snapshot.canContinue,
        quota: snapshot.quota,
        quotaReceivedAt: snapshot.quota ? performance.now() : undefined,
        queryStatus: snapshot.status === "in_progress" ? "streaming" : snapshot.status,
        queryError: undefined,
        recovered: true,
        recoveryLoading: false,
        canRetry: false,
      });
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
        if (!isActive() || chatJournalRef.current?.request.queryId !== request.queryId) return;
        if ("version" in result) {
          failures = 0;
          applySnapshot(result);
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
          setChat({
            ...chatScreenStateRef.current,
            question: journal.admitted ? chatScreenStateRef.current.question : pendingText,
            queryStatus: "failed",
            canContinue: result.canContinue ?? false,
            canRetry: false,
            recovered: true,
            recoveryLoading: false,
            queryError: result.message,
          });
          stopCycle();
          return;
        }

        setChat({
          ...chatScreenStateRef.current,
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
    state.view,
  ]);

  function submitChat(text: string): boolean {
    const identity = state.view === "ready" ? state.identity : undefined;
    const current = chatScreenStateRef.current;
    const ownerKey = identity ? chatOwnerKey(identity) : null;
    const previousJournal = chatJournalRef.current;
    const pendingRequestMatches =
      previousJournal !== null &&
      !previousJournal.admitted &&
      previousJournal.request.text === text;
    const retryingUnconfirmed = pendingRequestMatches && current.queryStatus === "unconfirmed";
    const retryingKnownCountFailure =
      pendingRequestMatches &&
      current.queryStatus === "rejected" &&
      current.canRetry === true &&
      current.queryErrorCode === "token_count_unavailable";
    const retrying = retryingUnconfirmed || retryingKnownCountFailure;
    const canStartNewRequest =
      current.queryStatus === "idle" ||
      ((current.queryStatus === "completed" || current.queryStatus === "failed") &&
        current.canContinue !== false) ||
      (current.queryStatus === "rejected" && Boolean(current.quota)) ||
      (current.queryStatus === "rejected" &&
        current.queryErrorCode === "storage_capacity_exceeded");
    if (
      !identity ||
      !ownerKey ||
      !apiConfig ||
      !session ||
      chatOwnerKeyRef.current !== ownerKey ||
      (current.profileStatus !== "complete" && !retrying) ||
      (!retrying && !canStartNewRequest) ||
      (previousJournal && !previousJournal.admitted && !retrying) ||
      chatSubmissionInFlightRef.current ||
      !text.trim()
    ) {
      return false;
    }

    const request: ChatRequest = retrying
      ? previousJournal.request
      : {
          version: 2,
          operation: chatConversationIdRef.current ? "message" : "start",
          conversationId: chatConversationIdRef.current || window.crypto.randomUUID(),
          queryId: window.crypto.randomUUID(),
          baseOrdinal: chatConversationIdRef.current
            ? (current.ordinal ?? priorTurnsIncludingCurrent(current).length)
            : 0,
          text,
        };
    const { operation, conversationId, queryId, baseOrdinal } = request;
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
    chatJournalRef.current = { request, admitted: false };
    chatJournalOwnerRef.current = { config: apiConfig, identity };
    chatDisplayedQueryIdRef.current = queryId;
    chatConversationIdRef.current = conversationId;
    const controller = new AbortController();
    const chatEpoch = chatEpochRef.current;
    const isActive = () =>
      chatEpochRef.current === chatEpoch &&
      chatOwnerKeyRef.current === ownerKey &&
      chatRequestRef.current === controller &&
      !controller.signal.aborted;
    chatSubmissionInFlightRef.current = true;
    chatRequestRef.current = controller;
    setChat({
      previousTurns: priorTurnsIncludingCurrent(current),
      profileStatus: "complete",
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
    });

    void streamChat(apiConfig, session, request, {
      signal: controller.signal,
      isActive,
      onEvent: (event) => {
        if (!isActive()) return;
        const before = chatScreenStateRef.current;
        if (event.type === "accepted") {
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
          chatJournalRef.current = {
            request: admittedRequest,
            admitted: true,
            ordinal: event.ordinal,
          };
          setChat({
            ...before,
            queryStatus: "streaming",
            ordinal: event.ordinal,
            queryErrorCode: undefined,
          });
        } else if (event.type === "text") {
          setChat({
            ...before,
            queryStatus: "streaming",
            answer: (before.answer || "") + event.text,
            queryErrorCode: undefined,
          });
        } else if (event.type === "completed") {
          setChat({
            ...before,
            queryStatus: "completed",
            canContinue: true,
            queryError: undefined,
            queryErrorCode: undefined,
          });
        }
      },
    })
      .then((result) => {
        if (!isActive()) return;
        const before = chatScreenStateRef.current;
        if ("version" in result) {
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
          chatJournalRef.current = {
            request: admittedRequest,
            admitted: true,
            ordinal: result.ordinal,
          };
          setChat({
            ...before,
            question: result.question,
            answer: result.answer,
            ordinal: result.ordinal,
            canContinue: result.canContinue,
            quota: result.quota,
            quotaReceivedAt: result.quota ? performance.now() : undefined,
            queryStatus: result.status === "in_progress" ? "streaming" : result.status,
            queryError: undefined,
            queryErrorCode: undefined,
            recovered: retrying,
            recoveryLoading: false,
            canRetry: false,
          });
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
          chatJournalRef.current = {
            request: admittedRequest,
            admitted: true,
            ordinal: result.ordinal,
          };
          setChat({
            ...before,
            queryStatus: "completed",
            canContinue: true,
            queryError: undefined,
            queryErrorCode: undefined,
            recoveryLoading: false,
            canRetry: false,
          });
          return;
        }
        const failureCode = result.code.toLowerCase();
        const retryableCountFailure =
          failureCode === "token_count_unavailable" && result.recordStatus === "not_admitted";
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
            chatConversationIdRef.current = previousJournal.request.conversationId;
          } else if (retryableCountFailure) {
            // CountTokens failed before admission. Keep this exact body and ID for an explicit
            // retry, even when the attempted request was a follow-up to an admitted turn.
            chatJournalRef.current = { request, admitted: false };
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
            chatConversationIdRef.current = previousJournal.request.conversationId;
          } else {
            try {
              clearChatJournal(apiConfig, identity);
            } catch {
              // A definitive pre-admission rejection still clears the in-memory reference.
            }
            chatJournalRef.current = null;
            if (operation === "start") chatConversationIdRef.current = null;
          }
        } else if (result.recordStatus === "failed") {
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
          chatJournalRef.current = {
            request: admittedRequest,
            admitted: true,
            ordinal: baseOrdinal + 1,
          };
        }
        setChat({
          ...before,
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
            retryableCountFailure ||
            (result.recordStatus === "unconfirmed" && !chatJournalRef.current?.admitted),
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
    return (
      <ChatScreen
        state={{ ...visibleChatState, projectName }}
        onSubmit={submitChat}
        onSignOut={signOut}
        onRetryProfile={retryChatProfile}
        onReset={resetChat}
        onCopy={copyChatAnswer}
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
