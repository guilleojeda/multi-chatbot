import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const state = { agents: [], streamCalls: [] };
  const Agent = vi.fn(function (options) {
    this.options = options;
    this.stream = vi.fn(async function* (text) {
      state.streamCalls.push({ agent: this, text });
      yield {
        type: "modelStreamUpdateEvent",
        event: {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "textDelta", text: "Respuesta del seguimiento." },
        },
      };
      yield {
        type: "agentResultEvent",
        result: {
          lastMessage: { content: [{ type: "textBlock", text: "Respuesta del seguimiento." }] },
          stopReason: "endTurn",
        },
      };
    });
    this.shutdown = vi.fn(async () => {});
    state.agents.push(this);
  });
  const BedrockModel = vi.fn(function (options) {
    this.options = options;
  });
  return {
    state,
    Agent,
    BedrockModel,
    configureLogging: vi.fn(),
  };
});

vi.mock("@strands-agents/sdk", () => ({
  Agent: sdk.Agent,
  BedrockModel: sdk.BedrockModel,
  configureLogging: sdk.configureLogging,
}));

import { createStrandsGenerator } from "../../runtime/provider.ts";

function historyPair(ordinal) {
  return [
    { role: "user", content: [{ text: `Pregunta anterior ${ordinal}` }] },
    { role: "assistant", content: [{ text: `Respuesta anterior ${ordinal}` }] },
  ];
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("the Strands follow-up provider", () => {
  beforeEach(() => {
    sdk.state.agents.length = 0;
    sdk.state.streamCalls.length = 0;
    sdk.Agent.mockClear();
    sdk.BedrockModel.mockClear();
  });

  it("creates a fresh agent with all prior pairs and passes current text separately", async () => {
    const generate = createStrandsGenerator({ region: "us-east-1" });
    const messages = Array.from({ length: 24 }, (_, index) => historyPair(index + 1)).flat();
    const currentText = "Ahora adaptá la actividad para evitar decimales.";
    const firstProfile = {
      fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
      responsePreferenceIds: ["step-by-step"],
    };
    const secondProfile = {
      fields: { educationLevels: ["primario"], subjects: ["Historia"] },
      responsePreferenceIds: ["ready-material"],
    };
    const request = {
      systemPrompt: "Ayudá con tareas de enseñanza. Perfil de Matemática.",
      profileSnapshot: firstProfile,
      text: currentText,
      messages,
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "reviewed-revision-123",
    };
    const originalRequest = structuredClone(request);

    await expect(collect(generate(request))).resolves.toMatchObject([
      { type: "text", text: "Respuesta del seguimiento." },
      { type: "result", stopReason: "end_turn" },
    ]);

    const nextText = "Agregá un cierre de cinco minutos.";
    const nextMessages = [...messages, ...historyPair(25)];
    const nextRequest = {
      ...request,
      systemPrompt: "Ayudá con tareas de enseñanza. Perfil de Historia.",
      profileSnapshot: secondProfile,
      messages: nextMessages,
      text: nextText,
    };
    const originalNextRequest = structuredClone(nextRequest);
    await expect(collect(generate(nextRequest))).resolves.toMatchObject([
      { type: "text", text: "Respuesta del seguimiento." },
      { type: "result", stopReason: "end_turn" },
    ]);

    expect(sdk.Agent).toHaveBeenCalledTimes(2);
    expect(sdk.BedrockModel).toHaveBeenCalledTimes(2);
    expect(sdk.state.agents).toHaveLength(2);
    expect(sdk.state.agents[0]).not.toBe(sdk.state.agents[1]);
    expect(sdk.state.agents.map(({ options }) => options.messages)).toEqual([
      messages,
      nextMessages,
    ]);
    expect(sdk.state.agents.map(({ options }) => options.systemPrompt)).toEqual([
      request.systemPrompt,
      nextRequest.systemPrompt,
    ]);
    expect(sdk.state.agents.every(({ options }) => options.contextManager === false)).toBe(true);
    expect(sdk.state.agents.every(({ options }) => options.retryStrategy === null)).toBe(true);
    expect(sdk.state.agents.every(({ options }) => options.tools.length === 0)).toBe(true);
    expect(sdk.state.agents.every(({ shutdown }) => shutdown.mock.calls.length === 1)).toBe(true);
    expect(sdk.state.streamCalls.map(({ text }) => text)).toEqual([currentText, nextText]);
    expect(sdk.state.streamCalls.map(({ agent }) => agent)).toEqual(sdk.state.agents);
    expect(sdk.state.agents[0].options.messages).toHaveLength(48);
    expect(sdk.state.agents[0].options.messages).not.toContainEqual({
      role: "user",
      content: [{ text: currentText }],
    });
    expect(request).toEqual(originalRequest);
    expect(nextRequest).toEqual(originalNextRequest);
  });
});
