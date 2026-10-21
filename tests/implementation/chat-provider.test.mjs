import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  events: [],
  streamError: undefined,
  modelConfig: null,
  agentConfig: null,
  input: null,
  shutdowns: 0,
}));

vi.mock("@strands-agents/sdk", () => ({
  Agent: class AgentDouble {
    constructor(config) {
      doubles.agentConfig = config;
    }

    async *stream(text) {
      doubles.input = text;
      for (const event of doubles.events) yield event;
      if (doubles.streamError) throw doubles.streamError;
    }

    async shutdown() {
      doubles.shutdowns += 1;
    }
  },
  BedrockModel: class BedrockModelDouble {
    constructor(config) {
      doubles.modelConfig = config;
    }
  },
  configureLogging() {},
}));

const { createStrandsGenerator } = await import("../../runtime/provider.ts");

const request = {
  systemPrompt: "Instrucciones y perfil del servidor.",
  profileSnapshot: { fields: { subjects: ["Matemática"] } },
  text: "Armá una actividad.",
  messages: [],
  modelId: "global.anthropic.claude-sonnet-4-6",
  revision: "revision-123",
  resultDeadlineAt: Date.now() + 60 * 60 * 1000,
};

function collect(source) {
  return Array.fromAsync(source);
}

beforeEach(() => {
  doubles.events = [];
  doubles.streamError = undefined;
  doubles.modelConfig = null;
  doubles.agentConfig = null;
  doubles.input = null;
  doubles.shutdowns = 0;
});

describe("the Strands provider boundary", () => {
  it("streams only text and returns real stop and usage metadata with retries and tools disabled", async () => {
    const remainingDeadlineMs = request.resultDeadlineAt - Date.now();
    doubles.events = [
      {
        type: "modelStreamUpdateEvent",
        event: {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "textDelta", text: "Actividad." },
        },
      },
      {
        type: "modelStreamUpdateEvent",
        event: {
          type: "modelMetadataEvent",
          usage: { inputTokens: 73, outputTokens: 28, totalTokens: 101 },
          metrics: { latencyMs: 412 },
        },
      },
      {
        type: "agentResultEvent",
        result: {
          stopReason: "endTurn",
          lastMessage: { content: [{ type: "textBlock", text: "Actividad." }] },
        },
      },
    ];

    const events = await collect(createStrandsGenerator({ region: "us-east-1" })(request));

    expect(events).toEqual([
      { type: "text", text: "Actividad." },
      {
        type: "result",
        stopReason: "end_turn",
        metrics: { inputTokens: 73, outputTokens: 28, totalTokens: 101, latencyMs: 412 },
      },
    ]);
    expect(doubles.input).toBe(request.text);
    expect(doubles.modelConfig).toMatchObject({
      modelId: request.modelId,
      region: "us-east-1",
      stream: true,
      maxTokens: 64_000,
      clientConfig: { maxAttempts: 1 },
    });
    expect(doubles.modelConfig.requestTimeout).toBeGreaterThan(remainingDeadlineMs - 100);
    expect(doubles.modelConfig.requestTimeout).toBeLessThanOrEqual(remainingDeadlineMs);
    expect(doubles.agentConfig).toMatchObject({
      systemPrompt: request.systemPrompt,
      messages: [],
      tools: [],
      retryStrategy: null,
      contextManager: false,
      printer: false,
    });
    expect(doubles.shutdowns).toBe(1);
  });

  it("turns SDK exceptions into allowlisted diagnostics without their raw message", async () => {
    const error = Object.assign(new Error("private provider details"), {
      name: "ThrottlingException",
      $metadata: { requestId: "provider-request-429", httpStatusCode: 429, attempts: 1 },
    });
    doubles.streamError = error;

    const events = await collect(createStrandsGenerator({ region: "us-east-1" })(request));

    expect(events).toEqual([
      {
        type: "error",
        providerCode: "ThrottlingException",
        requestId: "provider-request-429",
        httpStatusCode: 429,
        attempts: 1,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private provider details");
    expect(doubles.shutdowns).toBe(1);
  });

  it("omits default zero usage when Strands has no model metadata event", async () => {
    doubles.events = [
      {
        type: "agentResultEvent",
        result: {
          stopReason: "endTurn",
          lastMessage: { content: [{ type: "textBlock", text: "Actividad." }] },
          metrics: {
            latestAgentInvocation: {
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              cycles: [{ duration: 18 }],
            },
          },
        },
      },
    ];

    const events = await collect(createStrandsGenerator({ region: "us-east-1" })(request));

    expect(events).toEqual([{ type: "result", stopReason: "end_turn" }]);
    expect(doubles.shutdowns).toBe(1);
  });

  it("preserves zero usage and latency when model metadata actually reports zero", async () => {
    doubles.events = [
      {
        type: "modelStreamUpdateEvent",
        event: {
          type: "modelMetadataEvent",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          metrics: { latencyMs: 0 },
        },
      },
      {
        type: "agentResultEvent",
        result: {
          stopReason: "endTurn",
          lastMessage: { content: [{ type: "textBlock", text: "Actividad." }] },
        },
      },
    ];

    const events = await collect(createStrandsGenerator({ region: "us-east-1" })(request));

    expect(events).toEqual([
      {
        type: "result",
        stopReason: "end_turn",
        metrics: { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0 },
      },
    ]);
  });

  it("rejects non-text stream deltas instead of letting them complete as an answer", async () => {
    doubles.events = [
      {
        type: "modelStreamUpdateEvent",
        event: {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "toolUseInputDelta", input: "{}" },
        },
      },
      {
        type: "agentResultEvent",
        result: {
          stopReason: "endTurn",
          lastMessage: { content: [{ type: "textBlock", text: "unexpected" }] },
        },
      },
    ];

    const events = await collect(createStrandsGenerator({ region: "us-east-1" })(request));

    expect(events).toEqual([{ type: "error", providerCode: "Error" }]);
    expect(doubles.shutdowns).toBe(1);
  });
});
