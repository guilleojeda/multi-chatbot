import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  botId,
  caller,
  clone,
  conversationId,
  fixedNow,
  invoke,
  makeContext,
  makeRuntimeHarness,
  projectRoot,
  queryId,
  startPayload,
  terminal,
} from "./helpers/documents-runtime-harness.mjs";

const chatPath = path.join(projectRoot, "runtime/chat.ts");
const mismatchedSnapshotId = "e6f3b71a-b6f7-4d11-a635-379a6b17a514";
const otherQueryId = "b2bfbc9f-3699-4a93-b120-a03c0204bc67";

let createChatHandler;
let createChatInvocationHandler;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function messagePayload(overrides = {}) {
  return {
    ...startPayload,
    operation: "message",
    queryId: otherQueryId,
    baseOrdinal: 3,
    text: "¿Y una variante para el aula?",
    ...overrides,
  };
}

function assertHiddenFailure(response) {
  expect(response).toMatchObject({
    type: "failed",
    code: "conversation_hidden",
    recordStatus: "unconfirmed",
    canContinue: false,
  });
  expect(JSON.stringify(response)).not.toMatch(
    /PRIVATE_HISTORY|PRIVATE_ANSWER|SECRET_SNAPSHOT|private provider detail/,
  );
  expect(response).not.toHaveProperty("quota");
  expect(response).not.toHaveProperty("ordinal");
  expect(response).not.toHaveProperty("question");
  expect(response).not.toHaveProperty("answer");
}

function seedHiddenSnapshot(harness, payload = startPayload, overrides = {}) {
  return harness.state.seedSubmission(payload, {
    question: payload.text,
    answer: "PRIVATE_ANSWER_SENTINEL",
    profileSnapshot: { secret: "PRIVATE_HISTORY_PROFILE_SENTINEL" },
    contextSnapshot: { version: 1, recentReferences: [] },
    documentContext: {
      knowledgeBaseId: "kb-aurora-dev",
      query: "documentos de prueba",
      revision: "documents-r1",
      retrievedAt: fixedNow,
      status: "results",
      results: [{ text: "PRIVATE_HISTORY_DOCUMENT_SENTINEL" }],
    },
    ...overrides,
  });
}

describe("hidden conversations in the Runtime handler", () => {
  beforeAll(async () => {
    const module = await import(pathToFileURL(chatPath).href);
    createChatHandler = module.createChatHandler;
    createChatInvocationHandler = module.createChatInvocationHandler;
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["a repeated start", startPayload, startPayload],
    ["a repeated follow-up", messagePayload(), messagePayload()],
    ["recover", { version: 2, operation: "recover", conversationId, queryId }, startPayload],
  ])("does not publish a known %s snapshot after META is hidden", async (_name, request, saved) => {
    const harness = makeRuntimeHarness(createChatHandler, {
      meta: {
        conversationId,
        sub: caller.sub,
        botId,
        lastOrdinal: 4,
        hiddenAt: "2026-10-24T12:00:00.000Z",
      },
    });
    seedHiddenSnapshot(harness, saved);

    const response = terminal(await invoke(harness, request));

    assertHiddenFailure(response);
    expect(
      harness.state.calls.some(
        ([name, input]) => name === "getMeta" && input.conversationId === conversationId,
      ),
    ).toBe(true);
    expect(harness.state.profileReads).toBe(0);
    expect(harness.state.prepareInputs).toHaveLength(0);
    expect(harness.state.countInputs).toHaveLength(0);
    expect(harness.state.generateInputs).toHaveLength(0);
    expect(harness.state.admittedTurns).toHaveLength(0);
  });

  it("rejects a snapshot whose conversation ID differs from the request without revealing it", async () => {
    const payloadConversationId = conversationId;
    const recover = {
      version: 2,
      operation: "recover",
      conversationId: payloadConversationId,
      queryId,
    };
    const harness = makeRuntimeHarness(createChatHandler, { meta: null });
    seedHiddenSnapshot(harness, startPayload, { conversationId: mismatchedSnapshotId });

    const response = terminal(
      await invoke(
        harness,
        recover,
        makeContext({ sessionId: payloadConversationId, sessionHeader: payloadConversationId }),
      ),
    );

    expect(response).toMatchObject({ type: "failed" });
    expect(response.code).not.toBe("conversation_hidden");
    expect(response).not.toHaveProperty("status");
    expect(response).not.toHaveProperty("question");
    expect(response).not.toHaveProperty("answer");
    expect(JSON.stringify(response)).not.toMatch(/PRIVATE_ANSWER|SECRET_SNAPSHOT/);
  });

  it("fails closed for an ill-formed hiddenAt marker and never reveals the stored answer", async () => {
    const harness = makeRuntimeHarness(createChatHandler, {
      meta: { conversationId, sub: caller.sub, botId, lastOrdinal: 1, hiddenAt: null },
    });
    seedHiddenSnapshot(harness);

    const response = await invoke(harness, {
      version: 2,
      operation: "recover",
      conversationId,
      queryId,
    });

    assertHiddenFailure(response);
    expect(harness.state.generated).toBe(0);
  });

  it.each([
    ["another subject", { sub: "someone-else", botId }],
    ["another chatbot", { sub: caller.sub, botId: "bot-other" }],
  ])("does not disclose hidden status for META owned by %s", async (_name, metaOwner) => {
    const harness = makeRuntimeHarness(createChatHandler, {
      meta: {
        conversationId,
        ...metaOwner,
        lastOrdinal: 1,
        hiddenAt: "2026-10-24T12:00:00.000Z",
      },
    });
    seedHiddenSnapshot(harness);

    const response = await invoke(harness, {
      version: 2,
      operation: "recover",
      conversationId,
      queryId,
    });

    expect(response).toMatchObject({ type: "failed", recordStatus: "not_admitted" });
    expect(response.code).not.toBe("conversation_hidden");
    expect(JSON.stringify(response)).not.toMatch(/PRIVATE_QUESTION|PRIVATE_ANSWER/);
  });

  it.each([
    ["missing", "null"],
    ["unreadable", "throw"],
  ])("does not use a known snapshot as fallback when META is %s", async (_label, readMode) => {
    const harness = makeRuntimeHarness(createChatHandler, { meta: null });
    seedHiddenSnapshot(harness);
    harness.store.getMeta = vi.fn(async (input) => {
      harness.state.calls.push(["getMeta", clone(input)]);
      if (readMode === "null") return null;
      throw new Error("PRIVATE_STORAGE_DIAGNOSTIC_SENTINEL");
    });

    const response = await invoke(harness, {
      version: 2,
      operation: "recover",
      conversationId,
      queryId,
    });

    expect(response).toMatchObject({ type: "failed", recordStatus: "unconfirmed" });
    expect(JSON.stringify(response)).not.toMatch(
      /PRIVATE_QUESTION|PRIVATE_ANSWER|PRIVATE_STORAGE_DIAGNOSTIC_SENTINEL/,
    );
    expect(harness.state.generated).toBe(0);
  });

  it("rechecks META after recovery reconciles an expired known submission", async () => {
    const harness = makeRuntimeHarness(createChatHandler, {
      meta: { conversationId, sub: caller.sub, botId, lastOrdinal: 1 },
    });
    seedHiddenSnapshot(harness, startPayload, {
      status: "in_progress",
      stage: "admitted",
      resultDeadlineAt: fixedNow - 1,
    });
    const key = `${caller.sub}/${botId}/${queryId}`;
    let reconciled = false;
    harness.store.reconcileTurn = vi.fn(async () => {
      reconciled = true;
      harness.state.calls.push(["reconcileTurn"]);
      harness.state.meta = { ...harness.state.meta, hiddenAt: "bad-marker" };
      const submission = harness.state.submissions.get(key);
      submission.status = "failed";
      submission.stage = "failed";
      return clone(submission);
    });

    const response = await invoke(harness, {
      version: 2,
      operation: "recover",
      conversationId,
      queryId,
    });

    assertHiddenFailure(response);
    expect(harness.store.reconcileTurn).toHaveBeenCalledTimes(1);
    expect(reconciled).toBe(true);
    const reconcileIndex = harness.state.calls.findIndex(([name]) => name === "reconcileTurn");
    expect(reconcileIndex).toBeGreaterThanOrEqual(0);
    expect(harness.state.calls.slice(reconcileIndex + 1).some(([name]) => name === "getMeta")).toBe(
      true,
    );
  });

  it("checks a snapshot found by rejectAfterSubmissionLookup before returning it", async () => {
    const request = messagePayload();
    const harness = makeRuntimeHarness(createChatHandler, {
      profile: null,
      meta: { conversationId, sub: caller.sub, botId, lastOrdinal: request.baseOrdinal },
    });
    const saved = seedHiddenSnapshot(harness, request);
    let submissionReads = 0;
    let snapshotFound = false;
    let checkedMetaAfterSnapshot = false;
    harness.store.getMeta = vi.fn(async (input) => {
      harness.state.calls.push(["getMeta", clone(input)]);
      if (snapshotFound) {
        checkedMetaAfterSnapshot = true;
        return {
          conversationId,
          sub: caller.sub,
          botId,
          lastOrdinal: request.baseOrdinal,
          hiddenAt: "bad-marker",
        };
      }
      return { conversationId, sub: caller.sub, botId, lastOrdinal: request.baseOrdinal };
    });
    harness.store.getSubmission = vi.fn(async (input) => {
      harness.state.calls.push(["getSubmission", clone(input)]);
      submissionReads += 1;
      if (submissionReads === 1) return null;
      snapshotFound = true;
      return clone(saved);
    });

    const response = terminal(await invoke(harness, request));

    assertHiddenFailure(response);
    expect(submissionReads).toBeGreaterThanOrEqual(2);
    expect(snapshotFound).toBe(true);
    expect(checkedMetaAfterSnapshot).toBe(true);
    expect(harness.state.prepareInputs).toHaveLength(0);
    expect(harness.state.countInputs).toHaveLength(0);
    expect(harness.state.admittedTurns).toHaveLength(0);
  });

  it("rejects a follow-up before auxiliary work when its META is hidden", async () => {
    const request = messagePayload();
    const harness = makeRuntimeHarness(createChatHandler, {
      meta: {
        conversationId,
        sub: caller.sub,
        botId,
        lastOrdinal: request.baseOrdinal,
        hiddenAt: "2026-10-24T12:00:00.000Z",
      },
    });

    const response = terminal(await invoke(harness, request));

    assertHiddenFailure(response);
    expect(harness.state.profileReads).toBe(0);
    expect(harness.state.calls.map(([name]) => name)).not.toContain("readContext");
    expect(harness.state.calls.map(([name]) => name)).not.toContain("readQuota");
    expect(harness.state.prepareInputs).toHaveLength(0);
    expect(harness.state.countInputs).toHaveLength(0);
    expect(harness.state.admittedTurns).toHaveLength(0);
    expect(harness.state.generated).toBe(0);
  });

  it("does not admit or generate when the atomic continuation check loses to hide", async () => {
    const request = messagePayload();
    const visibleMeta = {
      conversationId,
      sub: caller.sub,
      botId,
      lastOrdinal: request.baseOrdinal,
    };
    const harness = makeRuntimeHarness(createChatHandler, { meta: visibleMeta });
    const attempted = [];
    harness.store.continueTurn = vi.fn(async (input) => {
      attempted.push(clone(input));
      harness.state.meta = { ...visibleMeta, hiddenAt: "2026-10-24T12:00:00.000Z" };
      throw Object.assign(new Error("conversation hidden at admission"), {
        code: "conversation_hidden",
      });
    });
    const quotaBefore = clone(harness.state.quota);

    const response = terminal(await invoke(harness, request));

    assertHiddenFailure(response);
    expect(attempted).toHaveLength(1);
    expect(harness.state.admittedTurns).toHaveLength(0);
    expect(harness.state.quota).toEqual(quotaBefore);
    expect(harness.state.generated).toBe(0);
    expect(JSON.stringify(harness.state.submissions)).not.toContain(otherQueryId);
  });

  it("keeps an admitted producer durable after its observer disconnects and blocks new recovery", async () => {
    const appendEntered = deferred();
    const releaseAppend = deferred();
    const harness = makeRuntimeHarness(createChatHandler);
    const appendChunk = harness.store.appendChunk;
    harness.store.appendChunk = vi.fn(async (input) => {
      appendEntered.resolve();
      await releaseAppend.promise;
      await appendChunk(input);
    });
    let activeTasks = 0;
    let nextTaskId = 0;
    const tasks = {
      addAsyncTask: vi.fn(() => {
        activeTasks += 1;
        nextTaskId += 1;
        return nextTaskId;
      }),
      completeAsyncTask: vi.fn(() => {
        activeTasks -= 1;
        return true;
      }),
    };
    const invocationHandler = createChatInvocationHandler(harness.handler, tasks);

    let stream;
    try {
      const response = await invocationHandler.process(startPayload, makeContext());
      stream = response[Symbol.asyncIterator]();
      expect((await stream.next()).value).toMatchObject({
        event: "accepted",
        data: { type: "accepted", queryId },
      });
      await appendEntered.promise;
      expect(activeTasks).toBe(1);

      await stream.return();
      harness.state.meta = { ...harness.state.meta, hiddenAt: "2026-10-24T12:00:00.000Z" };
      const denied = await invocationHandler.process(
        { version: 2, operation: "recover", conversationId, queryId },
        makeContext(),
      );
      assertHiddenFailure(denied);
      expect(activeTasks).toBe(1);
      const persistedWhileHidden = await harness.store.getSubmission({
        sub: caller.sub,
        botId,
        queryId,
      });
      expect(persistedWhileHidden).toMatchObject({
        status: "in_progress",
      });

      releaseAppend.resolve();
      await vi.waitFor(() =>
        expect(harness.state.submissions.get(`${caller.sub}/${botId}/${queryId}`)?.status).toBe(
          "completed",
        ),
      );
      await vi.waitFor(() => expect(activeTasks).toBe(0));
      expect(harness.state.submissions.get(`${caller.sub}/${botId}/${queryId}`).answer).toBe(
        "Actividad lista para aplicar.",
      );
      expect(harness.state.meta.hiddenAt).toBe("2026-10-24T12:00:00.000Z");
      expect(harness.store.completeTurn).toHaveBeenCalledTimes(1);
      expect(tasks.completeAsyncTask).toHaveBeenCalledTimes(1);
    } finally {
      releaseAppend.resolve();
      await stream?.return?.();
    }
  });
});
