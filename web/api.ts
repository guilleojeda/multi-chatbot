import { SessionError, type Session } from "./session";

export type PublicConfig = {
  region: string;
  userPoolId: string;
  clientId: string;
  apiBaseUrl: string;
  botId: string;
};

export type ApiError = Error & {
  code: string;
  status: number;
  fields?: string[];
  refreshFailed?: boolean;
};

export type ApiRequestOptions = {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  accessToken?: string | null;
};

export type AuthenticatedRequestOptions = {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof Error && "code" in error && "status" in error) {
    const candidate = error as Error & {
      code: unknown;
      status: unknown;
      fields?: unknown;
      refreshFailed?: unknown;
    };
    const fields = candidate.fields;
    if (
      typeof candidate.code === "string" &&
      typeof candidate.status === "number" &&
      (fields === undefined ||
        (Array.isArray(fields) && fields.every((field: unknown) => typeof field === "string")))
    ) {
      return Object.assign(error, {
        code: candidate.code,
        status: candidate.status,
        ...(Array.isArray(fields) ? { fields } : {}),
        ...(typeof candidate.refreshFailed === "boolean"
          ? { refreshFailed: candidate.refreshFailed }
          : {}),
      });
    }
  }
  const message = error instanceof SessionError ? error.message : "";
  return Object.assign(new Error(message || "La solicitud no pudo completarse."), {
    code: error instanceof SessionError ? error.code : "NETWORK_ERROR",
    status: 0,
  });
}

export function assertPublicConfig(value: unknown): PublicConfig {
  if (!isRecord(value)) throw new Error("Invalid public config");
  const { region, userPoolId, clientId, apiBaseUrl, botId } = value;
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

export async function readPublicConfig(): Promise<PublicConfig> {
  const response = await fetch("/public-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Public config request failed");
  return assertPublicConfig(await response.json());
}

function apiUrl(config: PublicConfig, path: string): string {
  return config.apiBaseUrl.replace(/\/+$/, "") + path;
}

export async function apiRequest(
  config: PublicConfig,
  path: string,
  options: ApiRequestOptions = {},
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
      fields:
        isRecord(payload) &&
        Array.isArray(payload.fields) &&
        payload.fields.every((field) => typeof field === "string")
          ? payload.fields
          : undefined,
    });
  }
  return payload;
}

export async function requestWithRefresh(
  config: PublicConfig,
  session: Session,
  path: string,
  options: AuthenticatedRequestOptions,
  isActive: () => boolean,
): Promise<unknown> {
  let accessToken = session.accessToken();
  if (!accessToken)
    throw Object.assign(new Error("No active session"), { code: "UNAUTHORIZED", status: 401 });

  try {
    return await apiRequest(config, path, { ...options, accessToken });
  } catch (error) {
    const firstError = asApiError(error);
    if (firstError.status !== 401 || !isActive()) throw firstError;

    let refreshed;
    try {
      refreshed = await session.restore();
    } catch (refreshError) {
      if (!isActive()) throw firstError;
      throw Object.assign(asApiError(refreshError), { refreshFailed: true });
    }
    if (!isActive()) throw firstError;
    if (!refreshed) throw firstError;
    accessToken = refreshed.accessToken;
    return apiRequest(config, path, { ...options, accessToken });
  }
}
