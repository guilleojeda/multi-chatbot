import { useEffect, useRef, useState, type FormEvent } from "react";
import type { QuotaView } from "../runtime/contracts";

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
  ordinal?: number;
  canContinue?: boolean;
  quota?: QuotaView;
  quotaReceivedAt?: number;
  queryErrorCode?: string;
  recovered?: boolean;
  recoveryLoading?: boolean;
  canRetry?: boolean;
  profileError?: string;
  queryError?: string;
  projectName?: string;
};

export type ChatScreenProps = {
  state: ChatScreenState;
  onSubmit: (text: string) => void | boolean;
  onSignOut: () => void | Promise<void>;
  onRetryProfile: () => void;
  onReset: () => void;
  onCopy: (text: string) => void | Promise<void>;
};

type CopyTarget = {
  latestOperation: number;
  error: boolean;
};

function createCopyTarget(): CopyTarget {
  return { latestOperation: 0, error: false };
}

function remainingQuotaTime(quota: QuotaView, elapsedMs = 0): string | null {
  if (quota.blockedUntil === null) return null;
  let remaining = quota.blockedUntil - quota.serverNow - elapsedMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;

  const units = [
    { duration: 86_400_000, singular: "día", plural: "días" },
    { duration: 3_600_000, singular: "hora", plural: "horas" },
    { duration: 60_000, singular: "minuto", plural: "minutos" },
  ];
  const parts: string[] = [];
  for (const { duration, singular, plural } of units) {
    const amount = Math.floor(remaining / duration);
    if (amount === 0) continue;
    parts.push(`${amount} ${amount === 1 ? singular : plural}`);
    remaining %= duration;
    if (parts.length === 2) break;
  }
  return parts.length > 0 ? parts.join(" y ") : "menos de un minuto";
}

export function ChatScreen({
  state,
  onSubmit,
  onSignOut,
  onRetryProfile,
  onReset,
  onCopy,
}: ChatScreenProps) {
  const [draft, setDraft] = useState("");
  const [quotaNow, setQuotaNow] = useState(0);
  const [, setCopyRevision] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queryRef = useRef<HTMLTextAreaElement>(null);
  const focusQueryAfterResetRef = useRef(false);
  const previousTurns = state.previousTurns || [];
  const previousCopyTargetsRef = useRef<(CopyTarget | null)[]>([]);
  const currentCopyTargetRef = useRef<CopyTarget | null>(null);
  const copyEpochRef = useRef(0);
  const sawConversationRef = useRef(false);
  const hasConversation =
    previousTurns.length > 0 ||
    Boolean(state.question || state.answer) ||
    state.queryStatus !== "idle";

  if (!hasConversation && sawConversationRef.current) {
    copyEpochRef.current += 1;
    previousCopyTargetsRef.current = [];
    currentCopyTargetRef.current = null;
  } else if (previousCopyTargetsRef.current.length > previousTurns.length) {
    copyEpochRef.current += 1;
    previousCopyTargetsRef.current = [];
    currentCopyTargetRef.current = null;
  }
  sawConversationRef.current = hasConversation;
  while (previousCopyTargetsRef.current.length < previousTurns.length) {
    previousCopyTargetsRef.current.push(null);
  }

  function copyTargetForPrevious(index: number): CopyTarget {
    const current = previousCopyTargetsRef.current[index];
    if (current) return current;
    const target = createCopyTarget();
    previousCopyTargetsRef.current[index] = target;
    return target;
  }

  function copyTargetForCurrent(): CopyTarget {
    currentCopyTargetRef.current ??= createCopyTarget();
    return currentCopyTargetRef.current;
  }

  const sending = state.queryStatus === "sending" || state.queryStatus === "streaming";
  const canSubmitForState =
    state.queryStatus === "idle" ||
    (state.queryStatus === "completed" && state.canContinue !== false) ||
    (state.queryStatus === "failed" && state.canContinue !== false) ||
    (state.queryStatus === "rejected" && Boolean(state.quota)) ||
    (state.queryStatus === "rejected" && state.queryErrorCode === "storage_capacity_exceeded");
  const canSubmit =
    state.profileStatus === "complete" && canSubmitForState && draft.trim().length > 0;
  const showConversation =
    state.profileStatus === "complete" ||
    previousTurns.length > 0 ||
    Boolean(state.question || state.answer) ||
    state.queryStatus !== "idle";
  const showComposer =
    state.profileStatus === "complete" &&
    state.queryStatus !== "unconfirmed" &&
    (state.queryStatus !== "rejected" ||
      Boolean(state.quota) ||
      state.queryErrorCode === "storage_capacity_exceeded") &&
    (state.queryStatus !== "failed" || state.canContinue !== false);
  const quotaElapsed =
    state.quotaReceivedAt === undefined ? 0 : Math.max(0, quotaNow - state.quotaReceivedAt);
  const quotaTime = state.quota ? remainingQuotaTime(state.quota, quotaElapsed) : null;
  const quotaMessage = quotaTime
    ? `Llegaste al límite de uso, vas a poder seguir usando la aplicación en ${quotaTime}`
    : null;
  const progressMessage = state.recoveryLoading
    ? "Recuperando el último envío…"
    : state.queryStatus === "sending"
      ? "Enviando consulta…"
      : state.queryStatus === "streaming"
        ? state.recoveryLoading
          ? "Recuperando el último envío…"
          : "Generando respuesta…"
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

  useEffect(() => {
    if (state.queryStatus === "rejected" && state.question) {
      setDraft(state.question);
    }
  }, [state.queryStatus, state.question]);

  useEffect(() => {
    if (!state.quota || state.quota.blockedUntil === null || state.quotaReceivedAt === undefined) {
      return;
    }

    setQuotaNow(performance.now());

    const timer = window.setInterval(() => {
      setQuotaNow(performance.now());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [state.quota, state.quotaReceivedAt]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    if (onSubmit(draft) === false) return;
    while (previousCopyTargetsRef.current.length < previousTurns.length) {
      previousCopyTargetsRef.current.push(null);
    }
    previousCopyTargetsRef.current[previousTurns.length] =
      (state.queryStatus === "completed" || state.queryStatus === "failed") && state.answer
        ? currentCopyTargetRef.current
        : null;
    currentCopyTargetRef.current = null;
    setDraft("");
  }

  function restart() {
    focusQueryAfterResetRef.current = true;
    const preserveRejectedDraft =
      state.queryStatus === "rejected" &&
      (state.queryErrorCode === "capacity_exceeded" ||
        state.queryErrorCode === "storage_capacity_exceeded");
    setDraft(preserveRejectedDraft ? draft || state.question || "" : "");
    copyEpochRef.current += 1;
    previousCopyTargetsRef.current = [];
    currentCopyTargetRef.current = null;
    sawConversationRef.current = false;
    setCopyRevision((revision) => revision + 1);
    onReset();
  }

  async function copyAnswer(text: string, target: CopyTarget) {
    if (!text) return;
    const epoch = copyEpochRef.current;
    const operation = ++target.latestOperation;
    function settle(error: boolean) {
      if (copyEpochRef.current !== epoch || target.latestOperation !== operation) return;
      target.error = error;
      setCopyRevision((revision) => revision + 1);
    }

    try {
      await onCopy(text);
      settle(false);
    } catch {
      settle(true);
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
            Se conserva el último envío de esta pestaña para recuperar su estado. Antes de que se
            admita, la consulta se guarda temporalmente; después se conserva solo su referencia.
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
              <p>{state.profileError || "No pudimos cargar tu perfil."}</p>
              <button className="account-button" type="button" onClick={onRetryProfile}>
                Reintentar
              </button>
            </div>
          ) : null}

          {(state.queryStatus === "idle" || state.queryStatus === "completed") &&
          state.queryError ? (
            <p className="chat-result-error" role="alert">
              {state.queryError}
            </p>
          ) : null}

          {showConversation ? (
            <div className="chat-conversation">
              {state.recovered ? (
                <p className="chat-context-note" role="status">
                  Recuperamos el último envío de esta conversación
                </p>
              ) : null}
              {sending ? (
                <p className="chat-context-note" role="status">
                  El trabajo puede continuar aunque dejes esta pantalla o cierres sesión. El cupo
                  consumido no se devuelve.
                </p>
              ) : null}
              {previousTurns.length > 0 ? (
                <ol className="chat-previous-turns" aria-label="Intercambios anteriores">
                  {previousTurns.map((turn, index) => {
                    const copyTarget = copyTargetForPrevious(index);
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
                              onClick={() => void copyAnswer(turn.answer, copyTarget)}
                            >
                              Copiar respuesta anterior {index + 1}
                            </button>
                          ) : (
                            <p className="chat-context-note">
                              Respuesta incompleta; este intercambio no se incluye en el contexto de
                              seguimientos.
                            </p>
                          )}
                          {copyTarget?.error ? (
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

              {quotaMessage ? (
                <p className="chat-quota-message" role="status" aria-live="polite">
                  {quotaMessage}
                </p>
              ) : null}

              {state.answer ? (
                <div className="chat-answer-block">
                  <p className="chat-message-label">Respuesta</p>
                  <div className="chat-answer">{state.answer}</div>
                  {state.queryStatus === "completed" || state.queryStatus === "failed" ? (
                    <button
                      className="account-button chat-copy-button"
                      type="button"
                      onClick={() => void copyAnswer(state.answer || "", copyTargetForCurrent())}
                    >
                      {state.queryStatus === "completed"
                        ? "Copiar respuesta"
                        : "Copiar texto parcial"}
                    </button>
                  ) : null}
                  {currentCopyTargetRef.current?.error ? (
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
                    {state.queryError || "La respuesta quedó incompleta."}
                  </p>
                  <p className="chat-context-note">
                    Este intercambio incompleto no se incluirá en el contexto del siguiente
                    seguimiento.
                  </p>
                </>
              ) : null}
              {state.queryStatus === "rejected" ? (
                state.quota ? null : (
                  <>
                    <p className="chat-result-error" role="alert">
                      {state.queryError ||
                        "No se admitió esta consulta. Volvé al inicio para comenzar un hilo nuevo."}
                    </p>
                    {state.canRetry && state.question ? (
                      <button
                        className="account-button account-button--secondary chat-restart-button"
                        type="button"
                        onClick={() => {
                          if (onSubmit(state.question || "") !== false) setDraft("");
                        }}
                      >
                        Reintentar el mismo envío
                      </button>
                    ) : null}
                  </>
                )
              ) : null}
              {state.queryStatus === "unconfirmed" && !state.recoveryLoading ? (
                <>
                  <p className="chat-result-error" role="alert">
                    {state.queryError || "No pudimos confirmar el estado de esta consulta."}
                  </p>
                  {state.canRetry && state.question ? (
                    <button
                      className="account-button account-button--secondary chat-restart-button"
                      type="button"
                      onClick={() => {
                        if (onSubmit(state.question || "") !== false) setDraft("");
                      }}
                    >
                      Reintentar el mismo envío
                    </button>
                  ) : null}
                </>
              ) : null}
              {state.queryStatus === "streaming" && state.queryError ? (
                <p className="chat-result-error" role="alert">
                  {state.queryError}
                </p>
              ) : null}

              {state.queryStatus === "completed" ||
              state.queryStatus === "failed" ||
              sending ||
              (state.queryStatus === "rejected" && !state.quota && !state.canRetry) ||
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
