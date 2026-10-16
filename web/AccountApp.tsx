import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccountScreen,
  type AccountScreenProps,
  type AccountState,
  type AccountSubmission,
} from "./AccountScreen";
import { SessionError, type Session } from "./session";

export type AccountRoute =
  { kind: "login" } | { kind: "recover" } | { kind: "invite"; token: string | null };

type PublicConfig = {
  region: string;
  userPoolId: string;
  clientId: string;
  apiBaseUrl: string;
  botId: string;
};

type ApiError = Error & {
  code: string;
  status: number;
};

type RetryOperation = () => Promise<void>;
type RouteIdentity = { key: string; epoch: number };

const recoveryNotice =
  "Si la cuenta está activa y tiene un email verificado, recibirás un código para continuar.";
const passwordResetLoginNotice = "La contraseña se cambió. Iniciá sesión con la nueva contraseña.";

function accountRouteKey(route: AccountRoute) {
  return route.kind === "invite" ? `invite:${route.token || ""}` : route.kind;
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

function asApiError(error: unknown): ApiError {
  if (error instanceof Error && "code" in error && "status" in error) {
    if (typeof error.code === "string" && typeof error.status === "number") {
      return Object.assign(error, { code: error.code, status: error.status });
    }
  }
  const message = error instanceof SessionError ? error.message : "";
  return Object.assign(new Error(message || "La solicitud no pudo completarse."), {
    code: error instanceof SessionError ? error.code : "NETWORK_ERROR",
    status: 0,
  });
}

function assertPublicConfig(value: unknown): PublicConfig {
  if (!isRecord(value)) throw new Error("Invalid public config");
  const config = value;
  const { region, userPoolId, clientId, apiBaseUrl, botId } = config;
  if (
    typeof region !== "string" ||
    !region ||
    typeof userPoolId !== "string" ||
    !userPoolId ||
    typeof clientId !== "string" ||
    !clientId ||
    typeof apiBaseUrl !== "string" ||
    !apiBaseUrl.startsWith("/") ||
    apiBaseUrl.startsWith("//") ||
    typeof botId !== "string" ||
    !botId
  ) {
    throw new Error("Invalid public config");
  }
  return { region, userPoolId, clientId, apiBaseUrl, botId };
}

async function readPublicConfig(): Promise<PublicConfig> {
  const response = await fetch("/public-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Public config request failed");
  return assertPublicConfig(await response.json());
}

function apiUrl(config: PublicConfig, path: string): string {
  return config.apiBaseUrl.replace(/\/+$/, "") + path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function apiRequest(
  config: PublicConfig,
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; accessToken?: string | null },
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.accessToken) headers.authorization = "Bearer " + options.accessToken;

  let response: Response;
  try {
    response = await fetch(apiUrl(config, path), {
      method: options.method || "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      cache: "no-store",
    });
  } catch {
    throw Object.assign(new Error("API unavailable"), { code: "NETWORK_ERROR", status: 0 });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) {
      throw Object.assign(new Error("API returned invalid JSON"), {
        code: "INVALID_RESPONSE",
        status: 502,
      });
    }
    payload = null;
  }

  if (!response.ok) {
    throw Object.assign(new Error("API request failed"), {
      code: isRecord(payload) && typeof payload.code === "string" ? payload.code : "API_ERROR",
      status: response.status,
    });
  }
  return payload;
}

async function requestWithRefresh(
  config: PublicConfig,
  session: Session,
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown },
): Promise<unknown> {
  let accessToken = session.accessToken();
  if (!accessToken)
    throw Object.assign(new Error("No active session"), { code: "UNAUTHORIZED", status: 401 });

  try {
    return await apiRequest(config, path, { ...options, accessToken });
  } catch (error) {
    const firstError = asApiError(error);
    if (firstError.status !== 401) throw firstError;

    const refreshed = await session.restore();
    if (!refreshed) throw firstError;
    accessToken = refreshed.accessToken;
    return apiRequest(config, path, { ...options, accessToken });
  }
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
  getSession,
}: {
  route: AccountRoute;
  projectName: string;
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
  const configRef = useRef<PublicConfig | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const retryOperationRef = useRef<RetryOperation | null>(null);
  const currentRouteKeyRef = useRef(routeKey);
  const routeEpochRef = useRef(0);
  if (currentRouteKeyRef.current !== routeKey) {
    currentRouteKeyRef.current = routeKey;
    routeEpochRef.current += 1;
  }
  const mountedRef = useRef(false);
  const initializeSequenceRef = useRef(0);
  const recoverySubmissionInFlightRef = useRef(false);
  const confirmOperationRef = useRef<{ email: string } | null>(null);
  const passwordResetLoginEmailRef = useRef<string | null>(null);

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
      retryOperationRef.current = async () => {
        if (!isActive()) return;
        setState((current) => ({ ...current, pending: true, error: undefined }));
        try {
          const membership = await requestWithRefresh(config, session, "/account/me", {});
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
          setState({
            view: "ready",
            email,
            projectName,
          });
        } catch (error) {
          if (!isActive()) return;
          const apiError = asApiError(error);
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
    [projectName],
  );

  const initialize = useCallback(
    async (isActive: () => boolean) => {
      if (!isActive()) return;
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
    [checkMembership, getSession, inspectInvitation, projectName, route],
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
        if (confirmOperationRef.current === operation) confirmOperationRef.current = null;
        passwordResetLoginEmailRef.current = submission.email;
        const currentRouteKey = currentRouteKeyRef.current;
        if (!mountedRef.current) return;
        if (currentRouteKey === "recover") {
          window.location.hash = "/login";
          return;
        }
        if (currentRouteKey === "login") {
          passwordResetLoginEmailRef.current = null;
          setState({
            view: "login",
            email: submission.email,
            notice: passwordResetLoginNotice,
            projectName,
          });
        }
      } catch (error) {
        if (confirmOperationRef.current === operation) confirmOperationRef.current = null;
        if (!isActive()) {
          if (isCurrentRoute({ key: "login", epoch: routeEpochRef.current })) {
            setState({ view: "login", email: submission.email, projectName });
          }
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
        if (!isRecord(acceptance) || acceptance.status !== "accepted") {
          throw Object.assign(new Error("Invitation acceptance response was invalid"), {
            code: "INVALID_RESPONSE",
            status: 502,
          });
        }
        replaceHash("/login");
        try {
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

      await session.signIn(submission.email, submission.password);
      if (!isActive()) return;

      if (isExistingInvitation) {
        if (route.kind !== "invite" || !route.token) {
          throw Object.assign(new Error("Invitation is missing"), {
            code: "INVALID_INVITATION",
            status: 400,
          });
        }
        await requestWithRefresh(config, session, "/account/invitations/accept", {
          method: "POST",
          body: { token: route.token },
        });
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

  async function signOut() {
    const identity = { key: routeKey, epoch: routeEpochRef.current };
    await sessionRef.current?.signOut();
    if (!isCurrentRoute(identity)) return;
    replaceHash("/login");
    setState({
      view: "login",
      pending: false,
      notice: "Cerraste sesión.",
      projectName,
    });
  }

  const screenProps: AccountScreenProps = {
    state,
    onSubmit: submit,
    onSignOut: signOut,
  };
  return <AccountScreen {...screenProps} />;
}
