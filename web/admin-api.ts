import { requestWithRefresh } from "./api";
import type { Session } from "./session";

export type AdminPublicConfig = {
  environment: string;
  region: string;
  userPoolId: string;
  clientId: string;
  apiBaseUrl: string;
};

export type AdminRequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
