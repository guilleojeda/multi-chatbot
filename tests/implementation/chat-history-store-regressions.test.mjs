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

function chunk(ordinal, queryId, role, index, text) {
  return {
    pk: "CONV#" + conversationId,
    sk:
      "TURN#" +
      String(ordinal).padStart(8, "0") +
      "#" +
      queryId +
      "#" +
      role.toUpperCase() +
      "#" +
      String(index).padStart(8, "0"),
    conversationId,
    ordinal,
    queryId,
    role,
    index,
    text,
  };
}

function queryPrefixPage(command, rows) {
  const input = command.input;
  const prefix = input.ExpressionAttributeValues[":prefix"];
  const matching = rows.filter((item) => item.sk.startsWith(prefix));
  if (input.ScanIndexForward === false) matching.reverse();
  const start = input.ExclusiveStartKey
    ? matching.findIndex((item) => item.sk === input.ExclusiveStartKey.sk) + 1
    : 0;
  const items = matching.slice(start, start + input.Limit);
  const lastIndex = start + items.length - 1;
  return {
    Items: items,
    ...(lastIndex < matching.length - 1
      ? { LastEvaluatedKey: { pk: items.at(-1).pk, sk: items.at(-1).sk } }
      : {}),
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
  it("reads only known turn ordinals instead of evaluating earlier child rows", async () => {
    const meta = makeMeta({ lastOrdinal: 3 });
    const turns = new Map([
      [
        3,
        makeTurn(3, q2, {
          status: "in_progress",
          phase: "invocation_claimed",
          cursor: 0,
          answerManifest: { count: 0, complete: false },
          resultDeadlineAt: Date.parse("2026-10-24T13:00:00.000Z"),
          ownerAttemptId: "attempt-2",
        }),
      ],
      [2, makeTurn(2, q1)],
      [1, makeTurn(1, q1)],
    ]);
    const sends = [];
    const send = vi.fn(async (command) => {
      sends.push(command);
      if (command instanceof GetCommand) {
        const { sk } = command.input.Key;
        return { Item: sk === "META" ? meta : turns.get(Number(sk.slice("TURN#".length))) };
      }
      if (command instanceof QueryCommand) {
        throw new Error("Turn descriptors must not scan child rows.");
      }
      if (command instanceof TransactWriteCommand) return {};
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const store = createStore(send);
    const request = { sub, botId, conversationId, limit: 1 };

    const first = await store.readTurns(request);
    const second = await store.readTurns({ ...request, cursor: first.nextCursor });
    const third = await store.readTurns({ ...request, cursor: second.nextCursor });

    expect([first, second, third].map((page) => page.turns.map(({ ordinal }) => ordinal))).toEqual([
      [3],
      [2],
      [1],
    ]);
    expect([first, second, third].map(({ throughOrdinal }) => throughOrdinal)).toEqual([3, 3, 3]);
    expect(first.turns[0]).toMatchObject({ status: "in_progress", cursor: 0 });
    expect(third.nextCursor).toBeUndefined();
    const turnGets = sends
      .filter((command) => command instanceof GetCommand)
      .map((command) => command.input.Key.sk)
      .filter((sk) => sk !== "META");
    expect(turnGets).toEqual(["TURN#00000003", "TURN#00000002", "TURN#00000001"]);
    expect(sends.filter((command) => command instanceof QueryCommand)).toHaveLength(0);
    expect(JSON.stringify([first, second, third])).not.toMatch(/context|document/i);
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
    const getKeys = [];
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        getKeys.push(command.input.Key.sk);
        return { Item: command.input.Key.sk === "META" ? latestMeta : latestTurn };
      }
      if (command instanceof QueryCommand) {
        throw new Error("Turn descriptors must not scan child rows.");
      }
      throw new Error("Unexpected command " + command.constructor.name);
    });

    const result = await createStore(send).readTurns({ sub, botId, conversationId, limit: 20 });

    expect(result.turns).toMatchObject([{ ordinal: 1, status: "completed" }]);
    expect(result.canContinue).toBe(true);
    expect(result.nextCursor).toBeUndefined();
    expect(getKeys).toEqual(["META", "TURN#00000001"]);
    expect(childRows).toHaveLength(24);
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
    let metaReads = 0;
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return {
          Item:
            command.input.Key.sk === "META"
              ? [firstMeta, withoutLabel][metaReads++]
              : makeTurn(1, q1),
        };
      }
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

  it("uses verified terminal activity for list and turn presentation when META retains admission time", async () => {
    const admittedAt = "2026-10-23T10:00:00.000Z";
    const completedAt = "2026-10-25T10:00:00.000Z";
    const historyOrder = `${completedAt}#${conversationId}`;
    const meta = makeMeta({
      lastOrdinal: 1,
      activeQueryId: undefined,
      activeOwnerAttemptId: undefined,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: admittedAt,
      historyOrder,
      historyLabel: "Legacy completed answer",
    });
    const send = vi.fn(async (command) => {
      if (command instanceof QueryCommand) {
        return {
          Items: [
            {
              pk: meta.pk,
              sk: "META",
              historyOwner: meta.historyOwner,
              historyOrder,
            },
          ],
        };
      }
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? meta : makeTurn(1, q1) };
      }
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const store = createStore(send);

    const listed = await store.listConversations({ sub, botId, limit: 1 });
    const turns = await store.readTurns({ sub, botId, conversationId, limit: 1 });

    expect(listed.conversations[0]).toMatchObject({
      updatedAt: completedAt,
      label: "Legacy completed answer",
    });
    expect(turns).toMatchObject({ updatedAt: completedAt, turns: [{ ordinal: 1 }] });
  });

  it.each([
    ["unknown sentinel", { historyOrder: `0000#${conversationId}` }, undefined],
    [
      "different conversation identity",
      { historyOrder: `2026-10-25T10:00:00.000Z#550e8400-e29b-41d4-a716-446655440001` },
      "2026-10-23T10:00:00.000Z",
    ],
    [
      "foreign history owner",
      {
        historyOrder: `2026-10-25T10:00:00.000Z#${conversationId}`,
        historyOwner: "USER#another-owner#BOT#" + botId,
      },
      "2026-10-23T10:00:00.000Z",
    ],
    [
      "non-canonical timestamp",
      { historyOrder: `2026-02-30T10:00:00.000Z#${conversationId}` },
      undefined,
    ],
  ])(
    "does not present an unowned or invalid history order (%s)",
    async (_label, overrides, expected) => {
      const meta = makeMeta({
        lastOrdinal: 1,
        activeQueryId: undefined,
        activeOwnerAttemptId: undefined,
        createdAt: "not-a-date",
        updatedAt: expected ? expected : undefined,
        ...overrides,
      });
      const send = vi.fn(async (command) => {
        if (command instanceof QueryCommand) {
          return {
            Items: [
              {
                pk: meta.pk,
                sk: "META",
                historyOwner: "USER#" + sub + "#BOT#" + botId,
                historyOrder: `2026-10-25T10:00:00.000Z#${conversationId}`,
              },
            ],
          };
        }
        if (command instanceof GetCommand) {
          return { Item: command.input.Key.sk === "META" ? meta : makeTurn(1, q1) };
        }
        throw new Error("Unexpected command " + command.constructor.name);
      });
      const store = createStore(send);

      const listed = await store.listConversations({ sub, botId, limit: 1 });
      const turns = await store.readTurns({ sub, botId, conversationId, limit: 1 });

      if (expected) {
        expect(listed.conversations[0].updatedAt).toBe(expected);
        expect(turns.updatedAt).toBe(expected);
      } else {
        expect(listed.conversations[0]).not.toHaveProperty("updatedAt");
        expect(turns).not.toHaveProperty("updatedAt");
      }
      expect(listed.conversations[0]).not.toHaveProperty("createdAt");
      expect(turns).not.toHaveProperty("createdAt");
    },
  );

  it("opens when META has unverifiable dates and omits them from presentation", async () => {
    const invalidDateMeta = makeMeta({
      lastOrdinal: 1,
      activeQueryId: undefined,
      activeOwnerAttemptId: undefined,
      createdAt: "not-a-date",
      updatedAt: "",
      historyOrder: "0000#" + conversationId,
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? invalidDateMeta : makeTurn(1, q1) };
      }
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
          return command.input.Key.sk === "META"
            ? {
                Item: makeMeta({
                  closed: entry.closed,
                  activeQueryId: undefined,
                  activeOwnerAttemptId: undefined,
                }),
              }
            : { Item: entry.turn };
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
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? makeMeta() : oldActive };
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
    const legacyChunks = [
      chunk(1, q1, "user", 0, "Pregunta histórica."),
      chunk(1, q1, "assistant", 0, "Prefijo durable "),
      chunk(1, q1, "assistant", 1, "sin confirmar."),
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
              : legacyActive,
        };
      }
      if (command instanceof QueryCommand) {
        return queryPrefixPage(command, legacyChunks);
      }
      throw new Error("Legacy active turns must not be reconciled: " + command.constructor.name);
    });

    const store = createStore(send);
    const result = await store.readTurns({ sub, botId, conversationId, limit: 1 });
    const answer = await store.readText({
      sub,
      botId,
      conversationId,
      ordinal: 1,
      queryId: q1,
      role: "assistant",
      throughCursor: result.turns[0].cursor,
    });

    expect(result).toMatchObject({
      canContinue: false,
      turns: [
        {
          status: "in_progress",
          cursor: 2,
          answerManifest: { count: 0, complete: false },
          failure: { code: "unconfirmable" },
        },
      ],
    });
    expect(answer).toMatchObject({
      chunks: [
        { index: 0, text: "Prefijo durable " },
        { index: 1, text: "sin confirmar." },
      ],
      complete: true,
    });
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(
      false,
    );
  });

  it("paginates a long legacy prefix and rejects gaps while reading it", async () => {
    const legacyActive = makeTurn(1, q1, {
      status: "in_progress",
      phase: "generating",
      answerManifest: { count: 0, complete: false },
    });
    delete legacyActive.cursor;
    delete legacyActive.resultDeadlineAt;
    delete legacyActive.ownerAttemptId;
    const prefixChunks = Array.from({ length: 201 }, (_, index) =>
      chunk(1, q1, "assistant", index, `fragment-${index};`),
    );
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return {
          Item: command.input.Key.sk === "META" ? makeMeta({ lastOrdinal: 1 }) : legacyActive,
        };
      }
      if (command instanceof QueryCommand) {
        return queryPrefixPage(command, prefixChunks);
      }
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const store = createStore(send);
    const turns = await store.readTurns({ sub, botId, conversationId, limit: 1 });
    const loaded = [];
    let cursor;
    let page;
    do {
      page = await store.readText({
        sub,
        botId,
        conversationId,
        ordinal: 1,
        queryId: q1,
        role: "assistant",
        throughCursor: turns.turns[0].cursor,
        ...(cursor ? { cursor } : {}),
      });
      loaded.push(...page.chunks);
      cursor = page.nextCursor;
    } while (cursor);

    expect(turns.turns[0]).toMatchObject({
      status: "in_progress",
      cursor: 201,
      answerManifest: { count: 0, complete: false },
      failure: { code: "unconfirmable" },
    });
    expect(loaded).toHaveLength(201);
    expect(loaded.map(({ index }) => index)).toEqual(
      Array.from({ length: 201 }, (_, index) => index),
    );
    expect(page.complete).toBe(true);

    const gappedTurn = makeTurn(1, q1, {
      status: "in_progress",
      phase: "generating",
      answerManifest: { count: 0, complete: false },
    });
    delete gappedTurn.cursor;
    const gappedChunks = [
      chunk(1, q1, "assistant", 0, "first"),
      chunk(1, q1, "assistant", 2, "third"),
    ];
    const gappedSend = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return {
          Item: command.input.Key.sk === "META" ? makeMeta({ lastOrdinal: 1 }) : gappedTurn,
        };
      }
      if (command instanceof QueryCommand) return queryPrefixPage(command, gappedChunks);
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const gappedStore = createStore(gappedSend);
    const gappedTurns = await gappedStore.readTurns({ sub, botId, conversationId, limit: 1 });
    await expect(
      gappedStore.readText({
        sub,
        botId,
        conversationId,
        ordinal: 1,
        queryId: q1,
        role: "assistant",
        throughCursor: gappedTurns.turns[0].cursor,
      }),
    ).rejects.toMatchObject({ code: "conversation_unavailable" });
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
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? makeMeta() : recordingQuestion };
      }
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
        return {
          Item:
            command.input.Key.sk === "META"
              ? makeMeta({ activeOwnerAttemptId: "different-attempt" })
              : active,
        };
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
      if (command instanceof GetCommand) {
        const sk = command.input.Key.sk;
        const turns = new Map([
          [3, makeTurn(3, q2)],
          [1, makeTurn(1, q1)],
        ]);
        return { Item: sk === "META" ? makeMeta() : turns.get(Number(sk.slice("TURN#".length))) };
      }
      throw new Error("Unexpected command " + command.constructor.name);
    });

    await expect(
      createStore(send).readTurns({ sub, botId, conversationId, limit: 3 }),
    ).rejects.toMatchObject({ code: "conversation_unavailable" });
  });

  it("rejects a missing ordinal when adjacent turn pages are read", async () => {
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        const sk = command.input.Key.sk;
        return {
          Item: sk === "META" ? makeMeta() : sk === "TURN#00000003" ? makeTurn(3, q2) : undefined,
        };
      }
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
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? makeMeta() : corrupted };
      }
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

  it("detects an undercounted immutable question without rejecting a later active answer append", async () => {
    const completed = makeTurn(1, q1, {
      answerManifest: { count: 1, complete: true },
      cursor: 1,
    });
    const questionChunks = [
      chunk(1, q1, "user", 0, "Pregunta conocida."),
      chunk(1, q1, "user", 1, "fragmento omitido."),
    ];
    const questionQueries = [];
    const questionStore = createStore(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? makeMeta({ lastOrdinal: 1 }) : completed };
      }
      if (command instanceof QueryCommand) {
        questionQueries.push(command.input);
        return queryPrefixPage(command, questionChunks);
      }
      throw new Error("Unexpected command " + command.constructor.name);
    });

    await expect(
      questionStore.readText({
        sub,
        botId,
        conversationId,
        ordinal: 1,
        queryId: q1,
        role: "user",
        throughCursor: 1,
      }),
    ).rejects.toMatchObject({ code: "conversation_unavailable" });
    expect(questionQueries).toHaveLength(1);
    expect(questionQueries[0].Limit).toBe(2);

    const active = makeTurn(1, q1, {
      status: "in_progress",
      phase: "invocation_claimed",
      answerManifest: { count: 1, complete: false },
      cursor: 1,
    });
    const assistantChunks = [
      chunk(1, q1, "assistant", 0, "Prefijo congelado."),
      chunk(1, q1, "assistant", 1, "append posterior."),
    ];
    const assistantQueries = [];
    const answerStore = createStore(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "META" ? makeMeta({ lastOrdinal: 1 }) : active };
      }
      if (command instanceof QueryCommand) {
        assistantQueries.push(command.input);
        return queryPrefixPage(command, assistantChunks);
      }
      throw new Error("Unexpected command " + command.constructor.name);
    });
    const answer = await answerStore.readText({
      sub,
      botId,
      conversationId,
      ordinal: 1,
      queryId: q1,
      role: "assistant",
      throughCursor: 1,
    });

    expect(answer).toMatchObject({
      chunks: [{ index: 0, text: "Prefijo congelado." }],
      complete: true,
    });
    expect(assistantQueries).toHaveLength(1);
    expect(assistantQueries[0].Limit).toBe(1);
  });

  it("checks the end of a paginated question manifest without mistaking a terminal key for extra data", async () => {
    function questionReader({ count, extra = false, terminalKey = false }) {
      const turn = makeTurn(1, q1, {
        questionManifest: { count, complete: true },
        answerManifest: { count: 1, complete: true },
        cursor: 1,
      });
      const chunks = Array.from({ length: count + (extra ? 1 : 0) }, (_, index) =>
        chunk(1, q1, "user", index, `question-${index};`),
      );
      const queries = [];
      const store = createStore(async (command) => {
        if (command instanceof GetCommand) {
          return { Item: command.input.Key.sk === "META" ? makeMeta({ lastOrdinal: 1 }) : turn };
        }
        if (command instanceof QueryCommand) {
          queries.push(command.input);
          const result = queryPrefixPage(command, chunks);
          if (
            terminalKey &&
            !command.input.ExclusiveStartKey &&
            result.Items.length === count &&
            result.LastEvaluatedKey === undefined
          ) {
            result.LastEvaluatedKey = {
              pk: result.Items.at(-1).pk,
              sk: result.Items.at(-1).sk,
            };
          }
          return result;
        }
        throw new Error("Unexpected command " + command.constructor.name);
      });
      return { queries, store };
    }

    const exactSixteen = questionReader({ count: 16, terminalKey: true });
    const exactSixteenText = await exactSixteen.store.readText({
      sub,
      botId,
      conversationId,
      ordinal: 1,
      queryId: q1,
      role: "user",
      throughCursor: 16,
    });
    expect(exactSixteenText.chunks).toHaveLength(16);
    expect(exactSixteenText.complete).toBe(true);
    expect(exactSixteen.queries.map(({ Limit }) => Limit)).toEqual([17, 1]);

    const extraSeventeenth = questionReader({ count: 16, extra: true });
    await expect(
      extraSeventeenth.store.readText({
        sub,
        botId,
        conversationId,
        ordinal: 1,
        queryId: q1,
        role: "user",
        throughCursor: 16,
      }),
    ).rejects.toMatchObject({ code: "conversation_unavailable" });
    expect(extraSeventeenth.queries.map(({ Limit }) => Limit)).toEqual([17]);

    const seventeenChunks = questionReader({ count: 17 });
    const firstSeventeen = await seventeenChunks.store.readText({
      sub,
      botId,
      conversationId,
      ordinal: 1,
      queryId: q1,
      role: "user",
      throughCursor: 17,
    });
    expect(firstSeventeen.chunks).toHaveLength(16);
    expect(firstSeventeen.complete).toBe(false);
    const finalPage = await seventeenChunks.store.readText({
      sub,
      botId,
      conversationId,
      ordinal: 1,
      queryId: q1,
      role: "user",
      throughCursor: 17,
      cursor: firstSeventeen.nextCursor,
    });
    expect(finalPage).toMatchObject({
      chunks: [{ index: 16, text: "question-16;" }],
      complete: true,
    });
    expect(seventeenChunks.queries.map(({ Limit }) => Limit)).toEqual([16, 2]);
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
      if (command instanceof QueryCommand)
        throw new Error("Completed empty answers must fail before fragment queries.");
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
    expect(queries).toHaveLength(0);
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
