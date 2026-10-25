import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createHistoryStore } from "../../runtime/history-store.ts";

const sub = "history-reader-regression";
const botId = "bot-history";
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const q1 = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";
const q2 = "b0d7cf70-ae36-49f4-a1b9-2837633a54ca";

function makeMeta(overrides = {}) {
  return {
    pk: "CONV#" + conversationId,
    sk: "META",
    conversationId,
    sub,
    botId,
    lastOrdinal: 3,
    closed: false,
    activeQueryId: q2,
    activeOwnerAttemptId: "attempt-2",
    historyOwner: "USER#" + sub + "#BOT#" + botId,
    historyOrder: "2026-10-24T11:00:00.000Z#" + conversationId,
    historyLabel: "Regression",
    ...overrides,
  };
}

function makeTurn(ordinal, queryId, overrides = {}) {
  const status = overrides.status ?? "completed";
  return {
    pk: "CONV#" + conversationId,
    sk: "TURN#" + String(ordinal).padStart(8, "0"),
    conversationId,
    sub,
    botId,
    ordinal,
    queryId,
    status,
    phase: status === "completed" ? "complete" : "failed",
    cursor: 1,
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: 1, complete: status === "completed" },
    ...overrides,
  };
}

function createStore(send, now = () => Date.parse("2026-10-24T12:00:00.000Z")) {
  return createHistoryStore({
    documentClient: { send },
    tableName: "history-test",
    botId,
    now,
  });
}

describe("history reader regressions", () => {
  it("continues past context and document rows filtered from an evaluated page", async () => {
    const rows = [
      {
        pk: "CONV#" + conversationId,
        sk: "TURN#00000003#DOCUMENT#00000000",
        conversationId,
        ordinal: 3,
        index: 0,
        text: "private document context",
      },
      {
        pk: "CONV#" + conversationId,
        sk: "TURN#00000003#CONTEXT#00000000",
        conversationId,
        ordinal: 3,
        index: 0,
        text: JSON.stringify([{ ordinal: 1, queryId: q1 }]),
      },
      makeTurn(3, q2, {
        status: "in_progress",
        phase: "invocation_claimed",
        cursor: 0,
        answerManifest: { count: 0, complete: false },
        resultDeadlineAt: Date.parse("2026-10-24T13:00:00.000Z"),
        ownerAttemptId: "attempt-2",
      }),
      {
        pk: "CONV#" + conversationId,
        sk: "TURN#00000002#DOCUMENT#00000000",
        conversationId,
        ordinal: 2,
        index: 0,
        text: "older private context",
      },
      makeTurn(2, q1),
    ].sort((left, right) => (right.sk < left.sk ? -1 : right.sk > left.sk ? 1 : 0));
    const sends = [];
    const send = vi.fn(async (command) => {
      sends.push(command);
      if (command instanceof GetCommand) return { Item: makeMeta() };
      if (command instanceof QueryCommand) {
        const input = command.input;
        const startIndex = input.ExclusiveStartKey
          ? rows.findIndex(
              (row) =>
                row.pk === input.ExclusiveStartKey.pk && row.sk === input.ExclusiveStartKey.sk,
            ) + 1
          : 0;
        const evaluated = rows.slice(startIndex, startIndex + input.Limit);
        const lastIndex = startIndex + evaluated.length - 1;
        return {
          Items:
            input.FilterExpression === "attribute_exists(#status)"
              ? evaluated.filter((row) => Object.hasOwn(row, "status"))
              : evaluated,
          ...(lastIndex < rows.length - 1
            ? { LastEvaluatedKey: { pk: "CONV#" + conversationId, sk: rows[lastIndex].sk } }
            : {}),
        };
      }
      if (command instanceof TransactWriteCommand) return {};
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const store = createStore(send);
    const request = { sub, botId, conversationId, limit: 1 };

    const first = await store.readTurns(request);
    expect(first.turns).toEqual([]);
    expect(first.throughOrdinal).toBe(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await store.readTurns({ ...request, cursor: first.nextCursor });
    expect(second.turns).toEqual([]);
    expect(second.nextCursor).toEqual(expect.any(String));
    const third = await store.readTurns({ ...request, cursor: second.nextCursor });
    expect(third.turns).toMatchObject([{ ordinal: 3, status: "in_progress" }]);
    expect(third.throughOrdinal).toBe(3);
    const turnQueries = sends.filter((command) => command instanceof QueryCommand);
    expect(turnQueries).toHaveLength(3);
    expect(
      turnQueries.every(
        (command) => command.input.FilterExpression === "attribute_exists(#status)",
      ),
    ).toBe(true);
    expect(JSON.stringify([first, second, third])).not.toMatch(
      /private document context|older private context/,
    );
  });

  it("does not let latest-turn chunks hide its descriptor on first open", async () => {
    const latestMeta = makeMeta({
      lastOrdinal: 1,
      activeQueryId: undefined,
      activeOwnerAttemptId: undefined,
    });
    const latestTurn = makeTurn(1, q1);
    const childRows = Array.from({ length: 24 }, (_, index) => ({
      pk: "CONV#" + conversationId,
      sk:
        "TURN#00000001#" +
        q1 +
        (index % 4 === 0
          ? "#ASSISTANT#"
          : index % 4 === 1
            ? "#USER#"
            : index % 4 === 2
              ? "#CONTEXT#"
              : "#DOCUMENT#") +
        String(index).padStart(8, "0"),
      conversationId,
      ordinal: 1,
      index,
      text: "private child content",
    }));
    const rows = [...childRows, latestTurn].sort((left, right) =>
      left.sk < right.sk ? 1 : left.sk > right.sk ? -1 : 0,
    );
    const queryInputs = [];
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: latestMeta };
      if (command instanceof QueryCommand) {
        queryInputs.push(command.input);
        const values = command.input.ExpressionAttributeValues;
        const matching = rows.filter(
          (row) =>
            row.pk === values[":pk"] && row.sk >= values[":lower"] && row.sk <= values[":upper"],
        );
        const startIndex = command.input.ExclusiveStartKey
          ? matching.findIndex(
              (row) =>
                row.pk === command.input.ExclusiveStartKey.pk &&
                row.sk === command.input.ExclusiveStartKey.sk,
            ) + 1
          : 0;
        const evaluated = matching.slice(startIndex, startIndex + command.input.Limit);
        const lastIndex = startIndex + evaluated.length - 1;
        return {
          Items: evaluated.filter((row) => Object.hasOwn(row, "status")),
          ...(lastIndex < matching.length - 1
            ? { LastEvaluatedKey: { pk: latestMeta.pk, sk: evaluated.at(-1).sk } }
            : {}),
        };
      }
      throw new Error("Unexpected command " + command.constructor.name);
    });

    const result = await createStore(send).readTurns({ sub, botId, conversationId, limit: 20 });

    expect(result.turns).toMatchObject([{ ordinal: 1, status: "completed" }]);
    expect(result.canContinue).toBe(true);
    expect(result.nextCursor).toBeUndefined();
    expect(queryInputs).toHaveLength(1);
    expect(queryInputs[0].ExpressionAttributeValues[":upper"]).toBe("TURN#00000001");
  });

  it("returns only available presentation metadata from META on the turn page", async () => {
    const firstMeta = makeMeta({
      lastOrdinal: 1,
      activeQueryId: undefined,
      activeOwnerAttemptId: undefined,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-24T11:00:00.000Z",
    });
    const withoutLabel = { ...firstMeta, historyLabel: undefined };
    const metas = [firstMeta, withoutLabel];
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: metas.shift() };
      if (command instanceof QueryCommand) return { Items: [makeTurn(1, q1)] };
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const store = createStore(send);

    const labeled = await store.readTurns({ sub, botId, conversationId, limit: 1 });
    const unlabeled = await store.readTurns({ sub, botId, conversationId, limit: 1 });

    expect(labeled).toMatchObject({
      label: "Regression",
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-24T11:00:00.000Z",
    });
    expect(unlabeled).not.toHaveProperty("label");
    expect(unlabeled).toMatchObject({
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-24T11:00:00.000Z",
    });
  });

  it("opens when META has unverifiable dates and omits them from presentation", async () => {
    const invalidDateMeta = makeMeta({
      lastOrdinal: 1,
      activeQueryId: undefined,
      activeOwnerAttemptId: undefined,
      createdAt: "not-a-date",
      updatedAt: "",
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: invalidDateMeta };
      if (command instanceof QueryCommand) return { Items: [makeTurn(1, q1)] };
      throw new Error("Unexpected command " + command.constructor.name);
    });

    const result = await createStore(send).readTurns({ sub, botId, conversationId, limit: 1 });

    expect(result.canContinue).toBe(true);
    expect(result.turns).toMatchObject([{ ordinal: 1, status: "completed" }]);
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
    expect(invalidDateMeta.createdAt).toBe("not-a-date");
    expect(invalidDateMeta.updatedAt).toBe("");
  });

  it("allows continuation after an open confirmed failure, but not after an uncertain claimed failure", async () => {
    const cases = [
      {
        closed: false,
        expected: true,
        turn: makeTurn(3, q2, {
          status: "failed",
          phase: "failed",
          answerManifest: { count: 1, complete: false },
        }),
      },
      {
        closed: true,
        expected: false,
        turn: makeTurn(3, q2, {
          status: "failed",
          phase: "failed",
          answerManifest: { count: 1, complete: false },
        }),
      },
    ];
    for (const entry of cases) {
      const store = createStore(async (command) => {
        if (command instanceof GetCommand) {
          return {
            Item: makeMeta({
              closed: entry.closed,
              activeQueryId: undefined,
              activeOwnerAttemptId: undefined,
            }),
          };
        }
        if (command instanceof QueryCommand) {
          return { Items: [entry.turn, makeTurn(2, q1), makeTurn(1, q1)] };
        }
        throw new Error("Unexpected command " + command.constructor.name);
      });
      const result = await store.readTurns({ sub, botId, conversationId, limit: 1 });
      expect(result.canContinue).toBe(entry.expected);
      expect(result.closed).toBe(entry.closed);
    }
  });

  it("reports a legacy active turn without recovery identity as unconfirmable without mutation", async () => {
    const oldActive = makeTurn(3, q2, {
      status: "in_progress",
      phase: undefined,
      ownerAttemptId: undefined,
      resultDeadlineAt: undefined,
      cursor: 0,
      answerManifest: { count: 0, complete: false },
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: makeMeta() };
      if (command instanceof QueryCommand) {
        return { Items: [oldActive, makeTurn(2, q1), makeTurn(1, q1)] };
      }
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const result = await createStore(send).readTurns({ sub, botId, conversationId, limit: 1 });
    expect(result.turns.find(({ ordinal }) => ordinal === 3)).toMatchObject({
      status: "in_progress",
      failure: { code: "unconfirmable" },
    });
    expect(result.closed).toBe(false);
    expect(result.canContinue).toBe(false);
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(
      false,
    );
  });

  it("opens the known pre-quota generating phase as unconfirmable without recovery", async () => {
    const legacyActive = makeTurn(1, q1, {
      status: "in_progress",
      phase: "generating",
      cursor: 0,
      answerManifest: { count: 0, complete: false },
    });
    delete legacyActive.cursor;
    delete legacyActive.resultDeadlineAt;
    delete legacyActive.ownerAttemptId;
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return {
          Item: makeMeta({
            lastOrdinal: 1,
            activeQueryId: undefined,
            activeOwnerAttemptId: undefined,
          }),
        };
      }
      if (command instanceof QueryCommand) return { Items: [legacyActive] };
      throw new Error("Legacy active turns must not be reconciled: " + command.constructor.name);
    });

    const result = await createStore(send).readTurns({ sub, botId, conversationId, limit: 1 });

    expect(result).toMatchObject({
      canContinue: false,
      turns: [
        {
          status: "in_progress",
          cursor: 0,
          answerManifest: { count: 0, complete: false },
          failure: { code: "unconfirmable" },
        },
      ],
    });
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(
      false,
    );
  });

  it("does not admit arbitrary or incomplete-question legacy phases", async () => {
    const recordingQuestion = makeTurn(3, q2, {
      status: "in_progress",
      phase: "recording_question",
      cursor: 0,
      questionManifest: { count: 0, complete: false },
      answerManifest: { count: 0, complete: false },
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: makeMeta() };
      if (command instanceof QueryCommand) return { Items: [recordingQuestion] };
      throw new Error("Unexpected command " + command.constructor.name);
    });

    await expect(
      createStore(send).readTurns({ sub, botId, conversationId, limit: 1 }),
    ).rejects.toMatchObject({ code: "conversation_unavailable" });
  });

  it("does not confirm an active turn whose owner attempt disagrees with META", async () => {
    const active = makeTurn(3, q2, {
      status: "in_progress",
      phase: "invocation_claimed",
      ownerAttemptId: "turn-attempt",
      resultDeadlineAt: Date.parse("2026-10-24T13:00:00.000Z"),
      cursor: 0,
      answerManifest: { count: 0, complete: false },
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: makeMeta({ activeOwnerAttemptId: "different-attempt" }) };
      }
      if (command instanceof QueryCommand) {
        return { Items: [active, makeTurn(2, q1), makeTurn(1, q1)] };
      }
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const result = await createStore(send).readTurns({ sub, botId, conversationId, limit: 1 });
    expect(result.turns.find(({ ordinal }) => ordinal === 3)).toMatchObject({
      status: "in_progress",
      failure: { code: "unconfirmable" },
    });
    expect(result.canContinue).toBe(false);
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(
      false,
    );
  });

  it("rejects a missing ordinal within a turn page", async () => {
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: makeMeta() };
      if (command instanceof QueryCommand) return { Items: [makeTurn(3, q2), makeTurn(1, q1)] };
      throw new Error("Unexpected command " + command.constructor.name);
    });

    await expect(
      createStore(send).readTurns({ sub, botId, conversationId, limit: 3 }),
    ).rejects.toMatchObject({ code: "conversation_unavailable" });
  });

  it("rejects a missing ordinal when adjacent turn pages are read", async () => {
    const pages = [
      {
        Items: [makeTurn(3, q2)],
        LastEvaluatedKey: {
          pk: "CONV#" + conversationId,
          sk: "TURN#00000003",
        },
      },
      { Items: [makeTurn(1, q1)] },
    ];
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: makeMeta() };
      if (command instanceof QueryCommand) return pages.shift() ?? {};
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const store = createStore(send);
    const first = await store.readTurns({ sub, botId, conversationId, limit: 1 });
    expect(first.turns.map(({ ordinal }) => ordinal)).toEqual([3]);
    expect(first.nextCursor).toEqual(expect.any(String));

    await expect(
      store.readTurns({ sub, botId, conversationId, limit: 1, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "conversation_unavailable" });
  });

  it.each([
    ["count differs from cursor", { cursor: 0, answerManifest: { count: 1, complete: true } }],
    ["completed manifest is partial", { answerManifest: { count: 1, complete: false } }],
  ])("rejects a descriptor with a corrupt answer manifest (%s)", async (_label, overrides) => {
    const corrupted = makeTurn(3, q2, { ...overrides, status: "completed", phase: "complete" });
    const store = createStore(async (command) => {
      if (command instanceof GetCommand) return { Item: makeMeta() };
      if (command instanceof QueryCommand) return { Items: [corrupted] };
      throw new Error("Unexpected command " + command.constructor.name);
    });
    await expect(store.readTurns({ sub, botId, conversationId, limit: 1 })).rejects.toMatchObject({
      code: "conversation_unavailable",
    });
  });

  it("reads pre-quota turns by deriving a missing cursor and chunk ordinal from canonical data", async () => {
    const legacy = makeTurn(1, q1);
    delete legacy.cursor;
    const legacyChunks = [
      {
        pk: legacy.pk,
        sk: `TURN#00000001#${q1}#USER#00000000`,
        conversationId,
        queryId: q1,
        role: "user",
        index: 0,
        text: "Pregunta histórica íntegra.",
      },
      {
        pk: legacy.pk,
        sk: `TURN#00000001#${q1}#ASSISTANT#00000000`,
        conversationId,
        queryId: q1,
        role: "assistant",
        index: 0,
        text: "Respuesta histórica íntegra.",
      },
    ];
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return {
          Item:
            command.input.Key.sk === "META"
              ? makeMeta({
                  lastOrdinal: 1,
                  activeQueryId: undefined,
                  activeOwnerAttemptId: undefined,
                })
              : legacy,
        };
      }
      if (command instanceof QueryCommand) {
        if (command.input.FilterExpression) return { Items: [legacy] };
        const prefix = command.input.ExpressionAttributeValues[":prefix"];
        return { Items: legacyChunks.filter((chunk) => chunk.sk.startsWith(prefix)) };
      }
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const store = createStore(send);

    const turns = await store.readTurns({ sub, botId, conversationId, limit: 1 });
    const answer = await store.readText({
      sub,
      botId,
      conversationId,
      ordinal: 1,
      queryId: q1,
      role: "assistant",
    });

    expect(turns.turns).toMatchObject([{ ordinal: 1, cursor: 1, status: "completed" }]);
    expect(turns.canContinue).toBe(true);
    expect(answer).toMatchObject({
      chunks: [{ index: 0, text: "Respuesta histórica íntegra." }],
      complete: true,
    });
    expect(legacy).not.toHaveProperty("cursor");
    expect(legacyChunks.every((chunk) => !Object.hasOwn(chunk, "ordinal"))).toBe(true);
  });

  it("rejects an explicit chunk ordinal that disagrees with its canonical key", async () => {
    const legacy = makeTurn(3, q2);
    delete legacy.cursor;
    const contradictoryChunk = {
      pk: legacy.pk,
      sk: `TURN#00000003#${q2}#ASSISTANT#00000000`,
      conversationId,
      ordinal: 2,
      queryId: q2,
      role: "assistant",
      index: 0,
      text: "No debe leerse como válida.",
    };
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? makeMeta() : legacy };
      }
      if (command instanceof QueryCommand) return { Items: [contradictoryChunk] };
      throw new Error("Unexpected command " + command.constructor.name);
    });

    await expect(
      createStore(send).readText({
        sub,
        botId,
        conversationId,
        ordinal: 3,
        queryId: q2,
        role: "assistant",
      }),
    ).rejects.toMatchObject({ code: "conversation_unavailable" });
  });

  it("rejects a completed empty answer before returning a continuation or reading fragments", async () => {
    const emptyCompleted = makeTurn(3, q2, {
      status: "completed",
      phase: "complete",
      cursor: 0,
      answerManifest: { count: 0, complete: true },
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? makeMeta() : emptyCompleted };
      }
      if (command instanceof QueryCommand) {
        if (command.input.FilterExpression) return { Items: [emptyCompleted] };
        throw new Error("Completed empty answers must fail before fragment queries.");
      }
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const store = createStore(send);

    await expect(store.readTurns({ sub, botId, conversationId, limit: 1 })).rejects.toMatchObject({
      code: "conversation_unavailable",
    });
    await expect(
      store.readText({
        sub,
        botId,
        conversationId,
        ordinal: 3,
        queryId: q2,
        role: "assistant",
      }),
    ).rejects.toMatchObject({ code: "conversation_unavailable" });

    const queries = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof QueryCommand);
    expect(queries).toHaveLength(1);
    expect(queries[0].input.FilterExpression).toBe("attribute_exists(#status)");
  });

  it.each([
    ["count differs from cursor", { cursor: 3, answerManifest: { count: 5, complete: true } }],
    ["completed manifest is partial", { answerManifest: { count: 1, complete: false } }],
  ])("rejects corrupt answer metadata before reading text (%s)", async (_label, overrides) => {
    const corrupted = makeTurn(3, q2, { ...overrides, status: "completed", phase: "complete" });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? makeMeta() : corrupted };
      }
      throw new Error(
        "Corrupt descriptor should fail before fragment reads: " + command.constructor.name,
      );
    });
    const store = createStore(send);
    await expect(
      store.readText({ sub, botId, conversationId, ordinal: 3, queryId: q2, role: "assistant" }),
    ).rejects.toMatchObject({ code: "conversation_unavailable" });
  });
});
