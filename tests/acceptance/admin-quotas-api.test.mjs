import { afterEach, describe, expect, it, vi } from "vitest";

const botId = "docentes";
const conversationTableName = "chat-docentes";
const policyKey = { pk: `BOT#${botId}`, sk: "QUOTA#POLICY" };
const policyPath = `/api/admin/bots/${botId}/quota`;
const defaultBot = {
  botId,
  projectName: "Docentes",
  accountTableName: "account-docentes",
  conversationTableName,
  clientId: "chat-client",
  siteUrl: "https://docentes.example.test/",
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
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
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
    if (!(command instanceof dynamoSdk.GetCommand)) {
      throw new Error(`Unexpected DynamoDB command: ${command.constructor.name}`);
    }
    if (readFailure) throw readFailure;
    const item = rows.get(rowKey(command.input.TableName, command.input.Key));
    return item ? { Item: clone(item) } : {};
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
    rows,
    commands,
    GetCommand: dynamoSdk.GetCommand,
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
  expect(harness.cognitoSend).not.toHaveBeenCalled();
  expect(harness.sesSend).not.toHaveBeenCalled();
  expect(harness.bedrockSend).not.toHaveBeenCalled();
  expect(harness.bedrockAgentSend).not.toHaveBeenCalled();
}

function expectNotCached(response) {
  expect(response.headers["cache-control"]).toBe("no-store");
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
