import { useEffect, useRef, useState, type FormEvent } from "react";

export type AccountView =
  | "login"
  | "invite-new"
  | "invite-existing"
  | "recover-request"
  | "recover-confirm"
  | "ready"
  | "denied";

export type AccountPendingAction = "request-reset" | "resend-reset" | "confirm-reset";

export type AccountState = {
  view: AccountView;
  identity?: { sub: string; botId: string; generation: number };
  email?: string;
  pending?: boolean;
  error?: string;
  notice?: string;
  projectName?: string;
  retryable?: boolean;
  canSignOut?: boolean;
  pendingAction?: AccountPendingAction;
};

export type AccountSubmission =
  | { action: "sign-in"; email: string; password: string }
  | { action: "accept-new"; email: string; password: string }
  | { action: "accept-existing"; email: string; password: string }
  | { action: "request-password-reset"; email: string }
  | { action: "resend-password-reset"; email: string }
  | { action: "confirm-password-reset"; email: string; code: string; password: string }
  | { action: "change-recovery-email" }
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
  "recover-request": {
    title: "Recuperá tu contraseña",
    description: "Ingresá el email de tu cuenta para solicitar un código de recuperación.",
  },
  "recover-confirm": {
    title: "Elegí una nueva contraseña",
    description: "Si recibiste un código en tu email, ingresalo para continuar.",
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

const passwordPolicyHint =
  "Usá al menos 8 caracteres, con una mayúscula, una minúscula, un número y un símbolo.";

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
    setPasswordError("");
  }, [state.view]);

  useEffect(() => {
    if (state.error || passwordError) errorRef.current?.focus();
  }, [state.error, passwordError]);

  function submit(
    event: FormEvent<HTMLFormElement>,
    action:
      | "sign-in"
      | "accept-new"
      | "accept-existing"
      | "request-password-reset"
      | "confirm-password-reset",
  ) {
    event.preventDefault();
    setPasswordError("");
    const form = event.currentTarget;
    const email = valueFrom(form, "email").trim().toLowerCase();
    if (action === "request-password-reset") {
      void onSubmit({ action, email });
      return;
    }

    const password = valueFrom(form, "password");

    if (
      (action === "accept-new" || action === "confirm-password-reset") &&
      password !== valueFrom(form, "confirmPassword")
    ) {
      setPasswordError("Las contraseñas no coinciden.");
      return;
    }

    if (action === "confirm-password-reset") {
      void onSubmit({ action, email, code: valueFrom(form, "code").trim(), password });
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
          <p className="eyebrow account-eyebrow">
            {state.view === "recover-request" || state.view === "recover-confirm"
              ? "Recuperación de contraseña"
              : "Acceso por invitación"}
          </p>
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
                : state.view === "recover-request"
                  ? "Preparando la recuperación…"
                  : state.view === "recover-confirm"
                    ? state.pendingAction === "resend-reset"
                      ? "Solicitando otro código…"
                      : state.pendingAction === "confirm-reset"
                        ? "Actualizando tu contraseña…"
                        : "Enviando el código…"
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

          {state.view === "recover-request" ? (
            <form
              key="recover-request"
              className="account-form"
              onSubmit={(event) => submit(event, "request-password-reset")}
            >
              <label htmlFor="recovery-email">Email</label>
              <input
                id="recovery-email"
                name="email"
                type="email"
                autoComplete="email"
                defaultValue={state.email || ""}
                required
                disabled={busy}
              />
              <button className="account-button" type="submit" disabled={busy}>
                {busy ? "Enviando…" : "Enviar código"}
              </button>
              <a className="account-text-link" href="/#/login">
                Volver a iniciar sesión
              </a>
            </form>
          ) : null}

          {state.view === "recover-confirm" ? (
            <>
              <form
                key="recover-confirm"
                className="account-form"
                onSubmit={(event) => submit(event, "confirm-password-reset")}
              >
                <label htmlFor="recovery-confirm-email">Email</label>
                <input
                  id="recovery-confirm-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={state.email || ""}
                  readOnly
                  required
                  disabled={busy}
                />
                <label htmlFor="recovery-code">Código de recuperación</label>
                <input
                  id="recovery-code"
                  name="code"
                  type="text"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  required
                  disabled={busy}
                />
                <label htmlFor="recovery-password">Elegí una nueva contraseña</label>
                <input
                  id="recovery-password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  aria-describedby="recovery-password-hint"
                  required
                  disabled={busy}
                />
                <p id="recovery-password-hint" className="account-field-hint">
                  {passwordPolicyHint}
                </p>
                <label htmlFor="recovery-confirm-password">Confirmá la nueva contraseña</label>
                <input
                  id="recovery-confirm-password"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  disabled={busy}
                />
                <button className="account-button" type="submit" disabled={busy}>
                  {busy ? "Actualizando…" : "Cambiar contraseña"}
                </button>
              </form>
              <div className="account-actions">
                <button
                  className="account-button account-button--secondary"
                  type="button"
                  onClick={() =>
                    void onSubmit({ action: "resend-password-reset", email: state.email || "" })
                  }
                  disabled={busy}
                >
                  Reenviar código
                </button>
                <button
                  className="account-button account-button--secondary"
                  type="button"
                  onClick={() => void onSubmit({ action: "change-recovery-email" })}
                  disabled={busy}
                >
                  Cambiar email
                </button>
                <a className="account-text-link" href="/#/login">
                  Volver a iniciar sesión
                </a>
              </div>
            </>
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
                {passwordPolicyHint}
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
              <a className="account-button" href="/#/chat">
                Ir al chat
              </a>
              <a className="account-button account-button--secondary" href="/#/profile">
                Mi perfil
              </a>
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
              ¿Olvidaste tu contraseña?{" "}
              <a className="account-text-link" href="/#/recover">
                Recuperala
              </a>{" "}
              <span aria-hidden="true">·</span> El acceso se habilita únicamente mediante una
              invitación.{" "}
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
