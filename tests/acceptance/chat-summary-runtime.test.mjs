import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatHandler } from "../../runtime/chat.ts";
import {
  botId,
  caller,
  clone,
  conversationId,
  fixedNow,
  invoke,
  makeContext,
  makeRuntimeHarness,
  queryId,
  quotaView,
  startPayload,
  terminal,
} from "./helpers/documents-runtime-harness.mjs";
import { extractOriginalRequestText } from "./helpers/model-input-text.mjs";

const modelId = "global.anthropic.claude-sonnet-4-6";
const summaryId = "a0ceeb6c-8600-47a8-8e92-b3d52a74d40d";
const reference = (ordinal) => ({
  ordinal,
  queryId: `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
});
const references = Array.from({ length: 6 }, (_, index) => reference(index + 1));
const messages = references.flatMap(({ ordinal }) => [
  { role: "user", content: [{ text: `Original question ${ordinal}.` }] },
  { role: "assistant", content: [{ text: `Original answer ${ordinal}.` }] },
]);
const candidate = {
  version: 1,
  summaryId,
  throughOrdinal: 2,
  sourceReferences: references.slice(0, 2),
  text: "PRIVATE_SUMMARY_TEXT: ORILLA; grupos de tres; papel; rúbrica con tres criterios.",
  modelId,
  revision: "reviewed-revision-123",
  preparedAt: fixedNow,
  inputTokens: 231,
  countRequestId: "safe-summary-count-request",
  requestId: "safe-summary-generation-request",
};
const snapshot = {
  version: 1,
  summary: { summaryId, throughOrdinal: 2 },
  recentReferences: references.slice(2),
};
const preparedMessages = clone(messages.slice(4));
preparedMessages[0].content.unshift({
  text: `<resumen_contexto_json>\n${JSON.stringify(candidate.text)}\n</resumen_contexto_json>`,
});
const continuation = {
  ...startPayload,
  operation: "message",
  baseOrdinal: 6,
  text: "Pasala a 60 minutos; mantené los grupos y la rúbrica.",
};
const meta = {
  conversationId,
  sub: caller.sub,
  botId,
  lastOrdinal: 6,
  closed: false,
};

function harness({ prepareContext, storedSummary, ...options } = {}) {
  let state;
  const prepare = vi.fn(async (input, context) => {
    state.calls.push(["prepareContext"]);
    if (prepareContext) return prepareContext(input, context, state);
    return {
      messages: clone(preparedMessages),
      references: clone(snapshot.recentReferences),
      contextSnapshot: clone(snapshot),
      summaryCandidate: clone(candidate),
    };
  });
  const app = makeRuntimeHarness(
    (dependencies) => createChatHandler({ ...dependencies, prepareContext: prepare }),
    { meta, contextMessages: messages, contextReferences: references, ...options },
  );
  state = app.state;
  if (storedSummary) {
    const read = app.store.readContext;
    app.store.readContext = async (input) => ({
      ...(await read(input)),
      summary: clone(storedSummary),
    });
  }
  return { ...app, prepareContext: prepare };
}

const withoutGenerationControls = (input) => {
  const result = clone(input);
  delete result.cancelSignal;
  delete result.resultDeadlineAt;
  return result;
};

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("prepared summary context in the conversation Runtime", () => {
  it("starts another conversation with the current profile and no summary or messages from previous work", async () => {
    const emptySnapshot = { version: 1, recentReferences: [] };
    const app = harness({
      meta: null,
      contextMessages: [],
      contextReferences: [],
      prepareContext: async () => ({
        messages: [],
        references: [],
        contextSnapshot: emptySnapshot,
      }),
    });

    const response = await invoke(app, startPayload);

    expect(terminal(response)).toMatchObject({ type: "completed" });
    expect(app.prepareContext).toHaveBeenCalledTimes(1);
    const [input, context] = app.prepareContext.mock.calls[0];
    expect(input.messages).toEqual([]);
    expect(input.profileSnapshot).toMatchObject({ sub: caller.sub, botId });
    expect(context.references).toEqual([]);
    expect(context.summary).toBeUndefined();
    expect(app.state.prepareInputs[0].messages).toEqual([]);
    expect(app.state.admittedTurns[0].contextSnapshot).toEqual(emptySnapshot);
    expect(app.state.admittedTurns[0].summaryCandidate).toBeUndefined();
  });

  it("prepares after access/profile/quota and shares one captured representation with documents, final count, admission and generation", async () => {
    const app = harness();
    const response = await invoke(app, continuation);

    expect(terminal(response)).toMatchObject({ type: "completed" });
    expect(app.prepareContext).toHaveBeenCalledTimes(1);
    const [input, context] = app.prepareContext.mock.calls[0];
    expect(input).toMatchObject({ text: continuation.text, messages, modelId });
    expect(input.profileSnapshot).toMatchObject({ sub: caller.sub, botId });
    expect(context.references).toEqual(references);
    const order = app.state.calls.map(([name]) => name);
    for (const prior of ["hasMember", "getMeta", "getProfile", "readContext", "readQuota"]) {
      expect(order.indexOf(prior)).toBeLessThan(order.indexOf("prepareContext"));
    }
    expect(order.indexOf("prepareContext")).toBeLessThan(order.indexOf("prepareDocuments"));
    expect(app.state.prepareInputs[0].messages).toEqual(preparedMessages);
    expect(app.state.countInputs).toHaveLength(1);
    expect(app.state.countInputs[0].messages).toEqual(preparedMessages);
    expect(extractOriginalRequestText(app.state.countInputs[0].text)).toBe(continuation.text);
    expect(app.state.generateInputs).toHaveLength(1);
    expect(withoutGenerationControls(app.state.generateInputs[0])).toEqual(
      app.state.countInputs[0],
    );
    expect(app.state.admittedTurns).toHaveLength(1);
    expect(app.state.admittedTurns[0]).toMatchObject({
      contextSnapshot: snapshot,
      summaryCandidate: candidate,
      contextReferences: snapshot.recentReferences,
      baseOrdinal: 6,
      profileSnapshot: app.state.prepareInputs[0].profileSnapshot,
    });
    expect(app.state.generateInputs[0].resultDeadlineAt).toBe(fixedNow + 3_600_000);
    expect(JSON.stringify(app.state.prepareInputs[0].messages)).not.toContain(
      "Original question 1.",
    );
    expect(messages[0].content[0].text).toBe("Original question 1.");
  });

  it("passes the loaded durable summary to preparation and reuses it without publishing another candidate", async () => {
    const app = harness({
      storedSummary: candidate,
      contextMessages: messages.slice(4),
      contextReferences: references.slice(2),
      prepareContext: async () => ({
        messages: clone(preparedMessages),
        references: clone(snapshot.recentReferences),
        contextSnapshot: clone(snapshot),
      }),
    });

    await invoke(app, continuation);

    expect(app.prepareContext).toHaveBeenCalledTimes(1);
    expect(app.prepareContext.mock.calls[0][1]).toMatchObject({ summary: candidate });
    expect(app.state.admittedTurns[0]).toMatchObject({ contextSnapshot: snapshot });
    expect(app.state.admittedTurns[0].summaryCandidate).toBeUndefined();
    expect(app.state.prepareInputs[0].messages).toEqual(preparedMessages);
  });

  it.each(["repeat", "recover"])(
    "returns a known %s before profile, summary, documents or native counting",
    async (operation) => {
      const app = harness({ profile: null });
      app.state.seedSubmission(continuation, { contextSnapshot: snapshot, summary: candidate });
      const request =
        operation === "recover" ? { version: 2, operation, conversationId, queryId } : continuation;

      const response = await invoke(app, request);

      expect(response).toMatchObject({ status: "completed", queryId });
      expect(app.prepareContext).not.toHaveBeenCalled();
      expect(app.state.profileReads).toBe(0);
      expect(app.state.prepareInputs).toEqual([]);
      expect(app.state.countInputs).toEqual([]);
      expect(app.state.generated).toBe(0);
      expect(JSON.stringify(response)).not.toContain(candidate.text);
      expect(response).not.toHaveProperty("contextSnapshot");
    },
  );

  it.each([
    ["anonymous", {}, { authorization: "" }, "unauthorized"],
    ["nonmember", { member: false }, {}, "access_denied"],
    ["foreign owner", { meta: { ...meta, sub: "another-person" } }, {}, "conversation_unavailable"],
    ["closed", { meta: { ...meta, closed: true } }, {}, "conversation_closed"],
    ["busy", { meta: { ...meta, activeQueryId: queryId } }, {}, "conversation_busy"],
    ["stale base", { meta: { ...meta, lastOrdinal: 7 } }, {}, "stale_base"],
    ["missing profile", { profile: null }, {}, "profile_required"],
    [
      "quota",
      { quota: { ...quotaView, daily: { ...quotaView.daily, used: 20 } } },
      {},
      "quota_exceeded",
    ],
  ])("does no summary work for %s", async (_name, options, auth, code) => {
    const app = harness(options);
    const response = await invoke(app, continuation, makeContext(auth));

    expect(terminal(response)).toMatchObject({ type: "failed", code });
    expect(app.prepareContext).not.toHaveBeenCalled();
    expect(app.state.admittedTurns).toEqual([]);
    expect(app.state.generated).toBe(0);
  });

  it("rejects summary failure safely, keeps the request identity and rechecks SEND before reporting no admission", async () => {
    const privateError = "PRIVATE_CONTEXT_PROVIDER_ERROR";
    const app = harness({
      prepareContext: async () => {
        throw Object.assign(new Error(privateError), {
          stage: "summarization",
          reason: "provider_error",
          requestId: "safe-summary-request-17",
        });
      },
    });

    const response = await invoke(app, continuation);

    expect(terminal(response)).toMatchObject({
      type: "failed",
      code: "context_unavailable",
      recordStatus: "not_admitted",
      queryId,
    });
    expect(app.state.calls.filter(([name]) => name === "getSubmission")).toHaveLength(2);
    expect(app.state.prepareInputs).toEqual([]);
    expect(app.state.countInputs).toEqual([]);
    expect(app.state.admittedTurns).toEqual([]);
    expect(app.state.generated).toBe(0);
    const logs = JSON.stringify([
      console.info.mock.calls,
      console.warn.mock.calls,
      console.error.mock.calls,
    ]);
    for (const privateValue of [privateError, candidate.text, continuation.text]) {
      expect(logs).not.toContain(privateValue);
      expect(JSON.stringify(response)).not.toContain(privateValue);
    }
    expect(logs).toContain("safe-summary-request-17");
    expect(logs).toContain(conversationId);
    expect(logs).toContain(queryId);
  });

  it("rejects a declared context that cannot be read without preparing documents or falling back to an empty history", async () => {
    const app = harness();
    app.store.readContext = async () => {
      throw new Error("PRIVATE_CORRUPT_SUMMARY");
    };

    const response = await invoke(app, continuation);

    expect(terminal(response)).toMatchObject({
      type: "failed",
      code: "context_unavailable",
      recordStatus: "not_admitted",
      queryId,
    });
    expect(app.prepareContext).not.toHaveBeenCalled();
    expect(app.state.prepareInputs).toEqual([]);
    expect(app.state.admittedTurns).toEqual([]);
    expect(app.state.generated).toBe(0);
    expect(JSON.stringify(response)).not.toContain("PRIVATE_CORRUPT_SUMMARY");
  });

  it("returns a compatible winner discovered after summary failure rather than publishing its losing candidate", async () => {
    const app = harness({
      prepareContext: async (_input, _context, state) => {
        state.seedSubmission(continuation, {
          answer: "Winner's original answer.",
          contextSnapshot: snapshot,
          summary: candidate,
        });
        throw new Error("lost race after auxiliary work");
      },
    });

    const response = await invoke(app, continuation);

    expect(response).toMatchObject({ status: "completed", answer: "Winner's original answer." });
    expect(app.state.admittedTurns).toEqual([]);
    expect(app.state.generated).toBe(0);
    expect(app.state.prepareInputs).toEqual([]);
  });

  it("keeps admission unconfirmed when the rejection's final SEND read cannot be completed", async () => {
    const app = harness({
      prepareContext: async () => {
        throw new Error("preparation failed");
      },
    });
    app.state.submissionLookupFailures.add(2);

    const response = await invoke(app, continuation);

    expect(terminal(response)).toMatchObject({
      type: "failed",
      recordStatus: "unconfirmed",
      queryId,
    });
    expect(app.state.admittedTurns).toEqual([]);
    expect(app.state.generated).toBe(0);
  });

  it.each([936_000, 936_001])(
    "still enforces final native capacity after summary at %i input tokens",
    async (inputTokens) => {
      const app = harness({ countInputTokens: async () => ({ inputTokens }) });

      const response = await invoke(app, continuation);

      expect(app.prepareContext).toHaveBeenCalledTimes(1);
      expect(app.state.countInputs).toHaveLength(1);
      expect(app.state.countInputs[0].messages).toEqual(preparedMessages);
      if (inputTokens === 936_000) {
        expect(terminal(response)).toMatchObject({ type: "completed" });
        expect(app.state.generated).toBe(1);
      } else {
        expect(terminal(response)).toMatchObject({
          type: "failed",
          code: "capacity_exceeded",
          recordStatus: "not_admitted",
        });
        expect(app.state.admittedTurns).toEqual([]);
        expect(app.state.generated).toBe(0);
      }
    },
  );
});
