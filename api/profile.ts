import {
  isStoredProfile,
  validateProfileInput,
  type ProfileConfig,
  type ProfileDocument,
  type StoredProfile,
} from "../config/profile.js";
import { accessTokenSubject } from "./auth.js";

type ProfileStore = {
  hasMember(sub: string, botId: string): Promise<boolean>;
  getProfile(input: { sub: string; botId: string }): Promise<StoredProfile | null>;
  putProfile(profile: ProfileDocument): Promise<void>;
};

type ProfileHandlerDependencies = {
  config: { botId: string; profile: ProfileConfig };
  store: ProfileStore;
  now: () => number;
};

type HttpEvent = {
  rawPath?: string;
  body?: string;
  isBase64Encoded?: boolean;
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

type ReadBodyResult = { kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" };

const profilePath = "/api/profile";
const maxBodyBytes = 16 * 1024;

function json(statusCode: number, body: Record<string, unknown>): ApiResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function readBody(event: HttpEvent): ReadBodyResult {
  if (event.body === undefined || event.body.length === 0) {
    return { kind: "ok", value: {} };
  }

  let source: string;
  let byteLength: number;
  if (event.isBase64Encoded) {
    const decoded = Buffer.from(event.body, "base64");
    byteLength = decoded.byteLength;
    source = decoded.toString("utf8");
  } else {
    source = event.body;
    byteLength = Buffer.byteLength(source, "utf8");
  }

  if (byteLength > maxBodyBytes) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(source) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

function safeFailure(): ApiResponse {
  return json(503, {
    code: "TRY_AGAIN",
    message: "No pudimos completar la operación. Intentá de nuevo.",
  });
}

function apiProfile(profile: StoredProfile | null): StoredProfile | null {
  if (!profile) return null;
  return {
    ...profile,
    responsePreferenceIds: profile.responsePreferenceIds ?? [],
  };
}

export function createProfileHandler({ config, store, now }: ProfileHandlerDependencies) {
  async function authorize(event: HttpEvent): Promise<string | ApiResponse> {
    const sub = accessTokenSubject(event.requestContext?.authorizer?.jwt?.claims);
    if (!sub) {
      return json(401, { code: "UNAUTHORIZED", message: "Iniciá sesión para continuar." });
    }
    if (!(await store.hasMember(sub, config.botId))) {
      return json(403, {
        code: "FORBIDDEN",
        message: "Esta cuenta no tiene acceso a este proyecto.",
      });
    }
    return sub;
  }

  async function getProfile(sub: string): Promise<ApiResponse> {
    const key = { sub, botId: config.botId };
    const profile = await store.getProfile(key);
    if (profile === null) return json(200, { ...key, profile: null });
    if (!isStoredProfile(profile, key, config.profile)) return safeFailure();
    return json(200, { ...key, profile: apiProfile(profile) });
  }

  async function putProfile(event: HttpEvent, sub: string): Promise<ApiResponse> {
    const body = readBody(event);
    if (body.kind === "too-large") {
      return json(413, {
        code: "PAYLOAD_TOO_LARGE",
        message: "El perfil supera el tamaño permitido.",
        fields: [],
      });
    }
    if (body.kind === "invalid") {
      return json(400, {
        code: "INVALID_PROFILE",
        message: "El perfil no tiene un formato válido.",
        fields: [],
      });
    }

    const validation = validateProfileInput(body.value, config.profile);
    if (!validation.ok) {
      return json(400, {
        code: "INVALID_PROFILE",
        message: "Revisá los campos del perfil.",
        fields: validation.fields,
      });
    }

    const profile: ProfileDocument = {
      sub,
      botId: config.botId,
      ...validation.value,
      updatedAt: new Date(now()).toISOString(),
    };
    await store.putProfile(profile);
    return json(200, {
      sub,
      botId: config.botId,
      profile,
    });
  }

  return async function handler(event: HttpEvent): Promise<ApiResponse> {
    const method = event.requestContext?.http?.method?.toUpperCase() || "";
    const path = event.requestContext?.http?.path || event.rawPath || "";
    if (path !== profilePath || (method !== "GET" && method !== "PUT")) {
      return json(404, { code: "NOT_FOUND", message: "No encontramos esa ruta." });
    }

    try {
      const authorization = await authorize(event);
      if (typeof authorization !== "string") return authorization;
      return method === "GET"
        ? await getProfile(authorization)
        : await putProfile(event, authorization);
    } catch {
      return safeFailure();
    }
  };
}
