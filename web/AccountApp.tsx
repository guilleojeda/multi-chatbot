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

export type AccountRoute =
  | { kind: "login" }
  | { kind: "recover" }
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
        if (!isActive()) return;
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
    authorizedRouteRef.current = null;
    setState({
      view: "login",
      pending: false,
      notice: "Cerraste sesión.",
      projectName,
    });
    if (window.location.hash !== "#/login") window.location.hash = "/login";
    void sessionRef.current?.signOut();
  }, [projectName]);

  const profileUnauthorized = useCallback(() => {
    authorizedRouteRef.current = null;
    setState({
      view: "login",
      pending: false,
      notice: "Tu sesión venció. Iniciá sesión nuevamente.",
      projectName,
    });
    if (window.location.hash !== "#/login") window.location.hash = "/login";
    void sessionRef.current?.signOut();
  }, [projectName]);

  const profileForbidden = useCallback(() => {
    authorizedRouteRef.current = null;
    setState({
      view: "denied",
      pending: false,
      error: "Esta cuenta no tiene acceso a este asistente.",
      retryable: false,
      canSignOut: Boolean(sessionRef.current?.accessToken()),
      projectName,
    });
  }, [projectName]);

  const screenProps: AccountScreenProps = {
    state,
    onSubmit: submit,
    onSignOut: signOut,
  };
  const profileRouteIsAuthorized =
    authorizedRouteRef.current?.key === routeKey &&
    authorizedRouteRef.current.epoch === routeEpochRef.current;
  if (
    route.kind === "profile" &&
    profileRouteIsAuthorized &&
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
