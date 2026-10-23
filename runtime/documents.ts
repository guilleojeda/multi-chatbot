import type {
  DocumentContext,
  DocumentResult,
  ModelInput,
  TokenCountOptions,
  TokenCountResult,
} from "./contracts.js";
import { modelContextWindowTokens } from "./model-capacity.js";

const retrievalQueryMaxCharacters = 1_000;
const reformulationOutputTokens = 512;
const maxAuxiliaryInputTokens = modelContextWindowTokens - reformulationOutputTokens;
const safeRequestIdPattern = /^[A-Za-z0-9_.:-]{1,256}$/;
const metricNames = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "latencyMs",
  "timeToFirstByteMs",
]);

export type DocumentPreparationStage = "auxiliary_count" | "reformulation" | "retrieval";

export type DocumentPreparationFailureReason =
  | "cancelled"
  | "count_failed"
  | "empty_query"
  | "input_too_large"
  | "invalid_count"
  | "invalid_input"
  | "invalid_results"
  | "reformulation_failed"
  | "reformulation_incomplete"
  | "reformulation_too_long"
  | "retrieval_failed"
  | "timeout";

export class DocumentPreparationError extends Error {
  readonly code = "documents_unavailable";

  constructor(
    readonly stage: DocumentPreparationStage,
    readonly reason: DocumentPreparationFailureReason,
    readonly requestId?: string,
    readonly metrics?: Record<string, number>,
  ) {
    super("Document preparation could not be completed.");
    this.name = "DocumentPreparationError";
  }
}

export type DocumentRetrievalRequest = {
  knowledgeBaseId: string;
  text: string;
  numberOfResults: 5;
  searchType: "SEMANTIC";
};

export type DocumentRetrievalResponse = {
  results: DocumentResult[];
  requestId?: string;
};

export type DocumentProviderEvent =
  | { type: "text"; text: string }
  | {
      type: "result";
      stopReason: string;
      requestId?: string;
      metrics?: Record<string, unknown>;
    }
  | {
      type: "error";
      requestId?: string;
      metrics?: Record<string, unknown>;
    };

export type DocumentPreparerDependencies = {
  knowledgeBaseId: string;
  revision: string;
  retrieve(
    input: DocumentRetrievalRequest,
    options: { abortSignal: AbortSignal },
  ): Promise<DocumentRetrievalResponse>;
  countInputTokens(input: ModelInput, options?: TokenCountOptions): Promise<TokenCountResult>;
  reformulate(
    input: ModelInput,
    options: { maxOutputTokens: 512; abortSignal: AbortSignal },
  ): AsyncIterable<DocumentProviderEvent>;
  now(): number;
  preparationTimeoutMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (Array.isArray(value)) {
    ancestors.add(value);
    const valid = value.every((entry) => isJsonValue(entry, ancestors));
    ancestors.delete(value);
    return valid;
  }
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && safeRequestIdPattern.test(value) ? value : undefined;
}

function safeMetrics(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const metrics: Record<string, number> = {};
  for (const [name, metric] of Object.entries(value)) {
    if (metricNames.has(name) && typeof metric === "number" && Number.isFinite(metric)) {
      metrics[name] = metric;
    }
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function safeDependencyEvidence(error: unknown): { requestId?: string } {
  if (!isRecord(error)) return {};
  const metadata = isRecord(error.$metadata) ? error.$metadata : undefined;
  const requestId = safeRequestId(metadata?.requestId ?? error.requestId);
  return requestId ? { requestId } : {};
}

function isCancellation(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.name === "AbortError" || error.code === "ABORT_ERR" || error.code === "ERR_ABORTED";
}

function validateInput(input: ModelInput): void {
  if (
    !isRecord(input) ||
    typeof input.systemPrompt !== "string" ||
    typeof input.text !== "string" ||
    !Array.isArray(input.messages) ||
    !isRecord(input.profileSnapshot) ||
    typeof input.modelId !== "string" ||
    typeof input.revision !== "string"
  ) {
    throw new DocumentPreparationError("retrieval", "invalid_input");
  }
}

function profileValues(snapshot: Record<string, unknown>, key: string): string[] {
  const fields = isRecord(snapshot.fields) ? snapshot.fields : undefined;
  const values = fields?.[key];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value): string[] => {
    if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
    if (isRecord(value) && typeof value.label === "string" && value.label.trim().length > 0) {
      return [value.label.trim()];
    }
    return [];
  });
}

function directRetrievalQuery(input: ModelInput): string {
  const parts = [input.text.trim()];
  const levels = profileValues(input.profileSnapshot, "educationLevels");
  const subjects = profileValues(input.profileSnapshot, "subjects");
  if (levels.length > 0) parts.push(`Nivel educativo: ${levels.join(", ")}`);
  if (subjects.length > 0) parts.push(`Materia: ${subjects.join(", ")}`);
  return parts.filter(Boolean).join(". ");
}

function auxiliaryModelInput(input: ModelInput): ModelInput {
  return {
    ...input,
    systemPrompt: [
      input.systemPrompt.trim(),
      "Prepará una consulta autónoma y fiel de búsqueda en una o dos frases, con un máximo total de 1.000 caracteres.",
      "Usá el perfil y el historial confirmado para resolver referentes. Priorizá las restricciones y el nivel indicados en el pedido actual.",
      "No agregues conocimiento externo ni incluyas introducciones, listas, explicaciones o una respuesta al pedido. Devolvé solo el texto de búsqueda, sin superar ese límite.",
    ].join("\n"),
  };
}

function validateRetrievedResults(value: unknown): DocumentResult[] {
  if (!Array.isArray(value) || value.length > 5) {
    throw new DocumentPreparationError("retrieval", "invalid_results");
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.text !== "string" || item.text.trim().length === 0) {
      throw new DocumentPreparationError("retrieval", "invalid_results");
    }
    if (
      (item.location !== undefined && !isRecord(item.location)) ||
      (item.metadata !== undefined && !isRecord(item.metadata)) ||
      (item.score !== undefined &&
        (typeof item.score !== "number" || !Number.isFinite(item.score))) ||
      (item.documentId !== undefined &&
        (typeof item.documentId !== "string" || item.documentId.trim().length === 0)) ||
      (item.location !== undefined && !isJsonValue(item.location)) ||
      (item.metadata !== undefined && !isJsonValue(item.metadata))
    ) {
      throw new DocumentPreparationError("retrieval", "invalid_results");
    }
    return {
      text: item.text,
      ...(item.location === undefined ? {} : { location: structuredClone(item.location) }),
      ...(item.metadata === undefined ? {} : { metadata: structuredClone(item.metadata) }),
      ...(item.score === undefined ? {} : { score: item.score }),
      ...(item.documentId === undefined ? {} : { documentId: item.documentId }),
    };
  });
}

function safeCountResult(value: unknown): value is TokenCountResult {
  return (
    isRecord(value) &&
    typeof value.inputTokens === "number" &&
    Number.isSafeInteger(value.inputTokens) &&
    value.inputTokens >= 0
  );
}

async function reformulatedQuery(
  iterable: AsyncIterable<DocumentProviderEvent>,
  ensureActive: (stage: DocumentPreparationStage) => void,
): Promise<{ query: string; requestId?: string; metrics?: Record<string, number> }> {
  if (
    iterable === null ||
    typeof iterable !== "object" ||
    typeof iterable[Symbol.asyncIterator] !== "function"
  ) {
    throw new DocumentPreparationError("reformulation", "reformulation_failed");
  }
  let query = "";
  let terminalResult: Extract<DocumentProviderEvent, { type: "result" }> | undefined;
  try {
    for await (const event of iterable) {
      ensureActive("reformulation");
      if (!isRecord(event) || typeof event.type !== "string" || terminalResult) {
        throw new DocumentPreparationError("reformulation", "reformulation_incomplete");
      }
      if (event.type === "text" && typeof event.text === "string") {
        query += event.text;
        continue;
      }
      if (event.type === "error") {
        throw new DocumentPreparationError(
          "reformulation",
          "reformulation_failed",
          safeRequestId(event.requestId),
          safeMetrics(event.metrics),
        );
      }
      if (
        event.type === "result" &&
        typeof event.stopReason === "string" &&
        event.stopReason === "end_turn"
      ) {
        terminalResult = event as Extract<DocumentProviderEvent, { type: "result" }>;
        continue;
      }
      throw new DocumentPreparationError(
        "reformulation",
        "reformulation_incomplete",
        safeRequestId("requestId" in event ? event.requestId : undefined),
        safeMetrics("metrics" in event ? event.metrics : undefined),
      );
    }
  } catch (error) {
    if (error instanceof DocumentPreparationError) throw error;
    throw new DocumentPreparationError(
      "reformulation",
      isCancellation(error) ? "cancelled" : "reformulation_failed",
      safeDependencyEvidence(error).requestId,
    );
  }
  ensureActive("reformulation");
  if (!terminalResult) {
    throw new DocumentPreparationError("reformulation", "reformulation_incomplete");
  }
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    throw new DocumentPreparationError(
      "reformulation",
      "empty_query",
      safeRequestId(terminalResult.requestId),
      safeMetrics(terminalResult.metrics),
    );
  }
  if (normalizedQuery.length > retrievalQueryMaxCharacters) {
    throw new DocumentPreparationError(
      "reformulation",
      "reformulation_too_long",
      safeRequestId(terminalResult.requestId),
      safeMetrics(terminalResult.metrics),
    );
  }
  return {
    query: normalizedQuery,
    ...(safeRequestId(terminalResult.requestId)
      ? { requestId: safeRequestId(terminalResult.requestId) }
      : {}),
    ...(safeMetrics(terminalResult.metrics)
      ? { metrics: safeMetrics(terminalResult.metrics) }
      : {}),
  };
}

export function createDocumentPreparer(dependencies: DocumentPreparerDependencies) {
  if (
    !dependencies.knowledgeBaseId ||
    !dependencies.revision ||
    !Number.isSafeInteger(dependencies.preparationTimeoutMs) ||
    dependencies.preparationTimeoutMs <= 0
  ) {
    throw new TypeError("Document preparation requires a revision, knowledge base, and deadline.");
  }

  return async function prepareDocuments(input: ModelInput): Promise<DocumentContext> {
    validateInput(input);
    const controller = new AbortController();
    let stage: DocumentPreparationStage = "retrieval";
    let timeoutError: DocumentPreparationError | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const ensureActive = (nextStage: DocumentPreparationStage = stage): void => {
      stage = nextStage;
      if (controller.signal.aborted) {
        throw timeoutError ?? new DocumentPreparationError(stage, "cancelled");
      }
    };
    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timeoutError = new DocumentPreparationError(stage, "timeout");
        controller.abort(new DOMException("Document preparation deadline exceeded.", "AbortError"));
        reject(timeoutError);
      }, dependencies.preparationTimeoutMs);
    });

    const run = async (): Promise<DocumentContext> => {
      let query = directRetrievalQuery(input);
      let reformulation: DocumentContext["reformulation"];
      if (
        input.messages.length > 0 ||
        input.text.length > retrievalQueryMaxCharacters ||
        query.length > retrievalQueryMaxCharacters
      ) {
        const auxiliaryInput = auxiliaryModelInput(input);
        ensureActive("auxiliary_count");
        let count: unknown;
        try {
          count = await dependencies.countInputTokens(auxiliaryInput, {
            abortSignal: controller.signal,
          });
        } catch (error) {
          throw new DocumentPreparationError(
            "auxiliary_count",
            isCancellation(error) ? "cancelled" : "count_failed",
            safeDependencyEvidence(error).requestId,
          );
        }
        ensureActive("auxiliary_count");
        if (!safeCountResult(count)) {
          throw new DocumentPreparationError("auxiliary_count", "invalid_count");
        }
        if (count.inputTokens > maxAuxiliaryInputTokens) {
          throw new DocumentPreparationError(
            "auxiliary_count",
            "input_too_large",
            safeRequestId(count.requestId),
          );
        }

        ensureActive("reformulation");
        let reformulationEvents: AsyncIterable<DocumentProviderEvent>;
        try {
          reformulationEvents = dependencies.reformulate(auxiliaryInput, {
            maxOutputTokens: reformulationOutputTokens,
            abortSignal: controller.signal,
          });
        } catch (error) {
          throw new DocumentPreparationError(
            "reformulation",
            isCancellation(error) ? "cancelled" : "reformulation_failed",
            safeDependencyEvidence(error).requestId,
          );
        }
        const output = await reformulatedQuery(reformulationEvents, ensureActive);
        query = output.query;
        reformulation = {
          modelId: input.modelId,
          inputTokens: count.inputTokens,
          ...(safeRequestId(output.requestId) ? { requestId: output.requestId } : {}),
          ...(safeRequestId(count.requestId) ? { countRequestId: count.requestId } : {}),
          ...(output.metrics ? { metrics: output.metrics } : {}),
        };
      }

      ensureActive("retrieval");
      let retrievalResponse: unknown;
      try {
        retrievalResponse = await dependencies.retrieve(
          {
            knowledgeBaseId: dependencies.knowledgeBaseId,
            text: query,
            numberOfResults: 5,
            searchType: "SEMANTIC",
          },
          { abortSignal: controller.signal },
        );
      } catch (error) {
        throw new DocumentPreparationError(
          "retrieval",
          isCancellation(error) ? "cancelled" : "retrieval_failed",
          safeDependencyEvidence(error).requestId,
        );
      }
      ensureActive("retrieval");
      if (!isRecord(retrievalResponse)) {
        throw new DocumentPreparationError("retrieval", "invalid_results");
      }
      let results: DocumentResult[];
      try {
        results = validateRetrievedResults(retrievalResponse.results);
      } catch (error) {
        if (error instanceof DocumentPreparationError) throw error;
        throw new DocumentPreparationError("retrieval", "invalid_results");
      }
      const retrievedAt = dependencies.now();
      if (!Number.isFinite(retrievedAt)) {
        throw new DocumentPreparationError("retrieval", "invalid_results");
      }
      const requestId = safeRequestId(retrievalResponse.requestId);
      return {
        knowledgeBaseId: dependencies.knowledgeBaseId,
        query,
        revision: dependencies.revision,
        retrievedAt,
        status: results.length > 0 ? "results" : "empty",
        results,
        ...(requestId ? { requestId } : {}),
        ...(reformulation ? { reformulation } : {}),
      };
    };

    try {
      return await Promise.race([run(), deadline]);
    } catch (error) {
      if (error instanceof DocumentPreparationError) throw error;
      throw new DocumentPreparationError(
        stage,
        isCancellation(error)
          ? "cancelled"
          : stage === "retrieval"
            ? "retrieval_failed"
            : "reformulation_failed",
        safeDependencyEvidence(error).requestId,
      );
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  };
}
