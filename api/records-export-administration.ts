import { isDeepStrictEqual } from "node:util";
import {
  isRecordsExportId,
  ownsRecordsExportKey,
  parseRecordsExportInput,
  RECORDS_EXPORT_INPUT_MAX_BYTES,
  recordsExecutionName,
} from "./records-export-contract.js";
import { normalizeRecordsFilters } from "./records-reader.js";

const EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD_SECONDS = 120;

export type RecordsExportExecutionView = {
  executionArn?: string;
  stateMachineArn?: string;
  name?: string;
  input?: string;
  output?: string;
  status?: string;
  startDate?: Date | string | number;
  stopDate?: Date | string | number;
};

export type RecordsExportExecution = {
  start(input: { name: string; input: Record<string, unknown> }): Promise<{
    executionArn: string;
  }>;
  get(input: { name: string }): Promise<RecordsExportExecutionView | null>;
};

export type RecordsExportObjects = {
  head(input: { bucket: string; key: string }): Promise<null | {
    eTag: string;
    contentLength: number;
  }>;
  signGet(input: {
    bucket: string;
    key: string;
    fileName: string;
    expiresInSeconds: number;
  }): Promise<string>;
};

type ExportFilters = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function timeValue(value: Date | string | number | undefined): number | null {
  const result =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value ?? "");
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function parseExecutionOutput(value: string | undefined): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length > 32_768) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readyReceipt(value: Record<string, unknown>): {
  objectKey: string;
  conversationCount: number;
  rowCount: number;
  bytes: number;
  eTag: string;
} | null {
  if (
    value.status !== "ready" ||
    Object.keys(value).length !== 6 ||
    !Object.keys(value).every((key) =>
      ["status", "objectKey", "conversationCount", "rowCount", "bytes", "eTag"].includes(key),
    ) ||
    typeof value.objectKey !== "string" ||
    !Number.isSafeInteger(value.conversationCount) ||
    (value.conversationCount as number) < 1 ||
    !Number.isSafeInteger(value.rowCount) ||
    (value.rowCount as number) < 1 ||
    (value.rowCount as number) < (value.conversationCount as number) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 1 ||
    typeof value.eTag !== "string" ||
    value.eTag.length < 1 ||
    value.eTag.length > 256
  ) {
    return null;
  }
  return {
    objectKey: value.objectKey,
    conversationCount: value.conversationCount as number,
    rowCount: value.rowCount as number,
    bytes: value.bytes as number,
    eTag: value.eTag,
  };
}

function validateExecution(
  execution: RecordsExportExecutionView,
  expected: {
    name: string;
    stateMachineArn: string;
    botId: string;
    actorSub: string;
    exportId: string;
  },
): void {
  if (
    execution.name !== expected.name ||
    execution.stateMachineArn !== expected.stateMachineArn ||
    typeof execution.executionArn !== "string" ||
    typeof execution.status !== "string"
  ) {
    throw failure("RECORDS_UNAVAILABLE");
  }
  const input = parseRecordsExportInput(execution.input);
  let canonicalFilters: Record<string, unknown> | null = null;
  try {
    if (input && isObject(input.filters)) canonicalFilters = normalizeRecordsFilters(input.filters);
  } catch {
    throw failure("RECORDS_UNAVAILABLE");
  }
  if (
    !input ||
    input.botId !== expected.botId ||
    input.actorSub !== expected.actorSub ||
    input.exportId !== expected.exportId ||
    !canonicalFilters ||
    !isDeepStrictEqual(input.filters, canonicalFilters) ||
    Object.keys(input).length !== 4 ||
    !Object.keys(input).every((key) => ["botId", "actorSub", "exportId", "filters"].includes(key))
  ) {
    throw failure("RECORDS_UNAVAILABLE");
  }
}

/** Owns receipt lookup, owner binding, result validation, retention, and download signing. */
export function createRecordsExportAdministration(options: {
  botId: string;
  environment: string;
  stateMachineArn: string;
  bucketName: string;
  execution: RecordsExportExecution;
  objects: RecordsExportObjects;
  now: () => number;
}) {
  const { botId, environment, stateMachineArn, bucketName, execution, objects, now } = options;

  function scope(actorSub: string, exportId: string) {
    if (!isRecordsExportId(exportId)) throw failure("INVALID_INPUT");
    return {
      name: recordsExecutionName(environment, botId, actorSub, exportId),
      stateMachineArn,
      botId,
      actorSub,
      exportId,
    };
  }

  async function describe(actorSub: string, exportId: string) {
    const expected = scope(actorSub, exportId);
    let observed: RecordsExportExecutionView | null;
    try {
      observed = await execution.get({ name: expected.name });
    } catch {
      throw failure("RECORDS_UNAVAILABLE");
    }
    if (!observed) throw failure("NOT_FOUND");
    validateExecution(observed, expected);
    return { expected, observed };
  }

  async function inspect(actorSub: string, exportId: string) {
    const { observed } = await describe(actorSub, exportId);
    const base = { botId, exportId };
    if (["RUNNING", "PENDING", "STARTING"].includes(observed.status ?? "")) {
      return { response: { ...base, status: "processing" as const }, receipt: null };
    }
    if (["FAILED", "TIMED_OUT", "ABORTED"].includes(observed.status ?? "")) {
      return { response: { ...base, status: "failed" as const }, receipt: null };
    }
    if (observed.status !== "SUCCEEDED") throw failure("RECORDS_UNAVAILABLE");

    const output = parseExecutionOutput(observed.output);
    if (!output) throw failure("RECORDS_UNAVAILABLE");
    if (output.status === "empty" && Object.keys(output).length === 1) {
      return { response: { ...base, status: "empty" as const }, receipt: null };
    }
    const receipt = readyReceipt(output);
    if (
      !receipt ||
      !ownsRecordsExportKey(receipt.objectKey, environment, botId, actorSub, exportId)
    ) {
      throw failure("RECORDS_UNAVAILABLE");
    }

    const completedAt = timeValue(observed.stopDate);
    if (completedAt === null || completedAt > now()) throw failure("RECORDS_UNAVAILABLE");
    const expiresAtMs = completedAt + EXPORT_RETENTION_MS;
    if (!Number.isSafeInteger(expiresAtMs)) throw failure("RECORDS_UNAVAILABLE");
    if (now() >= expiresAtMs) {
      return { response: { ...base, status: "expired" as const }, receipt: null };
    }

    let head: Awaited<ReturnType<RecordsExportObjects["head"]>>;
    try {
      head = await objects.head({ bucket: bucketName, key: receipt.objectKey });
    } catch {
      throw failure("RECORDS_UNAVAILABLE");
    }
    if (!head || head.eTag !== receipt.eTag || head.contentLength !== receipt.bytes) {
      throw failure("RECORDS_UNAVAILABLE");
    }

    return {
      response: {
        ...base,
        status: "ready" as const,
        conversationCount: receipt.conversationCount,
        rowCount: receipt.rowCount,
        bytes: receipt.bytes,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
      receipt: { ...receipt, expiresAtMs },
    };
  }

  return {
    async start(input: {
      actorSub: string;
      exportId: string;
      filters: ExportFilters;
    }): Promise<{ botId: string; exportId: string; status: "processing" }> {
      if (!isRecordsExportId(input.exportId) || !isObject(input.filters)) {
        throw failure("INVALID_INPUT");
      }
      const expected = scope(input.actorSub, input.exportId);
      const executionInput = {
        botId,
        actorSub: input.actorSub,
        exportId: input.exportId,
        filters: input.filters,
      };
      if (
        Buffer.byteLength(JSON.stringify(executionInput), "utf8") > RECORDS_EXPORT_INPUT_MAX_BYTES
      ) {
        throw failure("INVALID_INPUT");
      }
      try {
        const started = await execution.start({ name: expected.name, input: executionInput });
        if (typeof started.executionArn !== "string" || started.executionArn.length === 0) {
          throw failure("EXPORT_UNCONFIRMED");
        }
      } catch (error) {
        const code = isObject(error) && typeof error.code === "string" ? error.code : "";
        if (["INVALID_INPUT", "CONFLICT", "EXPORT_UNCONFIRMED"].includes(code)) throw error;
        throw failure("EXPORT_UNCONFIRMED");
      }
      return { botId, exportId: input.exportId, status: "processing" };
    },

    async get(input: { actorSub: string; exportId: string }) {
      return (await inspect(input.actorSub, input.exportId)).response;
    },

    async download(input: { actorSub: string; exportId: string }) {
      const { response, receipt } = await inspect(input.actorSub, input.exportId);
      if (response.status !== "ready" || !receipt) throw failure("EXPORT_NOT_READY");
      const signedAt = now();
      const remainingMs = receipt.expiresAtMs - signedAt;
      const expiresInSeconds = Math.min(MAX_DOWNLOAD_SECONDS, Math.floor(remainingMs / 1000));
      if (expiresInSeconds < 1) throw failure("EXPORT_NOT_READY");
      let url: string;
      try {
        url = await objects.signGet({
          bucket: bucketName,
          key: receipt.objectKey,
          fileName: `consultas-${botId}.csv`,
          expiresInSeconds,
        });
      } catch {
        throw failure("RECORDS_UNAVAILABLE");
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw failure("RECORDS_UNAVAILABLE");
      }
      const signedLifetime = Number(parsedUrl.searchParams.get("X-Amz-Expires"));
      if (
        parsedUrl.protocol !== "https:" ||
        !Number.isSafeInteger(signedLifetime) ||
        signedLifetime < 1 ||
        signedLifetime > expiresInSeconds ||
        signedLifetime > MAX_DOWNLOAD_SECONDS ||
        !parsedUrl.searchParams.get("response-content-disposition")?.startsWith("attachment") ||
        !parsedUrl.searchParams.get("response-cache-control")?.includes("no-store")
      ) {
        throw failure("RECORDS_UNAVAILABLE");
      }
      return {
        botId,
        exportId: input.exportId,
        url,
        expiresAt: new Date(signedAt + signedLifetime * 1000).toISOString(),
      };
    },
  };
}
