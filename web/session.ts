export type SessionTokens = {
  accessToken: string;
  idToken: string;
};

export type Session = {
  signIn(email: string, password: string): Promise<SessionTokens>;
  requestPasswordReset(email: string): Promise<void>;
  confirmPasswordReset(email: string, code: string, password: string): Promise<void>;
  restore(): Promise<SessionTokens | null>;
  accessToken(): string | null;
  idToken(): string | null;
  signOut(): Promise<void>;
};

export type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type SessionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CreateSessionOptions = {
  clientId: string;
  region: string;
  storage: SessionStorage;
  fetch: SessionFetch;
};

type CognitoResponse = Record<string, unknown>;

const refreshStorageKey = "auth-refresh";

export class SessionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.status = status;
  }
}

const invalidRefreshTokenCodes = new Set(["NotAuthorizedException", "UserNotFoundException"]);
const retryableCognitoCodes = new Set([
  "InternalErrorException",
  "LimitExceededException",
  "ServiceUnavailableException",
  "TooManyRequestsException",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function cognitoJson(
  fetcher: SessionFetch,
  region: string,
  operation: string,
  body: Record<string, unknown>,
): Promise<CognitoResponse> {
  let response: Response;
  try {
    response = await fetcher("https://cognito-idp." + region + ".amazonaws.com/", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService." + operation,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SessionError("NETWORK_ERROR", "Cognito no está disponible.", 0);
  }

  let parsed: unknown;
  try {
    if (typeof response.text === "function") {
      const text = await response.text();
      if (!text.trim()) {
        if (response.ok) return {};
        throw new Error("Empty error response");
      }
      parsed = JSON.parse(text) as unknown;
    } else {
      parsed = await response.json();
    }
  } catch {
    throw new SessionError("INVALID_RESPONSE", "Cognito devolvió una respuesta inválida.", 502);
  }
  if (!isRecord(parsed)) {
    throw new SessionError("INVALID_RESPONSE", "Cognito devolvió una respuesta inválida.", 502);
  }
  const result: CognitoResponse = parsed;

  if (!response.ok) {
    const code = typeof result.__type === "string" ? result.__type.split("#").pop() || "" : "";
    const status =
      response.status >= 500 || retryableCognitoCodes.has(code) ? 503 : response.status;
    throw new SessionError(
      code || "COGNITO_ERROR",
      "El email o la contraseña no fueron aceptados.",
      status,
    );
  }

  return result;
}

function authenticationResult(response: CognitoResponse): SessionTokens & {
  refreshToken?: string;
} {
  const rawResult = response.AuthenticationResult;
  if (!isRecord(rawResult)) {
    const challenge = typeof response.ChallengeName === "string" ? response.ChallengeName : "";
    throw new SessionError(
      challenge || "MISSING_AUTHENTICATION_RESULT",
      challenge
        ? "La cuenta necesita una acción adicional antes de iniciar sesión."
        : "Cognito no completó el inicio de sesión.",
    );
  }

  const accessToken = rawResult.AccessToken;
  const idToken = rawResult.IdToken;
  const refreshToken = rawResult.RefreshToken;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    typeof idToken !== "string" ||
    !idToken ||
    (refreshToken !== undefined && (typeof refreshToken !== "string" || !refreshToken))
  ) {
    throw new SessionError("INVALID_RESPONSE", "Cognito devolvió tokens inválidos.");
  }

  return {
    accessToken,
    idToken,
    ...(typeof refreshToken === "string" ? { refreshToken } : {}),
  };
}

export function createSession({
  clientId,
  region,
  storage,
  fetch: fetcher,
}: CreateSessionOptions): Session {
  let currentAccessToken: string | null = null;
  let currentIdToken: string | null = null;
  let authGeneration = 0;
  let resetGeneration = 0;
  let passwordResetBarrier: Promise<void> | null = null;
  let refreshPromise: Promise<SessionTokens | null> | null = null;

  function clearMemory() {
    currentAccessToken = null;
    currentIdToken = null;
  }

  function saveRefreshToken(token: string | undefined) {
    if (token) storage.setItem(refreshStorageKey, token);
  }

  async function signIn(email: string, password: string): Promise<SessionTokens> {
    if (passwordResetBarrier) {
      throw new SessionError(
        "PASSWORD_RESET_IN_PROGRESS",
        "El cambio de contraseña sigue en curso.",
      );
    }
    const generation = ++authGeneration;
    const resetGenerationAtStart = resetGeneration;
    refreshPromise = null;
    clearMemory();
    storage.removeItem(refreshStorageKey);
    const response = await cognitoJson(fetcher, region, "InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: {
        USERNAME: email.trim().toLowerCase(),
        PASSWORD: password,
      },
    });
    const tokens = authenticationResult(response);
    if (generation !== authGeneration || resetGenerationAtStart !== resetGeneration) {
      throw new SessionError(
        "PASSWORD_RESET_IN_PROGRESS",
        "El cambio de contraseña sigue en curso.",
      );
    }
    if (!tokens.refreshToken) {
      throw new SessionError(
        "MISSING_REFRESH_TOKEN",
        "No se pudo crear una sesión que pueda restaurarse.",
      );
    }
    currentAccessToken = tokens.accessToken;
    currentIdToken = tokens.idToken;
    saveRefreshToken(tokens.refreshToken);
    return { accessToken: tokens.accessToken, idToken: tokens.idToken };
  }

  async function requestPasswordReset(email: string): Promise<void> {
    await cognitoJson(fetcher, region, "ForgotPassword", {
      ClientId: clientId,
      Username: email.trim().toLowerCase(),
    });
  }

  async function confirmPasswordReset(
    email: string,
    code: string,
    password: string,
  ): Promise<void> {
    if (passwordResetBarrier) {
      throw new SessionError(
        "PASSWORD_RESET_IN_PROGRESS",
        "El cambio de contraseña sigue en curso.",
      );
    }
    resetGeneration += 1;
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    passwordResetBarrier = barrier;
    try {
      await cognitoJson(fetcher, region, "ConfirmForgotPassword", {
        ClientId: clientId,
        Username: email.trim().toLowerCase(),
        ConfirmationCode: code,
        Password: password,
      });
      authGeneration += 1;
      refreshPromise = null;
      clearMemory();
      storage.removeItem(refreshStorageKey);
    } finally {
      if (passwordResetBarrier === barrier) passwordResetBarrier = null;
      releaseBarrier();
    }
  }

  async function restore(): Promise<SessionTokens | null> {
    const generation = authGeneration;
    while (passwordResetBarrier) await passwordResetBarrier;
    if (generation !== authGeneration) return null;
    if (refreshPromise) return refreshPromise;

    const refreshToken = storage.getItem(refreshStorageKey);
    if (!refreshToken) {
      clearMemory();
      return null;
    }

    const renewal = (async (): Promise<SessionTokens | null> => {
      try {
        const response = await cognitoJson(fetcher, region, "InitiateAuth", {
          AuthFlow: "REFRESH_TOKEN_AUTH",
          ClientId: clientId,
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        });
        const tokens = authenticationResult(response);
        while (passwordResetBarrier) await passwordResetBarrier;
        if (generation !== authGeneration) return null;
        saveRefreshToken(tokens.refreshToken);
        currentAccessToken = tokens.accessToken;
        currentIdToken = tokens.idToken;
        return { accessToken: tokens.accessToken, idToken: tokens.idToken };
      } catch (error) {
        while (passwordResetBarrier) await passwordResetBarrier;
        if (generation !== authGeneration) return null;
        if (error instanceof SessionError && invalidRefreshTokenCodes.has(error.code)) {
          clearMemory();
          storage.removeItem(refreshStorageKey);
          return null;
        }
        if (error instanceof SessionError) {
          if (error.status > 0 && error.status < 500) {
            throw new SessionError(error.code, error.message, 503);
          }
          throw error;
        }
        throw new SessionError("NETWORK_ERROR", "Cognito no está disponible.", 0);
      }
    })();

    const sharedRenewal = renewal.finally(() => {
      if (refreshPromise === sharedRenewal) refreshPromise = null;
    });
    refreshPromise = sharedRenewal;
    return sharedRenewal;
  }

  async function signOut(): Promise<void> {
    const refreshToken = storage.getItem(refreshStorageKey);
    authGeneration += 1;
    refreshPromise = null;
    clearMemory();
    storage.removeItem(refreshStorageKey);
    if (!refreshToken) return;

    try {
      await cognitoJson(fetcher, region, "RevokeToken", {
        ClientId: clientId,
        Token: refreshToken,
      });
    } catch {
      // Local sign-out remains effective if Cognito cannot be reached.
    }
  }

  return {
    signIn,
    requestPasswordReset,
    confirmPasswordReset,
    restore,
    accessToken: () => currentAccessToken,
    idToken: () => currentIdToken,
    signOut,
  };
}
