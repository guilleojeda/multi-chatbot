import { adminRequest, type AdminPublicConfig } from "./admin-api";
import type { Session } from "./session";

export type RecordStatus = "in_progress" | "completed" | "failed";

export type RecordFilters = {
  from?: string;
  to?: string;
  status?: RecordStatus;
  personId?: string;
  levelId?: string;
  subject?: string;
  excludeTests: boolean;
};

export type RecordProfileFields = Record<string, Array<string | { id: string; label: string }>>;

export type RecordSearchResult = {
  conversationId: string;
  queryId: string;
  ordinal: number;
  personId: string;
  admittedAt: string;
  status: RecordStatus;
  questionPreview: string;
  profileFields: RecordProfileFields;
  isTest: boolean;
};

export type RecordSearchPage = {
  botId: string;
  results: RecordSearchResult[];
  nextCursor: string | null;
};

export type RecordTurnDescriptor = {
  ordinal: number;
  queryId: string;
  admittedAt: string;
  status: RecordStatus;
  answerComplete: boolean;
  profileFields: RecordProfileFields;
  failureCode?: string;
};

export type RecordConversationPage = {
  botId: string;
  conversationId: string;
  personId: string;
  hidden: boolean;
  isTest: boolean;
  throughOrdinal: number;
  turns: RecordTurnDescriptor[];
  nextCursor: string | null;
  newerCursor: string | null;
};

type RecordTextPageBase = {
  botId: string;
  conversationId: string;
  ordinal: number;
  text: string;
  nextCursor: string | null;
};

export type RecordQuestionTextPage = RecordTextPageBase & {
  role: "question";
};

export type RecordAnswerTextPage = RecordTextPageBase & {
  role: "answer";
  status: RecordStatus;
  answerComplete: boolean;
  failureCode?: string;
};

export type RecordTextPage = RecordQuestionTextPage | RecordAnswerTextPage;

export type ExportStatus = "processing" | "ready" | "empty" | "failed" | "expired";

export type RecordExportReceipt = {
  botId: string;
  exportId: string;
  status: ExportStatus;
  conversationCount?: number;
  rowCount?: number;
  bytes?: number;
  expiresAt?: number;
};

export type RecordExportDownload = {
  botId: string;
  exportId: string;
  url: string;
  expiresAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function parseProfileFields(value: unknown): RecordProfileFields {
  if (!isRecord(value)) throw new Error("INVALID_RESPONSE");
  const result: RecordProfileFields = {};
  for (const [key, values] of Object.entries(value)) {
    if (
      !key ||
      !Array.isArray(values) ||
      !values.every(
        (entry) =>
          typeof entry === "string" ||
          (isRecord(entry) && typeof entry.id === "string" && typeof entry.label === "string"),
      )
    ) {
      throw new Error("INVALID_RESPONSE");
    }
    result[key] = values.map((entry) =>
      typeof entry === "string" ? entry : { id: entry.id as string, label: entry.label as string },
    );
  }
  return result;
}

function isRecordStatus(value: unknown): value is RecordStatus {
  return value === "in_progress" || value === "completed" || value === "failed";
}

function parseDate(value: unknown): string {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
    throw new Error("INVALID_RESPONSE");
  }
  return value;
}

function parseOrdinal(value: unknown, allowZero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error("INVALID_RESPONSE");
  }
  return value;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && new Date(parsed).toISOString() === value) return parsed;
  }
  throw new Error("INVALID_RESPONSE");
}

export function parseRecordSearchPage(value: unknown, expectedBotId: string): RecordSearchPage {
  if (!isRecord(value) || value.botId !== expectedBotId || !Array.isArray(value.results)) {
    throw new Error("INVALID_RESPONSE");
  }
  const results = value.results.map((candidate): RecordSearchResult => {
    if (
      !isRecord(candidate) ||
      typeof candidate.conversationId !== "string" ||
      !candidate.conversationId ||
      typeof candidate.queryId !== "string" ||
      !candidate.queryId ||
      typeof candidate.personId !== "string" ||
      !candidate.personId ||
      !isRecordStatus(candidate.status) ||
      typeof candidate.questionPreview !== "string" ||
      typeof candidate.isTest !== "boolean"
    ) {
      throw new Error("INVALID_RESPONSE");
    }
    return {
      conversationId: candidate.conversationId,
      queryId: candidate.queryId,
      ordinal: parseOrdinal(candidate.ordinal),
      personId: candidate.personId,
      admittedAt: parseDate(candidate.admittedAt),
      status: candidate.status,
      questionPreview: candidate.questionPreview,
      profileFields: parseProfileFields(candidate.profileFields),
      isTest: candidate.isTest,
    };
  });
  if (!isCursor(value.nextCursor)) throw new Error("INVALID_RESPONSE");
  return { botId: expectedBotId, results, nextCursor: value.nextCursor };
}

export function parseRecordConversationPage(
  value: unknown,
  expectedBotId: string,
  expectedConversationId: string,
): RecordConversationPage {
  if (
    !isRecord(value) ||
    value.botId !== expectedBotId ||
    value.conversationId !== expectedConversationId ||
    typeof value.personId !== "string" ||
    !value.personId ||
    typeof value.hidden !== "boolean" ||
    typeof value.isTest !== "boolean" ||
    !Array.isArray(value.turns)
  ) {
    throw new Error("INVALID_RESPONSE");
  }
  const turns = value.turns.map((candidate): RecordTurnDescriptor => {
    if (
      !isRecord(candidate) ||
      typeof candidate.queryId !== "string" ||
      !candidate.queryId ||
      !isRecordStatus(candidate.status) ||
      typeof candidate.answerComplete !== "boolean"
    ) {
      throw new Error("INVALID_RESPONSE");
    }
    const failureCode = candidate.failureCode;
    if (failureCode !== undefined && typeof failureCode !== "string") {
      throw new Error("INVALID_RESPONSE");
    }
    return {
      ordinal: parseOrdinal(candidate.ordinal),
      queryId: candidate.queryId,
      admittedAt: parseDate(candidate.admittedAt),
      status: candidate.status,
      answerComplete: candidate.answerComplete,
      profileFields: parseProfileFields(candidate.profileFields),
      ...(typeof failureCode === "string" ? { failureCode } : {}),
    };
  });
  if (!isCursor(value.nextCursor) || !isCursor(value.newerCursor)) {
    throw new Error("INVALID_RESPONSE");
  }
  return {
    botId: expectedBotId,
    conversationId: expectedConversationId,
    personId: value.personId,
    hidden: value.hidden,
    isTest: value.isTest,
    throughOrdinal: parseOrdinal(value.throughOrdinal, true),
    turns,
    nextCursor: value.nextCursor,
    newerCursor: value.newerCursor,
  };
}

export function parseRecordTextPage(
  value: unknown,
  expectedBotId: string,
  expectedConversationId: string,
  expectedOrdinal: number,
  expectedRole: "question" | "answer",
): RecordTextPage {
  if (
    !isRecord(value) ||
    value.botId !== expectedBotId ||
    value.conversationId !== expectedConversationId ||
    value.ordinal !== expectedOrdinal ||
    value.role !== expectedRole ||
    typeof value.text !== "string" ||
    !isCursor(value.nextCursor)
  ) {
    throw new Error("INVALID_RESPONSE");
  }
  if (expectedRole === "question") {
    return {
      botId: expectedBotId,
      conversationId: expectedConversationId,
      ordinal: expectedOrdinal,
      role: expectedRole,
      text: value.text,
      nextCursor: value.nextCursor,
    };
  }
  if (!isRecordStatus(value.status) || typeof value.answerComplete !== "boolean") {
    throw new Error("INVALID_RESPONSE");
  }
  const failureCode = value.failureCode;
  if (failureCode !== undefined && typeof failureCode !== "string") {
    throw new Error("INVALID_RESPONSE");
  }
  return {
    botId: expectedBotId,
    conversationId: expectedConversationId,
    ordinal: expectedOrdinal,
    role: expectedRole,
    text: value.text,
    nextCursor: value.nextCursor,
    status: value.status,
    answerComplete: value.answerComplete,
    ...(typeof failureCode === "string" ? { failureCode } : {}),
  };
}

const exportStatuses = new Set<ExportStatus>(["processing", "ready", "empty", "failed", "expired"]);

export function parseRecordExportReceipt(
  value: unknown,
  expectedBotId: string,
): RecordExportReceipt {
  if (
    !isRecord(value) ||
    value.botId !== expectedBotId ||
    typeof value.exportId !== "string" ||
    !value.exportId ||
    !exportStatuses.has(value.status as ExportStatus)
  ) {
    throw new Error("INVALID_RESPONSE");
  }
  const receipt: RecordExportReceipt = {
    botId: expectedBotId,
    exportId: value.exportId,
    status: value.status as ExportStatus,
  };
  for (const field of ["conversationCount", "rowCount", "bytes"] as const) {
    const count = value[field];
    if (count !== undefined) {
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw new Error("INVALID_RESPONSE");
      }
      receipt[field] = count;
    }
  }
  if (value.expiresAt !== undefined) {
    receipt.expiresAt = parseTimestamp(value.expiresAt);
  }
  if (
    receipt.status === "ready" &&
    (receipt.conversationCount === undefined ||
      receipt.rowCount === undefined ||
      receipt.bytes === undefined ||
      receipt.expiresAt === undefined)
  ) {
    throw new Error("INVALID_RESPONSE");
  }
  return receipt;
}

export function parseRecordExportDownload(
  value: unknown,
  expectedBotId: string,
  expectedExportId: string,
): RecordExportDownload {
  if (
    !isRecord(value) ||
    value.botId !== expectedBotId ||
    value.exportId !== expectedExportId ||
    typeof value.url !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    throw new Error("INVALID_RESPONSE");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("INVALID_RESPONSE");
  }
  if (url.protocol !== "https:") throw new Error("INVALID_RESPONSE");
  return {
    botId: expectedBotId,
    exportId: expectedExportId,
    url: url.href,
    expiresAt: parseTimestamp(value.expiresAt),
  };
}

export function recordAdministrations(
  config: AdminPublicConfig,
  session: Session,
  botId: string,
  isActive: () => boolean,
) {
  const basePath = `/admin/bots/${encodeURIComponent(botId)}/records`;
  return {
    search(filters: RecordFilters, cursor?: string | null) {
      return adminRequest(
        config,
        session,
        `${basePath}/search`,
        { method: "POST", body: { filters, ...(cursor ? { cursor } : {}) } },
        isActive,
      );
    },
    conversation(
      conversationId: string,
      options?: { ordinal?: number; cursor?: string | null } | number | string | null,
    ) {
      const params = new URLSearchParams();
      if (typeof options === "number") {
        if (!Number.isSafeInteger(options) || options < 1) throw new Error("INVALID_REQUEST");
        params.set("ordinal", String(options));
      } else if (typeof options === "string") {
        params.set("cursor", options);
      } else if (options) {
        if (options.ordinal !== undefined) {
          if (!Number.isSafeInteger(options.ordinal) || options.ordinal < 1) {
            throw new Error("INVALID_REQUEST");
          }
          params.set("ordinal", String(options.ordinal));
        }
        if (options.cursor) params.set("cursor", options.cursor);
      }
      const query = params.toString() ? `?${params.toString()}` : "";
      return adminRequest(
        config,
        session,
        `${basePath}/conversations/${encodeURIComponent(conversationId)}${query}`,
        {},
        isActive,
      );
    },
    text(
      conversationId: string,
      ordinal: number,
      role: "question" | "answer",
      cursor?: string | null,
    ) {
      const params = new URLSearchParams({ role });
      if (cursor) params.set("cursor", cursor);
      return adminRequest(
        config,
        session,
        `${basePath}/conversations/${encodeURIComponent(conversationId)}/turns/${ordinal}/text?${params}`,
        {},
        isActive,
      );
    },
    startExport(exportId: string, filters: RecordFilters) {
      return adminRequest(
        config,
        session,
        `${basePath}/exports`,
        { method: "POST", body: { exportId, filters } },
        isActive,
      );
    },
    exportStatus(exportId: string) {
      return adminRequest(
        config,
        session,
        `${basePath}/exports/${encodeURIComponent(exportId)}`,
        {},
        isActive,
      );
    },
    downloadExport(exportId: string) {
      return adminRequest(
        config,
        session,
        `${basePath}/exports/${encodeURIComponent(exportId)}/download`,
        { method: "POST", body: {} },
        isActive,
      );
    },
  };
}
