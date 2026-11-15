import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { asApiError } from "./api";
import type { AdminPublicConfig } from "./admin-api";
import {
  parseRecordConversationPage,
  parseRecordExportDownload,
  parseRecordExportReceipt,
  parseRecordSearchPage,
  parseRecordTextPage,
  recordAdministrations,
  type ExportStatus,
  type RecordExportReceipt,
  type RecordFilters,
  type RecordProfileFields,
  type RecordSearchResult,
  type RecordStatus,
  type RecordTurnDescriptor,
} from "./admin-records-api";
import type { Session } from "./session";

type FilterDraft = {
  from: string;
  to: string;
  status: "" | RecordStatus;
  personId: string;
  levelId: string;
  subject: string;
  excludeTests: boolean;
};

type TextTurn = RecordTurnDescriptor & { question: string; answer: string };

type ConversationView = {
  kind: "loading" | "error" | "ready";
  conversationId: string;
  selectedOrdinal: number;
  personId?: string;
  hidden?: boolean;
  isTest?: boolean;
  throughOrdinal?: number;
  turns: TextTurn[];
  nextCursor: string | null;
  loadingMore?: boolean;
  error?: string;
};

type ExportJob = {
  exportId: string;
  filters: RecordFilters;
  state: "starting" | "uncertain" | ExportStatus;
  receipt?: RecordExportReceipt;
  error?: string;
};

type AdminRecordsProps = {
  botId: string;
  projectName: string;
  config: AdminPublicConfig;
  session: Session;
  sessionKey: string;
  active: boolean;
  onAuthorizationError: (status: 401 | 403) => void;
};

function cordobaDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Cordoba",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dateDaysBefore(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day - days));
  return [
    result.getUTCFullYear(),
    String(result.getUTCMonth() + 1).padStart(2, "0"),
    String(result.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function defaultDraft(): FilterDraft {
  const to = cordobaDate(new Date());
  return {
    from: dateDaysBefore(to, 29),
    to,
    status: "",
    personId: "",
    levelId: "",
    subject: "",
    excludeTests: true,
  };
}

function filtersFromDraft(draft: FilterDraft): RecordFilters {
  const from = draft.from.trim();
  const to = draft.to.trim();
  if ((from && !isDateValue(from)) || (to && !isDateValue(to))) {
    throw new Error("Ingresá fechas válidas para aplicar los filtros.");
  }
  if (from && to && from > to) {
    throw new Error("La fecha Desde no puede ser posterior a Hasta.");
  }
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(draft.status ? { status: draft.status } : {}),
    ...(draft.personId.trim() ? { personId: draft.personId.trim() } : {}),
    ...(draft.levelId ? { levelId: draft.levelId } : {}),
    ...(draft.subject.trim() ? { subject: draft.subject.trim() } : {}),
    excludeTests: draft.excludeTests,
  };
}

function isDateValue(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
  );
}

function makeUuid(): string {
  if (typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function messageForReadError(error: unknown): string {
  if (error instanceof Error && error.message === "INVALID_RESPONSE") {
    return "El servidor devolvió registros no válidos. Volvé a intentar la lectura.";
  }
  return "No pudimos leer los registros. Revisá la conexión e intentá de nuevo.";
}

function formatRecordDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fecha no disponible";
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Cordoba",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function statusLabel(status: RecordStatus): string {
  if (status === "in_progress") return "En curso";
  if (status === "completed") return "Completada";
  return "Fallida";
}

function valuesForField(values: RecordProfileFields[string]): string[] {
  return values.map((value) =>
    typeof value === "string" ? value : `${value.label} (${value.id})`,
  );
}

function profileFieldLabel(fieldId: string): string {
  if (fieldId === "educationLevels") return "Nivel educativo";
  if (fieldId === "subjects") return "Materias";
  return fieldId;
}

function filterSummary(filters: RecordFilters | null): string {
  if (!filters) return "Todavía no aplicaste filtros.";
  const values: string[] = [];
  if (filters.from || filters.to) {
    values.push(`Fechas: ${filters.from || "sin inicio"} a ${filters.to || "sin fin"}`);
  }
  if (filters.status) values.push(`Estado: ${statusLabel(filters.status)}`);
  if (filters.personId) values.push(`Persona: ${filters.personId}`);
  if (filters.levelId) values.push(`Nivel: ${filters.levelId}`);
  if (filters.subject) values.push(`Materia: ${filters.subject}`);
  values.push(filters.excludeTests ? "Pruebas del equipo excluidas" : "Incluye pruebas del equipo");
  return values.join(" · ");
}

function exportStatusMessage(job: ExportJob | undefined): string | null {
  if (!job) return null;
  if (job.state === "starting") return "Iniciando la preparación del archivo…";
  if (job.state === "uncertain")
    return job.error ?? "No se pudo confirmar el inicio de la preparación.";
  if (job.state === "processing")
    return (
      job.error ?? "Preparando el CSV con todas las consultas de cada conversación coincidente…"
    );
  if (job.state === "ready") return "El archivo está listo.";
  if (job.state === "empty") return "Sin consultas para exportar.";
  if (job.state === "expired") return "El archivo venció. Podés preparar una exportación nueva.";
  return job.error ?? "No se pudo preparar el archivo.";
}

function isAuthError(error: unknown): error is { status: 401 | 403 } {
  const status = asApiError(error).status;
  return status === 401 || status === 403;
}

function turnWithText(turn: RecordTurnDescriptor, question: string, answer: string): TextTurn {
  return { ...turn, question, answer };
}

export function AdminRecords({
  botId,
  projectName,
  config,
  session,
  sessionKey,
  active,
  onAuthorizationError,
}: AdminRecordsProps) {
  const [draft, setDraft] = useState<FilterDraft>(defaultDraft);
  const [appliedFilters, setAppliedFilters] = useState<RecordFilters | null>(null);
  const [rows, setRows] = useState<RecordSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const [searchError, setSearchError] = useState("");
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [formError, setFormError] = useState("");
  const [, setExportRevision] = useState(0);
  const [downloadPendingBotId, setDownloadPendingBotId] = useState<string | null>(null);
  const botRef = useRef(botId);
  const mountedRef = useRef(true);
  const searchEpochRef = useRef(0);
  const detailEpochRef = useRef(0);
  const autoSearchKeysRef = useRef(new Set<string>());
  const exportJobsRef = useRef(new Map<string, ExportJob>());
  const exportRevisionRef = useRef(0);

  botRef.current = botId;

  const currentExport = exportJobsRef.current.get(botId);

  const updateExport = useCallback((targetBotId: string, job: ExportJob) => {
    exportJobsRef.current.set(targetBotId, job);
    exportRevisionRef.current += 1;
    setExportRevision(exportRevisionRef.current);
  }, []);

  const handleAuthError = useCallback(
    (error: unknown) => {
      if (!isAuthError(error)) return false;
      onAuthorizationError(error.status);
      return true;
    },
    [onAuthorizationError],
  );

  const searchRecords = useCallback(
    async (
      requestedBotId: string,
      filters: RecordFilters,
      cursor: string | null,
      append: boolean,
    ) => {
      const requestEpoch = ++searchEpochRef.current;
      const isCurrent = () =>
        mountedRef.current &&
        botRef.current === requestedBotId &&
        searchEpochRef.current === requestEpoch;
      setSearchState("loading");
      setSearchError("");
      try {
        const response = await recordAdministrations(
          config,
          session,
          requestedBotId,
          isCurrent,
        ).search(filters, cursor);
        if (!isCurrent()) return;
        const page = parseRecordSearchPage(response, requestedBotId);
        setRows((current) => {
          if (!append) return page.results;
          const merged = [...current];
          for (const row of page.results) {
            const existingIndex = merged.findIndex(
              (existing) =>
                existing.conversationId === row.conversationId && existing.queryId === row.queryId,
            );
            if (existingIndex === -1) merged.push(row);
            else merged[existingIndex] = row;
          }
          return merged;
        });
        setAppliedFilters(filters);
        setNextCursor(page.nextCursor);
        setSearchState("ready");
      } catch (error) {
        if (!isCurrent() || handleAuthError(error)) return;
        setSearchError(messageForReadError(error));
        setSearchState("error");
      }
    },
    [config, handleAuthError, session],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      searchEpochRef.current += 1;
      detailEpochRef.current += 1;
    };
  }, []);

  useEffect(() => {
    searchEpochRef.current += 1;
    detailEpochRef.current += 1;
    autoSearchKeysRef.current.delete(`${sessionKey}:${botId}`);
    setDraft(defaultDraft());
    setAppliedFilters(null);
    setRows([]);
    setNextCursor(null);
    setSearchState("idle");
    setSearchError("");
    setConversation(null);
    setFormError("");
  }, [botId, sessionKey]);

  useEffect(() => {
    if (!active || !botId) return;
    const autoSearchKey = `${sessionKey}:${botId}`;
    if (autoSearchKeysRef.current.has(autoSearchKey)) return;
    autoSearchKeysRef.current.add(autoSearchKey);
    const filters = filtersFromDraft(defaultDraft());
    setDraft(defaultDraft());
    setAppliedFilters(filters);
    void searchRecords(botId, filters, null, false);
  }, [active, botId, searchRecords, sessionKey]);

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let filters: RecordFilters;
    try {
      filters = filtersFromDraft(draft);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Revisá las fechas antes de continuar.",
      );
      return;
    }
    setFormError("");
    setConversation(null);
    setRows([]);
    setNextCursor(null);
    setAppliedFilters(filters);
    void searchRecords(botId, filters, null, false);
  };

  const clearFilters = () => {
    const next = { ...defaultDraft(), from: "", to: "" };
    setDraft(next);
    setFormError("");
  };

  const loadMoreResults = () => {
    if (!appliedFilters || !nextCursor || searchState === "loading") return;
    void searchRecords(botId, appliedFilters, nextCursor, true);
  };

  const readFullText = useCallback(
    async (
      requestedBotId: string,
      conversationId: string,
      ordinal: number,
      role: "question" | "answer",
      isCurrent: () => boolean,
    ) => {
      let cursor: string | null = null;
      let text = "";
      const seenCursors = new Set<string>();
      do {
        const response = await recordAdministrations(
          config,
          session,
          requestedBotId,
          isCurrent,
        ).text(conversationId, ordinal, role, cursor);
        if (!isCurrent()) throw new Error("STALE_REQUEST");
        const page = parseRecordTextPage(response, requestedBotId, conversationId, ordinal, role);
        text += page.text;
        cursor = page.nextCursor;
        if (cursor) {
          if (seenCursors.has(cursor)) throw new Error("INVALID_RESPONSE");
          seenCursors.add(cursor);
        }
      } while (cursor);
      return text;
    },
    [config, session],
  );

  const readTurn = useCallback(
    async (
      requestedBotId: string,
      conversationId: string,
      turn: RecordTurnDescriptor,
      isCurrent: () => boolean,
    ): Promise<TextTurn> => {
      const [question, answer] = await Promise.all([
        readFullText(requestedBotId, conversationId, turn.ordinal, "question", isCurrent),
        readFullText(requestedBotId, conversationId, turn.ordinal, "answer", isCurrent),
      ]);
      return turnWithText(turn, question, answer);
    },
    [readFullText],
  );

  const openConversation = async (row: RecordSearchResult) => {
    const requestEpoch = ++detailEpochRef.current;
    const requestedBotId = botId;
    const isCurrent = () =>
      mountedRef.current &&
      botRef.current === requestedBotId &&
      detailEpochRef.current === requestEpoch;
    setConversation({
      kind: "loading",
      conversationId: row.conversationId,
      selectedOrdinal: row.ordinal,
      turns: [],
      nextCursor: null,
    });
    try {
      const response = await recordAdministrations(
        config,
        session,
        requestedBotId,
        isCurrent,
      ).conversation(row.conversationId);
      if (!isCurrent()) return;
      const page = parseRecordConversationPage(response, requestedBotId, row.conversationId);
      const turns = await Promise.all(
        page.turns.map((turn) => readTurn(requestedBotId, row.conversationId, turn, isCurrent)),
      );
      if (!isCurrent()) return;
      setConversation({
        kind: "ready",
        conversationId: page.conversationId,
        selectedOrdinal: row.ordinal,
        personId: page.personId,
        hidden: page.hidden,
        isTest: page.isTest,
        throughOrdinal: page.throughOrdinal,
        turns: turns.sort((left, right) => left.ordinal - right.ordinal),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (!isCurrent() || handleAuthError(error)) return;
      setConversation((current) =>
        current?.conversationId === row.conversationId
          ? { ...current, kind: "error", error: messageForReadError(error) }
          : current,
      );
    }
  };

  const loadMoreTurns = async () => {
    if (
      !conversation ||
      conversation.kind !== "ready" ||
      !conversation.nextCursor ||
      conversation.loadingMore
    ) {
      return;
    }
    const requestEpoch = detailEpochRef.current;
    const requestedBotId = botId;
    const { conversationId, nextCursor: cursor } = conversation;
    const isCurrent = () =>
      mountedRef.current &&
      botRef.current === requestedBotId &&
      detailEpochRef.current === requestEpoch;
    setConversation((current) =>
      current ? { ...current, loadingMore: true, error: undefined } : current,
    );
    try {
      const response = await recordAdministrations(
        config,
        session,
        requestedBotId,
        isCurrent,
      ).conversation(conversationId, cursor);
      if (!isCurrent()) return;
      const page = parseRecordConversationPage(response, requestedBotId, conversationId);
      const turns = await Promise.all(
        page.turns.map((turn) => readTurn(requestedBotId, conversationId, turn, isCurrent)),
      );
      if (!isCurrent()) return;
      setConversation((current) =>
        current?.conversationId === conversationId
          ? {
              ...current,
              personId: page.personId,
              hidden: page.hidden,
              isTest: page.isTest,
              throughOrdinal: page.throughOrdinal,
              turns: [...current.turns, ...turns]
                .filter(
                  (turn, index, all) =>
                    all.findIndex((candidate) => candidate.ordinal === turn.ordinal) === index,
                )
                .sort((left, right) => left.ordinal - right.ordinal),
              nextCursor: page.nextCursor,
              loadingMore: false,
            }
          : current,
      );
    } catch (error) {
      if (!isCurrent() || handleAuthError(error)) return;
      setConversation((current) =>
        current?.conversationId === conversationId
          ? { ...current, loadingMore: false, error: messageForReadError(error) }
          : current,
      );
    }
  };

  const startExport = async (existing?: ExportJob) => {
    const requestedBotId = botId;
    const currentJob = existing;
    const filters = currentJob?.filters ?? appliedFilters;
    if (!filters || !active) return;
    const exportId = currentJob?.state === "uncertain" ? currentJob.exportId : makeUuid();
    const job: ExportJob = { exportId, filters, state: "starting" };
    updateExport(requestedBotId, job);
    try {
      const response = await recordAdministrations(
        config,
        session,
        requestedBotId,
        () => mountedRef.current && botRef.current === requestedBotId,
      ).startExport(exportId, filters);
      const receipt = parseRecordExportReceipt(response, requestedBotId);
      if (receipt.exportId !== exportId || receipt.status !== "processing") {
        throw new Error("INVALID_RESPONSE");
      }
      if (!mountedRef.current || botRef.current !== requestedBotId) return;
      updateExport(requestedBotId, {
        exportId,
        filters,
        state: receipt.status,
        receipt,
      });
    } catch (error) {
      if (!mountedRef.current || botRef.current !== requestedBotId) return;
      if (handleAuthError(error)) return;
      updateExport(requestedBotId, {
        exportId,
        filters,
        state: "uncertain",
        error:
          error instanceof Error && error.message === "INVALID_RESPONSE"
            ? "El servidor devolvió un recibo no válido. Reintentá con el mismo identificador para confirmar el inicio."
            : "No pudimos confirmar el inicio de la preparación. Revisá la conexión y reintentá; se conservará el mismo identificador.",
      });
    }
  };

  const refreshExport = useCallback(
    async (requestedBotId: string, exportId: string) => {
      try {
        const response = await recordAdministrations(
          config,
          session,
          requestedBotId,
          () => mountedRef.current && botRef.current === requestedBotId,
        ).exportStatus(exportId);
        if (botRef.current !== requestedBotId) return null;
        const receipt = parseRecordExportReceipt(response, requestedBotId);
        if (receipt.exportId !== exportId) throw new Error("INVALID_RESPONSE");
        const previous = exportJobsRef.current.get(requestedBotId);
        if (!previous || previous.exportId !== exportId) return null;
        updateExport(requestedBotId, {
          ...previous,
          state: receipt.status,
          receipt,
          error: undefined,
        });
        return receipt;
      } catch (error) {
        if (!mountedRef.current || botRef.current !== requestedBotId) return null;
        if (handleAuthError(error)) return null;
        const previous = exportJobsRef.current.get(requestedBotId);
        if (previous?.exportId === exportId && botRef.current === requestedBotId) {
          updateExport(requestedBotId, {
            ...previous,
            error: "No pudimos consultar el estado de la preparación. Volveremos a intentarlo.",
          });
        }
        return null;
      }
    },
    [config, handleAuthError, session, updateExport],
  );

  useEffect(() => {
    if (!active || !currentExport || currentExport.state !== "processing") return;
    const requestedBotId = botId;
    const exportId = currentExport.exportId;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      if (disposed) return;
      const receipt = await refreshExport(requestedBotId, exportId);
      if (!disposed && receipt?.status === "processing") {
        timer = window.setTimeout(() => void poll(), 5_000);
      } else if (!disposed && receipt === null) {
        timer = window.setTimeout(() => void poll(), 15_000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, botId, currentExport?.exportId, currentExport?.state, refreshExport]);

  const downloadExport = async () => {
    const job = exportJobsRef.current.get(botId);
    if (!job || job.state !== "ready" || downloadPendingBotId === botId) return;
    const requestedBotId = botId;
    setDownloadPendingBotId(requestedBotId);
    updateExport(requestedBotId, { ...job, error: undefined });
    const isCurrent = () => {
      const current = exportJobsRef.current.get(requestedBotId);
      return (
        mountedRef.current &&
        botRef.current === requestedBotId &&
        current?.exportId === job.exportId &&
        current.state === "ready"
      );
    };
    try {
      const response = await recordAdministrations(
        config,
        session,
        requestedBotId,
        isCurrent,
      ).downloadExport(job.exportId);
      if (!isCurrent()) return;
      const link = parseRecordExportDownload(response, requestedBotId, job.exportId);
      if (!isCurrent()) return;
      const anchor = window.document.createElement("a");
      anchor.href = link.url;
      anchor.rel = "noreferrer";
      window.document.body.append(anchor);
      if (!isCurrent()) {
        anchor.remove();
        return;
      }
      anchor.click();
      anchor.remove();
    } catch (error) {
      if (!isCurrent()) return;
      if (handleAuthError(error)) return;
      if (asApiError(error).status === 409) {
        const receipt = await refreshExport(requestedBotId, job.exportId);
        if (receipt && receipt.status !== "ready") return;
      }
      const latest = exportJobsRef.current.get(requestedBotId);
      if (latest?.exportId === job.exportId && latest.state === "ready") {
        updateExport(requestedBotId, {
          ...latest,
          error:
            error instanceof Error && error.message === "INVALID_RESPONSE"
              ? "El servidor devolvió un enlace de descarga no válido. Volvé a intentarlo."
              : "No pudimos obtener el enlace de descarga. Revisá la conexión e intentá de nuevo.",
        });
      }
    } finally {
      if (mountedRef.current) {
        setDownloadPendingBotId((current) => (current === requestedBotId ? null : current));
      }
    }
  };

  const submitExport = () => {
    const existing = exportJobsRef.current.get(botId);
    if (existing?.state === "uncertain" || existing?.state === "failed") {
      void startExport(existing);
      return;
    }
    void startExport();
  };

  const levelOptions = Array.from(
    new Map(
      rows.flatMap((row) =>
        (row.profileFields.educationLevels ?? []).map((value) =>
          typeof value === "string" ? [value, { id: value, label: value }] : [value.id, value],
        ),
      ),
    ).values(),
  ).sort((left, right) => left.label.localeCompare(right.label, "es"));

  const changeDraft = <K extends keyof FilterDraft>(key: K, value: FilterDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (formError) setFormError("");
  };

  const exportMessage = exportStatusMessage(currentExport);

  return (
    <section className="admin-records" aria-labelledby="admin-records-title" hidden={!active}>
      <div className="admin-card admin-records__intro">
        <div className="admin-card__heading">
          <span className="admin-step">04</span>
          <div>
            <h2 id="admin-records-title">Consultas</h2>
            <p>
              Registros originales del chatbot {projectName}. Los filtros seleccionan consultas; la
              exportación incluye todos los turnos de cada conversación coincidente.
            </p>
          </div>
        </div>

        <form className="admin-records__filters" onSubmit={applyFilters}>
          <div className="admin-records__filter-grid">
            <div className="admin-records__field">
              <label htmlFor="admin-records-from">Desde</label>
              <input
                id="admin-records-from"
                type="date"
                value={draft.from}
                onChange={(event) => changeDraft("from", event.currentTarget.value)}
              />
            </div>
            <div className="admin-records__field">
              <label htmlFor="admin-records-to">Hasta</label>
              <input
                id="admin-records-to"
                type="date"
                value={draft.to}
                onChange={(event) => changeDraft("to", event.currentTarget.value)}
              />
            </div>
            <div className="admin-records__field">
              <label htmlFor="admin-records-status">Estado</label>
              <select
                id="admin-records-status"
                value={draft.status}
                onChange={(event) =>
                  changeDraft("status", event.currentTarget.value as FilterDraft["status"])
                }
              >
                <option value="">Todos</option>
                <option value="in_progress">En curso</option>
                <option value="completed">Completada</option>
                <option value="failed">Fallida</option>
              </select>
            </div>
            <div className="admin-records__field">
              <label htmlFor="admin-records-person">ID de persona</label>
              <input
                id="admin-records-person"
                type="text"
                autoComplete="off"
                value={draft.personId}
                onChange={(event) => changeDraft("personId", event.currentTarget.value)}
              />
            </div>
            <div className="admin-records__field">
              <label htmlFor="admin-records-level">Nivel educativo</label>
              <input
                id="admin-records-level"
                type="text"
                list="admin-records-level-options"
                autoComplete="off"
                value={draft.levelId}
                onChange={(event) => changeDraft("levelId", event.currentTarget.value)}
                aria-describedby="admin-records-level-hint"
              />
              <datalist id="admin-records-level-options">
                {levelOptions.map((level) => (
                  <option key={level.id} value={level.id} label={level.label} />
                ))}
              </datalist>
            </div>
            <div className="admin-records__field">
              <label htmlFor="admin-records-subject">Materia</label>
              <input
                id="admin-records-subject"
                type="text"
                autoComplete="off"
                value={draft.subject}
                onChange={(event) => changeDraft("subject", event.currentTarget.value)}
              />
            </div>
          </div>
          <p id="admin-records-level-hint" className="admin-field-hint">
            Filtrá por el ID exacto del nivel guardado en cada consulta. Las etiquetas de los
            resultados sirven como ayuda para encontrarlo.
          </p>

          <label className="admin-records__checkbox" htmlFor="admin-records-exclude-tests">
            <input
              id="admin-records-exclude-tests"
              type="checkbox"
              checked={draft.excludeTests}
              onChange={(event) => changeDraft("excludeTests", event.currentTarget.checked)}
            />
            Excluir pruebas del equipo
          </label>

          {formError ? (
            <p className="admin-message admin-message--error" role="alert">
              {formError}
            </p>
          ) : null}
          <div className="admin-records__filter-actions">
            <button className="admin-button" type="submit">
              Aplicar filtros
            </button>
            <button
              className="admin-button admin-button--quiet"
              type="button"
              onClick={clearFilters}
            >
              Limpiar filtros
            </button>
          </div>
        </form>
      </div>

      <div
        className="admin-card admin-records__results"
        aria-labelledby="admin-records-results-title"
      >
        <div className="admin-records__section-heading">
          <div>
            <h3 id="admin-records-results-title">Resultados</h3>
            <p>{filterSummary(appliedFilters)}</p>
          </div>
          <button
            className="admin-button admin-button--quiet"
            type="button"
            disabled={!appliedFilters || searchState === "loading"}
            onClick={() => appliedFilters && void searchRecords(botId, appliedFilters, null, false)}
          >
            Actualizar resultados
          </button>
        </div>

        {searchState === "loading" && rows.length === 0 ? (
          <div className="admin-result-placeholder" role="status">
            <span className="admin-spinner" aria-hidden="true" />
            Buscando consultas…
          </div>
        ) : null}
        {searchState === "error" ? (
          <div className="admin-records__error" role="alert">
            <p>{searchError}</p>
            <button
              className="admin-button admin-button--quiet"
              type="button"
              disabled={!appliedFilters}
              onClick={() =>
                appliedFilters && void searchRecords(botId, appliedFilters, null, false)
              }
            >
              Reintentar búsqueda
            </button>
          </div>
        ) : null}
        {searchState === "ready" && rows.length === 0 && !nextCursor ? (
          <p className="admin-records__empty">
            No hay consultas que coincidan con los filtros aplicados.
          </p>
        ) : null}
        {searchState === "ready" && rows.length === 0 && nextCursor ? (
          <p className="admin-records__empty">
            Esta página no contiene coincidencias. Podés continuar la búsqueda hacia atrás.
          </p>
        ) : null}

        {rows.length > 0 ? (
          <ul className="admin-records__list" aria-label="Consultas coincidentes">
            {rows.map((row) => (
              <li className="admin-records__row" key={`${row.conversationId}:${row.queryId}`}>
                <button
                  className="admin-records__row-button"
                  type="button"
                  aria-expanded={conversation?.conversationId === row.conversationId}
                  onClick={() => void openConversation(row)}
                >
                  <span className="admin-records__row-question">
                    {row.questionPreview || "Consulta sin texto"}
                  </span>
                  <span className="admin-records__row-meta">
                    {formatRecordDate(row.admittedAt)} · {statusLabel(row.status)} · turno{" "}
                    {row.ordinal} · ID {row.personId}
                  </span>
                  <span className="admin-records__row-meta">
                    {[
                      ...(row.profileFields.educationLevels ?? []),
                      ...(row.profileFields.subjects ?? []),
                    ]
                      .map((value) =>
                        typeof value === "string" ? value : `${value.label} (${value.id})`,
                      )
                      .join(" · ") || "Sin contexto profesional registrado"}
                    {row.isTest ? " · Prueba del equipo" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {nextCursor ? (
          <button
            className="admin-button admin-button--quiet admin-records__more"
            type="button"
            disabled={searchState === "loading"}
            onClick={loadMoreResults}
          >
            {searchState === "loading" ? "Cargando resultados…" : "Cargar más resultados"}
          </button>
        ) : null}
      </div>

      {conversation ? (
        <section
          className="admin-card admin-records__conversation"
          aria-labelledby="admin-records-conversation-title"
        >
          <div className="admin-records__section-heading">
            <div>
              <h3 id="admin-records-conversation-title">Conversación</h3>
              <p>Identificador: {conversation.conversationId}</p>
            </div>
            <button
              className="admin-button admin-button--quiet"
              type="button"
              onClick={() => {
                detailEpochRef.current += 1;
                setConversation(null);
              }}
            >
              Cerrar conversación
            </button>
          </div>
          {conversation.kind === "loading" ? (
            <div className="admin-result-placeholder" role="status">
              <span className="admin-spinner" aria-hidden="true" />
              Cargando originales…
            </div>
          ) : null}
          {conversation.kind === "error" ? (
            <div className="admin-records__error" role="alert">
              <p>{conversation.error}</p>
              <button
                className="admin-button admin-button--quiet"
                type="button"
                onClick={() => {
                  const row = rows.find(
                    (candidate) =>
                      candidate.conversationId === conversation.conversationId &&
                      candidate.ordinal === conversation.selectedOrdinal,
                  );
                  if (row) void openConversation(row);
                }}
              >
                Reintentar lectura
              </button>
            </div>
          ) : null}
          {conversation.kind === "ready" ? (
            <>
              <div className="admin-records__conversation-meta">
                <span>
                  ID de persona: <code>{conversation.personId}</code>
                </span>
                {conversation.hidden ? (
                  <strong>
                    Esta conversación fue quitada del historial de la persona; sigue disponible para
                    el equipo.
                  </strong>
                ) : null}
                {conversation.isTest ? (
                  <strong>Conversación de una cuenta de prueba del equipo.</strong>
                ) : null}
                <span>Turnos registrados: {conversation.throughOrdinal}</span>
              </div>
              {conversation.error ? (
                <p className="admin-message admin-message--error" role="alert">
                  {conversation.error}
                </p>
              ) : null}
              {conversation.turns.length > 0 ? (
                <ol className="admin-records__turns">
                  {conversation.turns.map((turn) => (
                    <li
                      className="admin-records__turn"
                      key={turn.queryId}
                      aria-current={
                        turn.ordinal === conversation.selectedOrdinal ? "true" : undefined
                      }
                    >
                      <div className="admin-records__turn-heading">
                        <h4>
                          Turno {turn.ordinal}
                          {turn.ordinal === conversation.selectedOrdinal ? " · Coincidencia" : ""}
                        </h4>
                        <span>
                          {formatRecordDate(turn.admittedAt)} · {statusLabel(turn.status)}
                        </span>
                      </div>
                      <div className="admin-records__original">
                        <h5>Pregunta original</h5>
                        <pre>{turn.question || "No hay texto original disponible."}</pre>
                      </div>
                      <div className="admin-records__original">
                        <h5>
                          Respuesta original
                          {turn.answer && !turn.answerComplete ? " · parcial" : ""}
                        </h5>
                        <pre>{turn.answer || "No hay respuesta guardada."}</pre>
                      </div>
                      <dl className="admin-records__profile">
                        {Object.entries(turn.profileFields).map(([fieldId, values]) => (
                          <div key={fieldId}>
                            <dt>{profileFieldLabel(fieldId)}</dt>
                            <dd>{valuesForField(values).join(" · ") || "Sin valores"}</dd>
                          </div>
                        ))}
                      </dl>
                      {turn.failureCode ? (
                        <p className="admin-records__failure">
                          Detalle de fallo: {turn.failureCode}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="admin-records__empty">
                  La búsqueda de esta conversación terminó sin turnos disponibles.
                </p>
              )}
              {conversation.nextCursor ? (
                <button
                  className="admin-button admin-button--quiet admin-records__more"
                  type="button"
                  disabled={conversation.loadingMore}
                  onClick={() => void loadMoreTurns()}
                >
                  {conversation.loadingMore ? "Cargando turnos…" : "Cargar más turnos"}
                </button>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      <section
        className="admin-card admin-records__export"
        aria-labelledby="admin-records-export-title"
      >
        <div className="admin-records__section-heading">
          <div>
            <h3 id="admin-records-export-title">Exportación CSV</h3>
            <p>
              Se exportan todas las consultas de cada conversación que coincida con los filtros
              aplicados, incluso sus turnos que no coincidan. El archivo guarda los originales tal
              como se registraron.
            </p>
          </div>
        </div>
        <p className="admin-records__csv-guidance">
          Para conservar acentos, comillas y saltos de línea, importá el archivo como texto UTF-8.
        </p>
        <div className="admin-records__export-actions">
          {!currentExport ||
          currentExport.state === "empty" ||
          currentExport.state === "expired" ? (
            <button
              className="admin-button"
              type="button"
              disabled={!appliedFilters || searchState === "loading"}
              onClick={submitExport}
            >
              Descargar conversaciones en CSV
            </button>
          ) : null}
          {currentExport?.state === "uncertain" || currentExport?.state === "failed" ? (
            <button className="admin-button" type="button" onClick={submitExport}>
              Reintentar preparación
            </button>
          ) : null}
          {currentExport?.state === "ready" ? (
            <>
              <button
                className="admin-button"
                type="button"
                disabled={downloadPendingBotId === botId}
                onClick={() => void downloadExport()}
              >
                {downloadPendingBotId === botId ? "Obteniendo enlace…" : "Descargar CSV"}
              </button>
              <button
                className="admin-button admin-button--quiet"
                type="button"
                disabled={!appliedFilters || searchState === "loading"}
                onClick={submitExport}
              >
                Preparar otra exportación
              </button>
            </>
          ) : null}
          {currentExport?.state === "starting" ? (
            <span className="admin-records__working" role="status">
              <span className="admin-spinner" aria-hidden="true" />
              Iniciando la preparación…
            </span>
          ) : null}
          {currentExport?.state === "processing" ? (
            <span className="admin-records__working" role="status">
              <span className="admin-spinner" aria-hidden="true" />
              Preparando CSV…
            </span>
          ) : null}
        </div>
        {currentExport?.state === "ready" && currentExport.receipt ? (
          <p className="admin-records__receipt" role="status">
            {currentExport.receipt.conversationCount} conversaciones ·{" "}
            {currentExport.receipt.rowCount} consultas · disponible hasta{" "}
            {formatRecordDate(new Date(currentExport.receipt.expiresAt as number).toISOString())}.
            <br />
            Filtros de esta exportación: {filterSummary(currentExport.filters)}.
          </p>
        ) : null}
        {currentExport?.state === "ready" && currentExport.error ? (
          <p className="admin-message admin-message--error" role="alert">
            {currentExport.error}
          </p>
        ) : null}
        {currentExport?.state === "processing" && currentExport.error ? (
          <p className="admin-message admin-message--error" role="alert">
            {currentExport.error}
          </p>
        ) : null}
        {currentExport &&
        exportMessage &&
        currentExport.state !== "ready" &&
        currentExport.state !== "processing" ? (
          <p
            className={`admin-message${currentExport.state === "empty" ? "" : " admin-message--error"}`}
            role={currentExport.state === "empty" ? "status" : "alert"}
          >
            {exportMessage}
          </p>
        ) : null}
      </section>
    </section>
  );
}
