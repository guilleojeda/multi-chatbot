import { validateProfileInput, type ProfileConfig, type ProfileDocument } from "../config/profile";

export type ProfileIdentity = { sub: string; botId: string; generation: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function invalidProfileResponse() {
  return Object.assign(new Error("Invalid profile response"), {
    code: "INVALID_RESPONSE",
    status: 502,
  });
}

function parseProfileDocument(
  value: unknown,
  config: ProfileConfig,
  identity: ProfileIdentity,
): ProfileDocument {
  if (!isRecord(value)) throw invalidProfileResponse();
  const expectedKeys = new Set(["sub", "botId", "updatedAt", "fields", "responsePreferenceIds"]);
  if (
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    value.sub !== identity.sub ||
    value.botId !== identity.botId ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    new Date(value.updatedAt).toISOString() !== value.updatedAt
  ) {
    throw invalidProfileResponse();
  }

  const responsePreferenceIds = Object.hasOwn(value, "responsePreferenceIds")
    ? value.responsePreferenceIds
    : [];
  const storedFields = value.fields;
  if (
    !isRecord(storedFields) ||
    config.fields.some((field) => !Object.hasOwn(storedFields, field.id))
  ) {
    throw invalidProfileResponse();
  }
  const validation = validateProfileInput({ fields: storedFields, responsePreferenceIds }, config);
  if (!validation.ok) throw invalidProfileResponse();
  return {
    sub: identity.sub,
    botId: identity.botId,
    updatedAt: value.updatedAt,
    fields: validation.value.fields,
    responsePreferenceIds: validation.value.responsePreferenceIds,
  };
}

export function parseProfileEnvelope(
  value: unknown,
  config: ProfileConfig,
  identity: ProfileIdentity,
): ProfileDocument | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["sub", "botId", "profile"].includes(key)) ||
    value.sub !== identity.sub ||
    value.botId !== identity.botId ||
    !Object.hasOwn(value, "profile")
  ) {
    throw invalidProfileResponse();
  }
  if (value.profile === null) return null;
  return parseProfileDocument(value.profile, config, identity);
}
