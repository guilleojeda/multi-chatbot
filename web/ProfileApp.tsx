import { useCallback, useEffect, useRef, useState } from "react";
import {
  validateProfileInput,
  type ProfileConfig,
  type ProfileDocument,
  type ProfileDraft,
} from "../config/profile";
import { asApiError, requestWithRefresh, type PublicConfig } from "./api";
import { type Session } from "./session";
import { ProfileScreen, type ProfileScreenState } from "./ProfileScreen";

type ProfileIdentity = { sub: string; botId: string; generation: number };
type ConfirmedProfile = { hasProfile: boolean; draft: ProfileDraft };
type RequestKind = "load" | "save";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyDraft(config: ProfileConfig): ProfileDraft {
  return {
    fields: Object.fromEntries(
      config.fields.map((field) => [field.id, field.type === "text-list" ? [""] : []]),
    ),
    responsePreferenceIds: [],
  };
}

function cloneDraft(draft: ProfileDraft): ProfileDraft {
  return {
    fields: Object.fromEntries(
      Object.entries(draft.fields).map(([fieldId, values]) => [fieldId, [...values]]),
    ),
    responsePreferenceIds: [...draft.responsePreferenceIds],
  };
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

function parseProfileEnvelope(
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

function invalidProfileResponse() {
  return Object.assign(new Error("Invalid profile response"), {
    code: "INVALID_RESPONSE",
    status: 502,
  });
}

function fieldErrorMessages(fieldIds: string[], config: ProfileConfig) {
  const errors: Record<string, string> = {};
  for (const fieldId of fieldIds) {
    const field = config.fields.find(({ id }) => id === fieldId);
    if (field) errors[fieldId] = `Revisá el campo «${field.label}».`;
  }
  return errors;
}

function saveErrorMessage(status: number, code: string) {
  if (status === 413 || code === "PAYLOAD_TOO_LARGE") {
    return "El perfil supera el tamaño permitido. Acortá los valores y volvé a guardar.";
  }
  if (status >= 500 || status === 0 || code === "INVALID_RESPONSE" || code === "NETWORK_ERROR") {
    return "No pudimos confirmar el guardado. Puede haberse aplicado. Podés reintentar el guardado o descartar y recargar.";
  }
  return "No pudimos guardar el perfil. Revisá los datos e intentá de nuevo.";
}

export function ProfileApp({
  config,
  apiConfig,
  session,
  identity,
  projectName,
  onSignOut,
  onUnauthorized,
  onForbidden,
}: {
  config: ProfileConfig;
  apiConfig: PublicConfig;
  session: Session;
  identity: ProfileIdentity;
  projectName: string;
  onSignOut: () => void | Promise<void>;
  onUnauthorized: () => void;
  onForbidden: () => void;
}) {
  const identityKey = `${identity.sub}\u0000${identity.botId}\u0000${identity.generation}`;
  const identityKeyRef = useRef(identityKey);
  identityKeyRef.current = identityKey;
  const viewGenerationRef = useRef(0);
  const confirmedRef = useRef<ConfirmedProfile | null>(null);
  const requestKindRef = useRef<RequestKind | null>(null);
  const contextRef = useRef<{
    identityKey: string;
    isActive: () => boolean;
    invalidate: () => void;
  } | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [state, setState] = useState<ProfileScreenState>(() => ({
    view: "loading",
    draft: emptyDraft(config),
    hasProfile: false,
  }));

  useEffect(() => {
    let active = true;
    const viewGeneration = ++viewGenerationRef.current;
    const isActive = () =>
      active &&
      viewGenerationRef.current === viewGeneration &&
      identityKeyRef.current === identityKey;
    const invalidate = () => {
      active = false;
    };
    contextRef.current = { identityKey, isActive, invalidate };
    confirmedRef.current = null;
    requestKindRef.current = "load";
    setState({ view: "loading", draft: emptyDraft(config), hasProfile: false });

    void requestWithRefresh(apiConfig, session, "/profile", {}, isActive)
      .then((payload) => {
        if (!isActive()) return;
        const profile = parseProfileEnvelope(payload, config, identity);
        const hasProfile = profile !== null;
        const draft = hasProfile ? cloneDraft(profile) : emptyDraft(config);
        confirmedRef.current = { hasProfile, draft: cloneDraft(draft) };
        setState({ view: "editing", draft, hasProfile });
      })
      .catch((error: unknown) => {
        if (!isActive()) return;
        const apiError = asApiError(error);
        if (apiError.status === 401 || apiError.refreshFailed) {
          requestKindRef.current = null;
          invalidate();
          setState({ view: "loading", draft: emptyDraft(config), hasProfile: false });
          onUnauthorized();
          return;
        }
        if (apiError.status === 403) {
          requestKindRef.current = null;
          invalidate();
          setState({ view: "loading", draft: emptyDraft(config), hasProfile: false });
          onForbidden();
          return;
        }
        setState({
          view: "load-error",
          draft: emptyDraft(config),
          hasProfile: false,
          error: "No pudimos cargar tu perfil. Podés reintentar.",
        });
      })
      .finally(() => {
        if (isActive()) requestKindRef.current = null;
      });

    return () => {
      invalidate();
      if (contextRef.current?.identityKey === identityKey) contextRef.current = null;
      if (requestKindRef.current === "load") requestKindRef.current = null;
    };
  }, [apiConfig, config, identity, identityKey, onForbidden, onUnauthorized, reloadCount, session]);

  const currentContext = useCallback(() => {
    const context = contextRef.current;
    return context && context.identityKey === identityKeyRef.current && context.isActive()
      ? context
      : null;
  }, []);

  const loadProfile = useCallback(() => {
    if (!currentContext() || requestKindRef.current) return;
    setState({ view: "loading", draft: emptyDraft(config), hasProfile: false });
    setReloadCount((count) => count + 1);
  }, [config, currentContext]);

  const changeField = useCallback(
    (fieldId: string, values: string[]) => {
      if (!currentContext() || requestKindRef.current) return;
      setState((current) => ({
        ...current,
        draft: { ...current.draft, fields: { ...current.draft.fields, [fieldId]: [...values] } },
        error: current.saveUnconfirmed ? current.error : undefined,
        fieldErrors: undefined,
        notice: undefined,
      }));
    },
    [currentContext],
  );

  const changePreferences = useCallback(
    (ids: string[]) => {
      if (!currentContext() || requestKindRef.current) return;
      setState((current) => ({
        ...current,
        draft: { ...current.draft, responsePreferenceIds: [...ids] },
        error: current.saveUnconfirmed ? current.error : undefined,
        fieldErrors: undefined,
        notice: undefined,
      }));
    },
    [currentContext],
  );

  const saveProfile = useCallback(async () => {
    const context = currentContext();
    if (!context || requestKindRef.current || state.view !== "editing") return;

    const candidate: ProfileDraft = {
      fields: Object.fromEntries(
        config.fields.map((field) => {
          const values = state.draft.fields[field.id] || [];
          return [
            field.id,
            field.type === "text-list"
              ? values.filter((value) => value.trim().length > 0)
              : [...values],
          ];
        }),
      ),
      responsePreferenceIds: [...state.draft.responsePreferenceIds],
    };
    const validation = validateProfileInput(candidate, config);
    if (!validation.ok) {
      const fieldErrors = fieldErrorMessages(validation.fields, config);
      setState((current) => ({
        ...current,
        error:
          Object.keys(fieldErrors).length > 0
            ? "Completá los campos obligatorios para guardar tu perfil."
            : "Revisá las opciones seleccionadas.",
        fieldErrors,
        notice: undefined,
      }));
      return;
    }

    requestKindRef.current = "save";
    setState((current) => ({
      ...current,
      saving: true,
      error: undefined,
      fieldErrors: undefined,
      notice: undefined,
      saveUnconfirmed: false,
    }));
    try {
      const payload = await requestWithRefresh(
        apiConfig,
        session,
        "/profile",
        { method: "PUT", body: candidate },
        context.isActive,
      );
      if (!context.isActive()) return;
      const document = parseProfileEnvelope(payload, config, identity);
      if (!document) throw invalidProfileResponse();
      const draft = cloneDraft(document);
      confirmedRef.current = { hasProfile: true, draft: cloneDraft(draft) };
      setState({
        view: "editing",
        draft,
        hasProfile: true,
        saving: false,
        notice: "Perfil guardado.",
      });
    } catch (error) {
      if (!context.isActive()) return;
      const apiError = asApiError(error);
      if (apiError.status === 401 || apiError.refreshFailed) {
        requestKindRef.current = null;
        context.invalidate();
        setState({ view: "loading", draft: emptyDraft(config), hasProfile: false });
        onUnauthorized();
        return;
      }
      if (apiError.status === 403) {
        requestKindRef.current = null;
        context.invalidate();
        setState({ view: "loading", draft: emptyDraft(config), hasProfile: false });
        onForbidden();
        return;
      }
      const fieldErrors = fieldErrorMessages(apiError.fields || [], config);
      const saveUnconfirmed =
        apiError.status === 0 ||
        apiError.status >= 500 ||
        apiError.code === "NETWORK_ERROR" ||
        apiError.code === "INVALID_RESPONSE";
      setState((current) => ({
        ...current,
        view: "editing",
        saving: false,
        error:
          apiError.status === 400 && Object.keys(fieldErrors).length > 0
            ? "Revisá los campos indicados e intentá guardar de nuevo."
            : saveErrorMessage(apiError.status, apiError.code),
        fieldErrors: Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined,
        saveUnconfirmed,
        notice: undefined,
      }));
    } finally {
      if (context.isActive()) requestKindRef.current = null;
    }
  }, [
    apiConfig,
    config,
    currentContext,
    identity,
    onForbidden,
    onUnauthorized,
    session,
    state.draft,
    state.view,
  ]);

  const discardChanges = useCallback(() => {
    if (!currentContext() || requestKindRef.current) return;
    const confirmed = confirmedRef.current;
    const draft = confirmed ? cloneDraft(confirmed.draft) : emptyDraft(config);
    setState({
      view: "editing",
      draft,
      hasProfile: confirmed?.hasProfile ?? false,
      notice: "Se descartaron los cambios sin guardar.",
    });
  }, [config, currentContext]);

  const signOut = useCallback(() => {
    const context = currentContext();
    if (context) context.invalidate();
    requestKindRef.current = null;
    confirmedRef.current = null;
    setState({ view: "loading", draft: emptyDraft(config), hasProfile: false });
    void onSignOut();
  }, [config, currentContext, onSignOut]);

  const retry = useCallback(() => {
    if (state.saveUnconfirmed) {
      void saveProfile();
      return;
    }
    loadProfile();
  }, [loadProfile, saveProfile, state.saveUnconfirmed]);

  const visibleState =
    contextRef.current && contextRef.current.identityKey !== identityKey
      ? { view: "loading" as const, draft: emptyDraft(config), hasProfile: false }
      : state;

  return (
    <ProfileScreen
      config={config}
      state={visibleState}
      onChangeField={changeField}
      onChangePreferences={changePreferences}
      onSave={saveProfile}
      onDiscard={discardChanges}
      onRetry={retry}
      onReload={loadProfile}
      onSignOut={signOut}
      projectName={projectName}
    />
  );
}
