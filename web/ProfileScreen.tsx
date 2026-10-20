import { useEffect, useRef, type FormEvent } from "react";
import type { ProfileConfig, ProfileDraft, ProfileField } from "../config/profile";

export type ProfileScreenState = {
  view: "loading" | "editing" | "load-error";
  draft: ProfileDraft;
  hasProfile: boolean;
  saving?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  notice?: string;
  saveUnconfirmed?: boolean;
};

export type ProfileScreenProps = {
  config: ProfileConfig;
  state: ProfileScreenState;
  onChangeField: (fieldId: string, values: string[]) => void;
  onChangePreferences: (ids: string[]) => void;
  onSave: () => void | Promise<void>;
  onDiscard: () => void;
  onRetry: () => void;
  onReload: () => void;
  onSignOut: () => void | Promise<void>;
  projectName?: string;
};

function fieldErrorId(fieldId: string) {
  return `profile-error-${fieldId}`;
}

function inputId(fieldId: string, suffix: string) {
  return `profile-${fieldId}-${suffix}`;
}

function fieldLegend(field: ProfileField) {
  return (
    <>
      {field.label}
      {field.required ? <span className="profile-required"> (obligatorio)</span> : null}
    </>
  );
}

export function ProfileScreen({
  config,
  state,
  onChangeField,
  onChangePreferences,
  onSave,
  onDiscard,
  onRetry,
  onReload,
  onSignOut,
  projectName = "Asistente para docentes",
}: ProfileScreenProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [state.view]);

  useEffect(() => {
    if (!state.error) return;
    const firstFieldId = Object.keys(state.fieldErrors || {})[0];
    if (firstFieldId) {
      const field = config.fields.find(({ id }) => id === firstFieldId);
      const controlId =
        field?.type === "multi-select"
          ? inputId(field.id, field.options[0]?.id || "")
          : inputId(firstFieldId, "0");
      document.getElementById(controlId)?.focus();
      return;
    }
    errorRef.current?.focus();
  }, [config.fields, state.error, state.fieldErrors]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSave();
  }

  function renderField(field: ProfileField) {
    const values = state.draft.fields[field.id] || [];
    const fieldError = state.fieldErrors?.[field.id];
    const describedBy = fieldError ? fieldErrorId(field.id) : undefined;

    if (field.type === "multi-select") {
      return (
        <fieldset
          className="profile-fieldset"
          key={field.id}
          disabled={state.saving}
          aria-describedby={describedBy}
          aria-required={field.required || undefined}
          aria-invalid={fieldError ? "true" : undefined}
        >
          <legend>{fieldLegend(field)}</legend>
          <div className="profile-choice-list">
            {field.options.map((option) => {
              const id = inputId(field.id, option.id);
              return (
                <label className="profile-choice" htmlFor={id} key={option.id}>
                  <input
                    id={id}
                    name={field.id}
                    type="checkbox"
                    value={option.id}
                    checked={values.includes(option.id)}
                    aria-invalid={fieldError ? "true" : undefined}
                    aria-required={field.required || undefined}
                    aria-describedby={describedBy}
                    onChange={(event) => {
                      const next = event.currentTarget.checked
                        ? [...values, option.id]
                        : values.filter((value) => value !== option.id);
                      onChangeField(field.id, next);
                    }}
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
          {fieldError ? (
            <p className="profile-field-error" id={fieldErrorId(field.id)}>
              {fieldError}
            </p>
          ) : null}
        </fieldset>
      );
    }

    const visibleValues = values.length > 0 ? values : [""];
    return (
      <fieldset
        className="profile-fieldset profile-fieldset--text-list"
        key={field.id}
        disabled={state.saving}
        aria-describedby={describedBy}
        aria-required={field.required || undefined}
        aria-invalid={fieldError ? "true" : undefined}
      >
        <legend>{fieldLegend(field)}</legend>
        <div className="profile-text-list">
          {visibleValues.map((value, index) => {
            const id = inputId(field.id, String(index));
            return (
              <div className="profile-text-list__row" key={`${field.id}-${index}`}>
                <div className="profile-text-list__input">
                  <label htmlFor={id}>
                    {field.label} {index + 1}
                  </label>
                  <input
                    id={id}
                    name={field.id}
                    type="text"
                    value={value}
                    aria-invalid={fieldError ? "true" : undefined}
                    aria-required={field.required || undefined}
                    aria-describedby={describedBy}
                    onChange={(event) => {
                      const next = [...visibleValues];
                      next[index] = event.currentTarget.value;
                      onChangeField(field.id, next);
                    }}
                  />
                </div>
                <button
                  className="account-button account-button--secondary profile-remove-button"
                  type="button"
                  aria-label={`Quitar ${field.label.toLowerCase()} ${index + 1}`}
                  onClick={() =>
                    onChangeField(
                      field.id,
                      values.filter((_, item) => item !== index),
                    )
                  }
                  disabled={state.saving}
                >
                  Quitar
                </button>
              </div>
            );
          })}
        </div>
        {fieldError ? (
          <p className="profile-field-error" id={fieldErrorId(field.id)}>
            {fieldError}
          </p>
        ) : null}
        <button
          className="account-button account-button--secondary profile-add-button"
          type="button"
          onClick={() => onChangeField(field.id, [...visibleValues, ""])}
          disabled={state.saving}
        >
          Agregar {field.label.toLowerCase().replace(/s$/, "")}
        </button>
      </fieldset>
    );
  }

  const busy = Boolean(state.saving);
  const loading = state.view === "loading";
  const loadError = state.view === "load-error";
  const editing = state.view === "editing";

  return (
    <div className="site-shell account-shell profile-shell">
      <header className="site-header account-header">
        <a className="site-header__name account-home-link" href="/">
          {projectName}
        </a>
        <nav className="profile-header-links" aria-label="Navegación de cuenta">
          <a className="site-header__label account-public-link" href="/#/chat">
            Volver al chat
          </a>
          <a className="site-header__label account-public-link" href="/">
            Página pública
          </a>
        </nav>
      </header>

      <main className="account-main profile-main">
        <section className="account-card profile-card" aria-labelledby="profile-title">
          <p className="eyebrow account-eyebrow">Perfil docente</p>
          <h1 id="profile-title" ref={headingRef} tabIndex={-1}>
            {loading
              ? "Cargando tu perfil"
              : loadError
                ? "No pudimos cargar tu perfil"
                : state.hasProfile
                  ? "Mi perfil"
                  : "Completá tu perfil"}
          </h1>
          <p className="account-description">
            {loading
              ? "Estamos consultando la información guardada de este asistente."
              : loadError
                ? "Tu perfil sigue protegido mientras volvemos a intentar la consulta."
                : "Completá tus niveles educativos y materias. Las preferencias son opcionales y solo se guardan cuando las elegís."}
          </p>

          {state.error ? (
            <p className="account-error profile-error" role="alert" ref={errorRef} tabIndex={-1}>
              {state.error}
            </p>
          ) : null}
          {state.notice ? (
            <p className="account-notice" role="status" aria-live="polite">
              {state.notice}
            </p>
          ) : null}
          {loading ? (
            <p className="account-progress" role="status" aria-live="polite">
              Cargando el perfil…
            </p>
          ) : null}

          {editing ? (
            <form className="profile-form" onSubmit={submit} noValidate>
              <div className="profile-fields">
                {config.fields.map(renderField)}
                <fieldset className="profile-fieldset" disabled={busy}>
                  <legend>Preferencias de respuesta (opcional)</legend>
                  <div className="profile-choice-list">
                    {config.responsePreferences.map((preference) => {
                      const id = inputId("response-preferences", preference.id);
                      return (
                        <label className="profile-choice" htmlFor={id} key={preference.id}>
                          <input
                            id={id}
                            name="responsePreferenceIds"
                            type="checkbox"
                            value={preference.id}
                            checked={state.draft.responsePreferenceIds.includes(preference.id)}
                            onChange={(event) => {
                              const next = event.currentTarget.checked
                                ? [...state.draft.responsePreferenceIds, preference.id]
                                : state.draft.responsePreferenceIds.filter(
                                    (value) => value !== preference.id,
                                  );
                              onChangePreferences(next);
                            }}
                          />
                          <span>{preference.displayText}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              </div>

              {busy ? (
                <p className="account-progress" role="status" aria-live="polite">
                  Guardando el perfil…
                </p>
              ) : null}
              <div className="profile-actions">
                <button className="account-button" type="submit" disabled={busy}>
                  {busy ? "Guardando…" : "Guardar perfil"}
                </button>
                {!state.saveUnconfirmed ? (
                  <button
                    className="account-button account-button--secondary"
                    type="button"
                    onClick={onDiscard}
                    disabled={busy}
                  >
                    Descartar cambios
                  </button>
                ) : null}
                {state.saveUnconfirmed ? (
                  <>
                    <button
                      className="account-button account-button--secondary"
                      type="button"
                      onClick={onRetry}
                      disabled={busy}
                    >
                      Reintentar guardado
                    </button>
                    <button
                      className="account-button account-button--secondary"
                      type="button"
                      onClick={onReload}
                      disabled={busy}
                    >
                      Descartar y recargar
                    </button>
                  </>
                ) : null}
              </div>
            </form>
          ) : null}

          {loadError ? (
            <div className="profile-actions">
              <button className="account-button" type="button" onClick={onRetry}>
                Reintentar
              </button>
            </div>
          ) : null}

          <div className="profile-session-actions">
            <button
              className="account-button account-button--secondary"
              type="button"
              onClick={() => void onSignOut()}
            >
              Cerrar sesión
            </button>
          </div>
          <p className="profile-navigation-note">
            Los cambios se guardan únicamente cuando seleccionás <strong>Guardar perfil</strong>. Al
            salir o recargar se descarta cualquier cambio sin guardar.
          </p>
        </section>
      </main>

      <footer className="site-footer account-footer">
        <span>{projectName}</span>
        <span>Perfil profesional</span>
      </footer>
    </div>
  );
}
