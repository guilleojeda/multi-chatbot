export type QuotaPolicy = {
  dailyLimit: number;
  monthlyLimit: number;
  revision: string;
};

export function isValidQuotaLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isValidQuotaRevision(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseQuotaPolicy(value: unknown): QuotaPolicy {
  if (
    !isRecord(value) ||
    !isValidQuotaLimit(value.dailyLimit) ||
    !isValidQuotaLimit(value.monthlyLimit) ||
    !isValidQuotaRevision(value.revision)
  ) {
    throw new Error("Quota policy is missing or invalid; refusing new submissions.");
  }

  return {
    dailyLimit: Number(value.dailyLimit),
    monthlyLimit: Number(value.monthlyLimit),
    revision: value.revision,
  };
}
