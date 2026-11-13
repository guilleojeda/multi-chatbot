import { requestWithRefresh } from "./api";
import type { Session } from "./session";
import { parseQuotaPolicy, type QuotaPolicy } from "../config/quota-policy";
import type { DocumentAction, DocumentFileInput } from "../config/documents";

export type AdminPublicConfig = {
  environment: string;
  region: string;
  userPoolId: string;
  clientId: string;
  apiBaseUrl: string;
};

export type AdminRequestOptions = {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  signal?: AbortSignal;
};

export type DocumentIntentBody = {
  operationId: string;
  action: DocumentAction;
  documentId?: string;
  expectedRevision?: string;
  file?: DocumentFileInput;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseAdminQuotaResponse(value: unknown, expectedBotId: string): QuotaPolicy {
  if (!isRecord(value) || value.botId !== expectedBotId || !isRecord(value.policy)) {
    throw new Error("INVALID_RESPONSE");
  }

  try {
    return parseQuotaPolicy(value.policy);
  } catch {
    throw new Error("INVALID_RESPONSE");
  }
}

export type AdminQuotaSaveResponse = QuotaPolicy & { changed: boolean };

export function parseAdminQuotaSaveResponse(
  value: unknown,
  expectedBotId: string,
): AdminQuotaSaveResponse {
  if (!isRecord(value) || value.botId !== expectedBotId || typeof value.changed !== "boolean") {
    throw new Error("INVALID_RESPONSE");
  }

  return { ...parseAdminQuotaResponse(value, expectedBotId), changed: value.changed };
}

export function assertAdminPublicConfig(value: unknown): AdminPublicConfig {
  if (!isRecord(value)) throw new Error("La configuración administrativa no es válida.");
  const { environment, region, userPoolId, clientId, apiBaseUrl } = value;
  if (
    typeof environment !== "string" ||
    !environment.trim() ||
    typeof region !== "string" ||
    !region.trim() ||
    typeof userPoolId !== "string" ||
    !userPoolId.trim() ||
    typeof clientId !== "string" ||
    !clientId.trim() ||
    typeof apiBaseUrl !== "string" ||
    !apiBaseUrl.startsWith("/") ||
    apiBaseUrl.startsWith("//")
  ) {
    throw new Error("La configuración administrativa no es válida.");
  }
  return { environment, region, userPoolId, clientId, apiBaseUrl };
}

export async function readAdminPublicConfig(): Promise<AdminPublicConfig> {
  const response = await fetch("/public-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("No se pudo leer la configuración administrativa.");
  return assertAdminPublicConfig(await response.json());
}

export async function adminRequest(
  config: AdminPublicConfig,
  session: Session,
  path: string,
  options: AdminRequestOptions,
  isActive: () => boolean,
): Promise<unknown> {
  return requestWithRefresh(config, session, path, options, isActive);
}

export function documentAdministrations(
  config: AdminPublicConfig,
  session: Session,
  botId: string,
  isActive: () => boolean,
) {
  const basePath = `/admin/bots/${encodeURIComponent(botId)}`;
  return {
    list(cursor?: string | null, signal?: AbortSignal) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      return adminRequest(config, session, `${basePath}/documents${query}`, { signal }, isActive);
    },
    createIntent(body: DocumentIntentBody) {
      return adminRequest(
        config,
        session,
        `${basePath}/document-operations`,
        { method: "POST", body },
        isActive,
      );
    },
    start(operationId: string) {
      return adminRequest(
        config,
        session,
        `${basePath}/document-operations/${encodeURIComponent(operationId)}/start`,
        { method: "POST", body: {} },
        isActive,
      );
    },
    get(operationId: string, signal?: AbortSignal) {
      return adminRequest(
        config,
        session,
        `${basePath}/document-operations/${encodeURIComponent(operationId)}`,
        { signal },
        isActive,
      );
    },
  };
}
