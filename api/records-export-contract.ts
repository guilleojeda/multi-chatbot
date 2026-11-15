import { createHash } from "node:crypto";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isRecordsExportId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}

export function recordsExecutionName(
  environment: string,
  botId: string,
  actorSub: string,
  exportId: string,
): string {
  const scope = JSON.stringify([environment, botId, actorSub, exportId]);
  return `records-${createHash("sha256").update(scope).digest("hex")}`;
}

export function exportAttemptKey(
  environment: string,
  botId: string,
  actorSub: string,
  exportId: string,
  attemptId: string,
): string {
  if (!isRecordsExportId(attemptId)) throw new TypeError("Invalid export attempt identity.");
  return `exports/${recordsExecutionName(environment, botId, actorSub, exportId)}/${attemptId}.csv`;
}

export function ownsRecordsExportKey(
  key: unknown,
  environment: string,
  botId: string,
  actorSub: string,
  exportId: string,
): key is string {
  if (typeof key !== "string" || !key.endsWith(".csv")) return false;
  const prefix = `exports/${recordsExecutionName(environment, botId, actorSub, exportId)}/`;
  return key.startsWith(prefix) && isRecordsExportId(key.slice(prefix.length, -4));
}
