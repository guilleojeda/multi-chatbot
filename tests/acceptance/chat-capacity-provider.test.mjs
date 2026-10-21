import http2 from "node:http2";
import {
  BedrockRuntimeClient,
  CountTokensCommand,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { configureLogging } from "@strands-agents/sdk";
import { afterEach, describe, expect, it } from "vitest";
import * as provider from "../../runtime/provider.ts";

const baseModelId = "anthropic.claude-sonnet-4-6";
const generationModelId = "global.anthropic.claude-sonnet-4-6";

function requireCapability(name) {
  const capability = provider[name];
  expect(capability, `runtime/provider.ts must export ${name}`).toBeTypeOf("function");
  return capability;
}

function collect(iterable) {
  return Array.fromAsync(iterable);
}

function historyPair(index) {
  return [
    { role: "user", content: [{ text: `Pregunta anterior ${index}: ¿qué cambió?` }] },
    { role: "assistant", content: [{ text: `Respuesta anterior ${index}: proporción áurea.` }] },
  ];
}

function requestsForCountingAndGeneration() {
  const profile = {
    educationLevels: ["Secundario"],
    subjects: ["Matemática", "Física"],
    responsePreferences: ["paso a paso"],
  };
  const profileText = `Perfil vigente: ${JSON.stringify(profile)}`;
  const systemPrompt = `Ayudá con tareas docentes.\r\n${profileText}\nConservá "la notación" y los saltos.`;
  const startText = "Armá una guía con 2 problemas de razón y proporción. 🌎";
  const history = Array.from({ length: 32 }, (_, index) => historyPair(index + 1)).flat();
  const followupText =
    'Revisá el ejercicio 17: mantené \tla tabla, agregá una pista y respetá el texto exacto: "a/b".\nFin. 🧭';
  const resultDeadlineAt = Date.now() + 60 * 60 * 1000;

  return [
    {
      systemPrompt,
      profileSnapshot: profile,
      text: startText,
      messages: [],
      modelId: generationModelId,
      revision: "provider-acceptance-revision",
      resultDeadlineAt,
    },
    {
      systemPrompt,
      profileSnapshot: profile,
      text: followupText,
      messages: history,
      modelId: generationModelId,
      revision: "provider-acceptance-revision",
      resultDeadlineAt,
    },
  ];
}

async function withSdkSendBoundary(run, responseForCommand) {
  const prototype = BedrockRuntimeClient.prototype;
  const ownDescriptor = Object.getOwnPropertyDescriptor(prototype, "send");
  const originalSend = prototype.send;

  prototype.send = async function (command, ...options) {
    return responseForCommand.call(this, command, options, originalSend);
  };

  try {
    return await run();
  } finally {
    if (ownDescriptor) Object.defineProperty(prototype, "send", ownDescriptor);
    else delete prototype.send;
  }
}

async function* successfulConverseStream() {
  yield { messageStart: { role: "assistant" } };
  yield { contentBlockStart: { contentBlockIndex: 0, start: {} } };
  yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Respuesta de prueba." } } };
  yield { contentBlockStop: { contentBlockIndex: 0 } };
  yield { messageStop: { stopReason: "end_turn" } };
  yield {
    metadata: {
      usage: { inputTokens: 42, outputTokens: 5, totalTokens: 47 },
      metrics: { latencyMs: 3 },
    },
  };
}

async function runWithLoopbackBedrock(mode, run) {
  const server = http2.createServer();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const codec = new EventStreamCodec(
    (bytes) => decoder.decode(bytes),
    (text) => encoder.encode(text),
  );
  const frame = codec.encode({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: "contentBlockDelta" },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: encoder.encode(JSON.stringify({ contentBlockIndex: 0, delta: { text: "fragmento" } })),
  });
  const received = [];
  server.on("stream", (stream, headers) => {
    received.push(headers[":path"]);
    if (mode === "initial-headers") return;

    stream.respond({ ":status": 200, "content-type": "application/vnd.amazon.eventstream" });
    if (mode === "active-stream") {
      const timer = setInterval(() => stream.write(frame), 25);
      stream.on("close", () => clearInterval(timer));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const keys = [
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_EC2_METADATA_DISABLED",
    "AWS_REGION",
  ];
  const priorEnvironment = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = `http://127.0.0.1:${server.address().port}`;
  process.env.AWS_ACCESS_KEY_ID = "acceptance-local-key";
  process.env.AWS_SECRET_ACCESS_KEY = "acceptance-local-secret";
  process.env.AWS_EC2_METADATA_DISABLED = "true";
  process.env.AWS_REGION = "us-east-1";

  const prototype = BedrockRuntimeClient.prototype;
  const ownDescriptor = Object.getOwnPropertyDescriptor(prototype, "send");
  const originalSend = prototype.send;
  const clientCalls = [];
  prototype.send = async function (command, options, ...rest) {
    const requestHandler = this.config.requestHandler;
    const call = {
      command,
      options,
      effectiveTimeoutMs: undefined,
    };
    clientCalls.push(call);
    try {
      return await originalSend.call(this, command, options, ...rest);
    } finally {
      call.effectiveTimeoutMs = requestHandler.httpHandlerConfigs().requestTimeout;
    }
  };

  try {
    return await run({ received, clientCalls });
  } finally {
    if (ownDescriptor) Object.defineProperty(prototype, "send", ownDescriptor);
    else delete prototype.send;
    for (const [key, value] of priorEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

afterEach(() => {
  configureLogging({ debug() {}, info() {}, warn() {}, error() {} });
});

describe("Bedrock input counting and generation request parity", () => {
  it("counts the exact system and ordered messages sent by real Strands for a start and long follow-up", async () => {
    configureLogging({ debug() {}, info() {}, warn() {}, error() {} });
    const createCounter = requireCapability("createBedrockTokenCounter");
    const countInputTokens = createCounter({ region: "us-east-1" });
    const generate = provider.createStrandsGenerator({ region: "us-east-1" });
    const requests = requestsForCountingAndGeneration();
    const calls = [];

    await withSdkSendBoundary(
      async () => {
        for (const request of requests) {
          await expect(countInputTokens(request)).resolves.toMatchObject({ inputTokens: 42 });
          await expect(collect(generate(request))).resolves.toMatchObject([
            { type: "text", text: "Respuesta de prueba." },
            { type: "result", stopReason: "end_turn" },
          ]);
        }
      },
      async function (command, _options, originalSend) {
        calls.push(command);
        if (command instanceof CountTokensCommand) {
          return { inputTokens: 42, $metadata: { requestId: "count-request" } };
        }
        if (command instanceof ConverseStreamCommand) {
          return {
            stream: successfulConverseStream(),
            $metadata: { requestId: "generation-request" },
          };
        }
        return originalSend.call(this, command);
      },
    );

    expect(calls).toHaveLength(4);
    for (let index = 0; index < requests.length; index += 1) {
      const countCommand = calls[index * 2];
      const generationCommand = calls[index * 2 + 1];
      expect(countCommand).toBeInstanceOf(CountTokensCommand);
      expect(generationCommand).toBeInstanceOf(ConverseStreamCommand);
      expect(countCommand.input.modelId).toBe(baseModelId);
      expect(generationCommand.input.modelId).toBe(generationModelId);
      expect(generationCommand.input.inferenceConfig).toMatchObject({ maxTokens: 64_000 });

      const expectedConverse = {
        system: [{ text: requests[index].systemPrompt }],
        messages: [
          ...requests[index].messages,
          { role: "user", content: [{ text: requests[index].text }] },
        ],
      };
      expect(countCommand.input.input).toEqual({ converse: expectedConverse });
      expect({
        system: generationCommand.input.system,
        messages: generationCommand.input.messages,
      }).toEqual(expectedConverse);
      expect(
        generationCommand.input.messages.filter(
          ({ role, content }) =>
            role === "user" && content.some(({ text }) => text === requests[index].text),
        ),
      ).toHaveLength(1);
      expect(countCommand.input).not.toHaveProperty("inferenceConfig");
    }
  });

  it("fails closed when CountTokens errors or returns a missing or invalid native count", async () => {
    const createCounter = requireCapability("createBedrockTokenCounter");
    const countInputTokens = createCounter({ region: "us-east-1" });
    const [request] = requestsForCountingAndGeneration();
    const invalidResponses = [
      undefined,
      {},
      { inputTokens: -1 },
      { inputTokens: 1.5 },
      { inputTokens: "42" },
    ];

    let errorCalls = 0;
    await withSdkSendBoundary(
      async () => {
        await expect(countInputTokens(request)).rejects.toThrow();
        expect(errorCalls).toBe(1);
      },
      async function (command) {
        errorCalls += 1;
        expect(command).toBeInstanceOf(CountTokensCommand);
        throw Object.assign(new Error("private provider response"), {
          name: "ValidationException",
          $metadata: { requestId: "native-count-error", httpStatusCode: 400, attempts: 1 },
        });
      },
    );

    for (const response of invalidResponses) {
      let countCalls = 0;
      await withSdkSendBoundary(
        async () => {
          await expect(countInputTokens(request)).rejects.toThrow();
          expect(countCalls).toBe(1);
        },
        async (command) => {
          countCalls += 1;
          expect(command).toBeInstanceOf(CountTokensCommand);
          return response;
        },
      );
    }
  });
});

describe("the installed Bedrock HTTP/2 handler and absolute result deadline", () => {
  it.each(["initial-headers", "silent-stream", "active-stream"])(
    "keeps the remaining result deadline across the %s call and does not complete it",
    async (mode) => {
      configureLogging({ debug() {}, info() {}, warn() {}, error() {} });
      const remainingMs = 450;
      const resultDeadlineAt = Date.now() + remainingMs;
      const controller = new AbortController();
      const deadlineTimer = setTimeout(
        () => controller.abort(),
        Math.max(0, resultDeadlineAt - Date.now()),
      );

      try {
        await runWithLoopbackBedrock(mode, async ({ received, clientCalls }) => {
          const startedAt = Date.now();
          const events = await collect(
            provider.createStrandsGenerator({ region: "us-east-1" })({
              ...requestsForCountingAndGeneration()[0],
              resultDeadlineAt,
              cancelSignal: controller.signal,
            }),
          );
          const elapsedMs = Date.now() - startedAt;

          expect(received).toEqual(["/model/global.anthropic.claude-sonnet-4-6/converse-stream"]);
          expect(clientCalls).toHaveLength(1);
          expect(clientCalls[0].command).toBeInstanceOf(ConverseStreamCommand);
          expect(clientCalls[0].options.abortSignal).toBeInstanceOf(AbortSignal);
          expect(clientCalls[0].options.abortSignal.aborted).toBe(true);
          expect(clientCalls[0].effectiveTimeoutMs).toBeGreaterThan(0);
          expect(clientCalls[0].effectiveTimeoutMs).toBeLessThanOrEqual(remainingMs);
          expect(clientCalls[0].effectiveTimeoutMs).toBeGreaterThan(remainingMs - 150);
          expect(elapsedMs).toBeLessThan(remainingMs + 500);
          expect(events.at(-1)?.type).toBe("error");
          expect(events.some(({ type }) => type === "result")).toBe(false);
          if (mode === "active-stream") {
            expect(events.some(({ type }) => type === "text")).toBe(true);
          }
        });
      } finally {
        clearTimeout(deadlineTimer);
      }
    },
  );
});
