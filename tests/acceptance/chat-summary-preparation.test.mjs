import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, fixedNow, projectRoot } from "./helpers/documents-runtime-harness.mjs";

const contextPath = path.join(projectRoot, "runtime/context.ts");
const modelId = "global.anthropic.claude-sonnet-4-6";
const revision = "summary-preparation-revision-1";
const triggerTokens = 128_000;
const summaryInputLimit = 1_000_000 - 64_000;
const summaryPreparationTimeoutMs = 60 * 60 * 1_000;
const currentRequestMarker = "CURRENT_REQUEST_MUST_NOT_ENTER_SUMMARY";
const profileMarker = "CURRENT_PROFILE_MUST_NOT_ENTER_SUMMARY";
const systemMarker = "COMPLETE_SYSTEM_INSTRUCTIONS_MARKER";

let createContextPreparer;

function message(role, text) {
  return { role, content: [{ text }] };
}

function makePair(ordinal, { question, answer } = {}) {
  return [
    message("user", question ?? `COMPLETE_QUESTION_${ordinal}`),
    message("assistant", answer ?? `COMPLETE_ANSWER_${ordinal}`),
  ];
}

function queryId(ordinal) {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function makeReferences(count, firstOrdinal = 1) {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = firstOrdinal + index;
    return { ordinal, queryId: queryId(ordinal) };
  });
}

function makeHistory(count, firstOrdinal = 1, overrides = {}) {
  const references = makeReferences(count, firstOrdinal);
  const messages = references.flatMap(({ ordinal }) => makePair(ordinal, overrides[ordinal]));
  return { messages, references };
}

function makeModelInput(messages, overrides = {}) {
  return {
    systemPrompt: `${systemMarker}; active profile content: ${profileMarker}`,
    profileSnapshot: {
      sub: caller.sub,
      botId: "bot-aurora",
      marker: profileMarker,
      fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
    },
    text: currentRequestMarker,
    messages,
    modelId,
    revision,
    ...overrides,
  };
}

function eventStream(events) {
  return (async function* () {
    for (const event of events) yield structuredClone(event);
  })();
}

function successfulSummaryStream(text = "SUMMARY_OUTPUT_DATA", metrics = { outputTokens: 12 }) {
  return eventStream([
    { type: "text", text },
    { type: "result", stopReason: "end_turn", metrics },
  ]);
}

function createPreparer({
  countInputTokens = vi.fn(async () => ({ inputTokens: 32, requestId: "count-request" })),
  summarize = vi.fn(() => successfulSummaryStream()),
  now = () => fixedNow,
  options = {},
} = {}) {
  const prepareContext = createContextPreparer({
    countInputTokens,
    summarize,
    now,
    ...options,
  });
  return { prepareContext, countInputTokens, summarize };
}

function preparationOptions(references, summary) {
  return {
    references,
    ...(summary ? { summary } : {}),
  };
}

function messageText(item) {
  return item.content
    .filter((block) => typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function messagesText(messages) {
  return messages.map(messageText).join("\n");
}

function effectiveModelText(input) {
  return [input.systemPrompt, input.text, messagesText(input.messages)].join("\n");
}

function modelInputForCounting(generationInput) {
  const modelInput = { ...generationInput };
  delete modelInput.cancelSignal;
  delete modelInput.resultDeadlineAt;
  return modelInput;
}

function expectOriginalMessagesInOrder(actualMessages, expectedMessages) {
  let nextMessageIndex = 0;
  for (const original of expectedMessages) {
    const originalText = messageText(original);
    const foundIndex = actualMessages.findIndex(
      (candidate, index) =>
        index >= nextMessageIndex &&
        candidate.role === original.role &&
        messageText(candidate).includes(originalText),
    );
    expect(foundIndex, `missing preserved ${original.role} history message`).toBeGreaterThanOrEqual(
      nextMessageIndex,
    );
    nextMessageIndex = foundIndex + 1;
  }
}

function expectFixedPreparedAt(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  expect(timestamp).toBe(fixedNow);
}

function makePreviousSummary() {
  return {
    version: 1,
    summaryId: "summary-version-2",
    throughOrdinal: 2,
    sourceReferences: makeReferences(2),
    text: "PREVIOUS_SUMMARY_DATA",
    modelId,
    revision,
    preparedAt: new Date(fixedNow - 1_000).toISOString(),
    inputTokens: 900,
    countRequestId: "previous-count-request",
  };
}

beforeAll(async () => {
  if (!existsSync(contextPath)) return;
  const module = await import(pathToFileURL(contextPath).href);
  createContextPreparer = module.createContextPreparer;
});

beforeEach(() => {
  expect(
    typeof createContextPreparer,
    "producto ausente: expected runtime/context.ts#createContextPreparer",
  ).toBe("function");
});

describe("preparación recurrente del contexto del chat", () => {
  it("usa el conteo nativo de la entrada previa completa y no resume justo debajo de 128000", async () => {
    const history = makeHistory(5);
    const modelInput = makeModelInput(history.messages);
    const countInputTokens = vi.fn(async () => ({
      inputTokens: triggerTokens - 1,
      requestId: "trigger-count-127999",
    }));
    const summarize = vi.fn(() => successfulSummaryStream());
    const { prepareContext } = createPreparer({ countInputTokens, summarize });
    const originalInput = structuredClone(modelInput);
    const originalReferences = structuredClone(history.references);

    const prepared = await prepareContext(modelInput, preparationOptions(history.references));

    expect(countInputTokens).toHaveBeenCalledTimes(1);
    expect(countInputTokens.mock.calls[0][0]).toEqual(modelInput);
    expect(countInputTokens.mock.calls[0][0]).toMatchObject({
      systemPrompt: expect.stringContaining(systemMarker),
      profileSnapshot: expect.objectContaining({ marker: profileMarker }),
      messages: history.messages,
      text: currentRequestMarker,
    });
    expect(countInputTokens.mock.calls[0][1]).toMatchObject({
      abortSignal: expect.any(AbortSignal),
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(prepared.messages).toEqual(history.messages);
    expect(prepared.references).toEqual(history.references);
    expect(prepared.summaryCandidate).toBeUndefined();
    expect(modelInput).toEqual(originalInput);
    expect(history.references).toEqual(originalReferences);
  });

  it("starts at the native 128000-token boundary, summarizes only the old prefix, and keeps four complete recent pairs", async () => {
    const longRecentQuestion = `RECENT_QUESTION_5_START ${"complete material details ".repeat(800)} RECENT_QUESTION_5_END`;
    const history = makeHistory(5, 1, { 5: { question: longRecentQuestion } });
    const modelInput = makeModelInput(history.messages);
    const countInputTokens = vi
      .fn()
      .mockResolvedValueOnce({ inputTokens: triggerTokens, requestId: "trigger-count-128000" })
      .mockResolvedValueOnce({ inputTokens: 321, requestId: "summary-count-1" });
    const summaryText = "SUMMARY_OUTPUT_DATA";
    const summarize = vi.fn(() =>
      successfulSummaryStream(summaryText, { inputTokens: 240, outputTokens: 18 }),
    );
    const { prepareContext } = createPreparer({ countInputTokens, summarize });
    const originalInput = structuredClone(modelInput);
    const originalReferences = structuredClone(history.references);

    const prepared = await prepareContext(modelInput, preparationOptions(history.references));

    expect(countInputTokens).toHaveBeenCalledTimes(2);
    expect(countInputTokens.mock.calls[0][0]).toEqual(modelInput);
    expect(countInputTokens.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
    expect(summarize).toHaveBeenCalledTimes(1);
    const [summaryGenerationInput] = summarize.mock.calls[0];
    const [summaryCountInput, summaryCountOptions] = countInputTokens.mock.calls[1];
    expect(summaryCountInput).toEqual(modelInputForCounting(summaryGenerationInput));
    expect(summaryCountOptions.abortSignal).toBe(summaryGenerationInput.cancelSignal);
    expect(summaryGenerationInput).toMatchObject({
      modelId,
      revision,
      cancelSignal: expect.any(AbortSignal),
      resultDeadlineAt: fixedNow + summaryPreparationTimeoutMs,
    });
    expect(summaryGenerationInput.resultDeadlineAt - fixedNow).not.toBe(120_000);
    const summarySourceText = effectiveModelText(summaryGenerationInput);
    expect(summarySourceText).toContain("COMPLETE_QUESTION_1");
    expect(summarySourceText).toContain("COMPLETE_ANSWER_1");
    expect(summarySourceText).not.toContain("COMPLETE_QUESTION_2");
    expect(summarySourceText).not.toContain(currentRequestMarker);
    expect(summarySourceText).not.toContain(profileMarker);

    const candidate = prepared.summaryCandidate;
    expect(candidate).toMatchObject({
      version: 1,
      throughOrdinal: 1,
      sourceReferences: [history.references[0]],
      text: summaryText,
      modelId,
      revision,
      inputTokens: 321,
      countRequestId: "summary-count-1",
      metrics: { inputTokens: 240, outputTokens: 18 },
    });
    expect(candidate.previousSummaryId).toBeUndefined();
    expect(candidate.summaryId).toEqual(expect.any(String));
    expect(candidate.summaryId.length).toBeGreaterThan(0);
    expectFixedPreparedAt(candidate.preparedAt);

    expect(prepared.contextSnapshot).toMatchObject({
      version: 1,
      summary: { summaryId: candidate.summaryId, throughOrdinal: 1 },
      recentReferences: history.references.slice(1),
    });
    expect(prepared.references).toEqual(history.references.slice(1));
    expectOriginalMessagesInOrder(prepared.messages, history.messages.slice(2));
    expect(messagesText(prepared.messages).split(summaryText)).toHaveLength(2);
    expect(messagesText(prepared.messages)).toContain(longRecentQuestion);
    expect(messagesText(prepared.messages)).toContain("RECENT_QUESTION_5_END");
    expect(messagesText(prepared.messages)).not.toContain(currentRequestMarker);
    expect(messagesText(prepared.messages)).not.toContain(profileMarker);
    expect(modelInput).toEqual(originalInput);
    expect(history.references).toEqual(originalReferences);
  });

  it("counts an existing summary plus all recent history, but summarizes only new old pairs on recurrence", async () => {
    const previousSummary = makePreviousSummary();
    const history = makeHistory(6, 3);
    const modelInput = makeModelInput(history.messages);
    const countInputTokens = vi
      .fn()
      .mockResolvedValueOnce({ inputTokens: triggerTokens, requestId: "trigger-with-old-summary" })
      .mockResolvedValueOnce({ inputTokens: 654, requestId: "summary-count-recurrent" });
    const summarize = vi.fn(() =>
      successfulSummaryStream("RECURRENT_SUMMARY_OUTPUT", { outputTokens: 24 }),
    );
    const { prepareContext } = createPreparer({ countInputTokens, summarize });
    const originalInput = structuredClone(modelInput);
    const originalSummary = structuredClone(previousSummary);
    const originalReferences = structuredClone(history.references);

    const prepared = await prepareContext(
      modelInput,
      preparationOptions(history.references, previousSummary),
    );

    expect(countInputTokens).toHaveBeenCalledTimes(2);
    const completeTriggerInput = countInputTokens.mock.calls[0][0];
    expect(completeTriggerInput.systemPrompt).toContain(systemMarker);
    expect(completeTriggerInput.systemPrompt).toContain(profileMarker);
    expect(completeTriggerInput.profileSnapshot).toEqual(modelInput.profileSnapshot);
    expect(completeTriggerInput.text).toBe(currentRequestMarker);
    const triggerRepresentation = messagesText(completeTriggerInput.messages);
    expect(triggerRepresentation).toContain(previousSummary.text);
    for (const item of history.messages) expect(triggerRepresentation).toContain(messageText(item));

    const [summaryGenerationInput] = summarize.mock.calls[0];
    const summarySourceText = effectiveModelText(summaryGenerationInput);
    expect(summarySourceText).toContain(previousSummary.text);
    expect(summarySourceText).toContain("COMPLETE_QUESTION_3");
    expect(summarySourceText).toContain("COMPLETE_ANSWER_3");
    expect(summarySourceText).toContain("COMPLETE_QUESTION_4");
    expect(summarySourceText).toContain("COMPLETE_ANSWER_4");
    for (const ordinal of [5, 6, 7, 8]) {
      expect(summarySourceText).not.toContain(`COMPLETE_QUESTION_${ordinal}`);
      expect(summarySourceText).not.toContain(`COMPLETE_ANSWER_${ordinal}`);
    }
    expect(summarySourceText).not.toContain(currentRequestMarker);
    expect(summarySourceText).not.toContain(profileMarker);

    expect(prepared.summaryCandidate).toMatchObject({
      version: 1,
      throughOrdinal: 4,
      previousSummaryId: previousSummary.summaryId,
      sourceReferences: history.references.slice(0, 2),
      text: "RECURRENT_SUMMARY_OUTPUT",
      modelId,
      revision,
      inputTokens: 654,
      countRequestId: "summary-count-recurrent",
    });
    expect(prepared.contextSnapshot).toMatchObject({
      version: 1,
      summary: {
        summaryId: prepared.summaryCandidate.summaryId,
        throughOrdinal: 4,
      },
      recentReferences: history.references.slice(2),
    });
    expect(prepared.references).toEqual(history.references.slice(2));
    expectOriginalMessagesInOrder(prepared.messages, history.messages.slice(4));
    expect(messagesText(prepared.messages)).toContain("RECURRENT_SUMMARY_OUTPUT");
    expect(messagesText(prepared.messages)).not.toContain(profileMarker);
    expect(modelInput).toEqual(originalInput);
    expect(previousSummary).toEqual(originalSummary);
    expect(history.references).toEqual(originalReferences);
  });

  it.each([0, 1, 4])(
    "does not count or create a summary with only %i recent pairs",
    async (pairCount) => {
      const history = makeHistory(pairCount);
      const modelInput = makeModelInput(history.messages);
      const countInputTokens = vi.fn(async () => ({ inputTokens: triggerTokens }));
      const summarize = vi.fn(() => successfulSummaryStream());
      const { prepareContext } = createPreparer({ countInputTokens, summarize });

      const prepared = await prepareContext(modelInput, preparationOptions(history.references));

      expect(countInputTokens).not.toHaveBeenCalled();
      expect(summarize).not.toHaveBeenCalled();
      expect(prepared.messages).toEqual(history.messages);
      expect(prepared.references).toEqual(history.references);
      expect(prepared.summaryCandidate).toBeUndefined();
      expect(prepared.contextSnapshot).toMatchObject({
        version: 1,
        recentReferences: history.references,
      });
      expect(prepared.contextSnapshot.summary).toBeUndefined();
    },
  );

  it("reuses an existing summary without regenerating it when no new old pair exists", async () => {
    const previousSummary = makePreviousSummary();
    const history = makeHistory(4, 3);
    const modelInput = makeModelInput(history.messages);
    const countInputTokens = vi.fn(async () => ({ inputTokens: triggerTokens }));
    const summarize = vi.fn(() => successfulSummaryStream("MUST_NOT_REGENERATE"));
    const { prepareContext } = createPreparer({ countInputTokens, summarize });

    const prepared = await prepareContext(
      modelInput,
      preparationOptions(history.references, previousSummary),
    );

    expect(countInputTokens).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(prepared.summaryCandidate).toBeUndefined();
    expect(prepared.contextSnapshot).toMatchObject({
      version: 1,
      summary: {
        summaryId: previousSummary.summaryId,
        throughOrdinal: previousSummary.throughOrdinal,
      },
      recentReferences: history.references,
    });
    expect(prepared.references).toEqual(history.references);
    expect(messagesText(prepared.messages)).toContain(previousSummary.text);
    expectOriginalMessagesInOrder(prepared.messages, history.messages);
  });

  it("fails closed when active or failed messages have no confirmed turn references", async () => {
    const history = makeHistory(5);
    const unconfirmedPair = makePair(6, {
      question: "ACTIVE_UNCONFIRMED_QUESTION",
      answer: "FAILED_PARTIAL_ANSWER",
    });
    const modelInput = makeModelInput([...history.messages, ...unconfirmedPair]);
    const countInputTokens = vi
      .fn()
      .mockResolvedValueOnce({ inputTokens: triggerTokens })
      .mockResolvedValueOnce({ inputTokens: 300 });
    const summarize = vi.fn(() => successfulSummaryStream());
    const { prepareContext } = createPreparer({ countInputTokens, summarize });
    const originalInput = structuredClone(modelInput);

    await expect(
      prepareContext(modelInput, preparationOptions(history.references)),
    ).rejects.toBeDefined();

    expect(countInputTokens).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(modelInput).toEqual(originalInput);
  });

  it("accepts an exact 936000-token summary input and rejects 936001 before provider generation", async () => {
    const history = makeHistory(5);
    const modelInput = makeModelInput(history.messages);

    const acceptedCounter = vi
      .fn()
      .mockResolvedValueOnce({ inputTokens: triggerTokens })
      .mockResolvedValueOnce({ inputTokens: summaryInputLimit, requestId: "summary-at-limit" });
    const acceptedSummarize = vi.fn(() => successfulSummaryStream());
    const accepted = createPreparer({
      countInputTokens: acceptedCounter,
      summarize: acceptedSummarize,
    });
    await expect(
      accepted.prepareContext(modelInput, preparationOptions(history.references)),
    ).resolves.toMatchObject({
      summaryCandidate: { inputTokens: summaryInputLimit, countRequestId: "summary-at-limit" },
    });
    expect(acceptedCounter).toHaveBeenCalledTimes(2);
    expect(acceptedSummarize).toHaveBeenCalledTimes(1);
    expect(acceptedSummarize.mock.calls[0][0].resultDeadlineAt - fixedNow).toBe(
      summaryPreparationTimeoutMs,
    );

    const rejectedCounter = vi
      .fn()
      .mockResolvedValueOnce({ inputTokens: triggerTokens })
      .mockResolvedValueOnce({ inputTokens: summaryInputLimit + 1 });
    const rejectedSummarize = vi.fn(() => successfulSummaryStream());
    const rejected = createPreparer({
      countInputTokens: rejectedCounter,
      summarize: rejectedSummarize,
    });
    const originalInput = structuredClone(modelInput);

    await expect(
      rejected.prepareContext(modelInput, preparationOptions(history.references)),
    ).rejects.toBeDefined();

    expect(rejectedCounter).toHaveBeenCalledTimes(2);
    expect(rejectedSummarize).not.toHaveBeenCalled();
    expect(modelInput).toEqual(originalInput);
  });

  it.each([
    ["empty output", [{ type: "result", stopReason: "end_turn" }]],
    [
      "whitespace output",
      [
        { type: "text", text: " \n " },
        { type: "result", stopReason: "end_turn" },
      ],
    ],
    ["EOF without terminal", [{ type: "text", text: "PARTIAL_SUMMARY" }]],
    [
      "filtered output",
      [
        { type: "text", text: "PARTIAL_SUMMARY" },
        { type: "result", stopReason: "content_filtered" },
      ],
    ],
    [
      "truncated output",
      [
        { type: "text", text: "PARTIAL_SUMMARY" },
        { type: "result", stopReason: "max_tokens" },
      ],
    ],
    [
      "guardrail stop",
      [
        { type: "text", text: "PARTIAL_SUMMARY" },
        { type: "result", stopReason: "guardrail_intervened" },
      ],
    ],
    [
      "provider error event",
      [
        { type: "text", text: "PARTIAL_SUMMARY" },
        { type: "error", providerCode: "ModelStreamError" },
      ],
    ],
    [
      "duplicate terminal",
      [
        { type: "text", text: "PARTIAL_SUMMARY" },
        { type: "result", stopReason: "end_turn" },
        { type: "result", stopReason: "end_turn" },
      ],
    ],
    [
      "event after terminal",
      [
        { type: "text", text: "PARTIAL_SUMMARY" },
        { type: "result", stopReason: "end_turn" },
        { type: "text", text: "LATE_TEXT" },
      ],
    ],
  ])("does not publish, retry, or fall back after %s", async (_label, events) => {
    const history = makeHistory(5);
    const modelInput = makeModelInput(history.messages);
    const countInputTokens = vi
      .fn()
      .mockResolvedValueOnce({ inputTokens: triggerTokens })
      .mockResolvedValueOnce({ inputTokens: 300 });
    const summarize = vi.fn(() => eventStream(events));
    const { prepareContext } = createPreparer({ countInputTokens, summarize });
    const originalInput = structuredClone(modelInput);

    await expect(
      prepareContext(modelInput, preparationOptions(history.references)),
    ).rejects.toBeDefined();

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(countInputTokens).toHaveBeenCalledTimes(2);
    expect(modelInput).toEqual(originalInput);
  });

  it("fails closed when the provider throws instead of completing, without a second attempt", async () => {
    const history = makeHistory(5);
    const modelInput = makeModelInput(history.messages);
    const countInputTokens = vi
      .fn()
      .mockResolvedValueOnce({ inputTokens: triggerTokens })
      .mockResolvedValueOnce({ inputTokens: 300 });
    const summarize = vi.fn(() =>
      (async function* () {
        yield { type: "text", text: "PARTIAL_SUMMARY" };
        throw new Error("synthetic provider failure");
      })(),
    );
    const { prepareContext } = createPreparer({ countInputTokens, summarize });

    await expect(
      prepareContext(modelInput, preparationOptions(history.references)),
    ).rejects.toBeDefined();

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(countInputTokens).toHaveBeenCalledTimes(2);
    expect(modelInput.messages).toEqual(history.messages);
  });

  it("aborts a pending trigger count when the configured finite preparation timeout expires", async () => {
    const history = makeHistory(5);
    const modelInput = makeModelInput(history.messages);
    let countSignal;
    const countInputTokens = vi.fn((_input, options) => {
      countSignal = options.abortSignal;
      return new Promise((resolve, reject) => {
        countSignal.addEventListener("abort", () => reject(new Error("count aborted")), {
          once: true,
        });
      });
    });
    const summarize = vi.fn(() => successfulSummaryStream());
    const { prepareContext } = createPreparer({
      countInputTokens,
      summarize,
      options: { preparationTimeoutMs: 30 },
    });
    const originalInput = structuredClone(modelInput);

    await expect(
      prepareContext(modelInput, preparationOptions(history.references)),
    ).rejects.toBeDefined();

    expect(countInputTokens).toHaveBeenCalledTimes(1);
    expect(countSignal).toBeInstanceOf(AbortSignal);
    expect(countSignal.aborted).toBe(true);
    expect(summarize).not.toHaveBeenCalled();
    expect(modelInput).toEqual(originalInput);
  });

  it("aborts a pending summary provider with the same preparation signal and publishes no candidate", async () => {
    const history = makeHistory(5);
    const modelInput = makeModelInput(history.messages);
    const countInputTokens = vi
      .fn()
      .mockResolvedValueOnce({ inputTokens: triggerTokens })
      .mockResolvedValueOnce({ inputTokens: 300, requestId: "summary-count-before-timeout" });
    const summarize = vi.fn((generationInput) =>
      (async function* () {
        await new Promise((_, reject) => {
          generationInput.cancelSignal.addEventListener(
            "abort",
            () => reject(new Error("summary aborted")),
            { once: true },
          );
        });
        yield { type: "text", text: "unexpected summary result" };
      })(),
    );
    const { prepareContext } = createPreparer({
      countInputTokens,
      summarize,
      options: { preparationTimeoutMs: 30 },
    });
    const originalInput = structuredClone(modelInput);

    await expect(
      prepareContext(modelInput, preparationOptions(history.references)),
    ).rejects.toBeDefined();

    expect(summarize).toHaveBeenCalledTimes(1);
    const [generationInput] = summarize.mock.calls[0];
    expect(generationInput.cancelSignal).toBeInstanceOf(AbortSignal);
    expect(generationInput.cancelSignal.aborted).toBe(true);
    expect(countInputTokens.mock.calls[1][1].abortSignal).toBe(generationInput.cancelSignal);
    expect(modelInput).toEqual(originalInput);
  });
});
