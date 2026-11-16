import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  phase11AdminClaims,
  phase11AdminEvent,
  phase11AdminGroup,
  phase11BotId,
  phase11Now,
  phase11ResponseBody,
} from "../support/phase11-documents-backend.mjs";

const botId = phase11BotId;
const conversationTableName = `chat-${botId}`;
const recordsIndexName = `records-${botId}-by-admission`;
const adminSub = "admin-sub";
const testPersonId = "team-test-sub";
const exportId = "36fd25f7-33ac-4d4b-90a6-a794bf70425d";
const recordsPath = (suffix = "") => `/api/admin/bots/${botId}/records${suffix}`;

function uuid(seed) {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function documentResourcesFor(targetBotId) {
  return {
    documentTableName: `documents-${targetBotId}`,
    uploadBucketName: `temporary-${targetBotId}`,
    documentBucketName: `prepared-${targetBotId}`,
    incomingPrefix: "incoming/",
    preparedPrefix: "prepared/",
    knowledgeBaseId: `knowledge-base-${targetBotId}`,
    dataSourceId: `data-source-${targetBotId}`,
    stateMachineArn: `arn:aws:states:us-east-1:118903272638:stateMachine:${targetBotId}-documents`,
  };
}

const defaultBot = {
  botId,
  projectName: "Docentes",
  accountTableName: `account-${botId}`,
  conversationTableName,
  clientId: "chat-client",
  siteUrl: "https://docentes.example.test/",
  ...documentResourcesFor(botId),
};

const secondBot = {
  botId: "matematica",
  projectName: "Matemática",
  accountTableName: "account-matematica",
  conversationTableName: "chat-matematica",
  clientId: "matematica-client",
  siteUrl: "https://matematica.example.test/",
  ...documentResourcesFor("matematica"),
};

const recordsCatalog = [
  { botId, recordsIndexName, testPersonIds: [testPersonId] },
  {
    botId: secondBot.botId,
    recordsIndexName: "records-matematica-by-admission",
    testPersonIds: ["matematica-test-sub"],
  },
];

function rowKey(tableName, key) {
  return `${tableName}\u0000${key.pk}\u0000${key.sk}`;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function turn({
  targetBotId = botId,
  conversationId,
  personId = "person-1",
  queryId,
  ordinal = 1,
  admittedAt = "2026-11-13T15:00:00.000Z",
  status = "completed",
  fields = { educationLevels: [{ id: "primaria", label: "Primaria" }], subjects: ["Matemática"] },
  questionCount = 1,
  answerCount = status === "completed" ? 1 : 0,
  answerComplete = status === "completed",
  failureCode,
}) {
  const phase =
    status === "completed" ? "complete" : status === "failed" ? "failed" : "invocation_claimed";
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}`,
    conversationId,
    sub: personId,
    botId: targetBotId,
    queryId,
    ordinal,
    operation: ordinal === 1 ? "start" : "message",
    baseOrdinal: ordinal - 1,
    requestFingerprint: `fingerprint-${queryId}`,
    status,
    phase,
    ownerAttemptId: `attempt-${ordinal}`,
    resultDeadlineAt: Date.parse(admittedAt) + 60_000,
    createdAt: admittedAt,
    updatedAt: admittedAt,
    questionManifest: { count: questionCount, complete: true },
    answerManifest: { count: answerCount, complete: answerComplete },
    cursor: answerCount,
    contextManifest: { count: 0, complete: true },
    contextSnapshot: { version: 1, recentReferences: [] },
    documentContextManifest: { count: 1, complete: true },
    profileSnapshot: {
      sub: personId,
      botId: targetBotId,
      fields,
      responsePreferenceIds: ["ready-material"],
      promptTexts: ["Incluí materiales completos y listos para usar."],
      updatedAt: "2026-11-10T12:00:00.000Z",
      configurationRevision: "reviewed-revision-123",
    },
    invocation: { modelId: "anthropic.claude-sonnet-test" },
    ...(failureCode ? { failure: { code: failureCode } } : {}),
  };
}

function meta({
  targetBotId = botId,
  conversationId,
  personId = "person-1",
  lastOrdinal = 1,
  hiddenAt,
}) {
  return {
    pk: `CONV#${conversationId}`,
    sk: "META",
    conversationId,
    sub: personId,
    botId: targetBotId,
    lastOrdinal,
    closed: true,
    ...(hiddenAt ? { hiddenAt } : {}),
  };
}

function textChunk({ conversationId, queryId, ordinal = 1, role = "user", index = 0, text }) {
  return {
    pk: `CONV#${conversationId}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}#${queryId}#${role.toUpperCase()}#${String(index).padStart(8, "0")}`,
    conversationId,
    queryId,
    ordinal,
    role,
    index,
    text,
  };
}

function addRows(rows, ...items) {
  for (const item of items) rows.set(rowKey(conversationTableName, item), clone(item));
}

function event({ method = "GET", path = recordsPath(), body, query, claims, token } = {}) {
  return phase11AdminEvent({
    method,
    path,
    ...(body === undefined ? {} : { body }),
    ...(query === undefined ? {} : { query }),
    ...(claims === undefined ? {} : { claims }),
    ...(token === undefined ? {} : { token }),
  });
}

function responseBody(response) {
  return phase11ResponseBody(response);
}

function commandValues(input) {
  return Object.values(input.ExpressionAttributeValues ?? {});
}

function pageForQuery(command, rows) {
  const input = command.input;
  const values = commandValues(input);
  const tableName = input.TableName;
  const indexQuery = Boolean(input.IndexName);
  let candidates = [...rows.entries()]
    .filter(([key]) => key.startsWith(`${tableName}\u0000`))
    .map(([, item]) => item);

  if (indexQuery) {
    const requestedBot = values.find((value) =>
      recordsCatalog.some((record) => record.botId === value),
    );
    candidates = candidates.filter(
      (item) => item.botId === requestedBot && Number.isSafeInteger(item.ordinal),
    );
    candidates = candidates.map(
      ({ pk, sk, botId: indexedBot, createdAt, conversationId, ordinal }) => ({
        pk,
        sk,
        botId: indexedBot,
        createdAt,
        conversationId,
        ordinal,
      }),
    );
    const keyDates = values
      .map((value) => (typeof value === "number" ? value : Date.parse(value)))
      .filter((value) => Number.isFinite(value));
    if (keyDates.length >= 2) {
      const lower = Math.min(...keyDates);
      const upper = Math.max(...keyDates);
      candidates = candidates.filter((item) => {
        const admittedAt = Date.parse(item.createdAt);
        return admittedAt >= lower && admittedAt <= upper;
      });
    }
  } else {
    const partition = values.find(
      (value) => typeof value === "string" && value.startsWith("CONV#"),
    );
    if (partition) candidates = candidates.filter((item) => item.pk === partition);
    const prefix = values.find((value) => typeof value === "string" && value.startsWith("TURN#"));
    if (prefix && prefix.endsWith("#")) {
      candidates = candidates.filter((item) => item.sk.startsWith(prefix));
    }
  }

  candidates.sort((left, right) => {
    if (indexQuery) {
      return (
        String(left.createdAt).localeCompare(String(right.createdAt)) ||
        String(left.conversationId).localeCompare(String(right.conversationId)) ||
        left.ordinal - right.ordinal
      );
    }
    return String(left.sk).localeCompare(String(right.sk));
  });
  if (input.ScanIndexForward === false) candidates.reverse();
  if (input.ExclusiveStartKey) {
    const startIndex = candidates.findIndex(
      (item) =>
        (indexQuery &&
          item.botId === input.ExclusiveStartKey.botId &&
          item.createdAt === input.ExclusiveStartKey.createdAt &&
          item.conversationId === input.ExclusiveStartKey.conversationId &&
          item.ordinal === input.ExclusiveStartKey.ordinal) ||
        (item.pk === input.ExclusiveStartKey.pk && item.sk === input.ExclusiveStartKey.sk),
    );
    if (startIndex >= 0) candidates = candidates.slice(startIndex + 1);
  }
  const limit =
    Number.isSafeInteger(input.Limit) && input.Limit > 0 ? input.Limit : candidates.length;
  const page = [];
  let bytes = 0;
  for (const candidate of candidates.slice(0, limit)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(candidate));
    if (page.length > 0 && bytes + itemBytes > 1024 * 1024) break;
    page.push(candidate);
    bytes += itemBytes;
  }
  const last = page.at(-1);
  const hasMore = candidates.length > page.length;
  return {
    Items: clone(page),
    ...(hasMore && last
      ? {
          LastEvaluatedKey: {
            pk: last.pk,
            sk: last.sk,
            ...(indexQuery && last.botId ? { botId: last.botId } : {}),
            ...(indexQuery && last.createdAt ? { createdAt: last.createdAt } : {}),
            ...(indexQuery && last.conversationId ? { conversationId: last.conversationId } : {}),
            ...(indexQuery && Number.isSafeInteger(last.ordinal) ? { ordinal: last.ordinal } : {}),
          },
        }
      : {}),
  };
}

async function loadAdminLambda({ initialRows = [], indexPages = [], batchLimit } = {}) {
  vi.resetModules();
  vi.stubEnv("USER_POOL_ID", "user-pool");
  vi.stubEnv("ADMIN_CLIENT_ID", "admin-client");
  vi.stubEnv("ADMIN_GROUP", phase11AdminGroup);
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");
  vi.stubEnv("AWS_SESSION_TOKEN", "test-session-token");
  vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
  vi.stubEnv("ENVIRONMENT", "dev");
  vi.stubEnv("BOT_CATALOG", JSON.stringify([defaultBot, secondBot]));
  vi.stubEnv("RECORDS_CATALOG", JSON.stringify(recordsCatalog));
  vi.stubEnv(
    "RECORDS_EXPORT_STATE_MACHINE_ARN",
    "arn:aws:states:us-east-1:118903272638:stateMachine:multi-chatbot-dev-admin-records-export",
  );

  const dynamoSdk = await import("@aws-sdk/lib-dynamodb");
  const rows = new Map();
  for (const item of initialRows) addRows(rows, item);
  const commands = [];
  let indexQueryCount = 0;
  let scriptedIndexPages = [...indexPages];
  const dynamoSend = vi.fn(async (command) => {
    commands.push(command);
    if (command instanceof dynamoSdk.GetCommand) {
      const item = rows.get(rowKey(command.input.TableName, command.input.Key));
      return item ? { Item: clone(item) } : {};
    }
    if (command instanceof dynamoSdk.BatchGetCommand) {
      const Responses = {};
      const UnprocessedKeys = {};
      for (const [tableName, request] of Object.entries(command.input.RequestItems ?? {})) {
        const keys = request.Keys ?? [];
        const limit = batchLimit ?? keys.length;
        const items = keys
          .slice(0, limit)
          .map((key) => rows.get(rowKey(tableName, key)))
          .filter(Boolean)
          .reverse()
          .map(clone);
        Responses[tableName] = items;
        if (keys.length > limit) UnprocessedKeys[tableName] = { Keys: keys.slice(limit) };
      }
      return { Responses, UnprocessedKeys };
    }
    if (command instanceof dynamoSdk.QueryCommand) {
      if (command.input.IndexName) {
        indexQueryCount += 1;
        if (scriptedIndexPages.length) return clone(scriptedIndexPages.shift());
      }
      return pageForQuery(command, rows);
    }
    throw new Error(`Unexpected DynamoDB command: ${command.constructor.name}`);
  });
  vi.spyOn(dynamoSdk.DynamoDBDocumentClient, "from").mockReturnValue({ send: dynamoSend });

  const sfnSdk = await import("@aws-sdk/client-sfn");
  const s3Sdk = await import("@aws-sdk/client-s3");
  const cognitoSdk = await import("@aws-sdk/client-cognito-identity-provider");
  const sesSdk = await import("@aws-sdk/client-sesv2");
  const bedrockSdk = await import("@aws-sdk/client-bedrock-runtime");
  const bedrockAgentSdk = await import("@aws-sdk/client-bedrock-agent-runtime");
  const sfnCommands = [];
  const executions = new Map();
  let defaultHead = { ETag: '"export-etag"', ContentLength: 4096 };
  const s3Commands = [];
  const sfnSend = vi.fn(async (command) => {
    sfnCommands.push(command);
    if (command instanceof sfnSdk.StartExecutionCommand) {
      const existing = executions.get(command.input.name);
      if (existing) {
        if (existing.input === command.input.input && existing.status === "RUNNING") {
          return { executionArn: existing.executionArn, startDate: new Date(phase11Now) };
        }
        throw Object.assign(new Error("Execution already exists"), {
          name: "ExecutionAlreadyExists",
        });
      }
      const executionArn =
        command.input.stateMachineArn.replace(":stateMachine:", ":execution:") +
        `:${command.input.name}`;
      executions.set(command.input.name, {
        executionArn,
        stateMachineArn: command.input.stateMachineArn,
        name: command.input.name,
        input: command.input.input,
        output: undefined,
        status: "RUNNING",
      });
      return { executionArn, startDate: new Date(phase11Now) };
    }
    if (command instanceof sfnSdk.DescribeExecutionCommand) {
      const found = [...executions.values()].find(
        (execution) => execution.executionArn === command.input.executionArn,
      );
      if (!found)
        throw Object.assign(new Error("Execution not found"), { name: "ExecutionDoesNotExist" });
      return {
        executionArn: found.executionArn,
        stateMachineArn: found.stateMachineArn,
        name: found.name,
        input: found.input,
        output: found.output,
        status: found.status,
        startDate: new Date(phase11Now),
        ...(found.status !== "RUNNING" ? { stopDate: new Date(phase11Now) } : {}),
      };
    }
    throw new Error(`Unexpected Step Functions command: ${command.constructor.name}`);
  });
  const s3Send = vi.fn(async (command) => {
    s3Commands.push(command);
    if (command instanceof s3Sdk.HeadObjectCommand) return clone(defaultHead);
    throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
  });
  const forbiddenSend = vi.fn(async (command) => {
    throw new Error(`Unexpected external command: ${command.constructor.name}`);
  });
  vi.spyOn(cognitoSdk.CognitoIdentityProviderClient.prototype, "send").mockImplementation(
    forbiddenSend,
  );
  vi.spyOn(sesSdk.SESv2Client.prototype, "send").mockImplementation(forbiddenSend);
  vi.spyOn(bedrockSdk.BedrockRuntimeClient.prototype, "send").mockImplementation(forbiddenSend);
  vi.spyOn(bedrockAgentSdk.BedrockAgentRuntimeClient.prototype, "send").mockImplementation(
    forbiddenSend,
  );
  vi.spyOn(sfnSdk.SFNClient.prototype, "send").mockImplementation(sfnSend);
  vi.spyOn(s3Sdk.S3Client.prototype, "send").mockImplementation(s3Send);

  const { handler } = await import("../../api/admin-lambda.ts");
  return {
    handler,
    rows,
    commands,
    dynamoSend,
    sfnCommands,
    executions,
    s3Commands,
    setIndexPages(pages) {
      scriptedIndexPages = [...pages];
      indexQueryCount = 0;
    },
    setExecution(exportName, { status, output }) {
      const execution = executions.get(exportName);
      if (!execution) throw new Error(`Unknown export execution: ${exportName}`);
      execution.status = status;
      execution.output = output === undefined ? undefined : JSON.stringify(output);
    },
    setHeadObject(value) {
      defaultHead = clone(value);
    },
    indexQueryCount: () => indexQueryCount,
    async invoke(apiEvent) {
      return handler(apiEvent);
    },
  };
}

function expectNoDynamoWrites(harness) {
  expect(
    harness.commands.every((command) =>
      ["GetCommand", "QueryCommand", "BatchGetCommand"].includes(command.constructor.name),
    ),
  ).toBe(true);
}

function expectNoGeneration(harness) {
  expectNoDynamoWrites(harness);
  expect(harness.s3Commands).toEqual([]);
  expect(harness.sfnCommands).toEqual([]);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("administrative records API", () => {
  it("filters on one historical turn, respects Córdoba dates and accents, and excludes configured test accounts", async () => {
    const matchingConversationId = uuid("conversation-match");
    const matchingQueryId = uuid("query-match");
    const splitConversationId = uuid("conversation-split");
    const teamTestConversationId = uuid("conversation-team-test");
    const matching = turn({
      conversationId: matchingConversationId,
      queryId: matchingQueryId,
      personId: "person-1",
      ordinal: 2,
      admittedAt: "2026-11-13T03:00:00.000Z",
      status: "failed",
      answerCount: 1,
      answerComplete: false,
      failureCode: "provider_error",
    });
    const splitStatus = turn({
      conversationId: splitConversationId,
      queryId: uuid("query-split-status"),
      personId: "person-1",
      ordinal: 1,
      admittedAt: "2026-11-13T12:00:00.000Z",
      status: "failed",
      fields: {
        educationLevels: [{ id: "secundaria", label: "Secundaria" }],
        subjects: ["Matemática"],
      },
    });
    const splitProfile = turn({
      conversationId: splitConversationId,
      queryId: uuid("query-split-profile"),
      personId: "person-1",
      ordinal: 2,
      admittedAt: "2026-11-12T12:00:00.000Z",
      status: "completed",
      fields: {
        educationLevels: [{ id: "primaria", label: "Primaria" }],
        subjects: ["Matemática"],
      },
    });
    const beforeLocalDay = turn({
      conversationId: uuid("conversation-before-local-day"),
      queryId: uuid("query-before-local-day"),
      personId: "person-1",
      admittedAt: "2026-11-13T02:59:59.999Z",
      status: "failed",
    });
    const noAccent = turn({
      conversationId: uuid("conversation-no-accent"),
      queryId: uuid("query-no-accent"),
      personId: "person-1",
      status: "failed",
      fields: {
        educationLevels: [{ id: "primaria", label: "Primaria" }],
        subjects: ["Matematica"],
      },
    });
    const teamTest = turn({
      conversationId: teamTestConversationId,
      queryId: uuid("query-team-test"),
      personId: testPersonId,
      status: "failed",
    });
    const fromOtherBot = turn({
      targetBotId: secondBot.botId,
      conversationId: uuid("conversation-other-bot"),
      queryId: uuid("query-other-bot"),
      personId: "person-1",
      status: "failed",
    });
    const harness = await loadAdminLambda({
      initialRows: [
        meta({ conversationId: matchingConversationId, personId: "person-1", lastOrdinal: 2 }),
        meta({ conversationId: splitConversationId, personId: "person-1", lastOrdinal: 2 }),
        meta({ conversationId: uuid("conversation-before-local-day"), personId: "person-1" }),
        meta({ conversationId: uuid("conversation-no-accent"), personId: "person-1" }),
        meta({ conversationId: teamTestConversationId, personId: testPersonId }),
        meta({
          targetBotId: secondBot.botId,
          conversationId: uuid("conversation-other-bot"),
          personId: "person-1",
        }),
        matching,
        splitStatus,
        splitProfile,
        beforeLocalDay,
        noAccent,
        teamTest,
        fromOtherBot,
        ...[
          matching,
          splitStatus,
          splitProfile,
          beforeLocalDay,
          noAccent,
          teamTest,
          fromOtherBot,
        ].map((item) =>
          textChunk({
            conversationId: item.conversationId,
            queryId: item.queryId,
            ordinal: item.ordinal,
            text: `Pregunta original ${item.queryId}`,
          }),
        ),
      ],
    });
    const filters = {
      from: "2026-11-13",
      to: "2026-11-13",
      status: "failed",
      personId: "person-1",
      levelId: "primaria",
      subject: " MATEMÁTICA ",
      excludeTests: true,
    };

    const response = await harness.invoke(
      event({ method: "POST", path: recordsPath("/search"), body: { filters } }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(responseBody(response)).toEqual({
      botId,
      results: [
        {
          conversationId: matchingConversationId,
          queryId: matchingQueryId,
          ordinal: 2,
          personId: "person-1",
          admittedAt: "2026-11-13T03:00:00.000Z",
          status: "failed",
          questionPreview: `Pregunta original ${matchingQueryId}`,
          profileFields: {
            educationLevels: [{ id: "primaria", label: "Primaria" }],
            subjects: ["Matemática"],
          },
          isTest: false,
        },
      ],
      nextCursor: null,
    });
    expect(
      harness.commands.some((command) => command.input.TableName === conversationTableName),
    ).toBe(true);
    expect(harness.commands.some((command) => command.input.IndexName === recordsIndexName)).toBe(
      true,
    );
    const indexQuery = harness.commands.find((command) => command.input.IndexName);
    expect(indexQuery.input.ScanIndexForward).toBe(false);
    expect(indexQuery.input.KeyConditionExpression).toMatch(/createdAt/);
    const indexedInstants = commandValues(indexQuery.input)
      .map((value) => (typeof value === "number" ? value : Date.parse(value)))
      .filter(Number.isFinite);
    expect(indexedInstants).toContain(Date.parse("2026-11-13T03:00:00.000Z"));
    expect(
      indexedInstants.some(
        (instant) =>
          instant === Date.parse("2026-11-14T03:00:00.000Z") ||
          instant === Date.parse("2026-11-14T02:59:59.999Z"),
      ),
    ).toBe(true);
    expect(
      harness.commands.some(
        (command) => command.input.TableName === secondBot.conversationTableName,
      ),
    ).toBe(false);
    expectNoGeneration(harness);

    const withoutAccent = await harness.invoke(
      event({
        method: "POST",
        path: recordsPath("/search"),
        body: { filters: { ...filters, subject: "matematica" } },
      }),
    );
    expect(withoutAccent.statusCode).toBe(200);
    expect(responseBody(withoutAccent).results).toEqual([
      expect.objectContaining({
        conversationId: noAccent.conversationId,
        queryId: noAccent.queryId,
      }),
    ]);

    const testPersonFilters = { ...filters, personId: testPersonId };
    const excludeTeamTests = await harness.invoke(
      event({
        method: "POST",
        path: recordsPath("/search"),
        body: { filters: testPersonFilters },
      }),
    );
    expect(responseBody(excludeTeamTests).results).toEqual([]);
    const includeTeamTests = await harness.invoke(
      event({
        method: "POST",
        path: recordsPath("/search"),
        body: { filters: { ...testPersonFilters, excludeTests: false } },
      }),
    );
    expect(responseBody(includeTeamTests).results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: teamTestConversationId,
          personId: testPersonId,
          isTest: true,
        }),
      ]),
    );
    expectNoDynamoWrites(harness);
  });

  it("preserves an empty index page continuation and rejects a cursor reused for different filters", async () => {
    const conversationId = uuid("conversation-after-empty-page");
    const queryId = uuid("query-after-empty-page");
    const matching = turn({
      conversationId,
      queryId,
      personId: "person-2",
    });
    const harness = await loadAdminLambda({
      initialRows: [
        meta({ conversationId: matching.conversationId, personId: "person-2" }),
        matching,
        textChunk({ conversationId, queryId, text: "Consulta de continuación" }),
      ],
    });
    const filters = {
      from: "2026-11-13",
      to: "2026-11-13",
      status: "completed",
      personId: "person-2",
      levelId: "primaria",
      subject: "Matemática",
      excludeTests: true,
    };
    const continuationKey = {
      pk: matching.pk,
      sk: matching.sk,
      botId,
      createdAt: matching.createdAt,
      conversationId: matching.conversationId,
      ordinal: matching.ordinal,
    };
    harness.setIndexPages([
      { Items: [], LastEvaluatedKey: continuationKey },
      { Items: [], LastEvaluatedKey: continuationKey },
    ]);

    const emptyPage = await harness.invoke(
      event({ method: "POST", path: recordsPath("/search"), body: { filters } }),
    );

    expect(emptyPage.statusCode).toBe(200);
    expect(responseBody(emptyPage)).toMatchObject({ botId, results: [] });
    expect(typeof responseBody(emptyPage).nextCursor).toBe("string");
    const readsAfterFirstPage = harness.commands.length;
    const changedFilter = await harness.invoke(
      event({
        method: "POST",
        path: recordsPath("/search"),
        body: {
          filters: { ...filters, subject: "Lengua" },
          cursor: responseBody(emptyPage).nextCursor,
        },
      }),
    );
    expect(changedFilter.statusCode).toBe(400);
    expect(harness.commands).toHaveLength(readsAfterFirstPage);

    harness.setIndexPages([{ Items: [matching], LastEvaluatedKey: undefined }]);
    const continued = await harness.invoke(
      event({
        method: "POST",
        path: recordsPath("/search"),
        body: { filters, cursor: responseBody(emptyPage).nextCursor },
      }),
    );
    expect(continued.statusCode).toBe(200);
    expect(responseBody(continued).results).toEqual([
      expect.objectContaining({
        conversationId: matching.conversationId,
        queryId: matching.queryId,
      }),
    ]);
    expectNoGeneration(harness);
  });

  it("finds an exact long Unicode subject and reopens the same canonical export receipt", async () => {
    const conversationId = uuid("conversation-long-subject");
    const queryId = uuid("query-long-subject");
    const subject = `Fonética ǰ, ${"İ".repeat(1_117)}`;
    const inputSubject = ` FONÉTICA J\u030c, ${"İ".repeat(1_117)} `;
    const canonicalSubject = `fonética ǰ, ${"i\u0307".repeat(1_117)}`;
    const harness = await loadAdminLambda({
      initialRows: [
        meta({ conversationId }),
        turn({ conversationId, queryId, fields: { educationLevels: [], subjects: [subject] } }),
        textChunk({ conversationId, queryId, text: "¿Cómo enseño fonética?" }),
      ],
    });
    const search = async (subjectFilter) =>
      harness.invoke(
        event({
          method: "POST",
          path: recordsPath("/search"),
          body: { filters: { subject: subjectFilter } },
        }),
      );

    const matching = await search(inputSubject);
    expect(matching.statusCode).toBe(200);
    expect(responseBody(matching).results).toEqual([expect.objectContaining({ queryId })]);
    const different = await search(canonicalSubject.replace(",", ""));
    expect(different.statusCode).toBe(200);
    expect(responseBody(different).results).toEqual([]);

    const start = async (subjectFilter) =>
      harness.invoke(
        event({
          method: "POST",
          path: recordsPath("/exports"),
          body: { exportId, filters: { subject: subjectFilter } },
        }),
      );
    expect((await start(inputSubject)).statusCode).toBe(202);
    expect(harness.executions.size).toBe(1);
    const [execution] = harness.executions.values();
    expect(JSON.parse(execution.input).filters.subject).toBe(canonicalSubject);
    harness.setExecution(execution.name, { status: "SUCCEEDED", output: { status: "empty" } });
    const replay = await start(canonicalSubject);
    expect(replay.statusCode).toBe(202);
    expect(responseBody(replay)).toEqual({ botId, exportId, status: "processing" });
    const receipt = await harness.invoke(event({ path: recordsPath(`/exports/${exportId}`) }));
    expect(receipt.statusCode).toBe(200);
    expect(responseBody(receipt)).toEqual({ botId, exportId, status: "empty" });
    expect(harness.executions.size).toBe(1);
    const initialStarts = harness.commands.filter(
      (command) => command.constructor.name === "StartExecutionCommand",
    ).length;
    // The text occupies less than 256 Ki characters, but the envelope exceeds 256 KiB.
    expect((await start("á".repeat(128 * 1024))).statusCode).toBe(400);
    expect(
      harness.commands.filter((command) => command.constructor.name === "StartExecutionCommand"),
    ).toHaveLength(initialStarts);
  });

  it("opens on the matching ordinal and pages both ways inside the original ordinal cut", async () => {
    const conversationId = uuid("conversation-with-many-turns");
    const path = recordsPath(`/conversations/${conversationId}`);
    const turns = Array.from({ length: 80 }, (_, index) =>
      turn({ conversationId, ordinal: index + 1, queryId: uuid(`conversation-turn-${index + 1}`) }),
    );
    const harness = await loadAdminLambda({
      initialRows: [meta({ conversationId, lastOrdinal: 80 }), ...turns],
    });
    const get = async (query) => harness.invoke(event({ path, query }));
    const page = async (query, first, last, throughOrdinal = 80) => {
      const response = await get(query);
      expect(response.statusCode).toBe(200);
      const body = responseBody(response);
      expect(body.throughOrdinal).toBe(throughOrdinal);
      expect(body.turns.map(({ ordinal }) => ordinal)).toEqual(
        Array.from({ length: last - first + 1 }, (_, index) => first + index),
      );
      return body;
    };
    const anchored = await page({ ordinal: "37" }, 13, 37);
    expect(anchored.turns.at(-1).queryId).toBe(turns[36].queryId);
    expect(anchored.nextCursor).toEqual(expect.any(String));
    expect(anchored.newerCursor).toEqual(expect.any(String));
    expect((await get({ ordinal: "0" })).statusCode).toBe(400);
    expect((await get({ ordinal: "37", cursor: anchored.newerCursor })).statusCode).toBe(400);
    expect((await get({ ordinal: "81" })).statusCode).toBe(404);

    addRows(
      harness.rows,
      meta({ conversationId, lastOrdinal: 81 }),
      turn({ conversationId, ordinal: 81, queryId: uuid("conversation-turn-81") }),
    );
    const older = await page({ cursor: anchored.nextCursor }, 1, 12);
    expect(older.nextCursor).toBeNull();
    const newer = await page({ cursor: anchored.newerCursor }, 38, 62);
    await page({ cursor: newer.nextCursor }, 13, 37);
    const newestAtCut = await page({ cursor: newer.newerCursor }, 63, 80);
    expect(newestAtCut.newerCursor).toBeNull();
    const latest = await page(undefined, 57, 81, 81);
    expect(latest.newerCursor).toBeNull();
    expectNoGeneration(harness);
  });

  it("assembles a page when a partition keeps returning a smaller batch of unprocessed keys", async () => {
    const conversationId = uuid("batch-get-partial-progress");
    const turns = Array.from({ length: 25 }, (_, index) =>
      turn({ conversationId, ordinal: index + 1, queryId: uuid(`batch-get-turn-${index + 1}`) }),
    );
    const harness = await loadAdminLambda({
      initialRows: [meta({ conversationId, lastOrdinal: turns.length }), ...turns],
      batchLimit: 3,
    });
    const response = await harness.invoke(
      event({ path: recordsPath(`/conversations/${conversationId}`) }),
    );
    expect(response.statusCode).toBe(200);
    expect(responseBody(response).turns.map(({ queryId }) => queryId)).toEqual(
      turns.map(({ queryId }) => queryId),
    );
    const requestedCounts = harness.commands
      .filter((command) => command.constructor.name === "BatchGetCommand")
      .map((command) => command.input.RequestItems[conversationTableName].Keys.length);
    expect(requestedCounts).toEqual([25, 22, 19, 16, 13, 10, 7, 4, 1]);
    expectNoGeneration(harness);
  });

  it("ends the batch read after bounded retries without any progress", async () => {
    const conversationId = uuid("batch-get-stalled");
    const harness = await loadAdminLambda({
      initialRows: [
        meta({ conversationId }),
        turn({ conversationId, queryId: uuid("stalled-turn") }),
      ],
      batchLimit: 0,
    });
    const response = await harness.invoke(
      event({ path: recordsPath(`/conversations/${conversationId}`) }),
    );
    expect(response.statusCode).toBe(503);
    expect(
      harness.commands.filter((command) => command.constructor.name === "BatchGetCommand"),
    ).toHaveLength(6);
    expectNoGeneration(harness);
  });

  it("reads hidden conversation manifests and original text in order without restoring or mutating history", async () => {
    const conversationId = uuid("removed-from-owner-history");
    const query1 = uuid("query-original");
    const query2 = uuid("query-follow-up");
    const history = meta({
      conversationId,
      personId: "person-1",
      lastOrdinal: 2,
      hiddenAt: "2026-11-13T16:00:00.000Z",
    });
    const first = turn({
      conversationId,
      queryId: query1,
      ordinal: 1,
      admittedAt: "2026-11-13T15:00:00.000Z",
      status: "completed",
      questionCount: 2,
      answerCount: 2,
    });
    const second = turn({
      conversationId,
      queryId: query2,
      ordinal: 2,
      admittedAt: "2026-11-13T15:05:00.000Z",
      status: "failed",
      answerCount: 1,
      answerComplete: false,
      failureCode: "provider_error",
    });
    const questionFirst = textChunk({ conversationId, queryId: query1, text: "¿Cómo enseño " });
    const questionSecond = textChunk({
      conversationId,
      queryId: query1,
      index: 1,
      text: "fracciones?",
    });
    const answerFirst = textChunk({
      conversationId,
      queryId: query1,
      role: "assistant",
      text: "Con material ",
    });
    const answerSecond = textChunk({
      conversationId,
      queryId: query1,
      role: "assistant",
      index: 1,
      text: "concreto.",
    });
    const partialAnswer = textChunk({
      conversationId,
      queryId: query2,
      ordinal: 2,
      role: "assistant",
      text: "Podrías usar ",
    });
    const harness = await loadAdminLambda({
      initialRows: [
        history,
        first,
        second,
        questionFirst,
        questionSecond,
        answerFirst,
        answerSecond,
        partialAnswer,
      ],
    });

    const opened = await harness.invoke(
      event({ method: "GET", path: recordsPath(`/conversations/${conversationId}`) }),
    );

    expect(opened.statusCode).toBe(200);
    expect(opened.headers["cache-control"]).toBe("no-store");
    expect(responseBody(opened)).toEqual({
      botId,
      conversationId,
      personId: "person-1",
      hidden: true,
      isTest: false,
      throughOrdinal: 2,
      turns: [
        {
          ordinal: 1,
          queryId: query1,
          admittedAt: first.createdAt,
          status: "completed",
          answerComplete: true,
          profileFields: first.profileSnapshot.fields,
        },
        {
          ordinal: 2,
          queryId: query2,
          admittedAt: second.createdAt,
          status: "failed",
          answerComplete: false,
          profileFields: second.profileSnapshot.fields,
          failureCode: "provider_error",
        },
      ],
      nextCursor: null,
      newerCursor: null,
    });

    const question = await harness.invoke(
      event({
        method: "GET",
        path: recordsPath(`/conversations/${conversationId}/turns/1/text`),
        query: { role: "question" },
      }),
    );
    const answer = await harness.invoke(
      event({
        method: "GET",
        path: recordsPath(`/conversations/${conversationId}/turns/1/text`),
        query: { role: "answer" },
      }),
    );
    const partial = await harness.invoke(
      event({
        method: "GET",
        path: recordsPath(`/conversations/${conversationId}/turns/2/text`),
        query: { role: "answer" },
      }),
    );
    expect(responseBody(question)).toEqual({
      botId,
      conversationId,
      ordinal: 1,
      role: "question",
      text: "¿Cómo enseño fracciones?",
      nextCursor: null,
    });
    expect(responseBody(answer)).toMatchObject({
      text: "Con material concreto.",
      status: "completed",
      answerComplete: true,
    });
    expect(responseBody(partial)).toMatchObject({
      text: "Podrías usar ",
      status: "failed",
      answerComplete: false,
      failureCode: "provider_error",
    });
    expect(
      harness.commands.filter((command) => command.constructor.name === "QueryCommand"),
    ).toHaveLength(3);
    expectNoGeneration(harness);

    const wrongBotMeta = meta({
      targetBotId: secondBot.botId,
      conversationId: uuid("conversation-owned-by-another-bot"),
      personId: "private-person",
    });
    addRows(harness.rows, wrongBotMeta);
    const foreignRead = await harness.invoke(
      event({
        method: "GET",
        path: recordsPath(`/conversations/${wrongBotMeta.conversationId}`),
      }),
    );
    expect(foreignRead.statusCode).not.toBe(200);
    expect(foreignRead.body).not.toContain("private-person");

    const inconsistentConversationId = uuid("conversation-with-inconsistent-turn");
    const inconsistentQueryId = uuid("query-with-inconsistent-owner");
    const inconsistentTurn = turn({
      conversationId: inconsistentConversationId,
      queryId: inconsistentQueryId,
      personId: "different-owner",
    });
    addRows(
      harness.rows,
      meta({ conversationId: inconsistentConversationId, personId: "person-1" }),
      inconsistentTurn,
    );
    const inconsistentRead = await harness.invoke(
      event({
        method: "GET",
        path: recordsPath(`/conversations/${inconsistentConversationId}`),
      }),
    );
    expect(inconsistentRead.statusCode).not.toBe(200);
    expect(inconsistentRead.body).not.toContain(inconsistentQueryId);
    expectNoDynamoWrites(harness);
  });

  it("pages a large original question across durable text fragments without dropping or reordering bytes", async () => {
    const conversationId = uuid("conversation-long-question");
    const queryId = uuid("query-long-question");
    const fragmentCount = 11;
    const fragments = Array.from(
      { length: fragmentCount },
      (_, index) => `${index}: ${"¿á".repeat(75_000)}`,
    );
    const original = fragments.join("");
    const chunks = fragments.map((text, index) =>
      textChunk({ conversationId, queryId, index, text }),
    );
    const harness = await loadAdminLambda({
      initialRows: [
        meta({ conversationId, personId: "person-1" }),
        turn({ conversationId, queryId, questionCount: fragmentCount }),
        ...chunks,
      ],
    });
    let cursor;
    let assembled = "";
    let pageCount = 0;
    let malformedCursorChecked = false;
    do {
      const response = await harness.invoke(
        event({
          method: "GET",
          path: recordsPath(`/conversations/${conversationId}/turns/1/text`),
          query: { role: "question", ...(cursor ? { cursor } : {}) },
        }),
      );
      expect(response.statusCode).toBe(200);
      const body = responseBody(response);
      assembled += body.text;
      cursor = body.nextCursor;
      pageCount += 1;
      expect(pageCount).toBeLessThanOrEqual(fragmentCount);
      if (cursor && !malformedCursorChecked) {
        const cursorValue = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        cursorValue.through = cursorValue.nextIndex;
        const malformedCursor = Buffer.from(JSON.stringify(cursorValue)).toString("base64url");
        const queryCount = harness.commands.filter(
          (command) => command.constructor.name === "QueryCommand",
        ).length;
        const rejected = await harness.invoke(
          event({
            method: "GET",
            path: recordsPath(`/conversations/${conversationId}/turns/1/text`),
            query: { role: "question", cursor: malformedCursor },
          }),
        );
        expect(rejected.statusCode).toBe(400);
        expect(
          harness.commands.filter((command) => command.constructor.name === "QueryCommand"),
        ).toHaveLength(queryCount);
        malformedCursorChecked = true;
      }
    } while (cursor);

    expect(pageCount).toBeGreaterThan(1);
    expect(malformedCursorChecked).toBe(true);
    expect(assembled).toBe(original);
    expect(Buffer.byteLength(assembled, "utf8")).toBe(Buffer.byteLength(original, "utf8"));
    expectNoGeneration(harness);
  });

  it.each([
    { status: "completed", append: false, answerComplete: true },
    { status: "failed", append: true, answerComplete: false, failureCode: "provider_error" },
  ])(
    "keeps the text and answer metadata on one cut when the turn becomes $status",
    async (terminal) => {
      const conversationId = uuid(`conversation-answer-cut-${terminal.status}`);
      const queryId = uuid(`query-answer-cut-${terminal.status}`);
      const original = ["a", "b", "c", "d", "e", "f"];
      const chunks = original.map((text, index) =>
        textChunk({ conversationId, queryId, role: "assistant", index, text }),
      );
      const harness = await loadAdminLambda({
        initialRows: [
          meta({ conversationId }),
          turn({ conversationId, queryId, status: "in_progress", answerCount: original.length }),
          ...chunks,
        ],
      });
      const get = async (cursor) => {
        const response = await harness.invoke(
          event({
            path: recordsPath(`/conversations/${conversationId}/turns/1/text`),
            query: { role: "answer", ...(cursor ? { cursor } : {}) },
          }),
        );
        expect(response.statusCode).toBe(200);
        return responseBody(response);
      };
      const beforeTerminal = await get();
      expect(beforeTerminal).toMatchObject({
        text: "abcd",
        status: "in_progress",
        answerComplete: false,
        nextCursor: expect.any(String),
      });
      const { append, ...terminalState } = terminal;
      addRows(
        harness.rows,
        turn({
          conversationId,
          queryId,
          ...terminalState,
          answerCount: original.length + Number(append),
        }),
      );
      if (append) {
        addRows(
          harness.rows,
          textChunk({
            conversationId,
            queryId,
            role: "assistant",
            index: original.length,
            text: "g",
          }),
        );
      }
      const previousCut = await get(beforeTerminal.nextCursor);
      expect(previousCut).toMatchObject({
        text: "ef",
        status: "in_progress",
        answerComplete: false,
        nextCursor: null,
      });
      expect(previousCut).not.toHaveProperty("failureCode");
      const fresh = await get();
      expect(fresh).toMatchObject({
        ...terminalState,
        text: "abcd",
        nextCursor: expect.any(String),
      });
      const freshEnd = await get(fresh.nextCursor);
      expect(freshEnd).toMatchObject({
        ...terminalState,
        text: append ? "efg" : "ef",
        nextCursor: null,
      });
      expectNoGeneration(harness);
    },
  );

  it("uses text continuation only when necessary and still rejects fragments outside terminal manifests", async () => {
    const conversationId = uuid("terminal-answer-integrity");
    const completeQueryId = uuid("terminal-answer-completed");
    const failedQueryId = uuid("terminal-answer-no-fragments");
    const complete = turn({ conversationId, queryId: completeQueryId, answerCount: 16 });
    const failed = turn({
      conversationId,
      queryId: failedQueryId,
      ordinal: 2,
      status: "failed",
      failureCode: "provider_error",
    });
    const chunk = (descriptor, index, text) =>
      textChunk({
        conversationId,
        queryId: descriptor.queryId,
        ordinal: descriptor.ordinal,
        role: "assistant",
        index,
        text,
      });
    const harness = await loadAdminLambda({
      initialRows: [
        meta({ conversationId, lastOrdinal: 2 }),
        complete,
        failed,
        ...Array.from({ length: 16 }, (_, index) => chunk(complete, index, "x")),
      ],
    });
    const { createRecordsReader } = await import("../../api/records-reader.ts");
    const reader = createRecordsReader({
      botId,
      conversationTableName,
      recordsIndexName,
      testPersonIds: [],
      documentClient: { send: harness.dynamoSend },
      environment: "dev",
    });
    const consume = async (descriptor) => {
      let output = "";
      for await (const piece of reader.readTextChunks(descriptor, "answer")) output += piece;
      return output;
    };
    const countQueries = () =>
      harness.commands.filter((command) => command.constructor.name === "QueryCommand").length;
    expect(await consume(complete)).toBe("x".repeat(16));
    expect(countQueries()).toBe(1);
    const get = async (ordinal, cursor) =>
      harness.invoke(
        event({
          path: recordsPath(`/conversations/${conversationId}/turns/${ordinal}/text`),
          query: { role: "answer", ...(cursor ? { cursor } : {}) },
        }),
      );
    const zero = await get(2);
    expect(zero.statusCode).toBe(200);
    expect(responseBody(zero)).toMatchObject({
      text: "",
      status: "failed",
      answerComplete: false,
      failureCode: "provider_error",
    });
    expect(countQueries()).toBe(2);
    expect(await consume(failed)).toBe("");
    expect(countQueries()).toBe(3);

    addRows(
      harness.rows,
      chunk(complete, 16, "unexpected extra"),
      chunk(failed, 0, "unreported answer"),
    );
    await expect(consume(complete)).rejects.toMatchObject({ code: "RECORDS_UNAVAILABLE" });
    expect(countQueries()).toBe(5);
    await expect(consume(failed)).rejects.toMatchObject({ code: "RECORDS_UNAVAILABLE" });
    expect((await get(2)).statusCode).toBe(503);
    let cursor;
    for (let page = 0; page < 3; page += 1) {
      const response = await get(1, cursor);
      expect(response.statusCode).toBe(200);
      cursor = responseBody(response).nextCursor;
      expect(cursor).toEqual(expect.any(String));
    }
    expect((await get(1, cursor)).statusCode).toBe(503);
    expectNoGeneration(harness);
  });

  it("authorizes before reads and resolves chatbot resources from the server catalog", async () => {
    const candidate = turn({
      conversationId: uuid("conversation-for-auth"),
      queryId: uuid("query-auth"),
    });
    const harness = await loadAdminLambda({ initialRows: [candidate] });

    const noBearer = await harness.invoke(
      event({ method: "POST", path: recordsPath("/search"), body: { filters: {} }, token: null }),
    );
    const wrongGroup = await harness.invoke(
      event({
        method: "POST",
        path: recordsPath("/search"),
        body: { filters: {} },
        claims: phase11AdminClaims({ groups: ["teacher"] }),
      }),
    );
    const uncataloguedBot = await harness.invoke(
      event({
        method: "POST",
        path: "/api/admin/bots/unknown/records/search",
        body: { filters: {} },
      }),
    );

    expect(noBearer.statusCode).toBe(401);
    expect(wrongGroup.statusCode).toBe(403);
    expect(uncataloguedBot.statusCode).toBe(404);
    expect(harness.commands).toEqual([]);
    expect(harness.sfnCommands).toEqual([]);
    expect(harness.s3Commands).toEqual([]);
  });

  it("starts one scoped export, verifies its receipt before refreshing short-lived downloads, and withholds invalid links", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(phase11Now));
    const harness = await loadAdminLambda();
    const filters = {
      from: "2026-11-01",
      to: "2026-11-13",
      status: "completed",
      personId: "person-1",
      levelId: "primaria",
      subject: "Matemática",
      excludeTests: true,
    };
    const startPath = recordsPath("/exports");
    const request = { exportId, filters };

    const started = await harness.invoke(event({ method: "POST", path: startPath, body: request }));
    expect(started.statusCode).toBe(202);
    expect(responseBody(started)).toEqual({ botId, exportId, status: "processing" });
    expect(started.headers["cache-control"]).toBe("no-store");
    const startCommand = harness.sfnCommands.find(
      (command) => command.constructor.name === "StartExecutionCommand",
    );
    expect(startCommand.input.stateMachineArn).toBe(
      "arn:aws:states:us-east-1:118903272638:stateMachine:multi-chatbot-dev-admin-records-export",
    );
    const expectedExecutionName = `records-${createHash("sha256")
      .update(JSON.stringify(["dev", botId, adminSub, exportId]))
      .digest("hex")}`;
    expect(startCommand.input.name).toBe(expectedExecutionName);
    const privateInput = JSON.parse(startCommand.input.input);
    expect(privateInput).toMatchObject({ botId, actorSub: adminSub, exportId });
    expect(privateInput.filters).toMatchObject({ ...filters, subject: "matemática" });

    const replay = await harness.invoke(
      event({
        method: "POST",
        path: startPath,
        body: { ...request, filters: { ...filters, subject: "  MATEMÁTICA " } },
      }),
    );
    expect(replay.statusCode).toBe(202);
    expect(responseBody(replay)).toEqual(responseBody(started));
    expect(harness.executions.size).toBe(1);
    expect(
      harness.sfnCommands
        .filter((command) => command.constructor.name === "StartExecutionCommand")
        .every(
          (command) =>
            command.input.name === expectedExecutionName &&
            command.input.input === startCommand.input.input,
        ),
    ).toBe(true);

    const conflictingRetry = await harness.invoke(
      event({
        method: "POST",
        path: startPath,
        body: { ...request, filters: { ...filters, subject: "Lengua" } },
      }),
    );
    expect(conflictingRetry.statusCode).toBe(409);
    expect(harness.executions.size).toBe(1);

    const processing = await harness.invoke(
      event({ method: "GET", path: recordsPath(`/exports/${exportId}`) }),
    );
    expect(responseBody(processing)).toEqual({ botId, exportId, status: "processing" });

    const attemptId = uuid("attempt-1");
    const workerResult = {
      status: "ready",
      objectKey: `exports/${expectedExecutionName}/${attemptId}.csv`,
      conversationCount: 3,
      rowCount: 9,
      bytes: 4096,
      eTag: '"export-etag"',
    };
    harness.setExecution(expectedExecutionName, { status: "SUCCEEDED", output: workerResult });
    harness.setHeadObject({ ETag: workerResult.eTag, ContentLength: workerResult.bytes });
    const ready = await harness.invoke(
      event({ method: "GET", path: recordsPath(`/exports/${exportId}`) }),
    );
    expect(ready.statusCode).toBe(200);
    expect(ready.headers["cache-control"]).toBe("no-store");
    expect(responseBody(ready)).toMatchObject({
      botId,
      exportId,
      status: "ready",
      conversationCount: 3,
      rowCount: 9,
      bytes: 4096,
      expiresAt: expect.any(String),
    });
    const readyExpiresAt = Date.parse(responseBody(ready).expiresAt);
    expect(Number.isFinite(readyExpiresAt)).toBe(true);
    const headCountAfterReady = harness.s3Commands.filter(
      (command) => command.constructor.name === "HeadObjectCommand",
    ).length;

    const otherAdmin = phase11AdminClaims({ sub: "another-admin" });
    const otherAdminDownload = await harness.invoke(
      event({
        method: "POST",
        path: recordsPath(`/exports/${exportId}/download`),
        body: {},
        claims: otherAdmin,
      }),
    );
    expect(otherAdminDownload.statusCode).not.toBe(200);
    expect(otherAdminDownload.body).not.toContain("url");
    const nonAdminDownload = await harness.invoke(
      event({
        method: "POST",
        path: recordsPath(`/exports/${exportId}/download`),
        body: {},
        claims: phase11AdminClaims({ groups: ["teacher"] }),
      }),
    );
    expect(nonAdminDownload.statusCode).toBe(403);
    const otherBotDownload = await harness.invoke(
      event({
        method: "POST",
        path: `/api/admin/bots/${secondBot.botId}/records/exports/${exportId}/download`,
        body: {},
      }),
    );
    expect(otherBotDownload.statusCode).not.toBe(200);
    expect(otherBotDownload.body).not.toContain("url");
    expect(
      harness.s3Commands.filter((command) => command.constructor.name === "HeadObjectCommand"),
    ).toHaveLength(headCountAfterReady);

    harness.setHeadObject({ ETag: '"wrong-etag"', ContentLength: workerResult.bytes });
    const mismatchedETag = await harness.invoke(
      event({ method: "POST", path: recordsPath(`/exports/${exportId}/download`), body: {} }),
    );
    expect(mismatchedETag.statusCode).not.toBe(200);
    expect(mismatchedETag.body).not.toContain("url");
    expect(
      harness.s3Commands.filter((command) => command.constructor.name === "HeadObjectCommand"),
    ).toHaveLength(headCountAfterReady + 1);

    harness.setHeadObject({ ETag: workerResult.eTag, ContentLength: workerResult.bytes - 1 });
    const mismatchedLength = await harness.invoke(
      event({ method: "POST", path: recordsPath(`/exports/${exportId}/download`), body: {} }),
    );
    expect(mismatchedLength.statusCode).not.toBe(200);
    expect(mismatchedLength.body).not.toContain("url");
    expect(
      harness.s3Commands.filter((command) => command.constructor.name === "HeadObjectCommand"),
    ).toHaveLength(headCountAfterReady + 2);

    harness.setHeadObject({ ETag: workerResult.eTag, ContentLength: workerResult.bytes });
    const firstDownload = await harness.invoke(
      event({ method: "POST", path: recordsPath(`/exports/${exportId}/download`), body: {} }),
    );
    expect(firstDownload.statusCode).toBe(200);
    expect(firstDownload.headers["cache-control"]).toBe("no-store");
    expect(responseBody(firstDownload)).toMatchObject({
      botId,
      exportId,
      url: expect.stringMatching(/^https:\/\//),
      expiresAt: expect.any(String),
    });
    const firstUrl = new URL(responseBody(firstDownload).url);
    expect(firstUrl.searchParams.get("response-content-disposition")).toMatch(/^attachment/);
    expect(firstUrl.searchParams.get("response-cache-control")).toContain("no-store");
    const firstLinkSeconds = Number(firstUrl.searchParams.get("X-Amz-Expires"));
    expect(firstLinkSeconds).toBeGreaterThan(0);
    expect(firstLinkSeconds).toBeLessThanOrEqual(120);
    expect(Date.parse(responseBody(firstDownload).expiresAt)).toBeLessThanOrEqual(
      Math.min(phase11Now + 120_000, readyExpiresAt),
    );
    const headCommand = harness.s3Commands.at(-1);
    expect(headCommand.input.Bucket).toBe(defaultBot.uploadBucketName);
    expect(headCommand.input.Key).toBe(workerResult.objectKey);
    expect(
      harness.s3Commands.filter((command) => command.constructor.name === "HeadObjectCommand"),
    ).toHaveLength(headCountAfterReady + 3);

    vi.setSystemTime(new Date(phase11Now + 1_000));
    const refreshedDownload = await harness.invoke(
      event({ method: "POST", path: recordsPath(`/exports/${exportId}/download`), body: {} }),
    );
    expect(refreshedDownload.statusCode).toBe(200);
    expect(responseBody(refreshedDownload).url).not.toBe(responseBody(firstDownload).url);
    expect(
      harness.s3Commands.filter((command) => command.constructor.name === "HeadObjectCommand"),
    ).toHaveLength(headCountAfterReady + 4);

    const wrongKeyId = "70896ec8-e643-4aca-89da-aacfa96434df";
    await harness.invoke(
      event({ method: "POST", path: startPath, body: { exportId: wrongKeyId, filters } }),
    );
    const wrongKeyName = [...harness.executions.entries()].find(
      ([, execution]) => JSON.parse(execution.input).exportId === wrongKeyId,
    )[0];
    harness.setExecution(wrongKeyName, {
      status: "SUCCEEDED",
      output: {
        ...workerResult,
        objectKey: `exports/${expectedExecutionName}/${uuid("wrong-key-attempt")}.csv`,
      },
    });
    const wrongKeyDownload = await harness.invoke(
      event({ method: "POST", path: recordsPath(`/exports/${wrongKeyId}/download`), body: {} }),
    );
    expect(wrongKeyDownload.statusCode).not.toBe(200);
    expect(wrongKeyDownload.body).not.toContain("url");
    expect(
      harness.s3Commands.filter((command) => command.constructor.name === "HeadObjectCommand"),
    ).toHaveLength(headCountAfterReady + 4);

    const failedId = "a401de12-209b-4f24-a09c-7bed3bb44679";
    await harness.invoke(
      event({ method: "POST", path: startPath, body: { exportId: failedId, filters } }),
    );
    const failedName = [...harness.executions.entries()].find(
      ([, execution]) => JSON.parse(execution.input).exportId === failedId,
    )[0];
    harness.setExecution(failedName, { status: "FAILED" });
    const failed = await harness.invoke(
      event({ method: "GET", path: recordsPath(`/exports/${failedId}`) }),
    );
    expect(responseBody(failed)).toEqual({ botId, exportId: failedId, status: "failed" });
    const linkForFailure = await harness.invoke(
      event({ method: "POST", path: recordsPath(`/exports/${failedId}/download`), body: {} }),
    );
    expect(linkForFailure.statusCode).not.toBe(200);
    expect(linkForFailure.body).not.toContain("url");

    const emptyId = "3be44c6d-20ec-49d1-94d9-7dd26f05d62b";
    await harness.invoke(
      event({ method: "POST", path: startPath, body: { exportId: emptyId, filters } }),
    );
    const emptyName = [...harness.executions.entries()].find(
      ([, execution]) => JSON.parse(execution.input).exportId === emptyId,
    )[0];
    harness.setExecution(emptyName, { status: "SUCCEEDED", output: { status: "empty" } });
    const empty = await harness.invoke(
      event({ method: "GET", path: recordsPath(`/exports/${emptyId}`) }),
    );
    expect(responseBody(empty)).toEqual({ botId, exportId: emptyId, status: "empty" });
    const emptyLink = await harness.invoke(
      event({ method: "POST", path: recordsPath(`/exports/${emptyId}/download`), body: {} }),
    );
    expect(emptyLink.statusCode).not.toBe(200);
    expect(emptyLink.body).not.toContain("url");

    vi.setSystemTime(new Date(phase11Now + 24 * 60 * 60 * 1000 + 1));
    const expired = await harness.invoke(
      event({ method: "GET", path: recordsPath(`/exports/${exportId}`) }),
    );
    expect(responseBody(expired).status).toBe("expired");
    const expiredLink = await harness.invoke(
      event({ method: "POST", path: recordsPath(`/exports/${exportId}/download`), body: {} }),
    );
    expect(expiredLink.statusCode).not.toBe(200);
    expect(expiredLink.body).not.toContain("url");
    expect(
      harness.s3Commands.filter((command) => command.constructor.name === "HeadObjectCommand"),
    ).toHaveLength(headCountAfterReady + 4);
  });
});
