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

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

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
    throw new SessionError("NETWORK_ERROR", "Cognito no está disponible.");
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
    throw new SessionError("INVALID_RESPONSE", "Cognito devolvió una respuesta inválida.");
  }
  if (!isRecord(parsed)) {
    throw new SessionError("INVALID_RESPONSE", "Cognito devolvió una respuesta inválida.");
  }
  const result: CognitoResponse = parsed;

  if (!response.ok) {
    const code = typeof result.__type === "string" ? result.__type.split("#").pop() || "" : "";
    throw new SessionError(
      code || "COGNITO_ERROR",
      "El email o la contraseña no fueron aceptados.",
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
  let passwordResetPending = false;
  let refreshPromise: Promise<SessionTokens | null> | null = null;

  function clearMemory() {
    currentAccessToken = null;
    currentIdToken = null;
  }

  function saveRefreshToken(token: string | undefined) {
    if (token) storage.setItem(refreshStorageKey, token);
  }

  async function signIn(email: string, password: string): Promise<SessionTokens> {
    if (passwordResetPending) {
      throw new SessionError(
        "PASSWORD_RESET_IN_PROGRESS",
        "El cambio de contraseña sigue en curso.",
      );
    }
    const generation = ++authGeneration;
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
    if (passwordResetPending || generation !== authGeneration) {
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
    if (passwordResetPending) {
      throw new SessionError(
        "PASSWORD_RESET_IN_PROGRESS",
        "El cambio de contraseña sigue en curso.",
      );
    }
    passwordResetPending = true;
    authGeneration += 1;
    refreshPromise = null;
    try {
      await cognitoJson(fetcher, region, "ConfirmForgotPassword", {
        ClientId: clientId,
        Username: email.trim().toLowerCase(),
        ConfirmationCode: code,
        Password: password,
      });
      clearMemory();
      storage.removeItem(refreshStorageKey);
    } finally {
      passwordResetPending = false;
    }
  }

  async function restore(): Promise<SessionTokens | null> {
    if (passwordResetPending) return null;
    if (refreshPromise) return refreshPromise;

    const generation = authGeneration;
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
        if (passwordResetPending || generation !== authGeneration) return null;
        currentAccessToken = tokens.accessToken;
        currentIdToken = tokens.idToken;
        saveRefreshToken(tokens.refreshToken);
        return { accessToken: tokens.accessToken, idToken: tokens.idToken };
      } catch {
        if (passwordResetPending || generation !== authGeneration) return null;
        clearMemory();
        storage.removeItem(refreshStorageKey);
        return null;
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
