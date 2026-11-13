import { afterEach, describe, expect, it, vi } from "vitest";

const botId = "docentes";
const conversationTableName = "chat-docentes";
const policyKey = { pk: `BOT#${botId}`, sk: "QUOTA#POLICY" };
const policyPath = `/api/admin/bots/${botId}/quota`;
function documentResourcesFor(targetBotId) {
  return {
    documentTableName: `documents-${targetBotId}`,
    uploadBucketName: `incoming-${targetBotId}`,
    documentBucketName: `prepared-${targetBotId}`,
    incomingPrefix: "incoming/",
    preparedPrefix: "prepared/",
    knowledgeBaseId: `knowledge-base-${targetBotId}`,
    dataSourceId: `data-source-${targetBotId}`,
    stateMachineArn: `arn:aws:states:us-east-1:118903272638:stateMachine:${targetBotId}-admin-documents`,
  };
}
const defaultBot = {
  botId,
  projectName: "Docentes",
  accountTableName: "account-docentes",
  conversationTableName,
  clientId: "chat-client",
  siteUrl: "https://docentes.example.test/",
  ...documentResourcesFor(botId),
};
const adminClaims = {
  sub: "admin-sub",
  token_use: "access",
  client_id: "admin-client",
  "cognito:groups": ["global-admin"],
};

function rowKey(tableName, key) {
  return `${tableName}\u0000${key.pk}\u0000${key.sk}`;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function setItem(rows, tableName, item) {
  rows.set(rowKey(tableName, item), clone(item));
}

function event(options = {}) {
  const token = options.token === undefined ? "validated-admin-token" : options.token;
  const headers = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const requestContext = {
    http: { method: options.method || "GET", path: options.path || policyPath },
  };
  if (options.claims !== null) {
    requestContext.authorizer = { jwt: { claims: options.claims || adminClaims } };
  }
  return {
    version: "2.0",
    rawPath: options.path || policyPath,
    rawQueryString: new URLSearchParams(options.query || {}).toString(),
    queryStringParameters: options.query || {},
    headers,
    requestContext,
    ...(options.rawBody !== undefined
      ? { body: options.rawBody }
      : options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
  };
}

function responseBody(response) {
  return JSON.parse(response.body);
}

async function loadAdminLambda({
  policy = { dailyLimit: 12, monthlyLimit: 80, revision: "r1" },
  bots = [defaultBot],
  policies = [{ botId, conversationTableName, policy }],
  readFailure,
  getFailure,
  beforeUpdate,
  updateError,
  applyBeforeUpdateError = false,
  updateResponse,
} = {}) {
  vi.resetModules();
  vi.stubEnv("USER_POOL_ID", "user-pool");
  vi.stubEnv("ADMIN_CLIENT_ID", "admin-client");
  vi.stubEnv("ADMIN_GROUP", "global-admin");
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("BOT_CATALOG", JSON.stringify(bots));

  const dynamoSdk = await import("@aws-sdk/lib-dynamodb");
  const rows = new Map();
  const commands = [];
  let getCount = 0;

  function valueForCondition(input, field) {
    const names = input.ExpressionAttributeNames || {};
    const nameToken = Object.entries(names).find(([, value]) => value === field)?.[0] || field;
    const expression = input.ConditionExpression || "";
    const token = expression.match(new RegExp(`${nameToken}\\s*=\\s*(:[A-Za-z0-9_]+)`))?.[1];
    return token ? input.ExpressionAttributeValues?.[token] : undefined;
  }

  function conditionalFailure() {
    return Object.assign(new Error("Conditional check failed"), {
      name: "ConditionalCheckFailedException",
    });
  }

  function applyUpdate(command) {
    const input = command.input;
    const key = rowKey(input.TableName, input.Key);
    const current = rows.get(key);
    if (!current) throw conditionalFailure();
    for (const field of ["dailyLimit", "monthlyLimit", "revision"]) {
      const expected = valueForCondition(input, field);
      if (expected !== undefined && !Object.is(current[field], expected)) {
        throw conditionalFailure();
      }
    }
    const names = input.ExpressionAttributeNames || {};
    const values = input.ExpressionAttributeValues || {};
    const next = clone(current);
    for (const field of ["dailyLimit", "monthlyLimit", "revision"]) {
      const nameToken = Object.entries(names).find(([, value]) => value === field)?.[0] || field;
      const valueToken = nameToken
        ? input.UpdateExpression?.match(new RegExp(`${nameToken}\\s*=\\s*(:[A-Za-z0-9_]+)`))?.[1]
        : undefined;
      if (valueToken && Object.hasOwn(values, valueToken)) next[field] = clone(values[valueToken]);
    }
    rows.set(key, next);
    return next;
  }

  for (const configuredPolicy of policies) {
    if (configuredPolicy.policy !== undefined && configuredPolicy.policy !== null) {
      setItem(rows, configuredPolicy.conversationTableName, {
        pk: `BOT#${configuredPolicy.botId}`,
        sk: "QUOTA#POLICY",
        ...configuredPolicy.policy,
      });
    }
  }
  const send = vi.fn(async (command) => {
    commands.push(command);
    if (command instanceof dynamoSdk.GetCommand) {
      getCount += 1;
      const failure = getCount > 1 ? getFailure : readFailure;
      if (failure) throw typeof failure === "function" ? failure({ command, getCount }) : failure;
      const item = rows.get(rowKey(command.input.TableName, command.input.Key));
      return item ? { Item: clone(item) } : {};
    }
    if (command instanceof dynamoSdk.UpdateCommand) {
      await beforeUpdate?.({ command, rows, getCount });
      let next;
      if (applyBeforeUpdateError) next = applyUpdate(command);
      if (updateError) {
        const failure =
          typeof updateError === "function"
            ? await updateError({ command, rows, next, getCount })
            : updateError;
        if (failure) throw failure;
      }
      if (!applyBeforeUpdateError) next = applyUpdate(command);
      if (updateResponse !== undefined) {
        return typeof updateResponse === "function"
          ? updateResponse({ command, rows, next })
          : updateResponse;
      }
      return { Attributes: clone(next) };
    }
    throw new Error(`Unexpected DynamoDB command: ${command.constructor.name}`);
  });
  const documentClient = { send };
  vi.spyOn(dynamoSdk.DynamoDBDocumentClient, "from").mockReturnValue(documentClient);

  const cognitoSdk = await import("@aws-sdk/client-cognito-identity-provider");
  const sesSdk = await import("@aws-sdk/client-sesv2");
  const bedrockSdk = await import("@aws-sdk/client-bedrock-runtime");
  const bedrockAgentSdk = await import("@aws-sdk/client-bedrock-agent-runtime");
  const unexpectedCall = new Error("Unexpected external SDK operation during quota GET");
  const cognitoSend = vi
    .spyOn(cognitoSdk.CognitoIdentityProviderClient.prototype, "send")
    .mockRejectedValue(unexpectedCall);
  const sesSend = vi.spyOn(sesSdk.SESv2Client.prototype, "send").mockRejectedValue(unexpectedCall);
  const bedrockSend = vi
    .spyOn(bedrockSdk.BedrockRuntimeClient.prototype, "send")
    .mockRejectedValue(unexpectedCall);
  const bedrockAgentSend = vi
    .spyOn(bedrockAgentSdk.BedrockAgentRuntimeClient.prototype, "send")
    .mockRejectedValue(unexpectedCall);

  const { handler } = await import("../../api/admin-lambda.ts");
  return {
    handler,
    documentClient,
    rows,
    commands,
    GetCommand: dynamoSdk.GetCommand,
    UpdateCommand: dynamoSdk.UpdateCommand,
    cognitoSend,
    sesSend,
    bedrockSend,
    bedrockAgentSend,
  };
}

function expectNoWrites(harness) {
  expect(harness.commands.filter((command) => !(command instanceof harness.GetCommand))).toEqual(
    [],
  );
  expectNoExternalEffects(harness);
}

function expectNoExternalEffects(harness) {
  expect(harness.cognitoSend).not.toHaveBeenCalled();
  expect(harness.sesSend).not.toHaveBeenCalled();
  expect(harness.bedrockSend).not.toHaveBeenCalled();
  expect(harness.bedrockAgentSend).not.toHaveBeenCalled();
}

function expectNotCached(response) {
  expect(response.headers["cache-control"]).toBe("no-store");
}

function quotaPut(harness, body, options = {}) {
  return harness.handler(event({ ...options, method: "PUT", body }));
}

function expectValidationError(response, expectedField) {
  expect(response.statusCode).toBe(400);
  const body = responseBody(response);
  expect(body.code).toBe("INVALID_INPUT");
  expect(Array.isArray(body.fields)).toBe(true);
  expect(body.fields.every((field) => typeof field === "string")).toBe(true);
  if (expectedField) expect(body.fields).toContain(expectedField);
  expectNotCached(response);
}

function updateCommands(harness) {
  return harness.commands.filter((command) => command instanceof harness.UpdateCommand);
}

function getCommands(harness) {
  return harness.commands.filter((command) => command instanceof harness.GetCommand);
}

function expectServerRevision(value, previous) {
  expect(value).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(value).not.toBe(previous);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("administrative quota GET API", () => {
  it("reads the current policy consistently through the real Lambda composition and retains unrelated records", async () => {
    const counterDay = {
      pk: `USER#teacher-sub#BOT#${botId}`,
      sk: "USAGE#DAY#2026-11-12",
      used: 6,
    };
    const counterMonth = {
      pk: `USER#teacher-sub#BOT#${botId}`,
      sk: "USAGE#MONTH#2026-11",
      used: 19,
    };
    const conversationMeta = {
      pk: "CONV#persisted-conversation",
      sk: "META",
      conversationId: "persisted-conversation",
      lastOrdinal: 1,
      historyLabel: "Actividad de fracciones",
    };
    const turn = {
      pk: "CONV#persisted-conversation",
      sk: "TURN#00000001",
      queryId: "persisted-query",
      status: "completed",
    };
    const harness = await loadAdminLambda({
      policy: { dailyLimit: 0, monthlyLimit: 30, revision: "initial revision" },
    });
    for (const item of [counterDay, counterMonth, conversationMeta, turn]) {
      setItem(harness.rows, conversationTableName, item);
    }

    const unchangedRecords = [...harness.rows.entries()]
      .filter(([key]) => !key.endsWith(`\u0000${policyKey.pk}\u0000${policyKey.sk}`))
      .map(([key, value]) => [key, clone(value)]);
    const initial = await harness.handler(
      event({ query: { tableName: "attacker-selected-table" } }),
    );

    expect(initial.statusCode).toBe(200);
    expect(responseBody(initial)).toEqual({
      botId,
      policy: { dailyLimit: 0, monthlyLimit: 30, revision: "initial revision" },
    });
    expectNotCached(initial);

    setItem(harness.rows, conversationTableName, {
      ...policyKey,
      dailyLimit: 7,
      monthlyLimit: 3,
      revision: "  opaque revision  ",
    });
    const changed = await harness.handler(event());

    expect(changed.statusCode).toBe(200);
    expect(responseBody(changed)).toEqual({
      botId,
      policy: { dailyLimit: 7, monthlyLimit: 3, revision: "  opaque revision  " },
    });
    expectNotCached(changed);

    setItem(harness.rows, conversationTableName, {
      ...policyKey,
      dailyLimit: Number.MAX_SAFE_INTEGER,
      monthlyLimit: Number.MAX_SAFE_INTEGER,
      revision: "max-safe-integer",
    });
    const maximum = await harness.handler(event());

    expect(maximum.statusCode).toBe(200);
    expect(responseBody(maximum)).toEqual({
      botId,
      policy: {
        dailyLimit: Number.MAX_SAFE_INTEGER,
        monthlyLimit: Number.MAX_SAFE_INTEGER,
        revision: "max-safe-integer",
      },
    });
    expectNotCached(maximum);

    expect(harness.commands).toHaveLength(3);
    for (const command of harness.commands) {
      expect(command).toBeInstanceOf(harness.GetCommand);
      expect(command.input.TableName).toBe(conversationTableName);
      expect(command.input.Key).toEqual(policyKey);
      expect(command.input.ConsistentRead).toBe(true);
    }
    expect(
      [...harness.rows.entries()]
        .filter(([key]) => !key.endsWith(`\u0000${policyKey.pk}\u0000${policyKey.sk}`))
        .map(([key, value]) => [key, clone(value)]),
    ).toEqual(unchangedRecords);
    expectNoWrites(harness);
  });

  it.each([
    ["daily negative", { dailyLimit: -1 }],
    ["daily fractional", { dailyLimit: 1.5 }],
    ["daily numeric string", { dailyLimit: "12" }],
    ["daily above the safe integer range", { dailyLimit: Number.MAX_SAFE_INTEGER + 1 }],
    ["monthly negative", { monthlyLimit: -1 }],
    ["monthly fractional", { monthlyLimit: 1.5 }],
    ["monthly numeric string", { monthlyLimit: "80" }],
    ["monthly above the safe integer range", { monthlyLimit: Number.MAX_SAFE_INTEGER + 1 }],
    ["empty revision", { revision: "" }],
    ["whitespace-only revision", { revision: " \t " }],
    ["non-string revision", { revision: 1 }],
  ])(
    "reports an invalid stored policy as unavailable (%s) without changing it",
    async (_label, invalid) => {
      const policy = { dailyLimit: 12, monthlyLimit: 80, revision: "r1", ...invalid };
      const harness = await loadAdminLambda({ policy });
      const before = clone(harness.rows.get(rowKey(conversationTableName, policyKey)));

      const response = await harness.handler(event());

      expect(response.statusCode).toBe(503);
      expect(responseBody(response)).toEqual({ code: "QUOTA_UNAVAILABLE" });
      expectNotCached(response);
      expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toEqual(before);
      expect(harness.rows.size).toBe(1);
      expectNoWrites(harness);
    },
  );

  it.each(["dailyLimit", "monthlyLimit", "revision"])(
    "does not fill in a missing %s in a stored policy",
    async (field) => {
      const policy = { dailyLimit: 12, monthlyLimit: 80, revision: "r1" };
      delete policy[field];
      const harness = await loadAdminLambda({ policy });
      const before = clone(harness.rows.get(rowKey(conversationTableName, policyKey)));

      const response = await harness.handler(event());

      expect(response.statusCode).toBe(503);
      expect(responseBody(response)).toEqual({ code: "QUOTA_UNAVAILABLE" });
      expectNotCached(response);
      expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toEqual(before);
      expectNoWrites(harness);
    },
  );

  it("does not create a default policy when the stored policy is absent", async () => {
    const harness = await loadAdminLambda({ policy: null });

    const response = await harness.handler(event());

    expect(response.statusCode).toBe(503);
    expect(responseBody(response)).toEqual({ code: "QUOTA_UNAVAILABLE" });
    expectNotCached(response);
    expect(harness.rows.size).toBe(0);
    expectNoWrites(harness);
  });

  it("reports a failed policy read as unavailable without writes or unrelated service calls", async () => {
    const harness = await loadAdminLambda({ readFailure: new Error("DynamoDB unavailable") });

    const response = await harness.handler(event());

    expect(response.statusCode).toBe(503);
    expect(responseBody(response)).toEqual({ code: "QUOTA_UNAVAILABLE" });
    expectNotCached(response);
    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0].input.TableName).toBe(conversationTableName);
    expectNoWrites(harness);
  });

  it("keeps reads isolated to each selected chatbot's configured conversation table", async () => {
    const secondBot = {
      botId: "matematica",
      projectName: "Matemática",
      accountTableName: "account-matematica",
      conversationTableName: "chat-matematica",
      clientId: "matematica-client",
      siteUrl: "https://matematica.example.test/",
      ...documentResourcesFor("matematica"),
    };
    const harness = await loadAdminLambda({
      bots: [defaultBot, secondBot],
      policies: [
        {
          botId,
          conversationTableName,
          policy: { dailyLimit: 4, monthlyLimit: 21, revision: "docentes-r5" },
        },
        {
          botId: secondBot.botId,
          conversationTableName: secondBot.conversationTableName,
          policy: { dailyLimit: 9, monthlyLimit: 7, revision: "matematica-r2" },
        },
      ],
    });

    const docentes = await harness.handler(event());
    const matematica = await harness.handler(
      event({ path: `/api/admin/bots/${secondBot.botId}/quota` }),
    );
    const docentesAgain = await harness.handler(event());

    expect(docentes.statusCode).toBe(200);
    expect(responseBody(docentes)).toEqual({
      botId,
      policy: { dailyLimit: 4, monthlyLimit: 21, revision: "docentes-r5" },
    });
    expect(matematica.statusCode).toBe(200);
    expect(responseBody(matematica)).toEqual({
      botId: secondBot.botId,
      policy: { dailyLimit: 9, monthlyLimit: 7, revision: "matematica-r2" },
    });
    expect(docentesAgain.statusCode).toBe(200);
    expect(responseBody(docentesAgain)).toEqual(responseBody(docentes));
    expect(harness.commands.map((command) => command.input.TableName)).toEqual([
      conversationTableName,
      secondBot.conversationTableName,
      conversationTableName,
    ]);
    expect(harness.commands.map((command) => command.input.Key.pk)).toEqual([
      `BOT#${botId}`,
      `BOT#${secondBot.botId}`,
      `BOT#${botId}`,
    ]);
    for (const command of harness.commands) {
      expect(command).toBeInstanceOf(harness.GetCommand);
      expect(command.input.ConsistentRead).toBe(true);
    }
    expectNoWrites(harness);
  });

  it.each([
    ["missing bearer token", { token: null }, 401],
    ["missing authorizer claims", { claims: null }, 401],
    ["wrong administrative client", { claims: { ...adminClaims, client_id: "other-client" } }, 403],
    ["wrong token type", { claims: { ...adminClaims, token_use: "id" } }, 403],
    ["non-admin group", { claims: { ...adminClaims, "cognito:groups": ["teacher"] } }, 403],
  ])("checks authorization before reading policy (%s)", async (_label, options, statusCode) => {
    const harness = await loadAdminLambda();

    const response = await harness.handler(event(options));

    expect(response.statusCode).toBe(statusCode);
    expectNotCached(response);
    expect(harness.commands).toEqual([]);
    expectNoWrites(harness);
  });

  it("returns not found for an unlisted chatbot without reading any table", async () => {
    const harness = await loadAdminLambda();
    const response = await harness.handler(event({ path: "/api/admin/bots/not-configured/quota" }));

    expect(response.statusCode).toBe(404);
    expect(responseBody(response)).toEqual({ code: "NOT_FOUND" });
    expectNotCached(response);
    expect(harness.commands).toEqual([]);
    expectNoWrites(harness);
  });
});

describe("administrative quota PUT API", () => {
  it("updates both limits through the production Lambda composition with a full CAS and preserves unrelated records", async () => {
    const counter = {
      pk: `USER#teacher-sub#BOT#${botId}`,
      sk: "USAGE#DAY#2026-11-12",
      used: 6,
    };
    const conversation = {
      pk: "CONV#persisted-conversation",
      sk: "META",
      conversationId: "persisted-conversation",
      lastOrdinal: 4,
    };
    const harness = await loadAdminLambda({
      policy: { dailyLimit: 12, monthlyLimit: 80, revision: "r1", operatorNote: "keep me" },
    });
    for (const item of [counter, conversation]) setItem(harness.rows, conversationTableName, item);
    const before = new Map([...harness.rows.entries()].map(([key, value]) => [key, clone(value)]));

    const response = await quotaPut(
      harness,
      { dailyLimit: 0, monthlyLimit: Number.MAX_SAFE_INTEGER, expectedRevision: "r1" },
      { query: { tableName: "attacker-selected-table" } },
    );

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toMatchObject({
      botId,
      policy: { dailyLimit: 0, monthlyLimit: Number.MAX_SAFE_INTEGER },
      changed: true,
    });
    const returnedRevision = responseBody(response).policy.revision;
    expectServerRevision(returnedRevision, "r1");
    expectNotCached(response);

    const updates = updateCommands(harness);
    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update.input.TableName).toBe(conversationTableName);
    expect(update.input.Key).toEqual(policyKey);
    const names = update.input.ExpressionAttributeNames || {};
    expect(update.input.UpdateExpression).not.toMatch(/\b(?:REMOVE|ADD|DELETE)\b/i);
    const setClause = update.input.UpdateExpression?.match(
      /\bSET\s+(.+?)(?:\s+(?:REMOVE|ADD|DELETE)\b|$)/i,
    )?.[1];
    const updatedFields = new Set(
      (setClause || "").split(",").map((assignment) => {
        const fieldToken = assignment.split("=")[0].trim();
        return names[fieldToken] || fieldToken;
      }),
    );
    expect(updatedFields).toEqual(new Set(["dailyLimit", "monthlyLimit", "revision"]));
    const condition = update.input.ConditionExpression || "";
    expect(condition).not.toMatch(/\bOR\b/i);
    for (const field of ["dailyLimit", "monthlyLimit", "revision"]) {
      const fieldToken = Object.entries(names).find(([, value]) => value === field)?.[0] || field;
      expect(condition).toMatch(new RegExp(`${fieldToken}\\s*=\\s*:[A-Za-z0-9_]+`));
    }
    expect(Object.values(update.input.ExpressionAttributeValues)).toEqual(
      expect.arrayContaining([12, 80, "r1", 0, Number.MAX_SAFE_INTEGER, returnedRevision]),
    );

    const persisted = harness.rows.get(rowKey(conversationTableName, policyKey));
    expect(persisted).toMatchObject({
      ...policyKey,
      dailyLimit: 0,
      monthlyLimit: Number.MAX_SAFE_INTEGER,
      revision: returnedRevision,
      operatorNote: "keep me",
    });
    expect(harness.rows.get(rowKey(conversationTableName, counter))).toEqual(
      before.get(rowKey(conversationTableName, counter)),
    );
    expect(harness.rows.get(rowKey(conversationTableName, conversation))).toEqual(
      before.get(rowKey(conversationTableName, conversation)),
    );
    expect(getCommands(harness)).toHaveLength(1);
    expectNoExternalEffects(harness);
  });

  it("makes a persisted PUT visible to an already-created runtime quota adapter without changing accumulated usage", async () => {
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    const sub = "teacher-sub";
    const harness = await loadAdminLambda({
      policy: { dailyLimit: 12, monthlyLimit: 80, revision: "r1" },
    });
    setItem(harness.rows, conversationTableName, {
      pk: `USER#${sub}#BOT#${botId}`,
      sk: "USAGE#DAY#2026-11-12",
      used: 6,
    });
    setItem(harness.rows, conversationTableName, {
      pk: `USER#${sub}#BOT#${botId}`,
      sk: "USAGE#MONTH#2026-11",
      used: 19,
    });
    const { createConversationStoreAdapter } = await import("../../runtime/conversation-store.ts");
    const runtimeStore = createConversationStoreAdapter({
      documentClient: harness.documentClient,
      tableName: conversationTableName,
      now: () => now,
    });

    const before = await runtimeStore.readQuota({ sub, botId, now });
    const reduced = await quotaPut(harness, {
      dailyLimit: 6,
      monthlyLimit: 25,
      expectedRevision: "r1",
    });
    const afterReduction = await runtimeStore.readQuota({ sub, botId, now });

    expect(before).toMatchObject({
      daily: { used: 6, limit: 12 },
      monthly: { used: 19, limit: 80 },
      policyRevision: "r1",
      blockedUntil: null,
    });
    expect(reduced.statusCode).toBe(200);
    expect(afterReduction).toMatchObject({
      daily: { used: before.daily.used, limit: 6 },
      monthly: { used: before.monthly.used, limit: 25 },
      policyRevision: responseBody(reduced).policy.revision,
    });
    expect(afterReduction.blockedUntil).toBe(afterReduction.daily.resetAt);

    const expanded = await quotaPut(harness, {
      dailyLimit: 10,
      monthlyLimit: 30,
      expectedRevision: responseBody(reduced).policy.revision,
    });
    const afterExpansion = await runtimeStore.readQuota({ sub, botId, now });

    expect(expanded.statusCode).toBe(200);
    expect(afterExpansion).toMatchObject({
      daily: { used: before.daily.used, limit: 10 },
      monthly: { used: before.monthly.used, limit: 30 },
      policyRevision: responseBody(expanded).policy.revision,
      blockedUntil: null,
    });
    expect(getCommands(harness).every((command) => command.input.ConsistentRead === true)).toBe(
      true,
    );
    expect(updateCommands(harness)).toHaveLength(2);
    expectNoExternalEffects(harness);
  });

  it("confirms a no-op only when revision and both requested values already match, without generating a revision or writing", async () => {
    const harness = await loadAdminLambda({
      policy: { dailyLimit: 12, monthlyLimit: 80, revision: "r1" },
    });
    const before = clone(harness.rows.get(rowKey(conversationTableName, policyKey)));

    const response = await quotaPut(harness, {
      dailyLimit: 12,
      monthlyLimit: 80,
      expectedRevision: "r1",
    });

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toEqual({
      botId,
      policy: { dailyLimit: 12, monthlyLimit: 80, revision: "r1" },
      changed: false,
    });
    expect(updateCommands(harness)).toEqual([]);
    expect(getCommands(harness)).toHaveLength(1);
    expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toEqual(before);
    expectNoExternalEffects(harness);
  });

  it("compares an opaque revision exactly and preserves spaces rather than normalizing it", async () => {
    const harness = await loadAdminLambda({
      policy: { dailyLimit: 12, monthlyLimit: 80, revision: "  opaque revision  " },
    });
    const normalized = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "opaque revision",
    });
    expect(normalized.statusCode).toBe(409);
    expect(updateCommands(harness)).toHaveLength(0);

    const exact = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "  opaque revision  ",
    });
    expect(exact.statusCode).toBe(200);
    const observed = await harness.handler(event());
    expect(responseBody(observed)).toEqual({
      botId,
      policy: responseBody(exact).policy,
    });
    expect(updateCommands(harness)).toHaveLength(1);
    expectNoExternalEffects(harness);
  });

  it("checks a stale revision before the no-op shortcut, even when the submitted values match", async () => {
    const harness = await loadAdminLambda({
      policy: { dailyLimit: 12, monthlyLimit: 80, revision: "current" },
    });

    const response = await quotaPut(harness, {
      dailyLimit: 12,
      monthlyLimit: 80,
      expectedRevision: "stale",
    });

    expect(response.statusCode).toBe(409);
    expect(responseBody(response)).toEqual({ code: "STATE_CHANGED" });
    expect(updateCommands(harness)).toEqual([]);
    expect(getCommands(harness)).toHaveLength(1);
    expectNoExternalEffects(harness);
  });

  it("generates a fresh server UUID for each changed invocation and never accepts a client-chosen revision", async () => {
    const harness = await loadAdminLambda({
      policy: { dailyLimit: 12, monthlyLimit: 80, revision: "r1" },
    });

    const first = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 80,
      expectedRevision: "r1",
    });
    expect(first.statusCode).toBe(200);
    const firstRevision = responseBody(first).policy.revision;
    const second = await quotaPut(harness, {
      dailyLimit: 14,
      monthlyLimit: 80,
      expectedRevision: firstRevision,
      revision: "client-chosen-revision",
    });

    expect(first.statusCode).toBe(200);
    expectServerRevision(firstRevision, "r1");
    expectValidationError(second, "revision");
    expect(updateCommands(harness)).toHaveLength(1);
    expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toMatchObject({
      dailyLimit: 13,
      monthlyLimit: 80,
      revision: firstRevision,
    });
  });

  it("does not replay a duplicate based on an old revision after restoring old values", async () => {
    const harness = await loadAdminLambda({
      policy: { dailyLimit: 12, monthlyLimit: 80, revision: "r1" },
    });
    const first = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "r1",
    });
    expect(first.statusCode).toBe(200);
    const firstRevision = responseBody(first).policy.revision;
    const restored = await quotaPut(harness, {
      dailyLimit: 12,
      monthlyLimit: 80,
      expectedRevision: firstRevision,
    });
    expect(restored.statusCode).toBe(200);
    const restoredRevision = responseBody(restored).policy.revision;
    const duplicate = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "r1",
    });

    expect(first.statusCode).toBe(200);
    expect(restored.statusCode).toBe(200);
    expectServerRevision(restoredRevision, firstRevision);
    expect(duplicate.statusCode).toBe(409);
    expect(responseBody(duplicate)).toEqual({ code: "STATE_CHANGED" });
    expect(updateCommands(harness)).toHaveLength(2);
    expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toMatchObject({
      dailyLimit: 12,
      monthlyLimit: 80,
      revision: restoredRevision,
    });
    expectNoExternalEffects(harness);
  });

  it("does not adapt a second invocation that started from the same base revision", async () => {
    const harness = await loadAdminLambda({
      policy: { dailyLimit: 12, monthlyLimit: 80, revision: "r1" },
    });
    const first = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "r1",
    });
    const second = await quotaPut(harness, {
      dailyLimit: 14,
      monthlyLimit: 82,
      expectedRevision: "r1",
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(responseBody(second)).toEqual({ code: "STATE_CHANGED" });
    expect(updateCommands(harness)).toHaveLength(1);
    expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toMatchObject({
      dailyLimit: 13,
      monthlyLimit: 81,
      revision: responseBody(first).policy.revision,
    });
    expectNoExternalEffects(harness);
  });

  it.each([
    ["missing dailyLimit", { monthlyLimit: 80, expectedRevision: "r1" }, "dailyLimit"],
    ["missing monthlyLimit", { dailyLimit: 12, expectedRevision: "r1" }, "monthlyLimit"],
    ["missing expectedRevision", { dailyLimit: 13, monthlyLimit: 80 }, "expectedRevision"],
    [
      "daily numeric string",
      { dailyLimit: "13", monthlyLimit: 80, expectedRevision: "r1" },
      "dailyLimit",
    ],
    [
      "monthly numeric string",
      { dailyLimit: 13, monthlyLimit: "80", expectedRevision: "r1" },
      "monthlyLimit",
    ],
    ["daily negative", { dailyLimit: -1, monthlyLimit: 80, expectedRevision: "r1" }, "dailyLimit"],
    [
      "monthly negative",
      { dailyLimit: 13, monthlyLimit: -1, expectedRevision: "r1" },
      "monthlyLimit",
    ],
    [
      "daily fractional",
      { dailyLimit: 1.5, monthlyLimit: 80, expectedRevision: "r1" },
      "dailyLimit",
    ],
    [
      "monthly fractional",
      { dailyLimit: 13, monthlyLimit: 1.5, expectedRevision: "r1" },
      "monthlyLimit",
    ],
    [
      "daily above safe integer",
      { dailyLimit: Number.MAX_SAFE_INTEGER + 1, monthlyLimit: 80, expectedRevision: "r1" },
      "dailyLimit",
    ],
    [
      "monthly above safe integer",
      { dailyLimit: 13, monthlyLimit: Number.MAX_SAFE_INTEGER + 1, expectedRevision: "r1" },
      "monthlyLimit",
    ],
    [
      "empty expected revision",
      { dailyLimit: 13, monthlyLimit: 80, expectedRevision: "" },
      "expectedRevision",
    ],
    [
      "whitespace expected revision",
      { dailyLimit: 13, monthlyLimit: 80, expectedRevision: " \t " },
      "expectedRevision",
    ],
    [
      "client-selected table or identity",
      {
        dailyLimit: 13,
        monthlyLimit: 80,
        expectedRevision: "r1",
        conversationTableName,
        sub: "attacker",
        used: 0,
      },
      "conversationTableName",
    ],
  ])("rejects %s before any read or write", async (_label, body, field) => {
    const harness = await loadAdminLambda();
    const before = clone(harness.rows.get(rowKey(conversationTableName, policyKey)));

    const response = await quotaPut(harness, body);

    expectValidationError(response, field);
    expect(harness.commands).toEqual([]);
    expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toEqual(before);
    expectNoExternalEffects(harness);
  });

  it("rejects malformed JSON with an identifiable body error before reading the policy", async () => {
    const harness = await loadAdminLambda();

    const response = await quotaPut(harness, undefined, { rawBody: "{malformed" });

    expectValidationError(response, "body");
    expect(harness.commands).toEqual([]);
    expectNoExternalEffects(harness);
  });

  it.each([
    ["missing policy", null],
    ["corrupt policy", { dailyLimit: 12, monthlyLimit: 80, revision: "" }],
  ])("does not create or overwrite a %s while handling PUT", async (_label, policy) => {
    const harness = await loadAdminLambda({ policy });

    const response = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "r1",
    });

    expect(response.statusCode).toBe(503);
    expect(responseBody(response)).toEqual({ code: "QUOTA_UNAVAILABLE" });
    expectNotCached(response);
    expect(updateCommands(harness)).toEqual([]);
    expectNoExternalEffects(harness);
  });

  it("returns unavailable on an initial read failure without attempting UpdateItem", async () => {
    const harness = await loadAdminLambda({ readFailure: new Error("DynamoDB unavailable") });

    const response = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "r1",
    });

    expect(response.statusCode).toBe(503);
    expect(responseBody(response)).toEqual({ code: "QUOTA_UNAVAILABLE" });
    expect(updateCommands(harness)).toEqual([]);
    expect(getCommands(harness)).toHaveLength(1);
    expectNoExternalEffects(harness);
  });

  it("returns the selected chatbot's policy and writes only its configured table", async () => {
    const secondBot = {
      botId: "matematica",
      projectName: "Matemática",
      accountTableName: "account-matematica",
      conversationTableName: "chat-matematica",
      clientId: "matematica-client",
      siteUrl: "https://matematica.example.test/",
      ...documentResourcesFor("matematica"),
    };
    const harness = await loadAdminLambda({
      bots: [defaultBot, secondBot],
      policies: [
        {
          botId,
          conversationTableName,
          policy: { dailyLimit: 12, monthlyLimit: 80, revision: "d1" },
        },
        {
          botId: secondBot.botId,
          conversationTableName: secondBot.conversationTableName,
          policy: { dailyLimit: 9, monthlyLimit: 7, revision: "m1" },
        },
      ],
    });

    const response = await quotaPut(
      harness,
      { dailyLimit: 0, monthlyLimit: 8, expectedRevision: "m1" },
      { path: `/api/admin/bots/${secondBot.botId}/quota`, query: { tableName: "not-the-table" } },
    );

    expect(response.statusCode).toBe(200);
    expect(responseBody(response).botId).toBe(secondBot.botId);
    expect(updateCommands(harness)[0].input.TableName).toBe(secondBot.conversationTableName);
    expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toMatchObject({
      dailyLimit: 12,
      monthlyLimit: 80,
      revision: "d1",
    });
    expect(
      harness.rows.get(
        rowKey(secondBot.conversationTableName, {
          pk: `BOT#${secondBot.botId}`,
          sk: "QUOTA#POLICY",
        }),
      ).dailyLimit,
    ).toBe(0);
    expectNoExternalEffects(harness);
  });

  it("resolves an ACK-lost update as successful only when one consistent read finds its own UUID and both values", async () => {
    const timeout = Object.assign(new Error("DynamoDB response timed out"), {
      name: "TimeoutError",
    });
    const harness = await loadAdminLambda({
      updateError: timeout,
      applyBeforeUpdateError: true,
      policy: { dailyLimit: 12, monthlyLimit: 80, revision: "r1" },
    });

    const response = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "r1",
    });

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toMatchObject({
      botId,
      policy: { dailyLimit: 13, monthlyLimit: 81 },
      changed: true,
    });
    expectServerRevision(responseBody(response).policy.revision, "r1");
    expect(getCommands(harness)).toHaveLength(2);
    expect(updateCommands(harness)).toHaveLength(1);
    expect(getCommands(harness)[1].input.ConsistentRead).toBe(true);
    expectNoExternalEffects(harness);
  });

  it("reports an ACK-lost update as unconfirmed when resolution still sees the original base", async () => {
    const timeout = Object.assign(new Error("DynamoDB response timed out"), {
      name: "TimeoutError",
    });
    const harness = await loadAdminLambda({ updateError: timeout });
    const before = clone(harness.rows.get(rowKey(conversationTableName, policyKey)));

    const response = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "r1",
    });

    expect(response.statusCode).toBe(503);
    expect(responseBody(response)).toEqual({ code: "SAVE_UNCONFIRMED" });
    expect(getCommands(harness)).toHaveLength(2);
    expect(updateCommands(harness)).toHaveLength(1);
    expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toEqual(before);
    expectNoExternalEffects(harness);
  });

  it("does not confirm an ACK-lost update when its own UUID remains but one requested value differs", async () => {
    const timeout = Object.assign(new Error("DynamoDB response timed out"), {
      name: "TimeoutError",
    });
    const harness = await loadAdminLambda({
      updateError: ({ rows }) => {
        const key = rowKey(conversationTableName, policyKey);
        rows.set(key, { ...rows.get(key), monthlyLimit: 999 });
        return timeout;
      },
      applyBeforeUpdateError: true,
    });

    const response = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "r1",
    });

    expect(response.statusCode).toBe(409);
    expect(responseBody(response)).toEqual({ code: "STATE_CHANGED" });
    expect(getCommands(harness)).toHaveLength(2);
    expect(updateCommands(harness)).toHaveLength(1);
    expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toMatchObject({
      dailyLimit: 13,
      monthlyLimit: 999,
    });
    expectNoExternalEffects(harness);
  });

  it("returns a state conflict when ACK resolution observes another policy, without retrying the write", async () => {
    const timeout = Object.assign(new Error("DynamoDB response timed out"), {
      name: "TimeoutError",
    });
    const harness = await loadAdminLambda({
      updateError: timeout,
      beforeUpdate: ({ rows }) =>
        setItem(rows, conversationTableName, {
          ...policyKey,
          dailyLimit: 13,
          monthlyLimit: 81,
          revision: "other-editor",
        }),
    });

    const response = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "r1",
    });

    expect(response.statusCode).toBe(409);
    expect(responseBody(response)).toEqual({ code: "STATE_CHANGED" });
    expect(getCommands(harness)).toHaveLength(2);
    expect(updateCommands(harness)).toHaveLength(1);
    expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toMatchObject({
      dailyLimit: 13,
      monthlyLimit: 81,
      revision: "other-editor",
    });
    expectNoExternalEffects(harness);
  });

  it("returns unconfirmed when ACK resolution cannot read the policy", async () => {
    const timeout = Object.assign(new Error("DynamoDB response timed out"), {
      name: "TimeoutError",
    });
    const harness = await loadAdminLambda({
      updateError: timeout,
      getFailure: new Error("DynamoDB resolution read unavailable"),
    });

    const response = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "r1",
    });

    expect(response.statusCode).toBe(503);
    expect(responseBody(response)).toEqual({ code: "SAVE_UNCONFIRMED" });
    expect(getCommands(harness)).toHaveLength(2);
    expect(updateCommands(harness)).toHaveLength(1);
    expectNoExternalEffects(harness);
  });

  it("uses all original values in the CAS when another edit changes limits before UpdateItem", async () => {
    const harness = await loadAdminLambda({
      beforeUpdate: ({ rows }) =>
        setItem(rows, conversationTableName, {
          ...policyKey,
          dailyLimit: 99,
          monthlyLimit: 80,
          revision: "r1",
        }),
    });

    const response = await quotaPut(harness, {
      dailyLimit: 13,
      monthlyLimit: 81,
      expectedRevision: "r1",
    });

    expect(response.statusCode).toBe(409);
    expect(responseBody(response)).toEqual({ code: "STATE_CHANGED" });
    expect(updateCommands(harness)).toHaveLength(1);
    expect(getCommands(harness)).toHaveLength(2);
    expect(harness.rows.get(rowKey(conversationTableName, policyKey))).toMatchObject({
      dailyLimit: 99,
      monthlyLimit: 80,
      revision: "r1",
    });
    expectNoExternalEffects(harness);
  });

  it.each([
    ["missing bearer token", { token: null }, 401],
    ["missing authorizer claims", { claims: null }, 401],
    ["wrong administrative client", { claims: { ...adminClaims, client_id: "other-client" } }, 403],
    ["wrong token type", { claims: { ...adminClaims, token_use: "id" } }, 403],
    ["non-admin group", { claims: { ...adminClaims, "cognito:groups": ["teacher"] } }, 403],
  ])(
    "checks PUT authorization before reading or writing (%s)",
    async (_label, options, statusCode) => {
      const harness = await loadAdminLambda();

      const response = await quotaPut(
        harness,
        { dailyLimit: 13, monthlyLimit: 81, expectedRevision: "r1" },
        options,
      );

      expect(response.statusCode).toBe(statusCode);
      expectNotCached(response);
      expect(harness.commands).toEqual([]);
      expectNoExternalEffects(harness);
    },
  );

  it("returns not found for PUT on an unlisted chatbot without reading or writing any table", async () => {
    const harness = await loadAdminLambda();
    const response = await quotaPut(
      harness,
      { dailyLimit: 13, monthlyLimit: 81, expectedRevision: "r1" },
      { path: "/api/admin/bots/not-configured/quota" },
    );

    expect(response.statusCode).toBe(404);
    expect(responseBody(response)).toEqual({ code: "NOT_FOUND" });
    expectNotCached(response);
    expect(harness.commands).toEqual([]);
    expectNoExternalEffects(harness);
  });
});
