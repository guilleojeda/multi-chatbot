import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createAccountStoreAdapter } from "../../api/aws-adapters.ts";
import { createProfileStoreAdapter } from "../../api/profile-store.ts";
import { createChatHandler } from "../../runtime/chat.ts";
import { siteConfig } from "../../config/site.ts";

// The Lambda compositions and account/profile/history adapters are real. This narrow in-memory
// SDK boundary implements only the DynamoDB operations used below; it does not model the native
// DynamoDB transaction/condition engine, which remains a separate verification boundary.
const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DynamoDBDocumentClient: { from: () => transport } };
});

const botId = "docentes";
const sub = "teacher-access-1";
const accountTable = "acceptance-account-access";
const conversationTable = "acceptance-conversations";
const fixedNow = Date.parse("2026-11-11T15:00:00.000Z");
const conversationId = "4f5758ba-b8ac-42f4-94f0-d86c16211011";
const otherConversationId = "4f5758ba-b8ac-42f4-94f0-d86c16211012";
const queryId = "3afba813-851b-4bfd-9ed6-e1c335a61011";
const otherSub = "teacher-access-other";
const accessKey = { pk: `BOT#${botId}#USER#${sub}`, sk: "ACCESS" };
const profileKey = { pk: `BOT#${botId}#USER#${sub}`, sk: "PROFILE" };
const legacyMemberKey = { pk: `BOT#${botId}`, sk: `MEMBER#${sub}` };
const validProfile = {
  ...profileKey,
  sub,
  botId,
  fields: { educationLevels: ["primario"], subjects: ["Matemática"] },
  updatedAt: "2026-11-10T15:00:00.000Z",
};

let accountLambda;
let historyLambda;
let rows;
let accessReadError;
let historyReadError;

function rowKey(table, key) {
  return JSON.stringify([table, key.pk, key.sk]);
}

function seed(key, fields) {
  seedTable(accountTable, key, fields);
}

function seedTable(table, key, fields) {
  rows.set(rowKey(table, key), structuredClone({ ...key, ...fields }));
}

function seedAccess(fields = {}) {
  seed(accessKey, { sub, botId, access: "active", revision: 3, ...fields });
}

function conversationFixture(id, ownerSub = sub) {
  const meta = {
    pk: `CONV#${id}`,
    sk: "META",
    conversationId: id,
    sub: ownerSub,
    botId,
    createdAt: "2026-11-10T14:00:00.000Z",
    updatedAt: "2026-11-10T14:30:00.000Z",
    lastOrdinal: 1,
    closed: false,
    historyOwner: `USER#${ownerSub}#BOT#${botId}`,
    historyOrder: `2026-11-10T14:30:00.000Z#${id}`,
    historyLabel: "Actividad de fracciones",
  };
  const turn = {
    pk: `CONV#${id}`,
    sk: "TURN#00000001",
    conversationId: id,
    sub: ownerSub,
    botId,
    queryId,
    ordinal: 1,
    status: "completed",
    phase: "complete",
    operation: "start",
    baseOrdinal: 0,
    ownerAttemptId: "attempt-history-acceptance",
    requestFingerprint: "fingerprint-history-acceptance",
    resultDeadlineAt: fixedNow + 60_000,
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: 1, complete: true },
    cursor: 1,
  };
  const question = {
    pk: `CONV#${id}`,
    sk: `TURN#00000001#${queryId}#USER#00000000`,
    conversationId: id,
    queryId,
    ordinal: 1,
    role: "user",
    index: 0,
    text: "Prepará una actividad sobre fracciones.",
  };
  const answer = {
    pk: `CONV#${id}`,
    sk: `TURN#00000001#${queryId}#ASSISTANT#00000000`,
    conversationId: id,
    queryId,
    ordinal: 1,
    role: "assistant",
    index: 0,
    text: "Actividad: representá tres cuartos con figuras.",
  };
  seedTable(conversationTable, { pk: meta.pk, sk: meta.sk }, meta);
  seedTable(conversationTable, { pk: turn.pk, sk: turn.sk }, turn);
  seedTable(conversationTable, { pk: question.pk, sk: question.sk }, question);
  seedTable(conversationTable, { pk: answer.pk, sk: answer.sk }, answer);
  return { meta, turn, question, answer };
}

function tableRows(table) {
  return [...rows.entries()]
    .filter(([key]) => key.startsWith(`["${table}",`))
    .map(([, value]) => structuredClone(value));
}

function event(method, path, body, { claims = { sub, token_use: "access" }, query = {} } = {}) {
  const rawQueryString = new URLSearchParams(query).toString();
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString,
    queryStringParameters: query,
    requestContext: {
      http: { method, path },
      authorizer: { jwt: { claims } },
    },
    headers: { authorization: "Bearer externally-validated-access-token" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function body(response) {
  return JSON.parse(response.body);
}

function accountReads() {
  return transport.send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof GetCommand && command.input.TableName === accountTable);
}

function expectAccessRead() {
  expect(accountReads().some((command) => command.input.Key.sk === "ACCESS")).toBe(true);
  expect(accountReads().every((command) => command.input.ConsistentRead === true)).toBe(true);
  expect(accountReads().some((command) => command.input.Key.sk.startsWith("MEMBER#"))).toBe(false);
}

function runtimeDependencies() {
  const accounts = createAccountStoreAdapter({
    documentClient: transport,
    tableName: accountTable,
    now: () => fixedNow,
  });
  const profiles = createProfileStoreAdapter({
    documentClient: transport,
    tableName: accountTable,
  });
  const getSubmission = vi.fn(async () => null);
  const store = {
    getSubmission,
    getMeta: vi.fn(async () => null),
    readQuota: vi.fn(),
    startTurn: vi.fn(),
    continueTurn: vi.fn(),
  };
  const generate = vi.fn();
  return {
    accounts,
    profiles,
    store,
    generate,
    prepareContext: vi.fn(),
    prepareDocuments: vi.fn(),
    countInputTokens: vi.fn(),
    config: {
      botId,
      profile: siteConfig.profile,
      modelId: "global.anthropic.claude-sonnet-4-6",
      revision: "phase9-acceptance",
      systemPrompt: "Asistente docente de prueba.",
    },
    now: () => fixedNow,
  };
}

async function invokeRuntime(dependencies) {
  // Signature validation belongs to AgentCore; the managed authorizer's contract is
  // substituted here. Real account adapter and handler decide the bot permission.
  const payload = Buffer.from(JSON.stringify({ sub, token_use: "access" })).toString("base64url");
  const response = await createChatHandler(dependencies)(
    {
      version: 2,
      operation: "start",
      conversationId,
      queryId,
      baseOrdinal: 0,
      text: "Prepará una actividad sobre fracciones.",
    },
    {
      sessionId: conversationId,
      headers: {
        authorization: `Bearer e30.${payload}.managed-authorizer-contract`,
        "x-amzn-bedrock-agentcore-runtime-session-id": conversationId,
      },
    },
  );
  if (typeof response?.[Symbol.asyncIterator] !== "function") return response;
  const events = [];
  for await (const event of response) events.push(event);
  return events.at(-1);
}

describe("the delivered account, profile, history and Runtime consumers of ACCESS", () => {
  beforeAll(async () => {
    for (const [name, value] of Object.entries({
      BOT_ID: botId,
      USER_POOL_ID: "us-east-1_acceptance",
      CLIENT_ID: "acceptance-bot-client",
      TABLE_NAME: accountTable,
      ACCOUNT_TABLE_NAME: accountTable,
      CONVERSATION_TABLE_NAME: conversationTable,
      HISTORY_INDEX_NAME: "ConversationHistory",
      AWS_REGION: "us-east-1",
    })) {
      vi.stubEnv(name, value);
    }
    accountLambda = (await import("../../api/lambda.ts")).handler;
    historyLambda = (await import("../../api/chat-history-lambda.ts")).handler;
  });

  beforeEach(() => {
    rows = new Map();
    accessReadError = undefined;
    historyReadError = undefined;
    transport.send.mockReset();
    transport.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        if (command.input.Key.sk === "ACCESS" && accessReadError) throw accessReadError;
        return {
          Item: structuredClone(rows.get(rowKey(command.input.TableName, command.input.Key))),
        };
      }
      if (command instanceof PutCommand) {
        const { TableName, Item } = command.input;
        rows.set(rowKey(TableName, Item), structuredClone(Item));
        return {};
      }
      if (command instanceof QueryCommand) {
        if (historyReadError) throw historyReadError;
        const { TableName, IndexName, ExpressionAttributeValues = {}, Limit } = command.input;
        const tableItems = [...rows.entries()]
          .filter(([key]) => JSON.parse(key)[0] === TableName)
          .map(([, value]) => structuredClone(value));
        if (IndexName === "ConversationHistory") {
          const historyOwner = ExpressionAttributeValues[":historyOwner"];
          const Items = tableItems
            .filter((item) => item.sk === "META" && item.historyOwner === historyOwner)
            .sort((left, right) => right.historyOrder.localeCompare(left.historyOrder));
          return { Items: typeof Limit === "number" ? Items.slice(0, Limit) : Items };
        }
        const partition = ExpressionAttributeValues[":pk"];
        const prefix = ExpressionAttributeValues[":prefix"];
        const matched = tableItems
          .filter(
            (item) =>
              item.pk === partition && typeof item.sk === "string" && item.sk.startsWith(prefix),
          )
          .sort((left, right) => left.sk.localeCompare(right.sk));
        const exclusiveKey = command.input.ExclusiveStartKey;
        const start = exclusiveKey
          ? matched.findIndex(
              (item) => item.pk === exclusiveKey.pk && item.sk === exclusiveKey.sk,
            ) + 1
          : 0;
        const Items = typeof Limit === "number" ? matched.slice(start, start + Limit) : matched;
        const hasMore = typeof Limit === "number" && matched.length > start + Limit;
        return {
          Items,
          ...(hasMore && Items.length > 0
            ? { LastEvaluatedKey: { pk: Items.at(-1).pk, sk: Items.at(-1).sk } }
            : {}),
        };
      }
      if (command instanceof UpdateCommand) {
        const {
          TableName,
          Key,
          ExpressionAttributeValues = {},
          UpdateExpression = "",
        } = command.input;
        const key = rowKey(TableName, Key);
        const item = rows.get(key);
        if (
          !item ||
          item.conversationId !== ExpressionAttributeValues[":conversationId"] ||
          item.sub !== ExpressionAttributeValues[":sub"] ||
          item.botId !== ExpressionAttributeValues[":botId"]
        ) {
          throw Object.assign(new Error("conditional update did not match"), {
            name: "ConditionalCheckFailedException",
          });
        }
        item.hiddenAt ??= ExpressionAttributeValues[":hiddenAt"];
        if (UpdateExpression.includes("REMOVE #historyOwner")) delete item.historyOwner;
        rows.set(key, item);
        return { Attributes: { hiddenAt: item.hiddenAt } };
      }
      throw new Error(`Unexpected external operation ${command.constructor.name}`);
    });
  });

  afterAll(() => vi.unstubAllEnvs());

  it("authorizes /account/me from the current ACCESS record and exposes its revision", async () => {
    seedAccess();
    const response = await accountLambda(event("GET", "/api/account/me"));

    expect(response.statusCode).toBe(200);
    expect(body(response)).toEqual({ sub, botId, access: { state: "active", revision: 3 } });
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expectAccessRead();
    expect(transport.send.mock.calls.every(([command]) => command instanceof GetCommand)).toBe(
      true,
    );
  });

  it("keeps /account/me available for a revoked account and reports the current revision", async () => {
    seedAccess({ access: "revoked", revision: 4 });

    const response = await accountLambda(event("GET", "/api/account/me"));

    expect(response.statusCode).toBe(200);
    expect(body(response)).toEqual({ sub, botId, access: { state: "revoked", revision: 4 } });
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expectAccessRead();
  });

  it("does not treat an invitation-only ACCESS row or a legacy MEMBER as a grant", async () => {
    seedAccess({
      access: "none",
      currentInvitation: { hash: "a".repeat(64), expiresAt: fixedNow + 1000 },
    });
    seed(legacyMemberKey, { sub, botId });

    const response = await accountLambda(event("GET", "/api/account/me"));

    expect(response.statusCode).toBe(403);
    expectAccessRead();
  });

  it.each([
    ["invalid state", { access: "unexpected" }],
    ["invalid revision", { revision: "3" }],
    ["different identity", { sub: "another-teacher" }],
  ])(
    "reports unavailable access for %s instead of granting or presenting absence",
    async (_, fields) => {
      seedAccess(fields);
      const response = await accountLambda(event("GET", "/api/account/me"));

      expect(response.statusCode).toBe(503);
      expect(transport.send.mock.calls.every(([command]) => command instanceof GetCommand)).toBe(
        true,
      );
    },
  );

  it("preserves a transient access read failure as a retryable account failure", async () => {
    seedAccess();
    accessReadError = new Error("DynamoDB temporarily unavailable");

    const response = await accountLambda(event("GET", "/api/account/me"));

    expect(response.statusCode).toBe(503);
    expect(body(response).code).toBe("TRY_AGAIN");
  });

  it("reads the existing professional profile after authorizing ACCESS", async () => {
    seedAccess();
    seed(profileKey, validProfile);

    const response = await accountLambda(event("GET", "/api/profile"));

    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({ sub, botId, profile: { fields: validProfile.fields } });
    expectAccessRead();
  });

  it("saves and rereads a profile through the Lambda without changing ACCESS", async () => {
    seedAccess();
    const accessBefore = structuredClone(rows.get(rowKey(accountTable, accessKey)));
    const fields = { educationLevels: ["secundario"], subjects: ["Lengua"] };

    const saved = await accountLambda(
      event("PUT", "/api/profile", { fields, responsePreferenceIds: [] }),
    );
    const reloaded = await accountLambda(event("GET", "/api/profile"));

    expect(saved.statusCode).toBe(200);
    expect(reloaded.statusCode).toBe(200);
    expect(body(reloaded)).toMatchObject({ sub, botId, profile: { fields } });
    expect(rows.get(rowKey(accountTable, accessKey))).toEqual(accessBefore);
    expect(
      transport.send.mock.calls.filter(([command]) => command instanceof PutCommand),
    ).toHaveLength(1);
    expectAccessRead();
  });

  it("allows a revoked account to read and save its profile without restoring access or changing history or quota", async () => {
    seedAccess({ access: "revoked", revision: 4 });
    const accessBefore = structuredClone(rows.get(rowKey(accountTable, accessKey)));
    const conversation = conversationFixture(conversationId);
    const quotaRows = [
      {
        pk: `USER#${sub}#BOT#${botId}`,
        sk: "USAGE#DAY#2026-11-11",
        used: 6,
        period: "2026-11-11",
      },
      {
        pk: `USER#${sub}#BOT#${botId}`,
        sk: "USAGE#MONTH#2026-11",
        used: 41,
        period: "2026-11",
      },
      { pk: `BOT#${botId}`, sk: "QUOTA#POLICY", dailyLimit: 20, monthlyLimit: 200, revision: 1 },
    ];
    for (const item of quotaRows) {
      seedTable(conversationTable, { pk: item.pk, sk: item.sk }, item);
    }
    const historyBefore = tableRows(conversationTable);
    const fields = { educationLevels: ["secundario"], subjects: ["Lengua"] };

    const absent = await accountLambda(event("GET", "/api/profile"));
    const saved = await accountLambda(
      event("PUT", "/api/profile", { fields, responsePreferenceIds: [] }),
    );
    const reloaded = await accountLambda(event("GET", "/api/profile"));

    expect(absent.statusCode).toBe(200);
    expect(body(absent)).toEqual({ sub, botId, profile: null });
    expect(saved.statusCode).toBe(200);
    expect(body(saved)).toMatchObject({ sub, botId, profile: { fields } });
    expect(reloaded.statusCode).toBe(200);
    expect(body(reloaded)).toMatchObject({ sub, botId, profile: { fields } });
    expect(rows.get(rowKey(accountTable, accessKey))).toEqual(accessBefore);
    expect(tableRows(conversationTable)).toEqual(historyBefore);
    expect(conversation.meta.historyOwner).toBe(`USER#${sub}#BOT#${botId}`);
    const profilePuts = transport.send.mock.calls.filter(
      ([command]) => command instanceof PutCommand,
    );
    expect(profilePuts).toHaveLength(1);
    expect(profilePuts[0][0].input.TableName).toBe(accountTable);
    expectAccessRead();
  });

  it("denies profile reads before loading personal data when ACCESS has no grant", async () => {
    seedAccess({ access: "none" });
    seed(legacyMemberKey, { sub, botId });
    seed(profileKey, validProfile);

    const response = await accountLambda(event("GET", "/api/profile"));

    expect(response.statusCode).toBe(403);
    expect(accountReads().some((command) => command.input.Key.sk === "PROFILE")).toBe(false);
  });

  it("denies none access for account, profile writes and history before reading user data", async () => {
    seedAccess({ access: "none" });
    seed(legacyMemberKey, { sub, botId });
    seed(profileKey, validProfile);
    conversationFixture(conversationId);

    const account = await accountLambda(event("GET", "/api/account/me"));
    const profile = await accountLambda(event("GET", "/api/profile"));
    const saved = await accountLambda(
      event("PUT", "/api/profile", {
        fields: { educationLevels: ["secundario"], subjects: ["Lengua"] },
        responsePreferenceIds: [],
      }),
    );
    const history = await historyLambda(event("GET", "/api/chat/conversations"));

    expect([account.statusCode, profile.statusCode, saved.statusCode, history.statusCode]).toEqual([
      403, 403, 403, 403,
    ]);
    expect(accountReads().some((command) => command.input.Key.sk === "PROFILE")).toBe(false);
    expect(transport.send.mock.calls.some(([command]) => command instanceof PutCommand)).toBe(
      false,
    );
    expect(
      transport.send.mock.calls.some(
        ([command]) =>
          command instanceof QueryCommand && command.input.IndexName === "ConversationHistory",
      ),
    ).toBe(false);
    expectAccessRead();
  });

  it("connects the history Lambda to ACCESS without requiring a complete profile", async () => {
    seedAccess();

    const response = await historyLambda(event("GET", "/api/chat/conversations"));

    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({ version: 1, conversations: [] });
    expectAccessRead();
    expect(accountReads().some((command) => command.input.Key.sk === "PROFILE")).toBe(false);
    expect(transport.send.mock.calls.some(([command]) => command instanceof QueryCommand)).toBe(
      true,
    );
  });

  it("lets a revoked account read, copy and hide only its own durable history, then keeps it hidden after access is restored", async () => {
    seedAccess({ access: "revoked", revision: 4 });
    const owned = conversationFixture(conversationId);
    const foreign = conversationFixture(otherConversationId, otherSub);
    const foreignBefore = structuredClone(
      rows.get(rowKey(conversationTable, { pk: foreign.meta.pk, sk: "META" })),
    );
    const nonMetaBeforeHide = tableRows(conversationTable).filter((item) => item.sk !== "META");

    const list = await historyLambda(event("GET", "/api/chat/conversations"));
    const meta = await historyLambda(event("GET", `/api/chat/conversations/${conversationId}`));
    const turns = await historyLambda(
      event("GET", `/api/chat/conversations/${conversationId}/turns`),
    );
    const question = await historyLambda(
      event("GET", `/api/chat/conversations/${conversationId}/turns/1/text`, undefined, {
        query: { role: "user", queryId, sub: otherSub, botId: "other-bot" },
      }),
    );
    const answer = await historyLambda(
      event("GET", `/api/chat/conversations/${conversationId}/turns/1/text`, undefined, {
        query: { role: "assistant", queryId },
      }),
    );
    const foreignMeta = await historyLambda(
      event("GET", `/api/chat/conversations/${otherConversationId}`),
    );
    const foreignTurns = await historyLambda(
      event("GET", `/api/chat/conversations/${otherConversationId}/turns`),
    );
    const foreignText = await historyLambda(
      event("GET", `/api/chat/conversations/${otherConversationId}/turns/1/text`, undefined, {
        query: { role: "user", queryId, sub: otherSub, botId: "other-bot" },
      }),
    );
    const foreignHide = await historyLambda(
      event("POST", `/api/chat/conversations/${otherConversationId}/hide`, { sub: otherSub }),
    );

    expect([list, meta, turns, question, answer].map(({ statusCode }) => statusCode)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(body(list).conversations).toEqual([
      expect.objectContaining({ conversationId, label: "Actividad de fracciones" }),
    ]);
    expect(body(meta)).toMatchObject({ conversationId, label: "Actividad de fracciones" });
    expect(body(turns).turns).toEqual([
      expect.objectContaining({ ordinal: 1, queryId, status: "completed" }),
    ]);
    expect(body(question).chunks).toEqual([
      { index: 0, text: "Prepará una actividad sobre fracciones." },
    ]);
    expect(body(answer).chunks).toEqual([
      { index: 0, text: "Actividad: representá tres cuartos con figuras." },
    ]);
    expect([
      foreignMeta.statusCode,
      foreignTurns.statusCode,
      foreignText.statusCode,
      foreignHide.statusCode,
    ]).toEqual([403, 403, 403, 404]);
    expect(
      JSON.stringify([foreignMeta, foreignTurns, foreignText, foreignHide].map(body)),
    ).not.toContain("Prepará una actividad sobre fracciones.");
    expect(rows.get(rowKey(conversationTable, { pk: foreign.meta.pk, sk: "META" }))).toEqual(
      foreignBefore,
    );
    expect(
      transport.send.mock.calls
        .map(([command]) => command)
        .filter((command) => command instanceof QueryCommand && command.input.IndexName)
        .every(
          (command) =>
            command.input.ExpressionAttributeValues[":historyOwner"] === `USER#${sub}#BOT#${botId}`,
        ),
    ).toBe(true);
    expectAccessRead();
    expect(accountReads().some((command) => command.input.Key.sk === "PROFILE")).toBe(false);

    const hidden = await historyLambda(
      event("POST", `/api/chat/conversations/${conversationId}/hide`, { sub: otherSub }),
    );
    const hiddenMeta = rows.get(rowKey(conversationTable, { pk: owned.meta.pk, sk: "META" }));
    const hiddenList = await historyLambda(event("GET", "/api/chat/conversations"));
    const hiddenDetails = await historyLambda(
      event("GET", `/api/chat/conversations/${conversationId}`),
    );
    const hiddenTurns = await historyLambda(
      event("GET", `/api/chat/conversations/${conversationId}/turns`),
    );
    const hiddenText = await historyLambda(
      event("GET", `/api/chat/conversations/${conversationId}/turns/1/text`, undefined, {
        query: { role: "user", queryId },
      }),
    );

    expect(hidden.statusCode).toBe(200);
    expect(body(hidden)).toMatchObject({ version: 1, conversationId });
    expect(Number.isFinite(Date.parse(body(hidden).hiddenAt))).toBe(true);
    expect(hiddenMeta).toMatchObject({ sub, botId, hiddenAt: body(hidden).hiddenAt });
    expect(hiddenMeta.historyOwner).toBeUndefined();
    expect(rows.get(rowKey(accountTable, accessKey))).toMatchObject({ access: "revoked" });
    expect(tableRows(conversationTable).filter((item) => item.sk !== "META")).toEqual(
      nonMetaBeforeHide,
    );
    expect(body(hiddenList).conversations).toEqual([]);
    expect([hiddenDetails.statusCode, hiddenTurns.statusCode, hiddenText.statusCode]).toEqual([
      404, 404, 404,
    ]);
    expect(body(hiddenDetails).code).toBe("CONVERSATION_HIDDEN");
    expect(rows.get(rowKey(conversationTable, { pk: foreign.meta.pk, sk: "META" }))).toEqual(
      foreignBefore,
    );

    seedAccess({ access: "active", revision: 5 });
    const restoredList = await historyLambda(event("GET", "/api/chat/conversations"));
    const restoredDetails = await historyLambda(
      event("GET", `/api/chat/conversations/${conversationId}`),
    );

    expect(restoredList.statusCode).toBe(200);
    expect(body(restoredList).conversations).toEqual([]);
    expect(restoredDetails.statusCode).toBe(404);
    expect(body(restoredDetails).code).toBe("CONVERSATION_HIDDEN");
  });

  it("keeps transient access and history failures as 503 responses instead of empty history", async () => {
    seedAccess();
    accessReadError = new Error("DynamoDB access timeout");

    const accessFailure = await historyLambda(event("GET", "/api/chat/conversations"));

    expect(accessFailure.statusCode).toBe(503);
    expect(body(accessFailure)).not.toEqual({ version: 1, conversations: [] });
    expect(JSON.stringify(body(accessFailure))).not.toContain("DynamoDB access timeout");
    expect(transport.send.mock.calls.some(([command]) => command instanceof QueryCommand)).toBe(
      false,
    );

    accessReadError = undefined;
    historyReadError = new Error("DynamoDB history timeout");
    const historyFailure = await historyLambda(event("GET", "/api/chat/conversations"));

    expect(historyFailure.statusCode).toBe(503);
    expect(body(historyFailure)).not.toEqual({ version: 1, conversations: [] });
    expect(body(historyFailure).code).toBe("HISTORY_UNAVAILABLE");
    expect(JSON.stringify(body(historyFailure))).not.toContain("DynamoDB history timeout");
  });

  it("rejects history access before querying conversations for an unaccepted invitation", async () => {
    seedAccess({ access: "none" });
    seed(legacyMemberKey, { sub, botId });

    const response = await historyLambda(event("GET", "/api/chat/conversations"));

    expect(response.statusCode).toBe(403);
    expect(transport.send.mock.calls.some(([command]) => command instanceof QueryCommand)).toBe(
      false,
    );
  });

  it("lets a newly authorized Runtime request reach the existing profile requirement", async () => {
    seedAccess();
    const dependencies = runtimeDependencies();

    const response = await invokeRuntime(dependencies);

    expect(response).toMatchObject({
      type: "failed",
      code: "profile_required",
      recordStatus: "not_admitted",
    });
    expectAccessRead();
    expect(dependencies.store.readQuota).not.toHaveBeenCalled();
    expect(dependencies.store.startTurn).not.toHaveBeenCalled();
    expect(dependencies.prepareContext).not.toHaveBeenCalled();
    expect(dependencies.prepareDocuments).not.toHaveBeenCalled();
    expect(dependencies.generate).not.toHaveBeenCalled();
  });

  it("does not load a Runtime submission or profile from a legacy membership alone", async () => {
    seedAccess({ access: "none" });
    seed(legacyMemberKey, { sub, botId });
    const dependencies = runtimeDependencies();

    const response = await invokeRuntime(dependencies);

    expect(response).toMatchObject({
      type: "failed",
      code: "access_denied",
      recordStatus: "not_admitted",
    });
    expect(dependencies.store.getSubmission).not.toHaveBeenCalled();
    expect(accountReads().some((command) => command.input.Key.sk === "PROFILE")).toBe(false);
    expect(dependencies.prepareContext).not.toHaveBeenCalled();
    expect(dependencies.prepareDocuments).not.toHaveBeenCalled();
    expect(dependencies.generate).not.toHaveBeenCalled();
  });
});
