import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BedrockRuntimeClient,
  CountTokensCommand,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { createBedrockTokenCounter, createStrandsGenerator } from "../../runtime/provider.ts";

const retrievalPath = fileURLToPath(
  new URL("../../runtime/documents-provider.ts", import.meta.url),
);
const kbId = "KBEXAMPLE1";
const text = "Observá condensación en una superficie fría.\nCompará las ideas del grupo. 🌧️";
const location = { type: "S3", s3Location: { uri: "s3://prepared-dev/agua.txt" } };
const rawResult = {
  content: { type: "TEXT", text },
  location,
  metadata: { nivel: "primario", source_revision: "fixture-1" },
  score: 0.72,
  documentId: "prepared-water",
};

afterEach(() => vi.restoreAllMocks());

async function retriever(send) {
  expect(
    existsSync(retrievalPath),
    "falta el adaptador público Retrieve del recorrido documental",
  ).toBe(true);
  const module = await import(pathToFileURL(retrievalPath).href);
  expect(module.createBedrockRetriever).toBeTypeOf("function");
  return module.createBedrockRetriever({ region: "us-east-1", client: { send } });
}

const request = () => ({
  knowledgeBaseId: kbId,
  text: "Ciclo del agua: actividades de observación en el aula para tercer grado.",
  numberOfResults: 5,
  searchType: "SEMANTIC",
});

describe("document retrieval provider boundary", () => {
  it("uses Retrieve separately from generation and preserves the available source evidence", async () => {
    const send = vi.fn(async () => ({
      retrievalResults: [structuredClone(rawResult)],
      $metadata: { requestId: "retrieve-request-1" },
    }));
    const retrieve = await retriever(send);
    const result = await retrieve(request());

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command.constructor.name).toBe("RetrieveCommand");
    expect(command.input).toEqual({
      knowledgeBaseId: kbId,
      retrievalQuery: { text: request().text },
      retrievalConfiguration: {
        vectorSearchConfiguration: { numberOfResults: 5, overrideSearchType: "SEMANTIC" },
      },
    });
    expect(result.requestId).toBe("retrieve-request-1");
    expect(result.results).toEqual([
      {
        text,
        location,
        metadata: rawResult.metadata,
        score: rawResult.score,
        documentId: rawResult.documentId,
      },
    ]);
  });

  it("keeps an explicit empty result distinct from dependency failure", async () => {
    const send = vi.fn(async () => ({ retrievalResults: [] }));
    const retrieve = await retriever(send);
    await expect(retrieve(request())).resolves.toMatchObject({ results: [] });

    send.mockRejectedValueOnce(
      Object.assign(new Error("dependency unavailable"), { name: "ThrottlingException" }),
    );
    await expect(retrieve(request())).rejects.toBeDefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("passes the preparation abort signal to the AWS request without retrying", async () => {
    const controller = new AbortController();
    const send = vi.fn(
      (_command, options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
            once: true,
          });
        }),
    );
    const retrieve = await retriever(send);
    const pending = retrieve(request(), { abortSignal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({ abortSignal: controller.signal });
    controller.abort(new DOMException("preparation deadline", "AbortError"));
    await rejected;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing result array", {}],
    ["missing content", { retrievalResults: [{ score: 0.8 }] }],
    ["blank text", { retrievalResults: [{ content: { type: "TEXT", text: "  " } }] }],
    ["nontext result", { retrievalResults: [{ content: { type: "IMAGE", byteContent: "AA==" } }] }],
  ])("does not turn %s into valid empty retrieval", async (_label, response) => {
    const send = vi.fn(async () => response);
    const retrieve = await retriever(send);
    await expect(retrieve(request())).rejects.toBeDefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("the auxiliary Sonnet invocation", () => {
  it("passes its preparation abort signal to native CountTokens", async () => {
    const controller = new AbortController();
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      inputTokens: 37,
      $metadata: { requestId: "auxiliary-count-1" },
    });
    const count = createBedrockTokenCounter({ region: "us-east-1" });
    const input = {
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "documents-acceptance",
      systemPrompt: "Prepará una consulta para recuperar información.",
      messages: [],
      text: "¿Y para tercer grado?",
    };

    await expect(count(input, { abortSignal: controller.signal })).resolves.toMatchObject({
      inputTokens: 37,
      requestId: "auxiliary-count-1",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(CountTokensCommand);
    expect(send.mock.calls[0][1]).toMatchObject({ abortSignal: controller.signal });
  });

  it("honors its explicit short output budget without changing the final-answer default", async () => {
    const calls = [];
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(ConverseStreamCommand);
      calls.push(command.input);
      return {
        stream: (async function* () {
          yield { messageStart: { role: "assistant" } };
          yield { contentBlockStart: { contentBlockIndex: 0, start: {} } };
          yield {
            contentBlockDelta: { contentBlockIndex: 0, delta: { text: "agua observación aula" } },
          };
          yield { contentBlockStop: { contentBlockIndex: 0 } };
          yield { messageStop: { stopReason: "end_turn" } };
        })(),
      };
    });
    const input = {
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "documents-acceptance",
      systemPrompt: "Prepará únicamente una consulta autónoma de búsqueda.",
      profileSnapshot: { fields: { subjects: ["Ciencias Naturales"] } },
      messages: [
        { role: "user", content: [{ text: "Trabajamos el ciclo del agua." }] },
        { role: "assistant", content: [{ text: "Podemos observar el patio." }] },
      ],
      text: "¿Y una alternativa sin salir de la escuela?",
      resultDeadlineAt: Date.now() + 60_000,
    };
    const auxiliary = createStrandsGenerator({ region: "us-east-1", maxOutputTokens: 512 });
    const answer = createStrandsGenerator({ region: "us-east-1" });
    const auxiliaryEvents = await Array.fromAsync(auxiliary(input));
    const answerEvents = await Array.fromAsync(answer(input));

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.inferenceConfig.maxTokens)).toEqual([512, 64_000]);
    expect(calls[0].messages).toEqual([
      ...input.messages,
      { role: "user", content: [{ text: input.text }] },
    ]);
    expect(calls[1].messages).toEqual(calls[0].messages);
    expect(auxiliaryEvents.at(-1)).toMatchObject({ type: "result", stopReason: "end_turn" });
    expect(answerEvents.at(-1)).toMatchObject({ type: "result", stopReason: "end_turn" });
  });
});
