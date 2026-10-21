import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const handlerPath = path.join(projectRoot, "runtime/chat.ts");
const conversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const queryId = "a4bfbc9f-3699-4e93-b120-a03c0204bc67";
const fixedNow = Date.parse("2026-10-19T16:00:00.000Z");
const caller = { sub: "teacher-123", token_use: "access" };
const botId = "bot-aurora";

const profileConfig = {
  fields: [
    {
      id: "educationLevels",
      label: "Niveles educativos",
      required: true,
      type: "multi-select",
      options: [
        { id: "inicial", label: "Inicial" },
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
  updatedAt: "2026-10-18T12:00:00.000Z",
};
const profileWithoutPreferences = { ...validProfile };
delete profileWithoutPreferences.responsePreferenceIds;

let createChatHandler;
let createChatInvocationHandler;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function bearer(claims = caller) {
  // Runtime has already validated this token. The fake signature is deliberately not tested here.
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `Bearer e30.${encodedClaims}.runtime-validated`;
}

function makeContext({
  claims = caller,
  sessionId = conversationId,
  sessionHeader = conversationId,
  authorization = bearer(claims),
} = {}) {
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    headers: {
      ...(authorization === null ? {} : { authorization }),
      ...(sessionHeader === undefined
        ? {}
        : { "x-amzn-bedrock-agentcore-runtime-session-id": sessionHeader }),
    },
  };
}

function makePayload(overrides = {}) {
  return {
    version: 2,
    operation: "start",
    conversationId,
    queryId,
    baseOrdinal: 0,
    text: "Armá una actividad de 15 minutos para introducir porcentajes.",
    ...overrides,
  };
}

const quotaView = {
  daily: {
    used: 3,
    limit: 20,
    resetAt: Date.parse("2026-10-20T03:00:00.000Z"),
    period: "2026-10-19",
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

function isAsyncIterable(value) {
  return value !== null && typeof value?.[Symbol.asyncIterator] === "function";
}

async function collect(stream) {
  const settled = await stream;
  if (!isAsyncIterable(settled)) return settled;
  const events = [];
  for await (const event of settled) events.push(event);
  return events;
}

function makeHarness({
  member = true,
  profile = validProfile,
  profileFailure,
  profileKey = { sub: caller.sub, botId },
  meta = null,
  startFailure,
  startGate,
  onStart,
  continueFailure,
  continueGate,
  onContinue,
  contextMessages = [],
  contextFailure,
  chunkFailureAt,
  completeGate,
  completeFailure,
  completeAfterCommit = false,
  onComplete,
  failFailure,
  generation = [
    { type: "text", text: "Actividad: descuentos en una librería." },
    { type: "result", stopReason: "end_turn" },
  ],
  generationFailure,
  generationFactory,
  config = profileConfig,
  queryIds = [queryId],
} = {}) {
  const state = {
    member,
    profile: clone(profile),
    profileFailure,
    profileKey: clone(profileKey),
    meta: clone(meta),
    startFailure,
    startGate,
    onStart,
    continueFailure,
    continueGate,
    onContinue,
    contextMessages: clone(contextMessages),
    contextFailure,
    chunkFailureAt,
    completeGate,
    completeFailure,
    completeAfterCommit,
    onComplete,
    failFailure,
    generation: clone(generation),
    generationFactory,
    generationFailure,
    config,
    calls: [],
    inputChunks: [],
    answerChunks: [],
    admitted: null,
    completeInput: null,
    failureInput: null,
    providerInputs: [],
    providerCalls: 0,
    nextQueryIndex: 0,
    queryIds,
    admittedTurns: [],
    completed: false,
    failed: false,
    submissions: new Map(),
    invocationClaims: new Set(),
  };

  const submissionKey = ({ sub, botId: requestedBotId, queryId: requestId }) =>
    `${sub}/${requestedBotId}/${requestId}`;

  const store = {
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
      return clone(quotaView);
    },
    async readContext(input) {
      state.calls.push(["readContext", clone(input)]);
      if (state.contextFailure) throw state.contextFailure;
      return { messages: clone(state.contextMessages), references: [] };
    },
    async startTurn(input) {
      state.calls.push(["startTurn", clone(input)]);
      state.onStart?.(clone(input));
      if (state.startGate) await state.startGate;
      if (state.startFailure) throw state.startFailure;
      state.admitted = clone(input);
      state.admittedTurns.push(clone(input));
      state.inputChunks.push({ role: "user", text: input.text });
      state.submissions.set(submissionKey(input), {
        ...clone(input),
        ordinal: 1,
        status: "in_progress",
        question: input.text,
        answer: "",
        answerManifest: { count: 0, complete: false },
        canContinue: false,
        cursor: 0,
      });
      state.meta = {
        conversationId: input.conversationId,
        sub: input.sub,
        botId: input.botId,
        lastOrdinal: 1,
        activeQueryId: input.queryId,
      };
      return { queryId: input.queryId, ordinal: 1 };
    },
    async continueTurn(input) {
      state.calls.push(["continueTurn", clone(input)]);
      if (state.meta?.closed) {
        throw Object.assign(new Error("conversation is closed"), { code: "conversation_closed" });
      }
      state.onContinue?.(clone(input));
      if (state.continueGate) await state.continueGate;
      if (state.continueFailure) throw state.continueFailure;
      state.admitted = clone(input);
      state.admittedTurns.push(clone(input));
      state.inputChunks.push({ role: "user", text: input.text });
      const ordinal = input.baseOrdinal + 1;
      state.submissions.set(submissionKey(input), {
        ...clone(input),
        ordinal,
        status: "in_progress",
        question: input.text,
        answer: "",
        answerManifest: { count: 0, complete: false },
        canContinue: false,
        cursor: 0,
      });
      state.meta = { ...state.meta, lastOrdinal: ordinal };
      state.meta.activeQueryId = input.queryId;
      return { queryId: input.queryId, ordinal };
    },
    async claimInvocation(input) {
      state.calls.push(["claimInvocation", clone(input)]);
      const key = submissionKey(input);
      if (state.invocationClaims.has(key)) return false;
      state.invocationClaims.add(key);
      return true;
    },
    async appendChunk(input) {
      state.calls.push(["appendChunk", clone(input)]);
      if (state.chunkFailureAt === state.answerChunks.length) {
        throw new Error("private DynamoDB failure detail");
      }
      state.answerChunks.push(clone(input));
      const submission = [...state.submissions.values()].find(
        (turn) => turn.queryId === input.queryId && turn.conversationId === input.conversationId,
      );
      if (submission) {
        submission.answer += input.text;
        submission.cursor += 1;
        submission.answerManifest = { count: submission.cursor, complete: false };
      }
    },
    async completeTurn(input) {
      state.calls.push(["completeTurn", clone(input)]);
      state.onComplete?.(clone(input));
      if (state.completeGate) await state.completeGate;
      const submission = [...state.submissions.values()].find(
        (turn) => turn.queryId === input.queryId && turn.conversationId === input.conversationId,
      );
      const recordCompletion = () => {
        state.completeInput = clone(input);
        state.completed = true;
        if (submission) {
          submission.status = "completed";
          submission.canContinue = true;
          submission.answerManifest = clone(input.answerManifest);
        }
        if (state.meta?.activeQueryId === input.queryId) delete state.meta.activeQueryId;
      };
      if (state.completeFailure) {
        if (state.completeAfterCommit) recordCompletion();
        throw state.completeFailure;
      }
      recordCompletion();
    },
    async failTurn(input) {
      state.calls.push(["failTurn", clone(input)]);
      if (state.failFailure) throw state.failFailure;
      state.failureInput = clone(input);
      state.failed = true;
      const submission = [...state.submissions.values()].find(
        (turn) => turn.queryId === input.queryId && turn.conversationId === input.conversationId,
      );
      if (submission) {
        submission.status = "failed";
        submission.canContinue = !(input.invocationClaimed && !input.providerFinished);
      }
      if (
        input.invocationClaimed &&
        !input.providerFinished &&
        state.meta?.conversationId === input.conversationId
      ) {
        state.meta.closed = true;
      }
      if (state.meta?.activeQueryId === input.queryId) delete state.meta.activeQueryId;
    },
    async reconcileTurn(input) {
      state.calls.push(["reconcileTurn", clone(input)]);
      const submission = state.submissions.get(submissionKey(input));
      if (submission) {
        submission.status = "failed";
        submission.canContinue = false;
      }
      if (state.meta?.activeQueryId === input.queryId) {
        delete state.meta.activeQueryId;
        state.meta.closed = true;
      }
      return clone(submission ?? null);
    },
  };

  const handler =
    typeof createChatHandler === "function"
      ? createChatHandler({
          config: {
            botId,
            profile: config,
            modelId: "global.anthropic.claude-sonnet-4-6",
            revision: "reviewed-revision-123",
            systemPrompt: "Ayudá con tareas de enseñanza usando conocimiento general.",
          },
          accounts: {
            async hasMember(input) {
              state.calls.push(["hasMember", clone(input)]);
              return state.member;
            },
          },
          profiles: {
            async getProfile(input) {
              state.calls.push(["getProfile", clone(input)]);
              if (state.profileFailure) throw state.profileFailure;
              if (state.profileKey.sub !== input.sub || state.profileKey.botId !== input.botId) {
                return null;
              }
              return clone(state.profile);
            },
          },
          store,
          async countInputTokens() {
            return { inputTokens: 0 };
          },
          generate(input) {
            state.providerCalls += 1;
            state.providerInputs.push(clone(input));
            state.calls.push(["generate", clone(input)]);
            if (state.generationFactory) return state.generationFactory();
            return (async function* () {
              for (const item of state.generation) {
                if (item.type === "error") throw new Error(item.message);
                yield clone(item);
              }
              if (state.generationFailure) throw state.generationFailure;
            })();
          },
          now: () => fixedNow,
        })
      : null;

  return { handler, state };
}

async function request(harness, payload = makePayload(), context) {
  const requestPayload = clone(payload);
  if (requestPayload && requestPayload.queryId === queryId) {
    requestPayload.queryId = harness.state.queryIds[harness.state.nextQueryIndex++] ?? queryId;
  }
  if (
    requestPayload &&
    requestPayload.operation === "message" &&
    requestPayload.baseOrdinal === 0
  ) {
    requestPayload.baseOrdinal = harness.state.meta?.lastOrdinal ?? 0;
  }
  const requestContext =
    context ??
    makeContext({
      sessionId: requestPayload?.conversationId ?? conversationId,
      sessionHeader: requestPayload?.conversationId ?? conversationId,
    });
  return collect(harness.handler(requestPayload, requestContext));
}

async function openStream(harness, payload = makePayload(), context = makeContext()) {
  const result = await harness.handler(payload, context);
  expect(isAsyncIterable(result), "a first POST must return an event stream").toBe(true);
  return result[Symbol.asyncIterator]();
}

function terminal(events) {
  return events.at(-1);
}

describe("the conversation Runtime handler", () => {
  beforeAll(async () => {
    if (!existsSync(handlerPath)) return;
    const module = await import(pathToFileURL(handlerPath).href);
    createChatHandler = module.createChatHandler;
    createChatInvocationHandler = module.createChatInvocationHandler;
  });

  beforeEach(() => {
    expect(
      typeof createChatHandler,
      "producto ausente: expected runtime/chat.ts#createChatHandler",
    ).toBe("function");
    expect(
      typeof createChatInvocationHandler,
      "producto ausente: expected runtime/chat.ts#createChatInvocationHandler",
    ).toBe("function");
  });

  it.each([
    ["a null payload", null],
    ["an unsupported payload version", makePayload({ version: 3 })],
    ["an unknown operation", makePayload({ operation: "replay" })],
    ["a malformed conversation UUID", makePayload({ conversationId: "not-a-uuid" })],
    ["empty text", makePayload({ text: "" })],
    ["whitespace-only text", makePayload({ text: " \n\t " })],
    ["non-string text", makePayload({ text: 27 })],
    ["a different Runtime session", makePayload(), makeContext({ sessionId: "another-session" })],
    [
      "a different session header",
      makePayload(),
      makeContext({ sessionHeader: "another-session" }),
    ],
    ["missing verified Runtime session context", makePayload(), makeContext({ sessionId: null })],
  ])(
    "rejects %s before reading protected data",
    async (_label, payload, context = makeContext()) => {
      const harness = makeHarness();

      const events = await request(harness, payload, context);

      expect(terminal(events)).toMatchObject({ type: "failed", recordStatus: "not_admitted" });
      expect(harness.state.calls).toEqual([]);
      expect(harness.state.providerCalls).toBe(0);
    },
  );

  it.each([
    ["a missing bearer token", { authorization: null }],
    ["an ID token", { sub: caller.sub, token_use: "id" }],
    ["an absent subject", { token_use: "access" }],
    ["an empty subject", { sub: "", token_use: "access" }],
  ])("rejects %s before account or conversation reads", async (_label, identity) => {
    const harness = makeHarness();

    const context = Object.hasOwn(identity, "authorization")
      ? makeContext(identity)
      : makeContext({ claims: identity });
    const events = await request(harness, makePayload(), context);

    expect(terminal(events)).toMatchObject({ type: "failed", recordStatus: "not_admitted" });
    expect(harness.state.calls).toEqual([]);
  });

  it.each([
    "sub",
    "owner",
    "ownerSub",
    "profile",
    "history",
    "messages",
    "prompt",
    "systemPrompt",
    "preferencePrompt",
    "modelId",
  ])("rejects a client-supplied %s instead of trusting it", async (field) => {
    const harness = makeHarness();
    const events = await request(harness, makePayload({ [field]: "attacker-controlled" }));

    expect(terminal(events)).toMatchObject({ type: "failed", recordStatus: "not_admitted" });
    expect(harness.state.calls).toEqual([]);
    expect(harness.state.providerCalls).toBe(0);
  });

  it("checks current chatbot membership before profile, conversation, or model access", async () => {
    const harness = makeHarness({ member: false });

    const events = await request(harness);

    expect(terminal(events)).toMatchObject({ type: "failed", code: "access_denied" });
    expect(harness.state.calls.map(([name]) => name)).toEqual(["hasMember"]);
    expect(harness.state.calls[0][1]).toEqual({ sub: caller.sub, botId });
    expect(harness.state.providerCalls).toBe(0);
  });

  it.each([
    [
      "a user without current membership",
      { member: false, meta: { conversationId, sub: caller.sub, botId, lastOrdinal: 1 } },
      ["hasMember"],
      "access_denied",
    ],
    [
      "a conversation that does not exist",
      { meta: null },
      ["hasMember", "getMeta"],
      "conversation_unavailable",
    ],
    [
      "another owner's conversation",
      { meta: { conversationId, sub: "another-teacher", botId, lastOrdinal: 1 } },
      ["hasMember", "getMeta"],
      "conversation_unavailable",
    ],
    [
      "another chatbot's conversation",
      { meta: { conversationId, sub: caller.sub, botId: "bot-cobalt", lastOrdinal: 1 } },
      ["hasMember", "getMeta"],
      "conversation_unavailable",
    ],
    [
      "a missing saved profile",
      { profile: null, meta: { conversationId, sub: caller.sub, botId, lastOrdinal: 1 } },
      ["hasMember", "getMeta", "getSubmission", "getProfile"],
      "profile_required",
    ],
  ])(
    "rejects a follow-up from %s before context or model access",
    async (_label, options, calls, code) => {
      const harness = makeHarness(options);

      const events = await request(harness, makePayload({ operation: "message" }));

      expect(terminal(events)).toMatchObject({
        type: "failed",
        recordStatus: "not_admitted",
        code,
      });
      const names = harness.state.calls.map(([name]) => name);
      expect(names[0]).toBe("hasMember");
      for (const name of calls) expect(names).toContain(name);
      expect(names.includes("getProfile")).toBe(calls.includes("getProfile"));
      expect(harness.state.calls.some(([name]) => name === "readContext")).toBe(false);
      expect(harness.state.providerCalls).toBe(0);
    },
  );

  it.each([
    ["another owner", { conversationId, sub: "another-teacher", botId }],
    ["another chatbot", { conversationId, sub: caller.sub, botId: "bot-cobalt" }],
    [
      "an existing conversation owned by the caller",
      { conversationId, sub: caller.sub, botId, lastOrdinal: 1 },
    ],
  ])("checks %s before reading the profile or invoking the model", async (_label, meta) => {
    const harness = makeHarness({ meta });

    const events = await request(harness);

    expect(terminal(events)).toMatchObject({ type: "failed", code: "conversation_unavailable" });
    expect(harness.state.calls.map(([name]) => name)).toContain("hasMember");
    expect(harness.state.calls.map(([name]) => name)).toContain("getMeta");
    expect(harness.state.calls.map(([name]) => name)).not.toContain("getProfile");
    expect(harness.state.calls.map(([name]) => name)).not.toContain("readQuota");
    expect(harness.state.providerCalls).toBe(0);
  });

  it.each([
    ["missing", { conversationId, sub: caller.sub, botId }],
    ["zero", { conversationId, sub: caller.sub, botId, lastOrdinal: 0 }],
    ["negative", { conversationId, sub: caller.sub, botId, lastOrdinal: -1 }],
    ["fractional", { conversationId, sub: caller.sub, botId, lastOrdinal: 1.5 }],
    [
      "unsafe",
      { conversationId, sub: caller.sub, botId, lastOrdinal: Number.MAX_SAFE_INTEGER + 1 },
    ],
  ])(
    "rejects an owned conversation with a %s last ordinal before loading context",
    async (_label, meta) => {
      const harness = makeHarness({ meta });

      const events = await request(harness, makePayload({ operation: "message", baseOrdinal: 1 }));

      expect(terminal(events)).toMatchObject({ type: "failed" });
      const names = harness.state.calls.map(([name]) => name);
      expect(names).toContain("hasMember");
      expect(names).toContain("getMeta");
      expect(names).not.toContain("getProfile");
      expect(names).not.toContain("readContext");
      expect(names).not.toContain("readQuota");
      expect(harness.state.providerCalls).toBe(0);
    },
  );

  it.each([
    ["absent", { profile: null }, "profile_required"],
    [
      "incomplete",
      { profile: { ...validProfile, fields: { educationLevels: [], subjects: [] } } },
      "temporarily_unavailable",
    ],
    [
      "configured with an unknown preference",
      { profile: { ...validProfile, responsePreferenceIds: ["unknown-preference"] } },
      "temporarily_unavailable",
    ],
    [
      "unavailable",
      { profileFailure: new Error("private profile table detail") },
      "temporarily_unavailable",
    ],
  ])("does not admit a turn when the current profile is %s", async (_label, options, code) => {
    const harness = makeHarness(options);

    const events = await request(harness);

    expect(terminal(events)).toMatchObject({
      type: "failed",
      code,
      recordStatus: "not_admitted",
    });
    expect(harness.state.calls.some(([name]) => name === "startTurn")).toBe(false);
    expect(harness.state.providerCalls).toBe(0);
    expect(JSON.stringify(events)).not.toContain("private profile table detail");
  });

  it("uses the saved profile, resolves selected preference text, and preserves the exact request text", async () => {
    const text = "  Armá una actividad\npara 2.º año: 25 % de descuento.  ";
    const harness = makeHarness();

    const events = await request(harness, makePayload({ text }));

    expect(terminal(events)).toMatchObject({ type: "completed", queryId });
    expect(harness.state.providerCalls).toBe(1);
    expect(harness.state.providerInputs[0]).toMatchObject({
      text,
      messages: [],
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "reviewed-revision-123",
      profileSnapshot: {
        sub: caller.sub,
        botId,
        fields: expect.objectContaining({ subjects: ["Matemática"] }),
        responsePreferenceIds: ["ready-material"],
        updatedAt: validProfile.updatedAt,
        promptTexts: ["Incluí materiales completos y listos para usar en clase."],
      },
    });
    expect(harness.state.providerInputs[0].systemPrompt).toContain(
      "Incluí materiales completos y listos para usar en clase.",
    );
    expect(harness.state.providerInputs[0].systemPrompt).not.toContain("Explicá cada paso");
    expect(harness.state.calls.find(([name]) => name === "getProfile")[1]).toEqual({
      sub: caller.sub,
      botId,
    });
    expect(harness.state.calls.some(([name]) => name === "putProfile")).toBe(false);
    expect(harness.state.admitted).toMatchObject({
      sub: caller.sub,
      botId,
      conversationId,
      queryId,
      baseOrdinal: 0,
      text,
      profileSnapshot: harness.state.providerInputs[0].profileSnapshot,
      invocation: {
        modelId: "global.anthropic.claude-sonnet-4-6",
        revision: "reviewed-revision-123",
      },
    });
    expect(harness.state.admitted.profileSnapshot.promptTexts).toContain(
      "Incluí materiales completos y listos para usar en clase.",
    );
    expect(JSON.stringify(harness.state.admitted.profileSnapshot)).toContain("Secundario");
    expect(JSON.stringify(harness.state.admitted.profileSnapshot)).toContain(
      "reviewed-revision-123",
    );
  });

  it("continues an owned thread with only its completed prior pairs and the current text separately", async () => {
    const priorMessages = [
      { role: "user", content: [{ text: "Armá una actividad de porcentajes." }] },
      { role: "assistant", content: [{ text: "Actividad de porcentajes: ..." }] },
      { role: "user", content: [{ text: "¿Podés agregar una comprobación?" }] },
      { role: "assistant", content: [{ text: "Cierre: ..." }] },
    ];
    const harness = makeHarness({
      meta: { conversationId, sub: caller.sub, botId, lastOrdinal: 2 },
      contextMessages: priorMessages,
    });
    const text = "Ahora adaptala para un grupo que todavía no trabajó decimales.";

    const events = await request(harness, makePayload({ operation: "message", text }));

    expect(terminal(events)).toMatchObject({ type: "completed", queryId });
    expect(events[0]).toMatchObject({ type: "accepted", conversationId, ordinal: 3 });
    expect(harness.state.calls.map(([name]) => name)).toEqual([
      "hasMember",
      "getSubmission",
      "getMeta",
      "getProfile",
      "readContext",
      "readQuota",
      "continueTurn",
      "claimInvocation",
      "generate",
      "appendChunk",
      "completeTurn",
    ]);
    expect(harness.state.calls.find(([name]) => name === "readContext")[1]).toEqual({
      conversationId,
    });
    expect(harness.state.admitted).toMatchObject({
      conversationId,
      sub: caller.sub,
      botId,
      baseOrdinal: 2,
      text,
    });
    expect(harness.state.providerInputs).toHaveLength(1);
    expect(harness.state.providerInputs[0]).toMatchObject({
      messages: priorMessages,
      text,
    });
    expect(harness.state.providerInputs[0].messages).not.toContainEqual({
      role: "user",
      content: [{ text }],
    });
    expect(harness.state.providerCalls).toBe(1);
    expect(harness.state.calls.some(([name]) => name === "startTurn")).toBe(false);
  });

  it("uses a newly saved profile for each continuation and leaves the earlier snapshot unchanged", async () => {
    const secondQueryId = "e54bd567-c9a1-49af-b204-8b69ef988a31";
    const harness = makeHarness({
      queryIds: [queryId, secondQueryId],
      contextMessages: [
        { role: "user", content: [{ text: "Pregunta anterior" }] },
        { role: "assistant", content: [{ text: "Respuesta anterior" }] },
      ],
    });
    const first = await request(harness, makePayload());
    expect(harness.state.admittedTurns[0]).toBeDefined();
    const firstSnapshot = clone(harness.state.admittedTurns[0].profileSnapshot);
    harness.state.profile = {
      ...validProfile,
      fields: { educationLevels: ["primario"], subjects: ["Historia"] },
      responsePreferenceIds: ["step-by-step"],
      updatedAt: "2026-10-20T10:00:00.000Z",
    };

    const second = await request(
      harness,
      makePayload({ operation: "message", text: "Seguimiento con el perfil actualizado." }),
    );

    expect(terminal(first)).toMatchObject({ type: "completed", queryId });
    expect(terminal(second)).toMatchObject({ type: "completed", queryId: secondQueryId });
    expect(harness.state.admittedTurns).toHaveLength(2);
    expect(harness.state.admittedTurns[0].profileSnapshot).toEqual(firstSnapshot);
    expect(harness.state.admittedTurns[1].profileSnapshot).toMatchObject({
      fields: expect.objectContaining({ subjects: ["Historia"] }),
      responsePreferenceIds: ["step-by-step"],
      promptTexts: ["Explicá cada paso con claridad."],
      updatedAt: "2026-10-20T10:00:00.000Z",
    });
    expect(harness.state.admittedTurns[0].profileSnapshot).not.toEqual(
      harness.state.admittedTurns[1].profileSnapshot,
    );
    expect(harness.state.providerInputs[1]).toMatchObject({
      messages: harness.state.contextMessages,
      text: "Seguimiento con el perfil actualizado.",
    });
  });

  it("does not read context or generate when the current saved profile is invalid", async () => {
    const harness = makeHarness({
      meta: { conversationId, sub: caller.sub, botId, lastOrdinal: 1 },
      profile: { ...validProfile, fields: { educationLevels: [], subjects: [] } },
    });

    const events = await request(harness, makePayload({ operation: "message" }));

    expect(terminal(events)).toMatchObject({ type: "failed", recordStatus: "not_admitted" });
    expect(harness.state.calls.map(([name]) => name)).toEqual([
      "hasMember",
      "getSubmission",
      "getMeta",
      "getProfile",
    ]);
    expect(harness.state.providerCalls).toBe(0);
  });

  it("does not admit or generate when the completed conversation context cannot be validated", async () => {
    const harness = makeHarness({
      meta: { conversationId, sub: caller.sub, botId, lastOrdinal: 1 },
      contextFailure: new Error("private completed chunk is missing"),
    });

    const events = await request(harness, makePayload({ operation: "message" }));

    expect(terminal(events)).toMatchObject({ type: "failed", recordStatus: "not_admitted" });
    expect(harness.state.calls.map(([name]) => name)).toEqual([
      "hasMember",
      "getSubmission",
      "getMeta",
      "getProfile",
      "readContext",
    ]);
    expect(harness.state.providerCalls).toBe(0);
    expect(harness.state.calls.some(([name]) => name === "continueTurn")).toBe(false);
  });

  it("rejects a competing continuation allocation before invoking the model", async () => {
    const harness = makeHarness({
      meta: { conversationId, sub: caller.sub, botId, lastOrdinal: 4 },
      contextMessages: [
        { role: "user", content: [{ text: "Pregunta anterior" }] },
        { role: "assistant", content: [{ text: "Respuesta anterior" }] },
      ],
      continueFailure: Object.assign(new Error("ordinal allocation conflict"), {
        name: "ConditionalCheckFailedException",
      }),
    });

    const events = await request(harness, makePayload({ operation: "message" }));

    expect(terminal(events)).toMatchObject({ type: "failed" });
    expect(events.some(({ type }) => type === "accepted" || type === "completed")).toBe(false);
    const names = harness.state.calls.map(([name]) => name);
    for (const name of [
      "hasMember",
      "getMeta",
      "getSubmission",
      "getProfile",
      "readContext",
      "readQuota",
      "continueTurn",
    ]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("claimInvocation");
    expect(names).not.toContain("generate");
    expect(harness.state.providerCalls).toBe(0);
  });

  it.each([
    ["omitted", profileWithoutPreferences],
    ["empty", { ...validProfile, responsePreferenceIds: [] }],
  ])(
    "allows a valid profile with %s preferences and resolves none by default",
    async (_label, profile) => {
      const harness = makeHarness({ profile });

      const events = await request(harness);

      expect(terminal(events).type).toBe("completed");
      expect(harness.state.providerInputs[0].systemPrompt).not.toContain(
        "Incluí materiales completos",
      );
      expect(harness.state.providerInputs[0].profileSnapshot.responsePreferenceIds).toEqual([]);
      expect(harness.state.providerInputs[0].messages).toEqual([]);
    },
  );

  it("splits a large provider delta into bounded durable text events without changing its UTF-8 text", async () => {
    const output = "Material para porcentajes: 25 % de descuento 🧮 á.\n".repeat(35_000);
    const harness = makeHarness({
      generation: [
        { type: "text", text: output },
        { type: "result", stopReason: "end_turn" },
      ],
    });
    const stream = await openStream(harness, makePayload(), makeContext());
    const emitted = [];

    try {
      expect((await stream.next()).value.type).toBe("accepted");
      let current;
      do {
        current = await stream.next();
        if (current.value?.type === "text") {
          emitted.push(current.value);
          const durablePrefix = harness.state.answerChunks.map(({ text }) => text).join("");
          expect(durablePrefix).toBe(emitted.map(({ text }) => text).join(""));
          expect(Buffer.byteLength(current.value.text, "utf8")).toBeLessThan(400 * 1024);
        }
      } while (current.value?.type !== "completed" && current.value?.type !== "failed");

      expect(current.value).toMatchObject({ type: "completed", queryId });
      expect(emitted.length).toBeGreaterThan(1);
      expect(emitted.map(({ index }) => index)).toEqual(emitted.map((_, index) => index));
      expect(harness.state.answerChunks.map(({ index }) => index)).toEqual(
        emitted.map(({ index }) => index),
      );
      expect(emitted.map(({ text }) => text).join("")).toBe(output);
      expect(harness.state.answerChunks.map(({ text }) => text).join("")).toBe(output);
    } finally {
      await stream.return();
    }
  });

  it("waits for durable admission before accepted and before starting model generation", async () => {
    const gate = deferred();
    const started = deferred();
    const harness = makeHarness({ startGate: gate.promise, onStart: started.resolve });
    const responsePromise = harness.handler(makePayload(), makeContext());
    let responseSettled = false;
    void responsePromise.then(() => {
      responseSettled = true;
    });

    try {
      expect(await waitFor(started.promise)).toBe(true);
      await Promise.resolve();
      expect(responseSettled).toBe(false);
      expect(harness.state.providerCalls).toBe(0);
      expect(harness.state.admitted).toBeNull();

      gate.resolve();
      const response = await responsePromise;
      expect(isAsyncIterable(response)).toBe(true);
      const stream = response[Symbol.asyncIterator]();
      const first = await stream.next();
      expect(first.value).toMatchObject({ type: "accepted", conversationId, queryId, ordinal: 1 });
      expect(harness.state.admitted).toMatchObject({ text: makePayload().text, queryId });
      const remainingEvents = [];
      for await (const event of stream) remainingEvents.push(event);
      expect(terminal(remainingEvents)).toMatchObject({ type: "completed", queryId });
      expect(harness.state.providerCalls).toBe(1);
    } finally {
      gate.resolve();
    }
  });

  it("persists each response chunk before emitting it, then waits for the completion commit", async () => {
    const completionGate = deferred();
    const completionStarted = deferred();
    const releaseSecondChunk = deferred();
    let providerFinished = false;
    const harness = makeHarness({
      generationFactory: () =>
        (async function* () {
          yield { type: "text", text: "Actividad: " };
          await releaseSecondChunk.promise;
          yield { type: "text", text: "descuentos en una librería." };
          yield { type: "result", stopReason: "end_turn" };
          providerFinished = true;
        })(),
      completeGate: completionGate.promise,
      onComplete: completionStarted.resolve,
    });
    const stream = await openStream(harness, makePayload(), makeContext());

    try {
      expect((await stream.next()).value.type).toBe("accepted");
      const firstTextPromise = stream.next();
      expect(await waitFor(firstTextPromise)).toBe(true);
      const firstText = await firstTextPromise;
      expect(firstText.value).toMatchObject({ type: "text", text: "Actividad: " });
      expect(harness.state.answerChunks.map(({ text }) => text)).toEqual(["Actividad: "]);
      expect(providerFinished).toBe(false);

      releaseSecondChunk.resolve();
      const secondText = await stream.next();
      expect(secondText.value).toMatchObject({ type: "text", text: "descuentos en una librería." });
      expect(harness.state.answerChunks.map(({ text }) => text)).toEqual([
        "Actividad: ",
        "descuentos en una librería.",
      ]);

      let completionSettled = false;
      const pendingTerminal = stream.next().then((value) => {
        completionSettled = true;
        return value;
      });
      expect(await waitFor(completionStarted.promise)).toBe(true);
      await Promise.resolve();
      expect(completionSettled).toBe(false);
      expect(harness.state.completed).toBe(false);
      expect(providerFinished).toBe(true);
      completionGate.resolve();
      expect((await pendingTerminal).value).toMatchObject({ type: "completed", queryId });
      expect(harness.state.completed).toBe(true);
      expect(harness.state.completeInput).toBeTruthy();
    } finally {
      releaseSecondChunk.resolve();
      completionGate.resolve();
      await stream.return();
    }
  });

  it.each([
    [
      "provider error",
      [
        { type: "text", text: "Prefijo" },
        { type: "error", message: "private provider detail" },
      ],
    ],
    ["empty output", [{ type: "result", stopReason: "end_turn" }]],
    ["provider EOF without a result", [{ type: "text", text: "Prefijo sin cierre" }]],
    [
      "truncated output",
      [
        { type: "text", text: "Prefijo incompleto" },
        { type: "result", stopReason: "max_tokens" },
      ],
    ],
  ])(
    "preserves incomplete output and never reports completed after %s",
    async (_label, generation) => {
      const harness = makeHarness({ generation });

      const events = await request(harness);

      expect(events.some(({ type }) => type === "completed")).toBe(false);
      expect(terminal(events)).toMatchObject({ type: "failed", recordStatus: "failed" });
      expect(harness.state.completed).toBe(false);
      expect(harness.state.failed).toBe(true);
      expect(harness.state.answerChunks.map(({ text }) => text).join("")).toBe(
        generation
          .filter(({ type }) => type === "text")
          .map(({ text }) => text)
          .join(""),
      );
      expect(JSON.stringify(events)).not.toMatch(
        /private provider detail|private DynamoDB failure detail/,
      );
      expect(harness.state.providerCalls).toBe(1);
    },
  );

  it("does not emit an answer chunk whose persistence failed and records the durable prefix as failed", async () => {
    const releaseSecondChunk = deferred();
    const harness = makeHarness({
      generationFactory: () =>
        (async function* () {
          yield { type: "text", text: "Prefijo guardado." };
          await releaseSecondChunk.promise;
          yield { type: "text", text: " Este lote falla." };
          yield { type: "result", stopReason: "end_turn" };
        })(),
      chunkFailureAt: 1,
    });
    const stream = await openStream(harness, makePayload(), makeContext());

    try {
      expect((await stream.next()).value.type).toBe("accepted");
      const firstTextPromise = stream.next();
      expect(await waitFor(firstTextPromise)).toBe(true);
      const firstText = await firstTextPromise;
      expect(firstText.value).toMatchObject({ type: "text", text: "Prefijo guardado." });
      expect(harness.state.answerChunks.map(({ text }) => text)).toEqual(["Prefijo guardado."]);

      releaseSecondChunk.resolve();
      const failed = await stream.next();
      expect(failed.value).toMatchObject({ type: "failed", recordStatus: "failed" });
      expect(JSON.stringify(failed.value)).not.toContain("private DynamoDB failure detail");
      expect(harness.state.answerChunks.map(({ text }) => text)).toEqual(["Prefijo guardado."]);
      expect(harness.state.completed).toBe(false);
      expect(harness.state.failed).toBe(true);
    } finally {
      releaseSecondChunk.resolve();
      await stream.return();
    }
  });

  it("keeps the registered producer active and durable after the SSE consumer returns", async () => {
    const nextChunk = deferred();
    const completeStarted = deferred();
    const app = new BedrockAgentCoreApp({
      config: { logging: { enabled: false } },
      invocationHandler: {
        async process() {
          return null;
        },
      },
    });
    let activeTasksAtProviderStart;
    const harness = makeHarness({
      generationFactory: () => {
        activeTasksAtProviderStart = app.getAsyncTaskInfo().activeCount;
        return (async function* () {
          yield { type: "text", text: "Prefijo que ya se mostró." };
          await nextChunk.promise;
          yield { type: "text", text: "Parte que no llegó a mostrarse." };
          yield { type: "result", stopReason: "end_turn" };
        })();
      },
      onComplete: completeStarted.resolve,
    });
    const invocationHandler = createChatInvocationHandler(harness.handler, app);
    const response = await invocationHandler.process(makePayload(), makeContext());
    expect(isAsyncIterable(response)).toBe(true);
    const stream = response[Symbol.asyncIterator]();

    try {
      expect((await stream.next()).value).toMatchObject({
        event: "accepted",
        data: { type: "accepted", queryId },
      });
      const firstTextPromise = stream.next();
      expect(await waitFor(firstTextPromise)).toBe(true);
      expect((await firstTextPromise).value).toMatchObject({
        event: "text",
        data: { type: "text", text: "Prefijo que ya se mostró." },
      });
      expect(activeTasksAtProviderStart).toBe(1);
      expect(app.getAsyncTaskInfo().activeCount).toBe(1);
      await stream.return();

      expect(app.getAsyncTaskInfo().activeCount).toBe(1);
      expect(harness.state.answerChunks.map(({ text }) => text)).toEqual([
        "Prefijo que ya se mostró.",
      ]);
      expect(harness.state.completed).toBe(false);
      expect(harness.state.failed).toBe(false);
      expect(harness.state.failureInput).toBeNull();

      nextChunk.resolve();
      expect(await waitFor(completeStarted.promise)).toBe(true);
      expect(harness.state.answerChunks.map(({ text }) => text)).toEqual([
        "Prefijo que ya se mostró.",
        "Parte que no llegó a mostrarse.",
      ]);
      expect(harness.state.completed).toBe(true);
      expect(harness.state.failed).toBe(false);
      expect(harness.state.failureInput).toBeNull();
      expect(harness.state.providerCalls).toBe(1);
      expect(harness.state.calls.filter(([name]) => name === "claimInvocation")).toHaveLength(1);
      await vi.waitFor(() => expect(app.getAsyncTaskInfo().activeCount).toBe(0));
      expect(harness.state.submissions.get(`${caller.sub}/${botId}/${queryId}`)).toMatchObject({
        status: "completed",
        canContinue: true,
      });
    } finally {
      nextChunk.resolve();
      await stream.return();
    }
  });

  it("does not retry generation and omits metrics the provider did not return", async () => {
    const harness = makeHarness({
      generation: [
        { type: "text", text: "Respuesta útil." },
        { type: "result", stopReason: "end_turn", requestId: "provider-request-1" },
      ],
    });

    const events = await request(harness);

    expect(terminal(events)).toMatchObject({ type: "completed", queryId });
    expect(harness.state.providerCalls).toBe(1);
    expect(Object.hasOwn(harness.state.completeInput, "metrics")).toBe(false);
    expect(JSON.stringify(harness.state.completeInput)).not.toMatch(
      /"(?:inputTokens|outputTokens|latencyMs)":0/,
    );
    expect(Object.hasOwn(terminal(events), "metrics")).toBe(false);
  });

  it("persists provider request and usage data that the generation actually returns", async () => {
    const metrics = { inputTokens: 73, outputTokens: 28, latencyMs: 412 };
    const harness = makeHarness({
      generation: [
        { type: "text", text: "Respuesta registrada." },
        {
          type: "result",
          stopReason: "end_turn",
          requestId: "provider-request-123",
          metrics,
        },
      ],
    });

    const events = await request(harness);

    expect(terminal(events)).toMatchObject({ type: "completed", queryId });
    expect(JSON.stringify(harness.state.completeInput)).toContain("provider-request-123");
    expect(JSON.stringify(harness.state.completeInput)).toContain(JSON.stringify(metrics));
  });

  it("returns a generic unconfirmed failure if the durable start record cannot be written", async () => {
    const harness = makeHarness({ startFailure: new Error("private start write detail") });

    const events = await request(harness);

    expect(terminal(events)).toMatchObject({ type: "failed", recordStatus: "unconfirmed" });
    expect(harness.state.providerCalls).toBe(0);
    expect(harness.state.completed).toBe(false);
    expect(JSON.stringify(events)).not.toContain("private start write detail");
  });

  it("preserves the durable prefix and reports unconfirmed if its failure status cannot be saved", async () => {
    const releaseSecondChunk = deferred();
    const harness = makeHarness({
      generationFactory: () =>
        (async function* () {
          yield { type: "text", text: "Prefijo durable." };
          await releaseSecondChunk.promise;
          yield { type: "text", text: " lote con error" };
        })(),
      chunkFailureAt: 1,
      failFailure: new Error("private failure-status write detail"),
    });
    const stream = await openStream(harness, makePayload(), makeContext());

    try {
      expect((await stream.next()).value.type).toBe("accepted");
      const firstTextPromise = stream.next();
      expect(await waitFor(firstTextPromise)).toBe(true);
      expect((await firstTextPromise).value).toMatchObject({
        type: "text",
        text: "Prefijo durable.",
      });

      releaseSecondChunk.resolve();
      const failed = await stream.next();
      expect(failed.value).toMatchObject({ type: "failed", recordStatus: "unconfirmed" });
      expect(harness.state.answerChunks.map(({ text }) => text)).toEqual(["Prefijo durable."]);
      expect(harness.state.completed).toBe(false);
      expect(JSON.stringify(failed.value)).not.toContain("private failure-status write detail");
    } finally {
      releaseSecondChunk.resolve();
      await stream.return();
    }
  });

  it("returns the authoritative completed result when the completion acknowledgement is ambiguous", async () => {
    const harness = makeHarness({
      generation: [
        { type: "text", text: "Respuesta ya guardada." },
        { type: "result", stopReason: "end_turn" },
      ],
      completeFailure: new Error("private completion commit detail"),
      completeAfterCommit: true,
      failFailure: new Error("private failure record detail"),
    });

    const events = await request(harness);

    expect(terminal(events)).toMatchObject({ type: "completed", queryId });
    expect(harness.state.answerChunks.map(({ text }) => text).join("")).toBe(
      "Respuesta ya guardada.",
    );
    expect(harness.state.completed).toBe(true);
    expect(harness.state.failed).toBe(false);
    expect(harness.state.calls.some(([name]) => name === "failTurn")).toBe(false);
    expect(harness.state.providerCalls).toBe(1);
    expect(JSON.stringify(events)).not.toMatch(
      /private completion commit detail|private failure record detail/,
    );
  });
});
