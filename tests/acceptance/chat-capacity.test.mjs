import { describe, expect, it } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createChatHandler } from "../../runtime/chat.ts";
import { createConversationStoreAdapter } from "../../runtime/conversation-store.ts";

const conversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const queryId = "a4bfbc9f-3699-4e93-b120-a03c0204bc67";
const earlierQueryIds = [
  "b5cfbc9f-3699-4e93-b120-a03c0204bc68",
  "c6dfbc9f-3699-4e93-b851-a03c0204bc69",
  "d7efbc9f-3699-4e93-b851-a03c0204bc70",
];
const fixedNow = Date.parse("2026-10-21T12:00:00.000Z");
const caller = { sub: "teacher-123", token_use: "access" };
const botId = "bot-aurora";
const modelId = "global.anthropic.claude-sonnet-4-6";

const profileConfig = {
  fields: [
    {
      id: "educationLevels",
      label: "Niveles educativos",
      required: true,
      type: "multi-select",
      options: [
        { id: "primario", label: "Primario" },
        { id: "secundario", label: "Secundario" },
      ],
    },
    { id: "subjects", label: "Materias", required: true, type: "text-list" },
  ],
  responsePreferences: [
    {
      id: "ready-material",
      displayText: "Materiales listos para clase",
      promptText: "Incluí materiales completos y listos para usar en clase.",
    },
    {
      id: "step-by-step",
      displayText: "Paso a paso",
      promptText: "Explicá cada paso con claridad.",
    },
  ],
};

const validProfile = {
  sub: caller.sub,
  botId,
  fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
  responsePreferenceIds: ["ready-material"],
  updatedAt: "2026-10-21T11:00:00.000Z",
};

const quota = {
  daily: {
    used: 3,
    limit: 20,
    resetAt: Date.parse("2026-10-22T03:00:00.000Z"),
    period: "2026-10-21",
  },
  monthly: {
    used: 17,
    limit: 200,
    resetAt: Date.parse("2026-11-01T03:00:00.000Z"),
    period: "2026-10",
  },
  serverNow: fixedNow,
  blockedUntil: null,
  policyRevision: "usage-policy-1",
};

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(promise, milliseconds = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function bearer() {
  const claims = Buffer.from(JSON.stringify(caller)).toString("base64url");
  return `Bearer e30.${claims}.runtime-validated`;
}

function makeContext() {
  return {
    sessionId: conversationId,
    headers: {
      authorization: bearer(),
      "x-amzn-bedrock-agentcore-runtime-session-id": conversationId,
    },
  };
}

function startPayload(overrides = {}) {
  return {
    version: 2,
    operation: "start",
    conversationId,
    queryId,
    baseOrdinal: 0,
    text: "  Armá una actividad de porcentajes para 2.º año.  ",
    ...overrides,
  };
}

function messagePayload(overrides = {}) {
  return startPayload({ operation: "message", baseOrdinal: 3, ...overrides });
}

function finalInput(input) {
  return {
    systemPrompt: input.systemPrompt,
    profileSnapshot: input.profileSnapshot,
    text: input.text,
    messages: input.messages,
    modelId: input.modelId,
    revision: input.revision,
  };
}

function makeHarness(options = {}) {
  const {
    profile = validProfile,
    profileFailure,
    meta = null,
    contextMessages = [],
    contextReferences = [],
    countFailure,
    countGate,
    onCount,
    generation = [
      { type: "text", text: "Actividad: descuentos en una librería." },
      { type: "result", stopReason: "end_turn" },
    ],
    store = null,
  } = options;
  const countResult = Object.hasOwn(options, "countResult")
    ? clone(options.countResult)
    : { inputTokens: 0 };

  const state = {
    now: fixedNow,
    profile: clone(profile),
    profileFailure,
    meta: clone(meta),
    contextMessages: clone(contextMessages),
    contextReferences: clone(contextReferences),
    countResult: clone(countResult),
    countFailure,
    countGate,
    onCount,
    generation: clone(generation),
    calls: [],
    countInputs: [],
    providerInputs: [],
    providerDeadlines: [],
    providerCalls: 0,
    admissions: [],
    claims: [],
    submissions: new Map(),
  };

  const submissionKey = ({ sub, botId: requestedBotId, queryId: requestId }) =>
    `${sub}/${requestedBotId}/${requestId}`;

  const conversationStore = store ?? {
    async getMeta(input) {
      state.calls.push(["getMeta", clone(input)]);
      return clone(state.meta);
    },
    async getSubmission(input) {
      state.calls.push(["getSubmission", clone(input)]);
      return clone(state.submissions.get(submissionKey(input)) ?? null);
    },
    async readQuota(input) {
      state.calls.push(["readQuota", clone(input)]);
      return clone(quota);
    },
    async readContext(input) {
      state.calls.push(["readContext", clone(input)]);
      return { messages: clone(state.contextMessages), references: clone(state.contextReferences) };
    },
    async startTurn(input) {
      state.calls.push(["startTurn", clone(input)]);
      state.admissions.push(clone(input));
      state.now = fixedNow + 10_000;
      state.meta = {
        conversationId: input.conversationId,
        sub: input.sub,
        botId: input.botId,
        lastOrdinal: 1,
        activeQueryId: input.queryId,
      };
      state.submissions.set(submissionKey(input), {
        sub: input.sub,
        botId: input.botId,
        conversationId: input.conversationId,
        queryId: input.queryId,
        requestFingerprint: input.requestFingerprint,
        operation: input.operation,
        baseOrdinal: input.baseOrdinal,
        ordinal: 1,
        status: "in_progress",
        stage: "admitted",
        question: input.text,
        questionManifest: { count: 1, complete: true },
        contextReferences: [],
        answer: "",
        answerManifest: { count: 0, complete: false },
        cursor: 0,
        canContinue: false,
        resultDeadlineAt: input.resultDeadlineAt,
        profileSnapshot: clone(input.profileSnapshot),
        invocation: clone(input.invocation),
        ownerAttemptId: input.ownerAttemptId,
      });
      return { queryId: input.queryId, ordinal: 1 };
    },
    async continueTurn(input) {
      state.calls.push(["continueTurn", clone(input)]);
      state.admissions.push(clone(input));
      state.now = fixedNow + 10_000;
      const ordinal = input.baseOrdinal + 1;
      state.meta = { ...state.meta, lastOrdinal: ordinal, activeQueryId: input.queryId };
      state.submissions.set(submissionKey(input), {
        sub: input.sub,
        botId: input.botId,
        conversationId: input.conversationId,
        queryId: input.queryId,
        requestFingerprint: input.requestFingerprint,
        operation: input.operation,
        baseOrdinal: input.baseOrdinal,
        ordinal,
        status: "in_progress",
        stage: "admitted",
        question: input.text,
        questionManifest: { count: 1, complete: true },
        contextReferences: clone(input.contextReferences),
        answer: "",
        answerManifest: { count: 0, complete: false },
        cursor: 0,
        canContinue: false,
        resultDeadlineAt: input.resultDeadlineAt,
        profileSnapshot: clone(input.profileSnapshot),
        invocation: clone(input.invocation),
        ownerAttemptId: input.ownerAttemptId,
      });
      return { queryId: input.queryId, ordinal };
    },
    async claimInvocation(input) {
      state.calls.push(["claimInvocation", clone(input)]);
      state.claims.push(clone(input));
      return true;
    },
    async appendChunk(input) {
      state.calls.push(["appendChunk", clone(input)]);
      const submission = [...state.submissions.values()].find(
        (turn) => turn.queryId === input.queryId,
      );
      submission.answer += input.text;
      submission.cursor += 1;
      submission.answerManifest = { count: submission.cursor, complete: false };
    },
    async completeTurn(input) {
      state.calls.push(["completeTurn", clone(input)]);
      const submission = [...state.submissions.values()].find(
        (turn) => turn.queryId === input.queryId,
      );
      submission.status = "completed";
      submission.stage = "complete";
      submission.canContinue = true;
      submission.answerManifest = clone(input.answerManifest);
      if (state.meta?.activeQueryId === input.queryId) delete state.meta.activeQueryId;
    },
    async failTurn(input) {
      state.calls.push(["failTurn", clone(input)]);
      const submission = [...state.submissions.values()].find(
        (turn) => turn.queryId === input.queryId,
      );
      if (submission) {
        submission.status = "failed";
        submission.stage = "failed";
        submission.canContinue = true;
      }
      if (state.meta?.activeQueryId === input.queryId) delete state.meta.activeQueryId;
    },
    async reconcileTurn() {
      return null;
    },
  };

  const handler = createChatHandler({
    config: {
      botId,
      profile: profileConfig,
      modelId,
      revision: "reviewed-revision-123",
      systemPrompt: "Ayudá con tareas de enseñanza usando conocimiento general.",
    },
    accounts: {
      async hasMember(input) {
        state.calls.push(["hasMember", clone(input)]);
        return true;
      },
    },
    profiles: {
      async getProfile(input) {
        state.calls.push(["getProfile", clone(input)]);
        if (state.profileFailure) throw state.profileFailure;
        return clone(state.profile);
      },
    },
    store: conversationStore,
    async prepareDocuments() {
      return {
        knowledgeBaseId: "kb-test-aurora",
        query: "consulta documental de prueba",
        revision: "documents-test-r1",
        retrievedAt: fixedNow,
        status: "empty",
        results: [],
      };
    },
    async countInputTokens(input) {
      const snapshot = clone(finalInput(input));
      state.calls.push(["countInputTokens", snapshot]);
      state.countInputs.push(snapshot);
      state.onCount?.();
      if (state.countGate) await state.countGate.promise;
      if (state.countFailure) throw state.countFailure;
      return clone(state.countResult);
    },
    generate(input) {
      const snapshot = clone(finalInput(input));
      state.calls.push(["generate", snapshot]);
      state.providerInputs.push(snapshot);
      state.providerDeadlines.push(input.resultDeadlineAt);
      state.providerCalls += 1;
      return (async function* () {
        for (const event of state.generation) yield clone(event);
      })();
    },
    now: () => state.now,
  });

  return { handler, store: conversationStore, state };
}

async function collect(response) {
  const settled = await response;
  if (!settled || typeof settled[Symbol.asyncIterator] !== "function") return settled;
  const events = [];
  for await (const event of settled) events.push(event);
  return events;
}

async function invoke(harness, payload = startPayload()) {
  return collect(harness.handler(payload, makeContext()));
}

function terminal(events) {
  return Array.isArray(events) ? events.at(-1) : events;
}

function callNames(state) {
  return state.calls.map(([name]) => name);
}

function expectCountBeforeAdmissionAndGeneration(state) {
  const names = callNames(state);
  const counted = names.indexOf("countInputTokens");
  const admission = names.findIndex((name) => name === "startTurn" || name === "continueTurn");
  const claim = names.indexOf("claimInvocation");
  const generation = names.indexOf("generate");
  expect(counted).toBeGreaterThanOrEqual(0);
  expect(state.countInputs).toHaveLength(1);
  expect(admission).toBeGreaterThan(counted);
  expect(claim).toBeGreaterThan(counted);
  expect(generation).toBeGreaterThan(counted);
}

describe("native model capacity admission", () => {
  it.each([0, 935_999, 936_000])(
    "admits a native input count of %i tokens",
    async (inputTokens) => {
      const harness = makeHarness({ countResult: { inputTokens } });

      const events = await invoke(harness);

      expect(terminal(events)).toMatchObject({ type: "completed", queryId });
      expect(harness.state.admissions).toHaveLength(1);
      expect(harness.state.claims).toHaveLength(1);
      expect(harness.state.providerCalls).toBe(1);
      expectCountBeforeAdmissionAndGeneration(harness.state);
    },
  );

  it("rejects 936,001 input tokens before admission, claim, or generation", async () => {
    const harness = makeHarness({ countResult: { inputTokens: 936_001 } });

    const events = await invoke(harness);

    expect(terminal(events)).toMatchObject({
      type: "failed",
      code: "capacity_exceeded",
      recordStatus: "not_admitted",
      queryId,
    });
    expect(harness.state.admissions).toHaveLength(0);
    expect(harness.state.claims).toHaveLength(0);
    expect(harness.state.providerCalls).toBe(0);
    expect(callNames(harness.state)).not.toContain("startTurn");
    expect(callNames(harness.state)).not.toContain("continueTurn");
  });

  it.each([
    ["an API exception", { countFailure: new Error("private CountTokens failure") }],
    ["a missing response", { countResult: undefined }],
    ["a missing token count", { countResult: {} }],
    ["a string token count", { countResult: { inputTokens: "20" } }],
    ["a negative token count", { countResult: { inputTokens: -1 } }],
    ["a fractional token count", { countResult: { inputTokens: 20.5 } }],
    ["an infinite token count", { countResult: { inputTokens: Number.POSITIVE_INFINITY } }],
  ])("fails closed for %s without consuming quota", async (_label, options) => {
    const harness = makeHarness(options);

    const events = await invoke(harness);

    expect(terminal(events)).toMatchObject({
      type: "failed",
      code: "token_count_unavailable",
      recordStatus: "not_admitted",
      queryId,
    });
    expect(terminal(events).code).not.toBe("capacity_exceeded");
    expect(terminal(events).code).not.toBe("quota_exceeded");
    expect(harness.state.admissions).toHaveLength(0);
    expect(harness.state.claims).toHaveLength(0);
    expect(harness.state.providerCalls).toBe(0);
    expect(callNames(harness.state)).not.toContain("startTurn");
    expect(callNames(harness.state)).not.toContain("continueTurn");
    expect(JSON.stringify(events)).not.toContain("private CountTokens failure");
  });

  it("counts and generates the exact resolved profile, complete pairs, and original question", async () => {
    const text = "  Armá una actividad\npara 2.º año: 25 % de descuento.  ";
    const messages = [
      { role: "user", content: [{ text: "Pregunta confirmada del turno 1." }] },
      { role: "assistant", content: [{ text: "Respuesta confirmada del turno 1." }] },
      { role: "user", content: [{ text: "Pregunta confirmada del turno 2." }] },
      { role: "assistant", content: [{ text: "Respuesta confirmada del turno 2." }] },
    ];
    const references = [
      { ordinal: 1, queryId: earlierQueryIds[0] },
      { ordinal: 2, queryId: earlierQueryIds[1] },
    ];
    const harness = makeHarness({
      meta: { conversationId, sub: caller.sub, botId, lastOrdinal: 2 },
      contextMessages: messages,
      contextReferences: references,
      countResult: { inputTokens: 41 },
    });

    const events = await invoke(harness, messagePayload({ baseOrdinal: 2, text }));

    expect(terminal(events)).toMatchObject({ type: "completed", queryId });
    expect(harness.state.countInputs).toHaveLength(1);
    expect(harness.state.providerInputs).toHaveLength(1);
    expect(harness.state.countInputs[0]).toEqual(harness.state.providerInputs[0]);
    expect(harness.state.countInputs[0]).toMatchObject({
      text,
      messages,
      modelId,
      profileSnapshot: {
        sub: caller.sub,
        botId,
        fields: {
          educationLevels: [{ id: "secundario", label: "Secundario" }],
          subjects: ["Matemática"],
        },
        responsePreferenceIds: ["ready-material"],
        promptTexts: ["Incluí materiales completos y listos para usar en clase."],
      },
    });
    expect(harness.state.countInputs[0].systemPrompt).toContain(
      "Incluí materiales completos y listos para usar en clase.",
    );
    expectCountBeforeAdmissionAndGeneration(harness.state);
    expect(harness.state.admissions[0].contextReferences).toEqual(references);
    expect(harness.state.admissions[0].text).toBe(text);
    expect(callNames(harness.state).indexOf("countInputTokens")).toBeLessThan(
      callNames(harness.state).indexOf("continueTurn"),
    );
  });

  it("keeps confirmed history above prior character and byte caps while admitting only references", async () => {
    const messages = [];
    const references = earlierQueryIds.map((earlierQueryId, index) => ({
      ordinal: index + 1,
      queryId: earlierQueryId,
    }));
    for (let index = 0; index < references.length; index += 1) {
      messages.push(
        { role: "user", content: [{ text: `Pregunta ${index + 1}: ${"á".repeat(60_000)}` }] },
        { role: "assistant", content: [{ text: `Respuesta ${index + 1}: ${"b".repeat(60_000)}` }] },
      );
    }
    const historyTextBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
    const harness = makeHarness({
      meta: { conversationId, sub: caller.sub, botId, lastOrdinal: 3 },
      contextMessages: messages,
      contextReferences: references,
      countResult: { inputTokens: 72 },
    });

    const events = await invoke(harness, messagePayload({ baseOrdinal: 3 }));

    expect(historyTextBytes).toBeGreaterThan(128 * 1024);
    expect(terminal(events)).toMatchObject({ type: "completed", queryId });
    expect(harness.state.countInputs[0].messages).toEqual(messages);
    expect(harness.state.providerInputs[0].messages).toEqual(messages);
    expectCountBeforeAdmissionAndGeneration(harness.state);
    expect(harness.state.admissions[0].contextReferences).toEqual(references);
    expect(harness.state.admissions[0]).not.toHaveProperty("messages");
  });

  it("accepts an original question above the prior character and byte caps when token and storage limits fit", async () => {
    const text = "á".repeat(70_000);
    const harness = makeHarness({ countResult: { inputTokens: 120 } });

    const events = await invoke(harness, startPayload({ text }));

    expect(text.length).toBeGreaterThan(8_000);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(128 * 1024);
    expect(terminal(events)).toMatchObject({ type: "completed", queryId });
    expect(harness.state.countInputs[0].text).toBe(text);
    expect(harness.state.providerInputs[0].text).toBe(text);
    expect(harness.state.admissions[0].text).toBe(text);
    expectCountBeforeAdmissionAndGeneration(harness.state);
  });

  it("does not change the counted snapshot when the profile and history update during counting", async () => {
    const countGate = deferred();
    const countStarted = deferred();
    const messages = [
      { role: "user", content: [{ text: "Confirmada antes del conteo." }] },
      { role: "assistant", content: [{ text: "Respuesta confirmada." }] },
    ];
    const harness = makeHarness({
      meta: { conversationId, sub: caller.sub, botId, lastOrdinal: 1 },
      contextMessages: messages,
      contextReferences: [{ ordinal: 1, queryId: earlierQueryIds[0] }],
      countResult: { inputTokens: 92 },
      countGate,
      onCount: () => countStarted.resolve(),
    });

    const responsePromise = harness.handler(messagePayload({ baseOrdinal: 1 }), makeContext());
    expect(await waitFor(countStarted.promise)).toBe(true);
    const counted = clone(harness.state.countInputs[0]);
    harness.state.profile = {
      ...validProfile,
      fields: { educationLevels: ["primario"], subjects: ["Historia"] },
      responsePreferenceIds: ["step-by-step"],
      updatedAt: "2026-10-21T11:30:00.000Z",
    };
    harness.state.contextMessages = [
      { role: "user", content: [{ text: "No debe incorporarse tras contar." }] },
      { role: "assistant", content: [{ text: "Tampoco esta respuesta." }] },
    ];
    countGate.resolve();

    const events = await collect(responsePromise);

    expect(terminal(events)).toMatchObject({ type: "completed", queryId });
    expect(harness.state.providerInputs[0]).toEqual(counted);
    expect(harness.state.providerInputs[0].messages).toEqual(messages);
    expect(harness.state.providerInputs[0].profileSnapshot.fields.subjects).toEqual(["Matemática"]);
    expectCountBeforeAdmissionAndGeneration(harness.state);
    expect(callNames(harness.state).filter((name) => name === "getProfile")).toHaveLength(1);
    expect(callNames(harness.state).filter((name) => name === "readContext")).toHaveLength(1);
  });

  it("rejects a known DynamoDB transaction overflow before any write or model claim", async () => {
    const commands = [];
    const documentClient = {
      async send(command) {
        commands.push(command);
        if (command instanceof QueryCommand) return { Items: [] };
        if (command instanceof GetCommand) return {};
        return {};
      },
    };
    const actualStore = createConversationStoreAdapter({
      documentClient,
      tableName: "conversations-aurora-dev",
      now: () => fixedNow,
    });
    actualStore.readQuota = async () => clone(quota);
    let claimCalls = 0;
    const claimInvocation = actualStore.claimInvocation.bind(actualStore);
    actualStore.claimInvocation = async (input) => {
      claimCalls += 1;
      return claimInvocation(input);
    };
    const oversizedQuestion = "x".repeat(4 * 1024 * 1024 + 64 * 1024);
    const harness = makeHarness({
      store: actualStore,
      countResult: { inputTokens: 936_000 },
    });

    const events = await invoke(harness, startPayload({ text: oversizedQuestion }));

    const failure = terminal(events);
    expect(failure).toMatchObject({
      type: "failed",
      code: "storage_capacity_exceeded",
      recordStatus: "not_admitted",
      queryId,
    });
    expect(failure.message).toMatch(/(storage|transaction|almacen|tamaño|taman|pregunta)/i);
    expect(commands.some((command) => command instanceof TransactWriteCommand)).toBe(false);
    expect(claimCalls).toBe(0);
    expect(harness.state.providerCalls).toBe(0);
    expect(harness.state.countInputs).toHaveLength(1);
    expect(harness.state.countInputs[0].text).toBe(oversizedQuestion);
  });

  it("repeats and recovers an existing ID without requiring current profile, policy, or count", async () => {
    const harness = makeHarness({ countResult: { inputTokens: 27 } });

    const first = await invoke(harness);
    expect(terminal(first)).toMatchObject({ type: "completed", queryId });
    const firstCountCalls = harness.state.countInputs.length;
    const firstProviderCalls = harness.state.providerCalls;
    const firstAdmissionCount = harness.state.admissions.length;

    harness.state.profileFailure = new Error("profile is unavailable now");
    harness.store.readQuota = async () => {
      throw new Error("policy is unavailable now");
    };
    harness.state.countFailure = new Error("CountTokens is unavailable now");
    harness.state.calls.length = 0;

    const repeated = await invoke(harness);
    const recovered = await collect(
      harness.handler({ version: 2, operation: "recover", conversationId, queryId }, makeContext()),
    );

    expect(repeated).toMatchObject({ status: "completed", queryId });
    expect(recovered).toMatchObject({ status: "completed", queryId });
    expect(harness.state.countInputs).toHaveLength(firstCountCalls);
    expect(harness.state.providerCalls).toBe(firstProviderCalls);
    expect(harness.state.admissions).toHaveLength(firstAdmissionCount);
    expect(callNames(harness.state)).not.toContain("getProfile");
    expect(callNames(harness.state)).not.toContain("readQuota");
    expect(callNames(harness.state)).not.toContain("countInputTokens");
    expect(callNames(harness.state)).not.toContain("generate");
  });

  it("keeps model context-window stops incomplete and never issues a second generation", async () => {
    const partial = "Prefijo antes de que Bedrock informe el límite de contexto.";
    const harness = makeHarness({
      generation: [
        { type: "text", text: partial },
        { type: "result", stopReason: "model_context_window_exceeded" },
      ],
    });

    const events = await invoke(harness);

    expect(events.some(({ type }) => type === "completed")).toBe(false);
    expect(terminal(events)).toMatchObject({
      type: "failed",
      code: "incomplete_response",
      recordStatus: "failed",
    });
    expect(harness.state.providerCalls).toBe(1);
    expect(harness.state.calls.filter(([name]) => name === "generate")).toHaveLength(1);
    expect(harness.state.calls.map(([name]) => name)).toContain("failTurn");
  });

  it("passes the durable admission deadline to generation without starting another 60 minutes", async () => {
    const harness = makeHarness();

    const events = await invoke(harness);

    expect(terminal(events)).toMatchObject({ type: "completed", queryId });
    const durableDeadline = harness.state.admissions[0].resultDeadlineAt;
    expect(durableDeadline).toBe(fixedNow + 60 * 60 * 1_000);
    expect(harness.state.providerDeadlines).toEqual([durableDeadline]);
    expect(harness.state.providerDeadlines[0]).not.toBe(harness.state.now + 60 * 60 * 1_000);
  });
});
