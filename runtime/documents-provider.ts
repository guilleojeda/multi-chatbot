import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  type RetrieveCommandInput,
} from "@aws-sdk/client-bedrock-agent-runtime";
import type { DocumentResult } from "./contracts.js";
import type { DocumentRetrievalRequest, DocumentRetrievalResponse } from "./documents.js";

type RetrieveClient = {
  send(command: RetrieveCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
};

type RetrieverInput = {
  region: string;
  client?: RetrieveClient;
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

function validRequest(value: DocumentRetrievalRequest): boolean {
  return (
    isRecord(value) &&
    typeof value.knowledgeBaseId === "string" &&
    value.knowledgeBaseId.trim().length > 0 &&
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    value.numberOfResults === 5 &&
    value.searchType === "SEMANTIC"
  );
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value) ? value : undefined;
}

function normalizeResults(value: unknown): DocumentResult[] {
  if (!Array.isArray(value) || value.length > 5) {
    throw new Error("Bedrock returned an invalid retrieval result collection.");
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !isRecord(item.content) ||
      item.content.type !== "TEXT" ||
      typeof item.content.text !== "string" ||
      item.content.text.trim().length === 0
    ) {
      throw new Error("Bedrock returned a retrieval result without usable text.");
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
      throw new Error("Bedrock returned invalid retrieval metadata.");
    }
    return {
      text: item.content.text,
      ...(item.location === undefined ? {} : { location: structuredClone(item.location) }),
      ...(item.metadata === undefined ? {} : { metadata: structuredClone(item.metadata) }),
      ...(item.score === undefined ? {} : { score: item.score }),
      ...(item.documentId === undefined ? {} : { documentId: item.documentId }),
    };
  });
}

function retrieveCommandInput(request: DocumentRetrievalRequest): RetrieveCommandInput {
  return {
    knowledgeBaseId: request.knowledgeBaseId,
    retrievalQuery: { text: request.text },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: 5,
        overrideSearchType: "SEMANTIC",
      },
    },
  };
}

export function createBedrockRetriever(input: RetrieverInput) {
  if (!input.region) throw new TypeError("Bedrock Retrieve requires an AWS region.");
  const client =
    input.client ?? new BedrockAgentRuntimeClient({ region: input.region, maxAttempts: 1 });

  return async function retrieve(
    request: DocumentRetrievalRequest,
    options: { abortSignal?: AbortSignal } = {},
  ): Promise<DocumentRetrievalResponse> {
    if (!validRequest(request)) throw new TypeError("Invalid Bedrock Retrieve request.");
    const command = new RetrieveCommand(retrieveCommandInput(request));
    const result: unknown = await client.send(command, {
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    if (!isRecord(result)) throw new Error("Bedrock returned an invalid Retrieve response.");
    const results = normalizeResults(result.retrievalResults);
    const requestId = safeRequestId(
      isRecord(result.$metadata) ? result.$metadata.requestId : undefined,
    );
    return { results, ...(requestId ? { requestId } : {}) };
  };
}
