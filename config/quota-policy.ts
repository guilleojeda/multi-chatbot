export type QuotaPolicy = {
  dailyLimit: number;
  monthlyLimit: number;
  revision: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseQuotaPolicy(value: unknown): QuotaPolicy {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.dailyLimit) ||
    Number(value.dailyLimit) < 0 ||
    !Number.isSafeInteger(value.monthlyLimit) ||
    Number(value.monthlyLimit) < 0 ||
    typeof value.revision !== "string" ||
    value.revision.trim().length === 0
  ) {
    throw new Error("Quota policy is missing or invalid; refusing new submissions.");
  }

  return {
    dailyLimit: Number(value.dailyLimit),
    monthlyLimit: Number(value.monthlyLimit),
    revision: value.revision,
  };
}
