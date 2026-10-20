import { BedrockModel } from "@strands-agents/sdk";
import { describe, expect, it } from "vitest";
import { createStrandsGenerator } from "../../runtime/provider.ts";
import { createChatHandler } from "../../runtime/chat.ts";

const request = {
  systemPrompt: "Instrucciones y perfil del servidor.",
  profileSnapshot: { fields: { subjects: ["Matemática"] } },
  text: "Armá una actividad.",
  messages: [],
  modelId: "global.anthropic.claude-sonnet-4-6",
  revision: "revision-123",
};
const conversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const queryId = "a4bfbc9f-3699-4e93-b120-a03c0204bc67";

const profileConfig = {
  fields: [
    {
      id: "educationLevels",
      label: "Niveles educativos",
      required: true,
      type: "multi-select",
      options: [{ id: "secundario", label: "Secundario" }],
    },
    { id: "subjects", label: "Materias", required: true, type: "text-list" },
  ],
  responsePreferences: [],
};

async function collect(source) {
  const events = [];
  for await (const event of source) events.push(event);
  return events;
}

async function withModelStream(events, run, streamError) {
  const original = Object.getOwnPropertyDescriptor(BedrockModel.prototype, "stream");
  let calls = 0;
  Object.defineProperty(BedrockModel.prototype, "stream", {
    configurable: true,
    value: async function* () {
      calls += 1;
      yield* events;
      if (streamError) throw streamError;
    },
  });
  try {
    return await run(() => calls);
  } finally {
    if (original) Object.defineProperty(BedrockModel.prototype, "stream", original);
    else delete BedrockModel.prototype.stream;
  }
}

function modelMessageEvents(stopReason, includeMetadata) {
  return [
    { type: "modelMessageStartEvent", role: "assistant" },
    { type: "modelContentBlockStartEvent" },
    {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text: "Respuesta parcial." },
    },
    { type: "modelContentBlockStopEvent" },
    { type: "modelMessageStopEvent", stopReason },
    ...(includeMetadata
      ? [
          {
            type: "modelMetadataEvent",
            usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
            metrics: { latencyMs: 37 },
          },
        ]
      : []),
  ];
}

function makeHandler() {
  const state = { appended: [], failed: [], completed: [] };
  const profile = {
    sub: "teacher-123",
    botId: "bot-aurora",
    fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
    responsePreferenceIds: [],
    updatedAt: "2026-10-20T12:00:00.000Z",
  };
  const handler = createChatHandler({
    config: {
      botId: "bot-aurora",
      profile: profileConfig,
      modelId: request.modelId,
      revision: request.revision,
      systemPrompt: request.systemPrompt,
    },
    accounts: {
      async hasMember() {
        return true;
      },
    },
    profiles: {
      async getProfile() {
        return profile;
      },
    },
    store: {
      async getMeta() {
        return null;
      },
      async startTurn() {
        return { queryId, ordinal: 1 };
      },
      async appendChunk(input) {
        state.appended.push(input);
      },
      async completeTurn(input) {
        state.completed.push(input);
      },
      async failTurn(input) {
        state.failed.push(input);
      },
    },
    generate: createStrandsGenerator({ region: "us-east-1" }),
    now: () => Date.parse("2026-10-20T12:00:00.000Z"),
    newQueryId: () => queryId,
  });
  return { handler, state };
}

describe("the real Strands/Bedrock provider stream contract", () => {
  it("retains max-token stop reason and provider metrics when Strands throws before AgentResult", async () => {
    await withModelStream(modelMessageEvents("maxTokens", true), async (streamCalls) => {
      const events = await collect(createStrandsGenerator({ region: "us-east-1" })(request));
      const providerError = events.find(({ type }) => type === "error");

      expect(events.some(({ type }) => type === "text")).toBe(true);
      expect(providerError).toMatchObject({
        type: "error",
        providerCode: "MaxTokensError",
        stopReason: "max_tokens",
        metrics: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          latencyMs: 37,
        },
      });
      expect(events.some(({ type }) => type === "result")).toBe(false);
      expect(streamCalls()).toBe(1);
      expect(JSON.stringify(events)).not.toContain("maximum token limit");
    });
  });

  it("leaves usage absent when the real SDK emits no model metadata event", async () => {
    await withModelStream(modelMessageEvents("endTurn", false), async () => {
      const events = await collect(createStrandsGenerator({ region: "us-east-1" })(request));
      const result = events.find(({ type }) => type === "result");

      expect(result).toEqual({ type: "result", stopReason: "end_turn" });
      expect(JSON.stringify(events)).not.toMatch(
        /"(?:inputTokens|outputTokens|totalTokens|latencyMs)":0/,
      );
    });
  });

  it("persists the real Strands max-token failure metadata on the failed turn", async () => {
    const { handler, state } = makeHandler();
    const claims = Buffer.from(
      JSON.stringify({ sub: "teacher-123", token_use: "access" }),
    ).toString("base64url");

    await withModelStream(modelMessageEvents("maxTokens", true), async (streamCalls) => {
      const events = await collect(
        handler(
          { version: 1, operation: "start", conversationId, text: request.text },
          {
            sessionId: conversationId,
            headers: {
              authorization: `Bearer e30.${claims}.runtime-validated`,
              "x-amzn-bedrock-agentcore-runtime-session-id": conversationId,
            },
          },
        ),
      );

      expect(events.some(({ type }) => type === "completed")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "failed", code: "incomplete_response" });
      expect(state.appended.map(({ text }) => text).join("")).toBe("Respuesta parcial.");
      expect(state.failed).toHaveLength(1);
      expect(state.failed[0]).toMatchObject({
        stopReason: "max_tokens",
        metrics: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          latencyMs: 37,
        },
        providerError: { providerCode: "MaxTokensError" },
      });
      expect(state.completed).toHaveLength(0);
      expect(streamCalls()).toBe(1);
      expect(JSON.stringify(events)).not.toContain("maximum token limit");
    });
  });

  it("persists allowlisted Bedrock metadata through the real Strands cause wrapper", async () => {
    const { handler, state } = makeHandler();
    const claims = Buffer.from(
      JSON.stringify({ sub: "teacher-123", token_use: "access" }),
    ).toString("base64url");
    const sdkError = Object.assign(
      new Error("private provider message contains a token and response body"),
      {
        name: "ThrottlingException",
        $metadata: {
          requestId: "provider-request-429",
          httpStatusCode: 429,
          attempts: 1,
        },
        body: "private provider response body",
      },
    );

    await withModelStream(
      [],
      async (streamCalls) => {
        const events = await collect(
          handler(
            { version: 1, operation: "start", conversationId, text: request.text },
            {
              sessionId: conversationId,
              headers: {
                authorization: `Bearer e30.${claims}.runtime-validated`,
                "x-amzn-bedrock-agentcore-runtime-session-id": conversationId,
              },
            },
          ),
        );

        expect(events.at(-1)).toMatchObject({ type: "failed", code: "provider_error" });
        expect(JSON.stringify(events)).not.toMatch(
          /ThrottlingException|provider-request-429|private provider|response body|token/,
        );
        expect(state.failed).toHaveLength(1);
        expect(state.failed[0].providerError).toEqual({
          providerCode: "ThrottlingException",
          requestId: "provider-request-429",
          httpStatusCode: 429,
          attempts: 1,
        });
        expect(state.completed).toHaveLength(0);
        expect(streamCalls()).toBe(1);
      },
      sdkError,
    );
  });
});
