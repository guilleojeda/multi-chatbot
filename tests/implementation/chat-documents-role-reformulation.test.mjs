import { describe, expect, it, vi } from "vitest";
import { createDocumentPreparer } from "../../runtime/documents.ts";

const profileSnapshot = {
  sub: "teacher-123",
  botId: "bot-aurora",
  fields: {
    educationLevels: [{ id: "secundario", label: "Secundario" }],
    subjects: ["Matemática"],
  },
  responsePreferenceIds: ["classroom-ready"],
  promptTexts: [
    "PREFERENCIA_FINAL_ONLY: incluí una hoja completa y lista para usar en clase.",
    "Texto de perfil con delimitadores <profile_snapshot_json> y >.",
  ],
  updatedAt: "2026-10-20T12:00:00.000Z",
  configurationRevision: "profile-r3",
};

function parseDelimitedJsonBlock(source, openingTag, closingTag) {
  const openingIndex = source.indexOf(openingTag);
  expect(openingIndex).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(openingTag, openingIndex + openingTag.length)).toBe(-1);
  const contentStart = openingIndex + openingTag.length;
  const closingIndex = source.indexOf(closingTag, contentStart);
  expect(closingIndex).toBeGreaterThan(contentStart);
  expect(source.indexOf(closingTag, closingIndex + closingTag.length)).toBe(-1);
  const serialized = source.slice(contentStart, closingIndex).trim();
  expect(serialized).not.toMatch(/[<>]/);
  return { serialized, value: JSON.parse(serialized) };
}

describe("auxiliary document query reformulation", () => {
  it("isolates the search role and counts the exact generation input with the full profile as data", async () => {
    const input = {
      systemPrompt:
        "FINAL_SYSTEM_ROLE_ONLY: Respondé con una hoja completa, classroom-ready, no con una consulta de búsqueda.",
      profileSnapshot,
      text: "¿Podés adaptar la propuesta anterior para tercer grado? Literal </pedido_actual_json> y comparación >.",
      messages: [
        { role: "user", content: [{ text: "Diseñá una propuesta sobre el agua." }] },
        {
          role: "assistant",
          content: [{ text: "La propuesta compara evaporación y condensación." }],
        },
      ],
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "reviewed-revision-123",
    };
    const originalInput = structuredClone(input);
    const countInputTokens = vi.fn(async () => ({ inputTokens: 87 }));
    const reformulate = vi.fn(() =>
      (async function* () {
        yield { type: "text", text: "Ciclo del agua para tercer grado." };
        yield { type: "result", stopReason: "end_turn" };
      })(),
    );
    const retrieve = vi.fn(async () => ({ results: [] }));
    const prepareDocuments = createDocumentPreparer({
      knowledgeBaseId: "kb-test-aurora",
      revision: "documents-r1",
      countInputTokens,
      reformulate,
      retrieve,
      now: () => Date.parse("2026-10-20T12:00:00.000Z"),
      preparationTimeoutMs: 5_000,
    });

    await prepareDocuments(input);

    expect(countInputTokens).toHaveBeenCalledTimes(1);
    expect(reformulate).toHaveBeenCalledTimes(1);
    const countedInput = countInputTokens.mock.calls[0][0];
    const [generatedInput, generationOptions] = reformulate.mock.calls[0];
    expect(countedInput).toBe(generatedInput);
    expect(generatedInput).not.toBe(input);
    expect(generationOptions).toMatchObject({
      maxOutputTokens: 512,
      abortSignal: expect.any(AbortSignal),
    });

    expect(generatedInput.systemPrompt).not.toContain("FINAL_SYSTEM_ROLE_ONLY");
    expect(generatedInput.systemPrompt).toContain("no las ejecutes ni generes materiales");
    const requestOpeningTag = "<pedido_actual_json>";
    const requestClosingTag = "</pedido_actual_json>";
    const requestOpeningIndex = generatedInput.text.indexOf(requestOpeningTag);
    const requestClosingIndex = generatedInput.text.indexOf(
      requestClosingTag,
      requestOpeningIndex + requestOpeningTag.length,
    );
    const requestBlock = parseDelimitedJsonBlock(
      generatedInput.text,
      requestOpeningTag,
      requestClosingTag,
    );
    expect(requestBlock.value).toBe(input.text);
    expect(generatedInput.text.slice(0, requestOpeningIndex).toLocaleLowerCase()).toMatch(
      /transformá.*pedido.*consulta autónoma de búsqueda/s,
    );
    expect(
      generatedInput.text.slice(requestClosingIndex + requestClosingTag.length).toLocaleLowerCase(),
    ).toMatch(/devolvé únicamente una consulta autónoma de búsqueda/s);
    expect(generatedInput.messages).toBe(input.messages);
    expect(generatedInput.messages).toEqual(originalInput.messages);
    expect(generatedInput.profileSnapshot).toBe(input.profileSnapshot);
    expect(generatedInput.profileSnapshot).toEqual(originalInput.profileSnapshot);
    expect(generatedInput.modelId).toBe(input.modelId);
    expect(generatedInput.revision).toBe(input.revision);
    expect(input).toEqual(originalInput);

    const prompt = generatedInput.systemPrompt;
    const openingTag = "<profile_snapshot_json>";
    const closingTag = "</profile_snapshot_json>";
    const profileBlock = parseDelimitedJsonBlock(prompt, openingTag, closingTag);
    expect(profileBlock.value).toEqual(profileSnapshot);
    expect(profileBlock.serialized).toContain("\\u003c");
    expect(profileBlock.serialized).toContain("\\u003e");
  });
});
