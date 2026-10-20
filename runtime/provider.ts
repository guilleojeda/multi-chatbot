import { Agent, BedrockModel, configureLogging } from "@strands-agents/sdk";

type GenerationInput = {
  systemPrompt: string;
  profileSnapshot: Record<string, unknown>;
  text: string;
  messages: [];
  modelId: string;
  revision: string;
};

type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "result"; stopReason: string; metrics?: Record<string, number> }
  | {
      type: "error";
      providerCode?: string;
      requestId?: string;
      httpStatusCode?: number;
      attempts?: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeProviderError(error: unknown): Extract<ProviderEvent, { type: "error" }> {
  if (!isRecord(error)) return { type: "error" };
  const metadata = isRecord(error.$metadata) ? error.$metadata : {};
  const name = typeof error.name === "string" ? error.name : undefined;
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

function usageMetrics(
  invocation:
    | {
        usage: { inputTokens: number; outputTokens: number; totalTokens: number };
        cycles: { duration: number }[];
      }
    | undefined,
): Record<string, number> | undefined {
  if (!invocation) return undefined;
  const metrics: Record<string, number> = {};
  const usage = invocation.usage;
  if (Number.isFinite(usage.inputTokens)) metrics.inputTokens = usage.inputTokens;
  if (Number.isFinite(usage.outputTokens)) metrics.outputTokens = usage.outputTokens;
  if (Number.isFinite(usage.totalTokens)) metrics.totalTokens = usage.totalTokens;
  if (invocation.cycles.length > 0) {
    const latencyMs = invocation.cycles.reduce((total, cycle) => total + cycle.duration, 0);
    if (Number.isFinite(latencyMs)) metrics.latencyMs = latencyMs;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

export function createStrandsGenerator(input: { region: string }) {
  // The runtime has no transcript logger; Strands' defaults only print warnings/errors,
  // whose SDK payloads can include provider error details.
  configureLogging({ debug() {}, info() {}, warn() {}, error() {} });

  return async function* generate(request: GenerationInput): AsyncGenerator<ProviderEvent> {
    const model = new BedrockModel({
      modelId: request.modelId,
      region: input.region,
      stream: true,
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

    try {
      for await (const event of agent.stream(request.text)) {
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
              case "modelMessageStopEvent":
              case "modelMetadataEvent":
                break;
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
              yield safeProviderError(event.error);
              return;
            }
            break;
          case "agentResultEvent": {
            if (event.result.lastMessage.content.some((block) => block.type !== "textBlock")) {
              throw new Error("Strands returned non-text result content.");
            }
            if (event.result.stopReason === "toolUse") {
              throw new Error("Strands requested a tool.");
            }
            const metrics = usageMetrics(event.result.metrics?.latestAgentInvocation);
            yield {
              type: "result",
              stopReason: stopReason(event.result.stopReason),
              ...(metrics ? { metrics } : {}),
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
      yield safeProviderError(error);
    } finally {
      await agent.shutdown();
    }
  };
}
