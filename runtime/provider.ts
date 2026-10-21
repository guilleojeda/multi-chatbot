import { BedrockRuntimeClient, CountTokensCommand } from "@aws-sdk/client-bedrock-runtime";
import type {
  ContentBlock as BedrockContentBlock,
  Message as BedrockMessage,
} from "@aws-sdk/client-bedrock-runtime";
import { Agent, BedrockModel, configureLogging } from "@strands-agents/sdk";
import { maxOutputTokens } from "./model-capacity.js";
import type { GenerationInput, ModelInput, TokenCountResult } from "./contracts.js";

const countModelId = "anthropic.claude-sonnet-4-6";

function toConverseMessage(message: ModelInput["messages"][number]): BedrockMessage {
  return {
    role: message.role,
    content: message.content.map((block): BedrockContentBlock => {
      if (!("text" in block)) {
        throw new Error("Bedrock input counting supports text messages only.");
      }
      return { text: block.text };
    }),
  };
}

type ProviderEvent =
  | { type: "text"; text: string }
  | {
      type: "result";
      stopReason: string;
      metrics?: Record<string, number>;
    }
  | {
      type: "error";
      providerCode?: string;
      requestId?: string;
      httpStatusCode?: number;
      attempts?: number;
      stopReason?: string;
      metrics?: Record<string, number>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerErrorDetails(error: unknown): {
  name?: string;
  metadata?: Record<string, unknown>;
} {
  const seen = new Set<Record<string, unknown>>();
  let current: unknown = error;
  let firstName: string | undefined;
  let metadata: Record<string, unknown> | undefined;
  let metadataName: string | undefined;

  for (let depth = 0; depth < 8 && isRecord(current) && !seen.has(current); depth += 1) {
    seen.add(current);
    const name = typeof current.name === "string" ? current.name : undefined;
    if (firstName === undefined) firstName = name;
    if (metadata === undefined && isRecord(current.$metadata)) {
      metadata = current.$metadata;
      metadataName = name;
    }
    current = current.cause;
  }

  return { name: metadataName ?? firstName, metadata };
}

function safeProviderError(
  error: unknown,
  outcome?: { stopReason?: string; metrics?: Record<string, number> },
): Extract<ProviderEvent, { type: "error" }> {
  const details = providerErrorDetails(error);
  const metadata = details.metadata ?? {};
  const name = typeof details.name === "string" ? details.name : undefined;
  const requestId = typeof metadata.requestId === "string" ? metadata.requestId : undefined;
  const httpStatusCode = metadata.httpStatusCode;
  const attempts = metadata.attempts;
  return {
    type: "error",
    ...(name && /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? { providerCode: name } : {}),
    ...(requestId && requestId.length <= 256 ? { requestId } : {}),
    ...(typeof httpStatusCode === "number" &&
    Number.isInteger(httpStatusCode) &&
    httpStatusCode >= 100 &&
    httpStatusCode <= 599
      ? { httpStatusCode }
      : {}),
    ...(typeof attempts === "number" && Number.isInteger(attempts) && attempts > 0
      ? { attempts }
      : {}),
    ...(outcome?.stopReason ? { stopReason: outcome.stopReason } : {}),
    ...(outcome?.metrics ? { metrics: outcome.metrics } : {}),
  };
}

function localCancellationEvent(
  observedStopReason?: string,
  metrics?: Record<string, number>,
): Extract<ProviderEvent, { type: "error" }> {
  const confirmedStopReason = observedStopReason ? stopReason(observedStopReason) : undefined;
  return {
    type: "error",
    providerCode: "local_cancellation",
    ...(confirmedStopReason && confirmedStopReason !== "cancelled"
      ? { stopReason: confirmedStopReason }
      : {}),
    ...(metrics ? { metrics } : {}),
  };
}

function stopReason(reason: string): string {
  switch (reason) {
    case "endTurn":
      return "end_turn";
    case "maxTokens":
      return "max_tokens";
    default:
      return reason;
  }
}

function modelEventMetrics(event: unknown): Record<string, number> | undefined {
  if (!isRecord(event)) return undefined;
  const metrics: Record<string, number> = {};
  const usage = isRecord(event.usage) ? event.usage : undefined;
  for (const name of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadInputTokens",
    "cacheWriteInputTokens",
  ]) {
    const value = usage?.[name];
    if (typeof value === "number" && Number.isFinite(value)) metrics[name] = value;
  }
  const performanceMetrics = isRecord(event.metrics) ? event.metrics : undefined;
  for (const name of ["latencyMs", "timeToFirstByteMs"]) {
    const value = performanceMetrics?.[name];
    if (typeof value === "number" && Number.isFinite(value)) metrics[name] = value;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

export function createStrandsGenerator(input: { region: string }) {
  // The runtime has no transcript logger; Strands' defaults only print warnings/errors,
  // whose SDK payloads can include provider error details.
  configureLogging({ debug() {}, info() {}, warn() {}, error() {} });

  return async function* generate(request: GenerationInput): AsyncGenerator<ProviderEvent> {
    const remainingDeadlineMs = Math.max(1, request.resultDeadlineAt - Date.now());
    const model = new BedrockModel({
      modelId: request.modelId,
      region: input.region,
      stream: true,
      maxTokens: maxOutputTokens,
      requestTimeout: remainingDeadlineMs,
      clientConfig: { maxAttempts: 1 },
    });
    const agent = new Agent({
      model,
      systemPrompt: request.systemPrompt,
      messages: [...request.messages],
      tools: [],
      retryStrategy: null,
      contextManager: false,
      printer: false,
    });

    let observedStopReason: string | undefined;
    let observedMetrics: Record<string, number> | undefined;
    try {
      for await (const event of agent.stream(
        request.text,
        request.cancelSignal ? { cancelSignal: request.cancelSignal } : undefined,
      )) {
        switch (event.type) {
          case "modelStreamUpdateEvent": {
            const modelEvent = event.event;
            switch (modelEvent.type) {
              case "modelContentBlockDeltaEvent":
                if (modelEvent.delta.type !== "textDelta") {
                  throw new Error("Strands returned non-text output.");
                }
                if (modelEvent.delta.text.length > 0) {
                  yield { type: "text", text: modelEvent.delta.text };
                }
                break;
              case "modelContentBlockStartEvent":
                if (modelEvent.start) throw new Error("Strands requested a tool.");
                break;
              case "modelMessageStartEvent":
              case "modelContentBlockStopEvent":
                break;
              case "modelMessageStopEvent":
                observedStopReason = stopReason(modelEvent.stopReason);
                break;
              case "modelMetadataEvent": {
                const metrics = modelEventMetrics(modelEvent);
                if (metrics) observedMetrics = { ...observedMetrics, ...metrics };
                break;
              }
              default:
                throw new Error("Strands returned an unsupported model event.");
            }
            break;
          }
          case "contentBlockEvent":
            if (event.contentBlock.type !== "textBlock") {
              throw new Error("Strands returned non-text content.");
            }
            break;
          case "messageAddedEvent":
          case "modelMessageEvent":
            if (event.message.content.some((block) => block.type !== "textBlock")) {
              throw new Error("Strands returned non-text message content.");
            }
            break;
          case "afterModelCallEvent":
            if (event.error) {
              if (request.cancelSignal?.aborted) {
                yield localCancellationEvent(observedStopReason, observedMetrics);
                return;
              }
              yield safeProviderError(event.error, {
                ...(observedStopReason ? { stopReason: observedStopReason } : {}),
                ...(observedMetrics ? { metrics: observedMetrics } : {}),
              });
              return;
            }
            break;
          case "agentResultEvent": {
            if (event.result.lastMessage.content.some((block) => block.type !== "textBlock")) {
              throw new Error("Strands returned non-text result content.");
            }
            if (request.cancelSignal?.aborted || event.result.stopReason === "cancelled") {
              yield localCancellationEvent(observedStopReason, observedMetrics);
              return;
            }
            if (event.result.stopReason === "toolUse") {
              throw new Error("Strands requested a tool.");
            }
            const resultStopReason = stopReason(event.result.stopReason);
            yield {
              type: "result",
              stopReason: resultStopReason,
              ...(observedMetrics ? { metrics: observedMetrics } : {}),
            };
            break;
          }
          case "beforeInvocationEvent":
          case "afterInvocationEvent":
          case "beforeModelCallEvent":
            break;
          case "beforeToolsEvent":
          case "afterToolsEvent":
          case "beforeToolCallEvent":
          case "afterToolCallEvent":
          case "toolStreamUpdateEvent":
          case "toolResultEvent":
          case "interruptEvent":
            throw new Error("Strands attempted unsupported tool or interrupt behavior.");
          default:
            throw new Error("Strands returned an unsupported agent event.");
        }
      }
    } catch (error) {
      if (request.cancelSignal?.aborted) {
        yield localCancellationEvent(observedStopReason, observedMetrics);
        return;
      }
      yield safeProviderError(error, {
        ...(observedStopReason ? { stopReason: observedStopReason } : {}),
        ...(observedMetrics ? { metrics: observedMetrics } : {}),
      });
    } finally {
      await agent.shutdown();
    }
  };
}

export function createBedrockTokenCounter(input: { region: string }) {
  const client = new BedrockRuntimeClient({ region: input.region, maxAttempts: 1 });

  return async function countInputTokens(request: ModelInput): Promise<TokenCountResult> {
    const command = new CountTokensCommand({
      modelId: countModelId,
      input: {
        converse: {
          system: [{ text: request.systemPrompt }],
          messages: [
            ...request.messages.map(toConverseMessage),
            { role: "user", content: [{ text: request.text }] },
          ],
        },
      },
    });
    const result = await client.send(command);
    if (
      !isRecord(result) ||
      typeof result.inputTokens !== "number" ||
      !Number.isInteger(result.inputTokens) ||
      result.inputTokens < 0
    ) {
      throw new Error("Bedrock returned an invalid native input-token count.");
    }

    const requestId = result.$metadata.requestId;
    return {
      inputTokens: result.inputTokens,
      ...(typeof requestId === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(requestId)
        ? { requestId }
        : {}),
    };
  };
}
