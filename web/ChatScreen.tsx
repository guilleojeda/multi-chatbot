import { useEffect, useRef, useState, type FormEvent } from "react";
import type { QuotaView } from "../runtime/contracts";

export type ChatProfileStatus = "loading" | "incomplete" | "error" | "complete";
export type ChatQueryStatus =
  "idle" | "sending" | "streaming" | "completed" | "failed" | "rejected" | "unconfirmed";

export type ChatHistoryConversation = {
  conversationId: string;
  label: string;
  pending?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastOrdinal: number;
  closed: boolean;
  activeQueryId?: string;
};

export type ChatHistoryTurn = {
  ordinal: number;
  queryId: string;
  question: string;
  answer: string;
  status: "in_progress" | "completed" | "failed";
  questionComplete: boolean;
  answerComplete: boolean;
  canContinue: boolean;
  failure?: { code?: string; message?: string };
};

export type ChatHistoryState = {
  status: "loading" | "ready" | "empty" | "error";
  conversations: ChatHistoryConversation[];
  nextCursor: string | null;
  loadingMore: boolean;
  selectedConversationId: string | null;
  turnsStatus: "idle" | "loading" | "ready" | "error";
  turns: ChatHistoryTurn[];
  turnsNextCursor: string | null;
  refreshRequired: boolean;
  loadingEarlier?: boolean;
  openingConversationId?: string;
  error?: string;
  turnsError?: string;
  closed?: boolean;
  canContinue?: boolean;
  throughOrdinal?: number;
};

export type ChatScreenState = {
  profileStatus: ChatProfileStatus;
  queryStatus: ChatQueryStatus;
  history?: ChatHistoryState;
  draft?: string;
  answerComplete?: boolean;
  queryId?: string;
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
  onSelectConversation?: (conversationId: string) => void | boolean | Promise<void | boolean>;
  onLoadMoreHistory?: () => void | Promise<void>;
  onRefreshHistory?: () => void | Promise<void>;
  onLoadEarlierTurns?: () => void | Promise<void>;
  onDraftChange?: (text: string) => void;
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
  onSelectConversation,
  onLoadMoreHistory,
  onRefreshHistory,
  onLoadEarlierTurns,
  onDraftChange,
}: ChatScreenProps) {
  const [mobileView, setMobileView] = useState<"history" | "chat">(
    state.history?.selectedConversationId ? "chat" : "history",
  );
  const draft = state.draft ?? "";
  const [quotaNow, setQuotaNow] = useState(0);
  const [, setCopyRevision] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const historyHeadingRef = useRef<HTMLHeadingElement>(null);
  const queryRef = useRef<HTMLTextAreaElement>(null);
  const focusQueryAfterResetRef = useRef(false);
  const previousCopyTargetsRef = useRef(new Map<string, CopyTarget>());
  const currentCopyTargetRef = useRef<CopyTarget | null>(null);
  const copyEpochRef = useRef(0);
  const sawConversationRef = useRef(false);
  const copyConversationRef = useRef<string | null>(state.history?.selectedConversationId ?? null);
  if (copyConversationRef.current !== (state.history?.selectedConversationId ?? null)) {
    copyConversationRef.current = state.history?.selectedConversationId ?? null;
    copyEpochRef.current += 1;
    previousCopyTargetsRef.current.clear();
    currentCopyTargetRef.current = null;
  }
  const historyTurns = state.history?.turns ?? [];
  const currentTurnAlreadyInHistory = Boolean(
    state.queryId && historyTurns.some((turn) => turn.queryId === state.queryId),
  );
  const hasConversation =
    historyTurns.length > 0 ||
    Boolean(state.question || state.answer) ||
    state.queryStatus !== "idle";

  if (!hasConversation && sawConversationRef.current) {
    copyEpochRef.current += 1;
    previousCopyTargetsRef.current.clear();
    currentCopyTargetRef.current = null;
  }
  sawConversationRef.current = hasConversation;

  function copyTargetKeyForPrevious(turn: Pick<ChatHistoryTurn, "queryId">): string {
    return turn.queryId;
  }

  function copyTargetForPrevious(turn: ChatHistoryTurn): CopyTarget {
    const key = copyTargetKeyForPrevious(turn);
    const current = previousCopyTargetsRef.current.get(key);
    if (current) return current;
    const target = createCopyTarget();
    previousCopyTargetsRef.current.set(key, target);
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
    state.profileStatus === "complete" &&
    state.history?.turnsStatus !== "loading" &&
    !state.history?.openingConversationId &&
    canSubmitForState &&
    draft.trim().length > 0;
  const showConversation =
    state.profileStatus === "complete" ||
    historyTurns.length > 0 ||
    Boolean(state.question || state.answer) ||
    state.queryStatus !== "idle" ||
    Boolean(
      state.history?.openingConversationId ||
      state.history?.turnsStatus === "loading" ||
      state.history?.turnsStatus === "error" ||
      state.history?.turnsError,
    );
  const showComposer =
    state.profileStatus === "complete" &&
    state.queryStatus !== "unconfirmed" &&
    (state.queryStatus !== "rejected" ||
      Boolean(state.quota) ||
      state.queryErrorCode === "storage_capacity_exceeded" ||
      state.queryErrorCode === "stale_base") &&
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
          ? historyTurns.length > 0
            ? "Escribí un seguimiento para continuar este hilo."
            : "Escribí una consulta para empezar."
          : state.queryStatus === "completed"
            ? "La respuesta está completa. Podés continuar este hilo."
            : "";

  useEffect(() => {
    if (mobileView === "history" && state.history) historyHeadingRef.current?.focus();
    else headingRef.current?.focus();
  }, [mobileView, state.history !== undefined]);

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
    if (state.queryStatus === "rejected" && state.question && !draft) {
      onDraftChange?.(state.question);
    }
  }, [state.queryStatus, state.question, draft, onDraftChange]);

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
    if (
      (state.queryStatus === "completed" || state.queryStatus === "failed") &&
      state.answer &&
      currentCopyTargetRef.current &&
      state.queryId
    ) {
      const key = copyTargetKeyForPrevious({ queryId: state.queryId });
      previousCopyTargetsRef.current.set(key, currentCopyTargetRef.current);
    }
    currentCopyTargetRef.current = null;
    onDraftChange?.("");
  }

  function restart() {
    focusQueryAfterResetRef.current = true;
    copyEpochRef.current += 1;
    previousCopyTargetsRef.current.clear();
    currentCopyTargetRef.current = null;
    sawConversationRef.current = false;
    setCopyRevision((revision) => revision + 1);
    onReset();
    setMobileView("chat");
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

  const history = state.history;
  const staleBaseRefreshRequired =
    state.queryErrorCode === "stale_base" && history?.refreshRequired === true;

  async function openConversation(conversationId: string) {
    const opened = await onSelectConversation?.(conversationId);
    if (opened !== false) setMobileView("chat");
  }

  function newConversation() {
    restart();
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
        {history ? (
          <aside
            className={`chat-history ${mobileView === "history" ? "chat-history--mobile-visible" : ""}`}
            aria-label="Historial de conversaciones"
          >
            <div className="chat-history__heading">
              <h2 id="chat-history-title" ref={historyHeadingRef} tabIndex={-1}>
                Historial
              </h2>
              <button
                className="account-button account-button--secondary chat-history__refresh"
                type="button"
                aria-label="Actualizar historial"
                onClick={() => void onRefreshHistory?.()}
              >
                Actualizar
              </button>
              <button
                className="account-button chat-history__new"
                type="button"
                onClick={newConversation}
              >
                Nueva conversación
              </button>
            </div>
            {history.status === "loading" ? (
              <p className="chat-history__message" role="status" aria-live="polite">
                Cargando historial…
              </p>
            ) : null}
            {history.status === "error" ? (
              <div className="chat-history__message" role="alert">
                <p>{history.error || "No pudimos cargar el historial."}</p>
                <button
                  className="account-button account-button--secondary"
                  type="button"
                  onClick={() => void onLoadMoreHistory?.()}
                >
                  Reintentar
                </button>
              </div>
            ) : null}
            {history.status === "empty" ? (
              <p className="chat-history__message">Todavía no hay conversaciones guardadas.</p>
            ) : null}
            {history.conversations.length > 0 ? (
              <ol className="chat-history__list" aria-labelledby="chat-history-title">
                {history.conversations.map((conversation) => {
                  const selected = history.selectedConversationId === conversation.conversationId;
                  return (
                    <li key={conversation.conversationId}>
                      <button
                        className="chat-history__item"
                        type="button"
                        aria-current={selected ? "page" : undefined}
                        onClick={() => void openConversation(conversation.conversationId)}
                      >
                        <span className="chat-history__label">{conversation.label}</span>
                        <span className="chat-history__meta">
                          {conversation.updatedAt
                            ? new Date(conversation.updatedAt).toLocaleDateString("es-AR")
                            : "Fecha no disponible"}
                          {conversation.pending
                            ? " · Sin confirmar"
                            : conversation.activeQueryId
                              ? " · En curso"
                              : conversation.closed
                                ? " · Cerrada"
                                : " · Abierta"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {history.nextCursor ? (
              <button
                className="account-button account-button--secondary chat-history__more"
                type="button"
                disabled={history.loadingMore}
                onClick={() => void onLoadMoreHistory?.()}
              >
                {history.loadingMore ? "Cargando…" : "Ver más conversaciones"}
              </button>
            ) : null}
          </aside>
        ) : null}
        <div
          className={`chat-main__content ${history && mobileView === "history" ? "chat-main__content--mobile-hidden" : ""}`}
        >
          {history && mobileView === "chat" ? (
            <button
              className="account-button account-button--secondary chat-mobile-history-back"
              type="button"
              onClick={() => setMobileView("history")}
            >
              Volver al historial
            </button>
          ) : null}
          <section className="chat-card" aria-labelledby="chat-title">
            <p className="eyebrow chat-eyebrow">Asistente para docentes</p>
            <h1 id="chat-title" ref={headingRef} tabIndex={-1}>
              Consultá o prepará un material
            </h1>

            <p className="chat-knowledge-note">
              Este asistente usa documentos del proyecto y puede complementar con conocimiento
              general.
            </p>
            <p className="chat-limit-note">
              Las conversaciones se guardan para que puedas consultarlas y continuarlas desde otra
              sesión.
            </p>
            {historyTurns.length > 0 ? (
              <p className="chat-context-note" role="note">
                En conversaciones largas usamos un resumen para continuar. Los mensajes originales
                siguen disponibles en el historial
              </p>
            ) : null}

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
                {historyTurns.length > 0 ? (
                  <ol className="chat-previous-turns" aria-label="Intercambios anteriores">
                    {historyTurns.map((turn, index) => {
                      const copyTarget = copyTargetForPrevious(turn);
                      const isCurrentTurn = Boolean(turn.queryId && turn.queryId === state.queryId);
                      const canCopyTurn =
                        (turn.status === "completed" && turn.answerComplete !== false) ||
                        (turn.status === "failed" && turn.answerComplete === true);
                      return (
                        <li className="chat-previous-turn" key={`${index}-${turn.status}`}>
                          <p className="chat-question">
                            <span className="chat-message-label">
                              {isCurrentTurn ? "Tu consulta" : `Tu consulta anterior ${index + 1}`}
                            </span>
                            {turn.question}
                          </p>
                          <div className="chat-answer-block">
                            <p className="chat-message-label">
                              {isCurrentTurn ? "Respuesta" : `Respuesta anterior ${index + 1}`}
                            </p>
                            <div className="chat-answer">{turn.answer}</div>
                            {canCopyTurn ? (
                              <button
                                className="account-button account-button--secondary chat-copy-button"
                                type="button"
                                aria-label={
                                  turn.status === "failed"
                                    ? isCurrentTurn
                                      ? "Copiar texto parcial"
                                      : `Copiar texto parcial anterior ${index + 1}`
                                    : isCurrentTurn
                                      ? "Copiar respuesta"
                                      : `Copiar respuesta anterior ${index + 1}`
                                }
                                onClick={() => void copyAnswer(turn.answer, copyTarget)}
                              >
                                {turn.status === "failed"
                                  ? isCurrentTurn
                                    ? "Copiar texto parcial"
                                    : `Copiar texto parcial anterior ${index + 1}`
                                  : isCurrentTurn
                                    ? "Copiar respuesta"
                                    : `Copiar respuesta anterior ${index + 1}`}
                              </button>
                            ) : (
                              <p className="chat-context-note">
                                {turn.status === "in_progress"
                                  ? turn.failure?.code === "unconfirmable"
                                    ? "No pudimos confirmar el estado remoto. El texto visible es un prefijo y no se puede continuar este hilo."
                                    : "Este envío sigue en curso."
                                  : "Respuesta incompleta; este intercambio no se incluye en el contexto de seguimientos."}
                              </p>
                            )}
                            {copyTarget?.error ? (
                              <p className="chat-result-error" role="alert">
                                No pudimos copiar la respuesta. Podés seleccionar el texto y
                                copiarlo.
                              </p>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                ) : null}

                {history?.turnsStatus === "loading" ? (
                  <p className="chat-progress" role="status" aria-live="polite">
                    Cargando conversación…
                  </p>
                ) : null}
                {history?.turnsError ? (
                  <p className="chat-result-error" role="alert">
                    {history.turnsError || "No pudimos abrir esta conversación."}
                  </p>
                ) : null}
                {history?.turnsNextCursor ? (
                  <button
                    className="account-button account-button--secondary chat-history__more-turns"
                    type="button"
                    disabled={history.loadingEarlier}
                    onClick={() => void onLoadEarlierTurns?.()}
                  >
                    {history.loadingEarlier
                      ? "Cargando mensajes…"
                      : history.turnsError
                        ? "Reintentar"
                        : "Ver mensajes anteriores"}
                  </button>
                ) : null}
                {history?.refreshRequired && history.selectedConversationId ? (
                  <div className="chat-result-error" role="alert">
                    <p>Otra pestaña avanzó esta conversación. Actualizala antes de continuar.</p>
                    <button
                      className="account-button account-button--secondary"
                      type="button"
                      onClick={() => void openConversation(history.selectedConversationId!)}
                    >
                      Actualizar conversación
                    </button>
                  </div>
                ) : null}

                {state.question && !currentTurnAlreadyInHistory ? (
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

                {state.answer && !currentTurnAlreadyInHistory ? (
                  <div className="chat-answer-block">
                    <p className="chat-message-label">Respuesta</p>
                    <div className="chat-answer">{state.answer}</div>
                    {(state.queryStatus === "completed" || state.queryStatus === "failed") &&
                    state.answerComplete !== false ? (
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
                      {!staleBaseRefreshRequired ? (
                        <p className="chat-result-error" role="alert">
                          {state.queryError ||
                            "No se admitió esta consulta. Volvé al inicio para comenzar un hilo nuevo."}
                        </p>
                      ) : null}
                      {state.canRetry && state.question ? (
                        <button
                          className="account-button account-button--secondary chat-restart-button"
                          type="button"
                          onClick={() => {
                            if (onSubmit(state.question || "") !== false) onDraftChange?.("");
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
                          if (onSubmit(state.question || "") !== false) onDraftChange?.("");
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
                      onChange={(event) => onDraftChange?.(event.currentTarget.value)}
                      rows={4}
                      disabled={
                        sending ||
                        state.history?.turnsStatus === "loading" ||
                        Boolean(state.history?.openingConversationId)
                      }
                      placeholder="Por ejemplo, pedí una explicación o un material para usar en clase."
                    />
                    <button
                      className="account-button"
                      type="submit"
                      disabled={!canSubmit || sending}
                    >
                      {sending ? "Enviando…" : "Enviar"}
                    </button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </main>

      <footer className="site-footer chat-footer">
        <span>{state.projectName || "Asistente para docentes"}</span>
        <span>Consultas guardadas para prestar el servicio y permitir su revisión.</span>
      </footer>
    </div>
  );
}
