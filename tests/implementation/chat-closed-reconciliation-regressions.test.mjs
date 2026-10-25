import { describe, expect, it, vi } from "vitest";
import { createChatHandler } from "../../runtime/chat.ts";
import { createContextPreparer } from "../../runtime/context.ts";
import {
  makeRuntimeHarness,
  invoke,
  startPayload,
  caller,
  botId,
  conversationId,
  fixedNow,
} from "../acceptance/helpers/documents-runtime-harness.mjs";

describe("a continuation after reconciling an expired invocation", () => {
  it("rejects a newly closed conversation before any auxiliary work", async () => {
    const references = Array.from({ length: 6 }, (_, index) => ({
      ordinal: index + 1,
      queryId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    const messages = references.flatMap(({ ordinal }) => [
      { role: "user", content: [{ text: `Pregunta ${ordinal}.` }] },
      { role: "assistant", content: [{ text: `Material ${ordinal}.` }] },
    ]);
    const countSummaryInput = vi.fn(async () => ({ inputTokens: 128_000 }));
    const summarize = vi.fn(async function* () {
      yield { type: "text", text: "Material confirmado del prefijo." };
      yield { type: "result", stopReason: "end_turn" };
    });
    const prepareContext = createContextPreparer({
      now: () => fixedNow,
      countInputTokens: countSummaryInput,
      summarize,
    });
    const expiredQueryId = "10000000-0000-4000-8000-000000000007";
    const app = makeRuntimeHarness(
      (dependencies) => createChatHandler({ ...dependencies, prepareContext }),
      {
        meta: {
          conversationId,
          sub: caller.sub,
          botId,
          lastOrdinal: 7,
          activeQueryId: expiredQueryId,
          closed: false,
        },
        contextMessages: messages,
        contextReferences: references,
      },
    );
    app.state.seedSubmission(
      { ...startPayload, queryId: expiredQueryId, operation: "message", baseOrdinal: 6 },
      {
        status: "in_progress",
        stage: "invocation_claimed",
        resultDeadlineAt: fixedNow - 1,
      },
    );
    app.store.reconcileTurn = vi.fn(async () => {
      app.state.meta.closed = true;
      delete app.state.meta.activeQueryId;
      return null;
    });
    const continueTurn = vi.spyOn(app.store, "continueTurn").mockImplementation(async () => {
      throw Object.assign(new Error("The durable conversation is closed."), {
        code: "conversation_busy",
      });
    });
    const readContext = vi.spyOn(app.store, "readContext");
    const result = await invoke(app, {
      ...startPayload,
      operation: "message",
      baseOrdinal: 7,
      text: "Continuá este material.",
    });

    expect(app.store.reconcileTurn).toHaveBeenCalledOnce();
    expect(result).toEqual([
      expect.objectContaining({
        type: "failed",
        code: "conversation_closed",
        recordStatus: "not_admitted",
        queryId: startPayload.queryId,
        canContinue: false,
      }),
    ]);
    expect(readContext).not.toHaveBeenCalled();
    expect(countSummaryInput).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(app.state.prepareInputs).toHaveLength(0);
    expect(app.state.countInputs).toHaveLength(0);
    expect(continueTurn).not.toHaveBeenCalled();
    expect(app.state.admittedTurns).toHaveLength(0);
  });
});
