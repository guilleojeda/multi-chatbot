import { useEffect, useRef, useState, type FormEvent } from "react";

export type ChatProfileStatus = "loading" | "incomplete" | "error" | "complete";
export type ChatQueryStatus =
  "idle" | "sending" | "streaming" | "completed" | "failed" | "rejected" | "unconfirmed";

export type PreviousChatTurn = {
  question: string;
  answer: string;
  status: "completed" | "failed";
};

export type ChatScreenState = {
  profileStatus: ChatProfileStatus;
  queryStatus: ChatQueryStatus;
  previousTurns?: PreviousChatTurn[];
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
  const [copyError, setCopyError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queryRef = useRef<HTMLTextAreaElement>(null);
  const focusQueryAfterResetRef = useRef(false);
  const previousTurns = state.previousTurns || [];
  const sending = state.queryStatus === "sending" || state.queryStatus === "streaming";
  const canSubmit =
    state.profileStatus === "complete" &&
    (state.queryStatus === "idle" ||
      state.queryStatus === "completed" ||
      state.queryStatus === "failed") &&
    draft.trim().length > 0;
  const showConversation =
    state.profileStatus === "complete" ||
    previousTurns.length > 0 ||
    Boolean(state.question || state.answer) ||
    state.queryStatus !== "idle";
  const showComposer =
    state.profileStatus === "complete" &&
    state.queryStatus !== "unconfirmed" &&
    state.queryStatus !== "rejected";
  const progressMessage =
    state.queryStatus === "sending"
      ? "Enviando consulta…"
      : state.queryStatus === "streaming"
        ? "Generando respuesta…"
        : state.queryStatus === "idle"
          ? previousTurns.length > 0
            ? "Escribí un seguimiento para continuar este hilo."
            : "Escribí una consulta para empezar."
          : state.queryStatus === "completed"
            ? "La respuesta está completa. Podés continuar este hilo."
            : "";

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (
      focusQueryAfterResetRef.current &&
      state.profileStatus === "complete" &&
      state.queryStatus === "idle"
    ) {
      focusQueryAfterResetRef.current = false;
      queryRef.current?.focus();
    }
  }, [state.profileStatus, state.queryStatus]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setCopyError(null);
    onSubmit(draft);
    setDraft("");
  }

  function restart() {
    focusQueryAfterResetRef.current = true;
    setDraft("");
    setCopyError(null);
    onReset();
  }

  async function copyAnswer(text: string, key: string) {
    if (!text) return;
    try {
      await onCopy(text);
      setCopyError(null);
    } catch {
      setCopyError(key);
    }
  }

  return (
    <div className="site-shell chat-shell">
      <header className="site-header chat-header">
        <a className="site-header__name" href="/">
          {state.projectName || "Asistente para docentes"}
        </a>
        <span className="site-header__label">Chat docente</span>
      </header>

      <main className="chat-main">
        <section className="chat-card" aria-labelledby="chat-title">
          <p className="eyebrow chat-eyebrow">Asistente para docentes</p>
          <h1 id="chat-title" ref={headingRef} tabIndex={-1}>
            Consultá o prepará un material
          </h1>

          <p className="chat-knowledge-note">
            Este asistente responde con conocimiento general. Todavía no utiliza documentos del
            proyecto.
          </p>
          <p className="chat-limit-note">
            Podés continuar este hilo mientras siga abierta tu sesión. Al recargar o cerrar sesión,
            el chat empieza vacío; todavía no podés abrir hilos anteriores.
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

          {showConversation ? (
            <div className="chat-conversation">
              {previousTurns.length > 0 ? (
                <ol className="chat-previous-turns" aria-label="Intercambios anteriores">
                  {previousTurns.map((turn, index) => {
                    const copyKey = `previous-${index}`;
                    return (
                      <li className="chat-previous-turn" key={`${index}-${turn.status}`}>
                        <p className="chat-question">
                          <span className="chat-message-label">
                            Tu consulta anterior {index + 1}
                          </span>
                          {turn.question}
                        </p>
                        <div className="chat-answer-block">
                          <p className="chat-message-label">Respuesta anterior {index + 1}</p>
                          <div className="chat-answer">{turn.answer}</div>
                          {turn.status === "completed" ? (
                            <button
                              className="account-button account-button--secondary chat-copy-button"
                              type="button"
                              aria-label={`Copiar respuesta anterior ${index + 1}`}
                              onClick={() => void copyAnswer(turn.answer, copyKey)}
                            >
                              Copiar respuesta anterior {index + 1}
                            </button>
                          ) : (
                            <p className="chat-context-note">
                              Respuesta incompleta; este intercambio no se incluye en el contexto de
                              seguimientos.
                            </p>
                          )}
                          {copyError === copyKey ? (
                            <p className="chat-result-error" role="alert">
                              No pudimos copiar la respuesta. Podés seleccionar el texto y copiarlo.
                            </p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : null}

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
                  {state.queryStatus === "completed" ? (
                    <button
                      className="account-button chat-copy-button"
                      type="button"
                      onClick={() => void copyAnswer(state.answer || "", "current")}
                    >
                      Copiar respuesta
                    </button>
                  ) : null}
                  {copyError === "current" ? (
                    <p className="chat-result-error" role="alert">
                      No pudimos copiar la respuesta. Podés seleccionar el texto y copiarlo.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {progressMessage ? (
                <p className="chat-progress" role="status" aria-live="polite">
                  {progressMessage}
                </p>
              ) : null}

              {state.queryStatus === "failed" ? (
                <>
                  <p className="chat-result-error" role="alert">
                    {state.error || "La respuesta quedó incompleta."}
                  </p>
                  <p className="chat-context-note">
                    Este intercambio incompleto no se incluirá en el contexto del siguiente
                    seguimiento.
                  </p>
                </>
              ) : null}
              {state.queryStatus === "rejected" ? (
                <p className="chat-result-error" role="alert">
                  {state.error ||
                    "No se admitió esta consulta. Volvé al inicio para comenzar un hilo nuevo."}
                </p>
              ) : null}
              {state.queryStatus === "unconfirmed" ? (
                <p className="chat-result-error" role="alert">
                  {state.error ||
                    "No pudimos confirmar que la respuesta haya terminado. Todavía no podés recuperar este envío desde esta pantalla."}
                </p>
              ) : null}

              {state.queryStatus === "completed" ||
              state.queryStatus === "failed" ||
              state.queryStatus === "rejected" ||
              state.queryStatus === "unconfirmed" ? (
                <button
                  className="account-button account-button--secondary chat-restart-button"
                  type="button"
                  onClick={restart}
                >
                  Volver al inicio
                </button>
              ) : null}

              {showComposer ? (
                <form className="chat-form" onSubmit={submit}>
                  <label htmlFor="chat-query">Escribí tu consulta</label>
                  <textarea
                    ref={queryRef}
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
