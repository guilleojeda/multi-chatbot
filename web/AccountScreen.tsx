import { useEffect, useRef, useState, type FormEvent } from "react";

export type AccountView = "login" | "invite-new" | "invite-existing" | "ready" | "denied";

export type AccountState = {
  view: AccountView;
  email?: string;
  pending?: boolean;
  error?: string;
  notice?: string;
  projectName?: string;
  retryable?: boolean;
  canSignOut?: boolean;
};

export type AccountSubmission =
  | { action: "sign-in"; email: string; password: string }
  | { action: "accept-new"; email: string; password: string }
  | { action: "accept-existing"; email: string; password: string }
  | { action: "retry" };

export type AccountScreenProps = {
  state: AccountState;
  onSubmit: (submission: AccountSubmission) => void | Promise<void>;
  onSignOut: () => void | Promise<void>;
};

const viewCopy: Record<AccountView, { title: string; description: string }> = {
  login: {
    title: "Iniciá sesión",
    description: "Ingresá con el email asociado a tu invitación.",
  },
  "invite-new": {
    title: "Activá tu cuenta",
    description: "Elegí una contraseña para activar el acceso a este asistente.",
  },
  "invite-existing": {
    title: "Aceptá la invitación",
    description: "Iniciá sesión con la cuenta invitada para agregar este asistente.",
  },
  ready: {
    title: "Tu acceso está activo",
    description: "Tu cuenta tiene acceso a este asistente.",
  },
  denied: {
    title: "No se pudo confirmar el acceso",
    description: "Revisá el enlace o volvé a la página pública.",
  },
};

function valueFrom(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value : "";
}

export function AccountScreen({ state, onSubmit, onSignOut }: AccountScreenProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [passwordError, setPasswordError] = useState("");
  const busy = Boolean(state.pending);
  const copy = viewCopy[state.view];

  useEffect(() => {
    headingRef.current?.focus();
  }, [state.view]);

  useEffect(() => {
    if (state.error || passwordError) errorRef.current?.focus();
  }, [state.error, passwordError]);

  function submit(
    event: FormEvent<HTMLFormElement>,
    action: "sign-in" | "accept-new" | "accept-existing",
  ) {
    event.preventDefault();
    setPasswordError("");
    const form = event.currentTarget;
    const email = valueFrom(form, "email").trim().toLowerCase();
    const password = valueFrom(form, "password");

    if (action === "accept-new" && password !== valueFrom(form, "confirmPassword")) {
      setPasswordError("Las contraseñas no coinciden.");
      return;
    }

    void onSubmit({ action, email, password });
  }

  return (
    <div className="site-shell account-shell">
      <header className="site-header account-header">
        <a className="site-header__name account-home-link" href="/">
          {state.projectName || "Asistente para docentes"}
        </a>
        <a className="site-header__label account-public-link" href="/">
          Página pública
        </a>
      </header>

      <main className="account-main">
        <section className="account-card" aria-labelledby="account-title">
          <p className="eyebrow account-eyebrow">Acceso por invitación</p>
          <h1 id="account-title" ref={headingRef} tabIndex={-1}>
            {copy.title}
          </h1>
          <p className="account-description">{copy.description}</p>

          {state.notice ? (
            <p className="account-notice" role="status">
              {state.notice}
            </p>
          ) : null}
          {state.error || passwordError ? (
            <p className="account-error" role="alert" ref={errorRef} tabIndex={-1}>
              {passwordError || state.error}
            </p>
          ) : null}
          {busy ? (
            <p className="account-progress" role="status" aria-live="polite">
              {state.view === "invite-new" || state.view === "invite-existing"
                ? "Procesando la invitación…"
                : "Comprobando tu acceso…"}
            </p>
          ) : null}

          {state.view === "login" ? (
            <form
              key="login"
              className="account-form"
              onSubmit={(event) => submit(event, "sign-in")}
            >
              <label htmlFor="account-email">Email</label>
              <input
                id="account-email"
                name="email"
                type="email"
                autoComplete="username"
                defaultValue={state.email || ""}
                required
                disabled={busy}
              />
              <label htmlFor="account-password">Contraseña</label>
              <input
                id="account-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={busy}
              />
              <button className="account-button" type="submit" disabled={busy}>
                {busy ? "Ingresando…" : "Iniciar sesión"}
              </button>
            </form>
          ) : null}

          {state.view === "invite-new" ? (
            <form
              key="invite-new"
              className="account-form"
              onSubmit={(event) => submit(event, "accept-new")}
            >
              <label htmlFor="invite-email">Email de la invitación</label>
              <input
                id="invite-email"
                name="email"
                type="email"
                autoComplete="username"
                value={state.email || ""}
                readOnly
                required
                disabled={busy}
              />
              <label htmlFor="invite-password">Elegí una contraseña</label>
              <input
                id="invite-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                disabled={busy}
                aria-describedby="invite-password-hint"
              />
              <p id="invite-password-hint" className="account-field-hint">
                Usá al menos 8 caracteres, con una mayúscula, una minúscula, un número y un símbolo.
              </p>
              <label htmlFor="invite-confirm-password">Confirmá la contraseña</label>
              <input
                id="invite-confirm-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                disabled={busy}
              />
              <button className="account-button" type="submit" disabled={busy}>
                {busy ? "Activando cuenta…" : "Activar cuenta"}
              </button>
            </form>
          ) : null}

          {state.view === "invite-existing" ? (
            <>
              {state.email ? <p className="account-email">{state.email}</p> : null}
              <form
                key="invite-existing"
                className="account-form"
                onSubmit={(event) => submit(event, "accept-existing")}
              >
                <label htmlFor="existing-invite-email">Email invitado</label>
                <input
                  id="existing-invite-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  value={state.email || ""}
                  readOnly
                  required
                  disabled={busy}
                />
                <label htmlFor="existing-invite-password">Contraseña</label>
                <input
                  id="existing-invite-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  disabled={busy}
                />
                <button className="account-button" type="submit" disabled={busy}>
                  {busy ? "Aceptando invitación…" : "Iniciar sesión y aceptar"}
                </button>
              </form>
            </>
          ) : null}

          {state.view === "ready" ? (
            <div className="account-ready">
              {state.email ? <p className="account-email">{state.email}</p> : null}
              <p>{state.projectName || "Asistente para docentes"}</p>
              <button
                className="account-button account-button--secondary"
                type="button"
                onClick={() => void onSignOut()}
                disabled={busy}
              >
                Cerrar sesión
              </button>
            </div>
          ) : null}

          {state.view === "denied" ? (
            <div className="account-actions">
              {state.retryable ? (
                <button
                  className="account-button"
                  type="button"
                  onClick={() => void onSubmit({ action: "retry" })}
                  disabled={busy}
                >
                  {busy ? "Reintentando…" : "Reintentar"}
                </button>
              ) : null}
              {state.canSignOut ? (
                <button
                  className="account-button account-button--secondary"
                  type="button"
                  onClick={() => void onSignOut()}
                  disabled={busy}
                >
                  Cerrar sesión
                </button>
              ) : null}
              <a className="account-text-link" href="/#/login">
                Iniciar sesión
              </a>
              <a className="account-text-link" href="/">
                Volver a la página pública
              </a>
            </div>
          ) : null}

          {state.view === "login" && !busy ? (
            <p className="account-help">
              El acceso se habilita únicamente mediante una invitación.{" "}
              <a className="account-text-link" href="/">
                Volver a la página pública
              </a>
            </p>
          ) : null}
        </section>
      </main>

      <footer className="site-footer account-footer">
        <span>{state.projectName || "Asistente para docentes"}</span>
        <span>Acceso a tu cuenta</span>
      </footer>
    </div>
  );
}
