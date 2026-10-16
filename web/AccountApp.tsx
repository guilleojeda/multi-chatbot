import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccountScreen,
  type AccountScreenProps,
  type AccountState,
  type AccountSubmission,
} from "./AccountScreen";
import { createSession, SessionError, type Session } from "./session";

export type AccountRoute = { kind: "login" } | { kind: "invite"; token: string | null };

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

export function AccountApp({ route, projectName }: { route: AccountRoute; projectName: string }) {
  const [state, setState] = useState<AccountState>({
    view: route.kind === "invite" ? "denied" : "login",
    pending: true,
    projectName,
  });
  const [retryCount, setRetryCount] = useState(0);
  const configRef = useRef<PublicConfig | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const retryOperationRef = useRef<RetryOperation | null>(null);

  const inspectInvitation = useCallback(
    async (config: PublicConfig, token: string) => {
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
      setState({
        view: invitation.kind === "new" ? "invite-new" : "invite-existing",
        email: invitation.email,
        projectName,
      });
    },
    [projectName],
  );

  const checkMembership = useCallback(
    async (config: PublicConfig, session: Session, email?: string) => {
      retryOperationRef.current = async () => {
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
          setState({
            view: "ready",
            email,
            projectName,
          });
        } catch (error) {
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

  const initialize = useCallback(async () => {
    setState({
      view: route.kind === "invite" ? "denied" : "login",
      pending: true,
      projectName,
    });

    try {
      const config = await readPublicConfig();
      configRef.current = config;
      const session = createSession({
        clientId: config.clientId,
        region: config.region,
        storage: window.sessionStorage,
        fetch: window.fetch.bind(window),
      });
      sessionRef.current = session;

      if (route.kind === "invite") {
        if (!route.token) {
          throw Object.assign(new Error("Invitation token is missing"), {
            code: "INVALID_INVITATION",
            status: 400,
          });
        }
        await inspectInvitation(config, route.token);
        return;
      }

      const restored = await session.restore();
      if (!restored) {
        setState({
          view: "login",
          pending: false,
          projectName,
        });
        return;
      }
      await checkMembership(config, session);
    } catch (error) {
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
  }, [checkMembership, inspectInvitation, projectName, route]);

  useEffect(() => {
    void initialize();
  }, [initialize, retryCount]);

  async function submit(submission: AccountSubmission) {
    if (submission.action === "retry") {
      if (retryOperationRef.current && sessionRef.current?.accessToken()) {
        await retryOperationRef.current();
      } else {
        setRetryCount((count) => count + 1);
      }
      return;
    }

    const session = sessionRef.current;
    const config = configRef.current;
    if (!session || !config) {
      setState({
        view: "denied",
        error: errorMessage("NETWORK_ERROR", 0, "config"),
        pending: false,
        retryable: true,
        projectName,
      });
      return;
    }

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
          await checkMembership(config, session, submission.email);
        } catch {
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

      await checkMembership(config, session, submission.email);
    } catch (error) {
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
    await sessionRef.current?.signOut();
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
