import { useState, type FormEvent } from "react";

export type ChatProfileStatus = "loading" | "incomplete" | "error" | "complete";
export type ChatQueryStatus =
  "idle" | "sending" | "streaming" | "completed" | "failed" | "unconfirmed";

export type ChatScreenState = {
  profileStatus: ChatProfileStatus;
  queryStatus: ChatQueryStatus;
  question?: string;
  answer?: string;
  error?: string;
  projectName?: string;
};

export type ChatScreenProps = {
  state: ChatScreenState;
  onSubmit: (text: string) => void;
  onSignOut: () => void | Promise<void>;
  onRetryProfile: () => void;
  onReset: () => void;
  onCopy: (text: string) => void | Promise<void>;
};

export function ChatScreen({
  state,
  onSubmit,
  onSignOut,
  onRetryProfile,
  onReset,
  onCopy,
}: ChatScreenProps) {
  const [draft, setDraft] = useState("");
  const [copyError, setCopyError] = useState("");
  const sending = state.queryStatus === "sending" || state.queryStatus === "streaming";
  const queryEnded =
    state.queryStatus === "completed" ||
    state.queryStatus === "failed" ||
    state.queryStatus === "unconfirmed";
  const canSubmit =
    state.profileStatus === "complete" && state.queryStatus === "idle" && draft.trim().length > 0;
  const progressMessage =
    state.queryStatus === "sending"
      ? "Enviando consulta…"
      : state.queryStatus === "streaming"
        ? "Generando respuesta…"
        : state.queryStatus === "idle"
          ? "Escribí una consulta para empezar."
          : state.queryStatus === "completed"
            ? "La respuesta está completa."
            : "";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setCopyError("");
    onSubmit(draft);
    setDraft("");
  }

  async function copyAnswer() {
    if (state.queryStatus !== "completed" || !state.answer) return;
    try {
      await onCopy(state.answer);
      setCopyError("");
    } catch {
      setCopyError("No pudimos copiar la respuesta. Podés seleccionar el texto y copiarlo.");
    }
  }

  return (
    <div className="site-shell chat-shell">
      <header className="site-header chat-header">
        <a className="site-header__name" href="/">
          {state.projectName || "Asistente para docentes"}
        </a>
        <span className="site-header__label">Primera consulta</span>
      </header>

      <main className="chat-main">
        <section className="chat-card" aria-labelledby="chat-title">
          <p className="eyebrow chat-eyebrow">Asistente para docentes</p>
          <h1 id="chat-title">Consultá o prepará un material</h1>

          <p className="chat-knowledge-note">
            Este asistente responde con conocimiento general. Todavía no utiliza documentos del
            proyecto.
          </p>
          <p className="chat-limit-note">
            Cada consulta inicia un hilo nuevo. Todavía no podés retomar consultas anteriores.
          </p>

          <nav className="chat-account-actions" aria-label="Acciones de cuenta">
            <a className="account-button account-button--secondary" href="/#/profile">
              Mi perfil
            </a>
            <button
              className="account-button account-button--secondary"
              type="button"
              onClick={() => void onSignOut()}
            >
              Cerrar sesión
            </button>
          </nav>

          {state.profileStatus === "loading" ? (
            <p className="chat-profile-message" role="status" aria-live="polite">
              Cargando tu perfil…
            </p>
          ) : null}

          {state.profileStatus === "incomplete" ? (
            <div className="chat-profile-message">
              <p>Completá tu perfil para conversar.</p>
              <a className="account-text-link" href="/#/profile">
                Ir a Mi perfil
              </a>
            </div>
          ) : null}

          {state.profileStatus === "error" ? (
            <div className="chat-profile-message" role="alert">
              <p>{state.error || "No pudimos cargar tu perfil."}</p>
              <button className="account-button" type="button" onClick={onRetryProfile}>
                Reintentar
              </button>
            </div>
          ) : null}

          {state.profileStatus === "complete" ? (
            <div className="chat-conversation">
              {state.question ? (
                <p className="chat-question">
                  <span className="chat-message-label">Tu consulta</span>
                  {state.question}
                </p>
              ) : null}

              {state.answer ? (
                <div className="chat-answer-block">
                  <p className="chat-message-label">Respuesta</p>
                  <div className="chat-answer">{state.answer}</div>
                </div>
              ) : null}

              {progressMessage ? (
                <p className="chat-progress" role="status" aria-live="polite">
                  {progressMessage}
                </p>
              ) : null}

              {state.queryStatus === "failed" ? (
                <p className="chat-result-error" role="alert">
                  {state.error || "La respuesta quedó incompleta."}
                </p>
              ) : null}
              {state.queryStatus === "unconfirmed" ? (
                <p className="chat-result-error" role="alert">
                  {state.error ||
                    "No pudimos confirmar que la respuesta haya terminado. Todavía no podés recuperar este envío desde esta pantalla."}
                </p>
              ) : null}
              {state.queryStatus === "completed" ? (
                <div className="chat-result-actions">
                  <button
                    className="account-button"
                    type="button"
                    onClick={() => void copyAnswer()}
                  >
                    Copiar respuesta
                  </button>
                  <button
                    className="account-button account-button--secondary"
                    type="button"
                    onClick={onReset}
                  >
                    Volver al inicio
                  </button>
                  {copyError ? (
                    <p className="chat-result-error" role="alert">
                      {copyError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {state.queryStatus === "failed" || state.queryStatus === "unconfirmed" ? (
                <button
                  className="account-button account-button--secondary"
                  type="button"
                  onClick={onReset}
                >
                  Volver al inicio
                </button>
              ) : null}

              {!queryEnded ? (
                <form className="chat-form" onSubmit={submit}>
                  <label htmlFor="chat-query">Escribí tu consulta</label>
                  <textarea
                    id="chat-query"
                    name="query"
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    rows={4}
                    disabled={sending}
                    placeholder="Por ejemplo, pedí una explicación o un material para usar en clase."
                  />
                  <button className="account-button" type="submit" disabled={!canSubmit || sending}>
                    {sending ? "Enviando…" : "Enviar"}
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </section>
      </main>

      <footer className="site-footer chat-footer">
        <span>{state.projectName || "Asistente para docentes"}</span>
        <span>Consultas guardadas para prestar el servicio y permitir su revisión.</span>
      </footer>
    </div>
  );
}
