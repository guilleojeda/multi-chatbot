import { describe, expect, it, vi } from "vitest";
import { createChatHandler } from "../../runtime/chat.ts";

// This double records the Runtime/store contract; it does not prove DynamoDB transaction behavior.
const conversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const otherConversationId = "d90fdf5e-2c77-4a9f-b851-5e16aa52d4b0";
const queryId = "a4bfbc9f-3699-4e93-b120-a03c0204bc67";
const secondQueryId = "b5cfbc9f-3699-4e93-b120-a03c0204bc68";
const fixedNow = Date.parse("2026-10-21T12:00:00.000Z");
const caller = { sub: "teacher-123", token_use: "access" };
const botId = "bot-aurora";
const resultDeadlineMs = 60 * 60 * 1000;

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
  responsePreferenceIds: ["step-by-step"],
  updatedAt: "2026-10-21T11:00:00.000Z",
};

const defaultQuota = {
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

function bearer(claims = caller) {
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `Bearer e30.${encodedClaims}.runtime-validated`;
}

function makeContext(id = conversationId, claims = caller) {
  return {
    sessionId: id,
    headers: {
      authorization: bearer(claims),
      "x-amzn-bedrock-agentcore-runtime-session-id": id,
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
    text: "  Prepará una actividad de proporcionalidad.  ",
    ...overrides,
  };
}

function keyOf({ sub, botId: requestedBotId = botId, queryId: requestId }) {
  return `${sub}/${requestedBotId}/${requestId}`;
}

function createSubmission(input, ordinal) {
  return {
    version: 2,
    sub: input.sub,
    botId: input.botId,
    queryId: input.queryId,
    conversationId: input.conversationId,
    operation: input.operation,
    baseOrdinal: input.baseOrdinal,
    requestFingerprint: input.requestFingerprint,
    ordinal,
    status: "in_progress",
    question: input.text,
    answer: "",
    canContinue: false,
    profileSnapshot: clone(input.profileSnapshot),
    resultDeadlineAt: input.resultDeadlineAt,
    cursor: 0,
  };
}

function makeHarness({
  member = true,
  profile = validProfile,
  profileFailure,
  metaByConversation = new Map(),
  quota = defaultQuota,
  generate,
  storeOverrides = {},
  now = fixedNow,
} = {}) {
  const state = {
    now,
    profile: clone(profile),
    quota: clone(quota),
    calls: [],
    providerCalls: 0,
    providerInputs: [],
    submissions: new Map(),
    metaByConversation: new Map(metaByConversation),
    invocationClaims: new Set(),
  };

  const findSubmission = ({
    sub,
    botId: requestedBotId,
    queryId: requestId,
    conversationId: id,
  }) => {
    if (sub && requestedBotId) {
      return state.submissions.get(`${sub}/${requestedBotId}/${requestId}`) ?? null;
    }
    return (
      [...state.submissions.values()].find(
        (submission) =>
          submission.queryId === requestId &&
          (id === undefined || submission.conversationId === id),
      ) ?? null
    );
  };

  const store = {
    async getMeta(input) {
      state.calls.push(["getMeta", clone(input)]);
      return clone(state.metaByConversation.get(input.conversationId) ?? null);
    },
    async readContext(input) {
      state.calls.push(["readContext", clone(input)]);
      return { messages: [], references: [] };
    },
    async getSubmission(input) {
      state.calls.push(["getSubmission", clone(input)]);
      return clone(findSubmission(input));
    },
    async readQuota(input) {
      state.calls.push(["readQuota", clone(input)]);
      return clone(state.quota);
    },
    async startTurn(input) {
      state.calls.push(["startTurn", clone(input)]);
      const ordinal = 1;
      const submission = createSubmission(input, ordinal);
      state.submissions.set(keyOf(input), submission);
      state.metaByConversation.set(input.conversationId, {
        conversationId: input.conversationId,
        sub: input.sub,
        botId: input.botId,
        lastOrdinal: ordinal,
        activeQueryId: input.queryId,
      });
      return { queryId: input.queryId, ordinal };
    },
    async continueTurn(input) {
      state.calls.push(["continueTurn", clone(input)]);
      const ordinal = input.baseOrdinal + 1;
      const submission = createSubmission(input, ordinal);
      state.submissions.set(keyOf(input), submission);
      state.metaByConversation.set(input.conversationId, {
        conversationId: input.conversationId,
        sub: input.sub,
        botId: input.botId,
        lastOrdinal: ordinal,
        activeQueryId: input.queryId,
      });
      return { queryId: input.queryId, ordinal };
    },
    async claimInvocation(input) {
      state.calls.push(["claimInvocation", clone(input)]);
      const claimKey = `${input.sub}/${input.botId}/${input.queryId}`;
      if (state.invocationClaims.has(claimKey)) return false;
      state.invocationClaims.add(claimKey);
      return true;
    },
    async appendChunk(input) {
      state.calls.push(["appendChunk", clone(input)]);
      const submission = findSubmission(input);
      if (submission) {
        submission.answer += input.text;
        submission.cursor += 1;
      }
    },
    async completeTurn(input) {
      state.calls.push(["completeTurn", clone(input)]);
      const submission = findSubmission(input);
      if (submission) {
        submission.status = "completed";
        submission.canContinue = true;
        submission.cursor = input.cursor ?? submission.cursor;
      }
      const meta = state.metaByConversation.get(input.conversationId);
      if (meta?.activeQueryId === input.queryId) delete meta.activeQueryId;
    },
    async failTurn(input) {
      state.calls.push(["failTurn", clone(input)]);
      const submission = findSubmission(input);
      if (submission) {
        submission.status = "failed";
        submission.canContinue = input.canContinue ?? true;
        submission.failure = { code: input.code };
        submission.cursor = input.cursor ?? submission.cursor;
      }
      const meta = state.metaByConversation.get(input.conversationId);
      if (meta?.activeQueryId === input.queryId) delete meta.activeQueryId;
    },
    async reconcileTurn(input) {
      state.calls.push(["reconcileTurn", clone(input)]);
      const submission = findSubmission(input);
      if (submission) {
        submission.status = "failed";
        submission.canContinue = false;
        submission.failure = { code: "result_timeout" };
      }
      const meta = state.metaByConversation.get(input.conversationId);
      if (meta?.activeQueryId === input.queryId) {
        delete meta.activeQueryId;
        meta.closed = true;
      }
      return clone(submission);
    },
  };
  Object.assign(store, storeOverrides);
  store._harnessState = state;
  for (const method of [
    "getMeta",
    "readContext",
    "getSubmission",
    "readQuota",
    "startTurn",
    "continueTurn",
    "claimInvocation",
    "appendChunk",
    "completeTurn",
    "failTurn",
    "reconcileTurn",
  ]) {
    store[method] = vi.fn(store[method].bind(store));
  }

  const provider =
    generate ??
    async function* () {
      yield { type: "text", text: "Actividad durable." };
      yield { type: "result", stopReason: "end_turn" };
    };
  const handler = createChatHandler({
    config: {
      botId,
      profile: profileConfig,
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "reviewed-revision-123",
      systemPrompt: "Ayudá con tareas de enseñanza.",
    },
    accounts: {
      async hasMember(input) {
        state.calls.push(["hasMember", clone(input)]);
        return member;
      },
    },
    profiles: {
      async getProfile(input) {
        state.calls.push(["getProfile", clone(input)]);
        if (profileFailure) throw profileFailure;
        return clone(state.profile);
      },
    },
    store,
    generate(input) {
      state.providerCalls += 1;
      state.providerInputs.push(clone(input));
      return provider(input, state);
    },
    now: () => state.now,
  });

  return { handler, state, store };
}

async function invoke(handler, payload) {
  return await handler(payload, makeContext(payload.conversationId));
}

function isAsyncIterable(value) {
  return value !== null && typeof value?.[Symbol.asyncIterator] === "function";
}

async function collectEvents(result) {
  const settled = await result;
  expect(isAsyncIterable(settled), "the first POST must return a stream").toBe(true);
  const events = [];
  for await (const event of settled) events.push(event);
  return events;
}

async function terminalResult(result) {
  const settled = await result;
  if (isAsyncIterable(settled)) return terminal(await collectEvents(settled));
  return settled;
}

function terminal(events) {
  return events.at(-1);
}

function callNames(state) {
  return state.calls.map(([name]) => name);
}

function quotaFailure(quota = defaultQuota) {
  return Object.assign(new Error("usage quota exceeded"), {
    code: "quota_exceeded",
    quota: clone(quota),
  });
}

function seededMeta({ id = conversationId, sub = caller.sub, lastOrdinal = 2 } = {}) {
  return [id, { conversationId: id, sub, botId, lastOrdinal }];
}

describe("usage admission and submission recovery in the Runtime handler", () => {
  it("admits a version 2 start with the client query ID and invokes once after durable admission", async () => {
    const harness = makeHarness();

    const events = await collectEvents(invoke(harness.handler, startPayload()));

    expect(events[0]).toMatchObject({
      type: "accepted",
      conversationId,
      queryId,
      ordinal: 1,
    });
    expect(terminal(events)).toMatchObject({ type: "completed", queryId });
    expect(harness.store.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.store.startTurn.mock.calls[0][0]).toMatchObject({
      conversationId,
      queryId,
      baseOrdinal: 0,
      text: "  Prepará una actividad de proporcionalidad.  ",
      sub: caller.sub,
      botId,
      resultDeadlineAt: fixedNow + resultDeadlineMs,
      quota: defaultQuota,
    });
    expect(harness.store.startTurn.mock.calls[0][0].requestFingerprint).toEqual(expect.any(String));
    expect(harness.store.startTurn.mock.calls[0][0].ownerAttemptId).toEqual(expect.any(String));
    expect(harness.store.claimInvocation).toHaveBeenCalledTimes(1);
    expect(harness.state.providerCalls).toBe(1);
    expect(harness.state.providerInputs[0].text).toBe(startPayload().text);
    expect(harness.store.readQuota).toHaveBeenCalledWith({
      sub: caller.sub,
      botId,
      now: fixedNow,
    });
  });

  it("rejects unsupported versions and invalid IDs or ordinals before profile or usage reads", async () => {
    for (const override of [
      { version: 1 },
      { version: 3 },
      { queryId: undefined },
      { queryId: "not-a-uuid" },
      { baseOrdinal: -1 },
    ]) {
      const harness = makeHarness();

      const result = await terminalResult(invoke(harness.handler, startPayload(override)));

      expect(result).toMatchObject({ type: "failed", recordStatus: "not_admitted" });
      expect(harness.state.providerCalls).toBe(0);
      expect(harness.store.readQuota).not.toHaveBeenCalled();
      expect(callNames(harness.state)).not.toContain("getProfile");
    }
  });

  it("rejects missing membership or another owner's conversation before admission", async () => {
    const withoutMembership = makeHarness({ member: false });
    const denied = await terminalResult(
      invoke(withoutMembership.handler, startPayload({ queryId: secondQueryId })),
    );
    expect(denied).toMatchObject({ type: "failed", recordStatus: "not_admitted" });
    expect(withoutMembership.store.getSubmission).not.toHaveBeenCalled();
    expect(withoutMembership.store.readQuota).not.toHaveBeenCalled();

    const otherOwner = makeHarness({
      metaByConversation: new Map([seededMeta({ sub: "another-teacher" })]),
    });
    const deniedOwner = await terminalResult(
      invoke(otherOwner.handler, startPayload({ operation: "message", baseOrdinal: 2 })),
    );
    expect(deniedOwner).toMatchObject({ type: "failed", recordStatus: "not_admitted" });
    expect(otherOwner.store.startTurn).not.toHaveBeenCalled();
    expect(otherOwner.store.continueTurn).not.toHaveBeenCalled();
    expect(otherOwner.store.readQuota).not.toHaveBeenCalled();
    expect(otherOwner.state.providerCalls).toBe(0);
  });

  it("does not reveal a recoverable snapshot after membership is revoked", async () => {
    const harness = makeHarness({ member: false });
    const privateAnswer = "Respuesta que no debe filtrarse tras revocar acceso.";
    harness.state.submissions.set(keyOf({ sub: caller.sub, queryId }), {
      ...createSubmission(
        {
          sub: caller.sub,
          botId,
          queryId,
          conversationId,
          operation: "start",
          baseOrdinal: 0,
          requestFingerprint: "fingerprint",
          text: "Pregunta privada.",
          profileSnapshot: { fields: { subjects: ["Matemática"] } },
          resultDeadlineAt: fixedNow + resultDeadlineMs,
        },
        1,
      ),
      status: "completed",
      answer: privateAnswer,
      canContinue: true,
    });

    const recovered = await terminalResult(
      invoke(harness.handler, {
        version: 2,
        operation: "recover",
        conversationId,
        queryId,
      }),
    );

    expect(recovered).toMatchObject({ type: "failed", code: "access_denied" });
    expect(JSON.stringify(recovered)).not.toContain(privateAnswer);
    expect(harness.store.getSubmission).not.toHaveBeenCalled();
    expect(harness.store.reconcileTurn).not.toHaveBeenCalled();
  });

  it("does not reveal a snapshot returned for a different owner", async () => {
    const privateAnswer = "Respuesta perteneciente a otra persona.";
    const harness = makeHarness({
      storeOverrides: {
        async getSubmission() {
          return {
            sub: "another-teacher",
            botId,
            queryId,
            conversationId,
            ordinal: 3,
            status: "completed",
            question: "Pregunta de otra persona.",
            answer: privateAnswer,
            canContinue: true,
            cursor: 1,
          };
        },
      },
    });

    const recovered = await terminalResult(
      invoke(harness.handler, {
        version: 2,
        operation: "recover",
        conversationId,
        queryId,
      }),
    );

    expect(recovered).toMatchObject({ type: "failed" });
    expect(JSON.stringify(recovered)).not.toContain(privateAnswer);
    expect(JSON.stringify(recovered)).not.toContain("Pregunta de otra persona.");
    expect(harness.store.reconcileTurn).not.toHaveBeenCalled();
  });

  it("returns the server quota view when either the daily or monthly cup is exhausted", async () => {
    for (const period of ["daily", "monthly"]) {
      const exhausted = {
        ...defaultQuota,
        [period]: {
          ...defaultQuota[period],
          used: defaultQuota[period].limit,
        },
        blockedUntil:
          period === "daily" ? defaultQuota.daily.resetAt : defaultQuota.monthly.resetAt,
      };
      const harness = makeHarness({
        quota: exhausted,
        storeOverrides: {
          async startTurn() {
            throw quotaFailure(exhausted);
          },
        },
      });

      const failure = await terminalResult(invoke(harness.handler, startPayload()));

      expect(failure).toMatchObject({
        type: "failed",
        code: "quota_exceeded",
        recordStatus: "not_admitted",
        quota: exhausted,
      });
      expect(harness.state.providerCalls).toBe(0);
      expect(harness.store.startTurn).toHaveBeenCalledTimes(1);
      expect(harness.store.claimInvocation).not.toHaveBeenCalled();
    }
  });

  it("does not admit an incomplete profile or read the quota policy", async () => {
    const harness = makeHarness({
      profile: {
        ...validProfile,
        fields: { educationLevels: [], subjects: [] },
      },
    });

    const result = await terminalResult(invoke(harness.handler, startPayload()));

    expect(result).toMatchObject({ type: "failed", recordStatus: "not_admitted" });
    expect(harness.store.readQuota).not.toHaveBeenCalled();
    expect(harness.store.startTurn).not.toHaveBeenCalled();
    expect(harness.state.providerCalls).toBe(0);
  });

  it("returns the durable in-progress snapshot for a repeated active ID without reading profile or policy again", async () => {
    const started = deferred();
    const releaseProvider = deferred();
    const harness = makeHarness({
      generate: async function* () {
        started.resolve();
        await releaseProvider.promise;
        yield { type: "text", text: "Respuesta que sigue." };
        yield { type: "result", stopReason: "end_turn" };
      },
    });
    const firstResponse = await invoke(harness.handler, startPayload());
    expect(isAsyncIterable(firstResponse)).toBe(true);
    const firstStream = firstResponse[Symbol.asyncIterator]();
    expect((await firstStream.next()).value).toMatchObject({ type: "accepted", queryId });
    const pendingText = firstStream.next();
    expect(await waitFor(started.promise)).toBe(true);

    const repeated = await invoke(harness.handler, startPayload());

    expect(isAsyncIterable(repeated)).toBe(false);
    expect(repeated).toMatchObject({
      version: 2,
      conversationId,
      queryId,
      ordinal: 1,
      status: "in_progress",
      question: startPayload().text,
    });
    expect(harness.store.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.store.readQuota).toHaveBeenCalledTimes(1);
    expect(callNames(harness.state).filter((name) => name === "getProfile")).toHaveLength(1);
    expect(harness.state.providerCalls).toBe(1);

    releaseProvider.resolve();
    await pendingText;
    await firstStream.return();
  });

  it("returns repeated completed and failed IDs as JSON snapshots without another invocation", async () => {
    for (const { status, answer, canContinue, generate } of [
      {
        status: "completed",
        answer: "Respuesta completa.",
        canContinue: true,
        generate: async function* () {
          yield { type: "text", text: "Respuesta completa." };
          yield { type: "result", stopReason: "end_turn" };
        },
      },
      {
        status: "failed",
        answer: "Prefijo durable.",
        canContinue: true,
        generate: async function* () {
          yield { type: "text", text: "Prefijo durable." };
          yield { type: "result", stopReason: "max_tokens" };
        },
      },
      {
        status: "failed",
        answer: "Prefijo de fin incierto.",
        canContinue: false,
        generate: async function* () {
          yield { type: "text", text: "Prefijo de fin incierto." };
          yield { type: "error", providerCode: "ProviderError" };
        },
      },
    ]) {
      const harness = makeHarness({ generate });
      await collectEvents(invoke(harness.handler, startPayload()));

      const repeated = await invoke(harness.handler, startPayload());

      expect(isAsyncIterable(repeated)).toBe(false);
      expect(repeated).toMatchObject({
        version: 2,
        conversationId,
        queryId,
        ordinal: 1,
        status,
        question: startPayload().text,
        answer,
        canContinue,
      });
      expect(harness.store.startTurn).toHaveBeenCalledTimes(1);
      expect(harness.store.readQuota).toHaveBeenCalledTimes(1);
      expect(harness.state.providerCalls).toBe(1);
    }
  });

  it("rejects changed text, conversation, base ordinal, or operation for an existing ID", async () => {
    for (const changes of [
      { text: "Una pregunta distinta." },
      { conversationId: otherConversationId },
      { operation: "message", baseOrdinal: 1 },
      { operation: "message", baseOrdinal: 0 },
    ]) {
      const harness = makeHarness();
      await collectEvents(invoke(harness.handler, startPayload()));
      const originalProviderCalls = harness.state.providerCalls;

      const failure = await terminalResult(invoke(harness.handler, startPayload(changes)));

      expect(failure).toMatchObject({ type: "failed" });
      expect(String(failure.code)).toMatch(/conflict/i);
      expect(harness.store.startTurn).toHaveBeenCalledTimes(1);
      expect(harness.store.continueTurn).not.toHaveBeenCalled();
      expect(harness.store.readQuota).toHaveBeenCalledTimes(1);
      expect(harness.state.providerCalls).toBe(originalProviderCalls);
    }
  });

  it("uses a fresh profile and policy for a new follow-up while recovery keeps the first snapshot", async () => {
    const updatedQuota = {
      ...defaultQuota,
      daily: { ...defaultQuota.daily, used: 4 },
      monthly: { ...defaultQuota.monthly, used: 18 },
      policyRevision: "usage-policy-2",
    };
    const harness = makeHarness();
    await collectEvents(invoke(harness.handler, startPayload()));
    const original = harness.state.submissions.get(keyOf({ sub: caller.sub, queryId }));
    expect(original).toBeDefined();
    const firstSnapshot = clone(original.profileSnapshot);
    harness.state.profile = {
      ...validProfile,
      fields: { educationLevels: ["primario"], subjects: ["Historia"] },
      updatedAt: "2026-10-21T12:05:00.000Z",
    };
    harness.state.quota = updatedQuota;

    const next = await collectEvents(
      invoke(
        harness.handler,
        startPayload({
          operation: "message",
          queryId: secondQueryId,
          baseOrdinal: 1,
          text: "Adaptala para trabajar sin decimales.",
        }),
      ),
    );
    const recoveredFirst = await invoke(harness.handler, {
      version: 2,
      operation: "recover",
      conversationId,
      queryId,
    });

    expect(next[0]).toMatchObject({ type: "accepted", queryId: secondQueryId, ordinal: 2 });
    expect(harness.store.continueTurn).toHaveBeenCalledTimes(1);
    expect(harness.store.continueTurn.mock.calls[0][0]).toMatchObject({
      baseOrdinal: 1,
      queryId: secondQueryId,
      quota: updatedQuota,
      profileSnapshot: expect.objectContaining({
        fields: expect.objectContaining({ subjects: ["Historia"] }),
      }),
    });
    expect(original.profileSnapshot).toEqual(firstSnapshot);
    expect(recoveredFirst).toMatchObject({
      version: 2,
      queryId,
      status: "completed",
    });
    expect(harness.state.providerCalls).toBe(2);
  });

  it("returns a conversation-busy rejection for a second ID while the first generation is active", async () => {
    const entered = deferred();
    const release = deferred();
    const harness = makeHarness({
      generate: async function* () {
        entered.resolve();
        await release.promise;
        yield { type: "text", text: "Primera respuesta." };
        yield { type: "result", stopReason: "end_turn" };
      },
    });
    const first = await invoke(harness.handler, startPayload());
    const firstStream = first[Symbol.asyncIterator]();
    expect((await firstStream.next()).value).toMatchObject({ type: "accepted", queryId });
    const pendingText = firstStream.next();
    expect(await waitFor(entered.promise)).toBe(true);
    harness.store.continueTurn = vi.fn(async () => {
      throw Object.assign(new Error("conversation is busy"), { code: "conversation_busy" });
    });

    const rejected = await invoke(
      harness.handler,
      startPayload({
        operation: "message",
        queryId: secondQueryId,
        baseOrdinal: 1,
        text: "Otro pedido simultáneo.",
      }),
    );
    const events = isAsyncIterable(rejected) ? await collectEvents(rejected) : null;
    const failure = events ? terminal(events) : rejected;

    expect(failure).toMatchObject({ type: "failed", recordStatus: "not_admitted" });
    expect(String(failure.code)).toMatch(/busy|conversation/i);
    expect(harness.state.providerCalls).toBe(1);
    expect(harness.store.continueTurn).toHaveBeenCalledTimes(1);
    release.resolve();
    await pendingText;
    await firstStream.return();
  });

  it("does not invoke for a competing last-cup admission rejected by the store", async () => {
    const winnerGate = deferred();
    const winnerStarted = deferred();
    let admitted = false;
    const exhausted = {
      ...defaultQuota,
      daily: { ...defaultQuota.daily, used: 19 },
      monthly: { ...defaultQuota.monthly, used: 199 },
    };
    const harness = makeHarness({
      quota: exhausted,
      generate: async function* () {
        winnerStarted.resolve();
        await winnerGate.promise;
        yield { type: "text", text: "Única consulta admitida." };
        yield { type: "result", stopReason: "end_turn" };
      },
      storeOverrides: {
        async startTurn(input) {
          if (admitted)
            throw quotaFailure({ ...exhausted, daily: { ...exhausted.daily, used: 20 } });
          admitted = true;
          const ordinal = 1;
          this._harnessState.submissions.set(keyOf(input), createSubmission(input, ordinal));
          this._harnessState.metaByConversation.set(input.conversationId, {
            conversationId: input.conversationId,
            sub: input.sub,
            botId: input.botId,
            lastOrdinal: ordinal,
            activeQueryId: input.queryId,
          });
          return { queryId: input.queryId, ordinal };
        },
      },
    });
    harness.store._harnessState = harness.state;
    const first = await invoke(harness.handler, startPayload());
    const firstStream = first[Symbol.asyncIterator]();
    expect((await firstStream.next()).value).toMatchObject({ type: "accepted", queryId });
    const pendingText = firstStream.next();
    expect(await waitFor(winnerStarted.promise)).toBe(true);

    const second = await invoke(
      harness.handler,
      startPayload({
        conversationId: otherConversationId,
        queryId: secondQueryId,
        text: "La consulta que compite por el último cupo.",
      }),
    );
    const rejectedEvents = isAsyncIterable(second) ? await collectEvents(second) : null;
    const failure = rejectedEvents ? terminal(rejectedEvents) : second;

    expect(failure).toMatchObject({ type: "failed", code: "quota_exceeded" });
    expect(harness.state.providerCalls).toBe(1);
    expect(admitted).toBe(true);
    winnerGate.resolve();
    await pendingText;
    await firstStream.return();
  });

  it("does not invoke when the store refuses the one-time invocation claim", async () => {
    const harness = makeHarness({
      storeOverrides: {
        async claimInvocation(input) {
          this._harnessState.calls.push(["claimInvocation", clone(input)]);
          return false;
        },
      },
    });
    harness.store._harnessState = harness.state;

    const result = await terminalResult(invoke(harness.handler, startPayload()));

    expect(result.type).not.toBe("completed");
    expect(harness.store.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.store.claimInvocation).toHaveBeenCalledTimes(1);
    expect(harness.state.providerCalls).toBe(0);
  });

  it("does not report accepted or invoke until the atomic original-question admission finishes", async () => {
    const admissionStarted = deferred();
    const releaseAdmission = deferred();
    const harness = makeHarness({
      storeOverrides: {
        async startTurn(input) {
          admissionStarted.resolve();
          await releaseAdmission.promise;
          const ordinal = 1;
          this._harnessState.submissions.set(keyOf(input), createSubmission(input, ordinal));
          this._harnessState.metaByConversation.set(input.conversationId, {
            conversationId: input.conversationId,
            sub: input.sub,
            botId: input.botId,
            lastOrdinal: ordinal,
            activeQueryId: input.queryId,
          });
          return { queryId: input.queryId, ordinal };
        },
      },
    });
    harness.store._harnessState = harness.state;
    const responsePromise = invoke(harness.handler, startPayload());
    let response;
    let stream;
    let eventSettled = false;
    const first = await Promise.race([
      responsePromise.then((value) => ({ kind: "response", value })),
      admissionStarted.promise.then(() => ({ kind: "admission" })),
    ]);
    if (first.kind === "response") {
      response = first.value;
      expect(isAsyncIterable(response)).toBe(true);
      stream = response[Symbol.asyncIterator]();
      const pendingEvent = stream.next().then((value) => {
        eventSettled = true;
        return value;
      });
      expect(await waitFor(admissionStarted.promise)).toBe(true);
      await Promise.resolve();
      expect(eventSettled).toBe(false);
      expect(harness.state.providerCalls).toBe(0);
      releaseAdmission.resolve();
      expect((await pendingEvent).value).toMatchObject({
        type: "accepted",
        queryId,
        ordinal: 1,
      });
    } else {
      let responseSettled = false;
      void responsePromise.then(() => {
        responseSettled = true;
      });
      await Promise.resolve();
      expect(responseSettled).toBe(false);
      expect(harness.state.providerCalls).toBe(0);
      releaseAdmission.resolve();
      response = await responsePromise;
      expect(isAsyncIterable(response)).toBe(true);
      stream = response[Symbol.asyncIterator]();
      expect((await stream.next()).value).toMatchObject({
        type: "accepted",
        queryId,
        ordinal: 1,
      });
    }
    expect(harness.store.startTurn.mock.calls[0][0].text).toBe(startPayload().text);
    const remainingEvents = [];
    for await (const event of stream) remainingEvents.push(event);
    expect(terminal(remainingEvents)).toMatchObject({ type: "completed", queryId });
    expect(harness.state.providerCalls).toBe(1);
  });

  it("recovers an admission whose commit acknowledgement was lost under the same query ID", async () => {
    const harness = makeHarness({
      storeOverrides: {
        async startTurn(input) {
          this._harnessState.submissions.set(keyOf(input), createSubmission(input, 1));
          throw new Error("transaction response timed out");
        },
      },
    });
    harness.store._harnessState = harness.state;

    const result = await terminalResult(invoke(harness.handler, startPayload()));

    expect(result).toMatchObject({
      version: 2,
      conversationId,
      queryId,
      ordinal: 1,
      status: "in_progress",
      question: startPayload().text,
    });
    expect(harness.store.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.store.getSubmission).toHaveBeenCalledWith({
      sub: caller.sub,
      botId,
      queryId,
    });
    expect(harness.state.providerCalls).toBe(0);
  });

  it("keeps a timed-out admission without a visible reference unconfirmed for explicit same-ID recovery", async () => {
    const harness = makeHarness({
      storeOverrides: {
        async startTurn() {
          throw new Error("transaction response timed out");
        },
      },
    });

    const result = await terminalResult(invoke(harness.handler, startPayload()));

    expect(result).toMatchObject({
      type: "failed",
      queryId,
      recordStatus: "unconfirmed",
    });
    expect(result.code).not.toBe("conversation_unavailable");
    expect(harness.store.getSubmission.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(harness.state.providerCalls).toBe(0);
  });

  it("recovers an active submission before its 60-minute deadline without reconciling or invoking", async () => {
    const harness = makeHarness();
    await collectEvents(invoke(harness.handler, startPayload()));
    const submission = harness.state.submissions.get(keyOf({ sub: caller.sub, queryId }));
    expect(submission).toBeDefined();
    submission.status = "in_progress";
    submission.answer = "Prefijo durable.";
    submission.canContinue = false;
    submission.resultDeadlineAt = fixedNow + resultDeadlineMs;
    harness.state.now = submission.resultDeadlineAt - 1;
    const callsBefore = harness.state.providerCalls;

    const recovered = await invoke(harness.handler, {
      version: 2,
      operation: "recover",
      conversationId,
      queryId,
    });

    expect(recovered).toMatchObject({
      version: 2,
      queryId,
      status: "in_progress",
      question: startPayload().text,
      answer: "Prefijo durable.",
      canContinue: false,
    });
    expect(harness.store.reconcileTurn).not.toHaveBeenCalled();
    expect(harness.state.providerCalls).toBe(callsBefore);
  });

  it("reconciles an active submission at 60 minutes to failed and closes without reinvoking", async () => {
    const harness = makeHarness();
    await collectEvents(invoke(harness.handler, startPayload()));
    const submission = harness.state.submissions.get(keyOf({ sub: caller.sub, queryId }));
    expect(submission).toBeDefined();
    submission.status = "in_progress";
    submission.answer = "Prefijo durable.";
    submission.canContinue = false;
    submission.resultDeadlineAt = fixedNow + resultDeadlineMs;
    harness.state.now = submission.resultDeadlineAt;
    const callsBefore = harness.state.providerCalls;

    const recovered = await invoke(harness.handler, {
      version: 2,
      operation: "recover",
      conversationId,
      queryId,
    });

    expect(harness.store.reconcileTurn).toHaveBeenCalledTimes(1);
    expect(recovered).toMatchObject({
      version: 2,
      queryId,
      status: "failed",
      answer: "Prefijo durable.",
      canContinue: false,
    });
    expect(harness.state.providerCalls).toBe(callsBefore);
    expect(harness.store.claimInvocation).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade a completed record when the completion acknowledgement is ambiguous", async () => {
    const harness = makeHarness({
      storeOverrides: {
        async completeTurn(input) {
          const submission = this._harnessState.submissions.get(keyOf(input));
          expect(submission).toBeDefined();
          submission.status = "completed";
          submission.canContinue = true;
          submission.answer = "Commit confirmado en DynamoDB.";
          throw new Error("completion response timed out");
        },
      },
    });
    harness.store._harnessState = harness.state;

    const result = await invoke(harness.handler, startPayload());
    const events = isAsyncIterable(result) ? await collectEvents(result) : null;
    const completion = events ? terminal(events) : result;

    expect(completion).toMatchObject({ type: "completed", queryId });
    expect(harness.store.failTurn).not.toHaveBeenCalled();
    expect(harness.store.completeTurn).toHaveBeenCalledTimes(1);
    expect(harness.state.providerCalls).toBe(1);
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
