import { prepareUnchangedContext } from "../../support/context-preparation.mjs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));

export const botId = "bot-aurora";
export const conversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
export const queryId = "a4bfbc9f-3699-4e93-b120-a03c0204bc67";
export const fixedNow = Date.parse("2026-10-23T16:00:00.000Z");
export const caller = { sub: "teacher-123", token_use: "access" };

export const profileConfig = {
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
  ],
};

export const validProfile = {
  sub: caller.sub,
  botId,
  fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
  responsePreferenceIds: ["ready-material"],
  updatedAt: "2026-10-22T12:00:00.000Z",
};

export const quotaView = {
  daily: {
    used: 3,
    limit: 20,
    resetAt: Date.parse("2026-10-24T03:00:00.000Z"),
    period: "2026-10-23",
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

export const startPayload = {
  version: 2,
  operation: "start",
  conversationId,
  queryId,
  baseOrdinal: 0,
  text: "Armá una actividad de 15 minutos sobre porcentajes.",
};

export const bearer = (claims = caller) => {
  // Runtime already validates this token; this fixture exercises the handler's subject lookup.
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `Bearer e30.${encodedClaims}.runtime-validated`;
};

export function makeContext({
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

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function requestFingerprint(payload) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        payload.operation,
        payload.conversationId,
        payload.baseOrdinal,
        payload.text,
      ]),
    )
    .digest("hex");
}

export function makeRuntimeHarness(
  createChatHandler,
  {
    member = true,
    profile = validProfile,
    meta = null,
    contextMessages = [],
    contextReferences = [],
    quota = quotaView,
    onReadQuota,
    prepareDocuments = async () => ({
      knowledgeBaseId: "kb-dev-aurora",
      query: "porcentajes secundaria matemática",
      revision: "documents-revision-1",
      retrievedAt: fixedNow,
      status: "empty",
      results: [],
    }),
    countInputTokens = async () => ({ inputTokens: 32 }),
    generation = [
      { type: "text", text: "Actividad lista para aplicar." },
      { type: "result", stopReason: "end_turn" },
    ],
    generationFailure,
  } = {},
) {
  const state = {
    member,
    profile: clone(profile),
    profileReads: 0,
    meta: clone(meta),
    contextMessages: clone(contextMessages),
    contextReferences: clone(contextReferences),
    quota: clone(quota),
    onReadQuota,
    calls: [],
    submissions: new Map(),
    submissionLookupFailures: new Set(),
    prepareInputs: [],
    countInputs: [],
    generateInputs: [],
    admittedTurns: [],
    invocationClaims: new Set(),
    generated: 0,
    answer: "",
    completeInput: null,
    failureInput: null,
  };

  const submissionKey = ({ sub = caller.sub, botId: requestedBotId = botId, queryId: id }) =>
    `${sub}/${requestedBotId}/${id}`;

  state.seedSubmission = (payload, overrides = {}) => {
    const submission = {
      sub: caller.sub,
      botId,
      conversationId: payload.conversationId,
      queryId: payload.queryId,
      requestFingerprint: requestFingerprint(payload),
      operation: payload.operation,
      baseOrdinal: payload.baseOrdinal,
      ordinal: payload.baseOrdinal + 1,
      status: "completed",
      stage: "complete",
      question: payload.text,
      questionManifest: { count: 1, complete: true },
      contextReferences: [],
      answer: "Respuesta guardada.",
      answerManifest: { count: 1, complete: true },
      cursor: 1,
      canContinue: true,
      resultDeadlineAt: fixedNow + 60 * 60 * 1000,
      profileSnapshot: { sub: caller.sub, botId, fields: {} },
      documentContext: {},
      invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "runtime-r1" },
      ...clone(overrides),
    };
    state.submissions.set(submissionKey(submission), submission);
    return clone(submission);
  };

  const store = {
    async getMeta(input) {
      state.calls.push(["getMeta", clone(input)]);
      return clone(state.meta);
    },
    async getSubmission(input) {
      state.calls.push(["getSubmission", clone(input)]);
      if (
        state.submissionLookupFailures.has(
          state.calls.filter(([name]) => name === "getSubmission").length,
        )
      ) {
        throw new Error("private submission lookup detail");
      }
      return clone(state.submissions.get(submissionKey(input)) ?? null);
    },
    async readContext(input) {
      state.calls.push(["readContext", clone(input)]);
      return { messages: clone(state.contextMessages), references: clone(state.contextReferences) };
    },
    async readQuota(input) {
      state.calls.push(["readQuota", clone(input)]);
      if (state.onReadQuota) return clone(await state.onReadQuota(clone(input), state));
      return clone(state.quota);
    },
    async startTurn(input) {
      state.calls.push(["startTurn", clone(input)]);
      const key = submissionKey(input);
      if (state.submissions.has(key)) {
        throw Object.assign(new Error("submission already exists"), { code: "submission_exists" });
      }
      state.admittedTurns.push(clone(input));
      const submission = {
        ...clone(input),
        ordinal: 1,
        status: "in_progress",
        stage: "admitted",
        question: input.text,
        questionManifest: { count: 1, complete: true },
        answer: "",
        answerManifest: { count: 0, complete: false },
        cursor: 0,
        canContinue: false,
      };
      state.submissions.set(key, submission);
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
      const key = submissionKey(input);
      if (state.submissions.has(key)) {
        throw Object.assign(new Error("submission already exists"), { code: "submission_exists" });
      }
      const ordinal = input.baseOrdinal + 1;
      state.admittedTurns.push(clone(input));
      state.submissions.set(key, {
        ...clone(input),
        ordinal,
        status: "in_progress",
        stage: "admitted",
        question: input.text,
        questionManifest: { count: 1, complete: true },
        answer: "",
        answerManifest: { count: 0, complete: false },
        cursor: 0,
        canContinue: false,
      });
      state.meta = { ...state.meta, lastOrdinal: ordinal, activeQueryId: input.queryId };
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
      state.answer += input.text;
      const submission = state.submissions.get(submissionKey({ queryId: input.queryId }));
      if (submission) {
        submission.answer += input.text;
        submission.cursor += 1;
        submission.answerManifest = { count: submission.cursor, complete: false };
      }
    },
    async completeTurn(input) {
      state.calls.push(["completeTurn", clone(input)]);
      state.completeInput = clone(input);
      const submission = state.submissions.get(submissionKey({ queryId: input.queryId }));
      if (submission) {
        submission.status = "completed";
        submission.stage = "complete";
        submission.canContinue = true;
        submission.answerManifest = clone(input.answerManifest);
      }
      if (state.meta?.activeQueryId === input.queryId) delete state.meta.activeQueryId;
    },
    async failTurn(input) {
      state.calls.push(["failTurn", clone(input)]);
      state.failureInput = clone(input);
      const submission = state.submissions.get(submissionKey({ queryId: input.queryId }));
      if (submission) {
        submission.status = "failed";
        submission.stage = "failed";
        submission.canContinue = !(input.invocationClaimed && !input.providerFinished);
      }
      if (state.meta?.activeQueryId === input.queryId) delete state.meta.activeQueryId;
    },
    async reconcileTurn(input) {
      state.calls.push(["reconcileTurn", clone(input)]);
      return clone(state.submissions.get(submissionKey(input)) ?? null);
    },
  };

  const handler = createChatHandler({
    config: {
      botId,
      profile: profileConfig,
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "reviewed-revision-123",
      systemPrompt:
        "Ayudá con tareas de enseñanza usando documentos del proyecto y conocimiento general.",
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
        state.profileReads += 1;
        if (state.profile === null) return null;
        if (state.profile.sub !== input.sub || state.profile.botId !== input.botId) return null;
        return clone(state.profile);
      },
    },
    store,
    prepareContext: prepareUnchangedContext,
    prepareDocuments: async (input) => {
      state.calls.push(["prepareDocuments"]);
      state.prepareInputs.push(clone(input));
      return clone(await prepareDocuments(input, state));
    },
    countInputTokens: async (input) => {
      state.calls.push(["countInputTokens"]);
      state.countInputs.push(clone(input));
      return clone(await countInputTokens(input, state));
    },
    generate: (input) => {
      state.calls.push(["generate"]);
      state.generated += 1;
      state.generateInputs.push(clone(input));
      return (async function* () {
        for (const event of generation) {
          if (event.type === "error") throw new Error(event.message ?? "provider failed");
          yield clone(event);
        }
        if (generationFailure) throw generationFailure;
      })();
    },
    now: () => fixedNow,
  });

  return { handler, state, store };
}

export async function invoke(harness, payload = startPayload, context = makeContext()) {
  const response = await harness.handler(clone(payload), context);
  if (response === null || typeof response?.[Symbol.asyncIterator] !== "function") return response;
  const events = [];
  for await (const event of response) events.push(event);
  return events;
}

export function terminal(events) {
  return Array.isArray(events) ? events.at(-1) : events;
}
