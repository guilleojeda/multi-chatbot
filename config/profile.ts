export type ProfileOption = {
  readonly id: string;
  readonly label: string;
};

export type MultiSelectProfileField = {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly type: "multi-select";
  readonly options: readonly ProfileOption[];
};

export type TextListProfileField = {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly type: "text-list";
};

export type ProfileField = MultiSelectProfileField | TextListProfileField;

export type ResponsePreference = {
  readonly id: string;
  readonly displayText: string;
  readonly promptText: string;
};

export type ProfileConfig = {
  readonly fields: readonly ProfileField[];
  readonly responsePreferences: readonly ResponsePreference[];
};

export type ProfileDraft = {
  fields: Record<string, string[]>;
  responsePreferenceIds: string[];
};

export type ProfileDocument = ProfileDraft & {
  sub: string;
  botId: string;
  updatedAt: string;
};

export type StoredProfile = Omit<ProfileDocument, "responsePreferenceIds"> & {
  responsePreferenceIds?: string[];
};

export type ProfileInputValidation =
  { ok: true; value: ProfileDraft } | { ok: false; fields: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function isStoredProfile(
  value: unknown,
  input: { sub: string; botId: string },
  config: ProfileConfig,
): value is StoredProfile {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set(["sub", "botId", "fields", "responsePreferenceIds", "updatedAt"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (
    value.sub !== input.sub ||
    value.botId !== input.botId ||
    !isCanonicalIsoDate(value.updatedAt)
  ) {
    return false;
  }
  if (!isRecord(value.fields)) return false;

  const configuredFieldIds = config.fields.map(({ id }) => id).sort();
  const storedFieldIds = Object.keys(value.fields).sort();
  if (
    configuredFieldIds.length !== storedFieldIds.length ||
    configuredFieldIds.some((id, index) => id !== storedFieldIds[index])
  ) {
    return false;
  }

  const responsePreferenceIds = value.responsePreferenceIds;
  if (
    responsePreferenceIds !== undefined &&
    (!Array.isArray(responsePreferenceIds) ||
      !responsePreferenceIds.every((id) => typeof id === "string"))
  ) {
    return false;
  }

  const draft = validateProfileInput(
    {
      fields: value.fields,
      responsePreferenceIds: responsePreferenceIds ?? [],
    },
    config,
  );
  if (!draft.ok) return false;

  for (const fieldId of configuredFieldIds) {
    const storedValues = value.fields[fieldId];
    const normalizedValues = draft.value.fields[fieldId];
    if (
      !Array.isArray(storedValues) ||
      storedValues.length !== normalizedValues.length ||
      storedValues.some((entry, index) => entry !== normalizedValues[index])
    ) {
      return false;
    }
  }

  const storedPreferences = responsePreferenceIds ?? [];
  return (
    storedPreferences.length === draft.value.responsePreferenceIds.length &&
    storedPreferences.every((id, index) => id === draft.value.responsePreferenceIds[index])
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function validateProfileInput(
  value: unknown,
  config: ProfileConfig,
): ProfileInputValidation {
  if (!isRecord(value)) return { ok: false, fields: [] };

  const invalidFields = new Set<string>();
  const allowedBodyKeys = new Set(["fields", "responsePreferenceIds"]);
  if (Object.keys(value).some((key) => !allowedBodyKeys.has(key))) {
    return { ok: false, fields: [] };
  }

  const fieldsValue = value.fields;
  if (!isRecord(fieldsValue)) {
    for (const field of config.fields) {
      if (field.required) invalidFields.add(field.id);
    }
    return { ok: false, fields: [...invalidFields] };
  }

  const configuredFields = new Map(config.fields.map((field) => [field.id, field]));
  for (const fieldId of Object.keys(fieldsValue)) {
    if (!configuredFields.has(fieldId)) invalidFields.add(fieldId);
  }

  const normalizedFields: Record<string, string[]> = {};
  for (const field of config.fields) {
    const fieldValue = fieldsValue[field.id];
    if (fieldValue === undefined) {
      normalizedFields[field.id] = [];
      if (field.required) invalidFields.add(field.id);
      continue;
    }

    if (!Array.isArray(fieldValue) || !fieldValue.every((item) => typeof item === "string")) {
      invalidFields.add(field.id);
      normalizedFields[field.id] = [];
      continue;
    }

    if (field.type === "multi-select") {
      const allowedOptions = new Set(field.options.map((option) => option.id));
      const selections = fieldValue as string[];
      if (selections.some((id) => !allowedOptions.has(id))) invalidFields.add(field.id);
      normalizedFields[field.id] = unique(selections.filter((id) => allowedOptions.has(id)));
    } else {
      const subjects = (fieldValue as string[]).map((subject) => subject.trim());
      if (subjects.some((subject) => subject.length === 0)) invalidFields.add(field.id);
      normalizedFields[field.id] = unique(subjects.filter((subject) => subject.length > 0));
    }

    if (field.required && normalizedFields[field.id].length === 0) invalidFields.add(field.id);
  }

  const responsePreferenceIds = value.responsePreferenceIds;
  if (
    !Array.isArray(responsePreferenceIds) ||
    !responsePreferenceIds.every((id) => typeof id === "string")
  ) {
    return { ok: false, fields: [...invalidFields] };
  }

  const configuredPreferences = new Set(config.responsePreferences.map(({ id }) => id));
  if (responsePreferenceIds.some((id) => !configuredPreferences.has(id))) {
    return { ok: false, fields: [...invalidFields] };
  }

  if (invalidFields.size > 0) return { ok: false, fields: [...invalidFields] };

  return {
    ok: true,
    value: {
      fields: normalizedFields,
      responsePreferenceIds: unique(responsePreferenceIds as string[]),
    },
  };
}
