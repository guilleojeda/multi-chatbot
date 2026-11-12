import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createAccountStoreAdapter } from "../../api/aws-adapters.ts";
import { createProfileStoreAdapter } from "../../api/profile-store.ts";
import { createChatHandler } from "../../runtime/chat.ts";
import { siteConfig } from "../../config/site.ts";

// The application factories and Lambda composition are real. This transport only implements
// point reads/writes and an empty external query result; it has no permission or CAS rules.
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
const queryId = "3afba813-851b-4bfd-9ed6-e1c335a61011";
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

function rowKey(table, key) {
  return JSON.stringify([table, key.pk, key.sk]);
}

function seed(key, fields) {
  rows.set(rowKey(accountTable, key), structuredClone({ ...key, ...fields }));
}

function seedAccess(fields = {}) {
  seed(accessKey, { sub, botId, access: "active", revision: 3, ...fields });
}

function event(method, path, body) {
  return {
    version: "2.0",
    rawPath: path,
    requestContext: {
      http: { method, path },
      authorizer: { jwt: { claims: { sub, token_use: "access" } } },
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
      if (command instanceof QueryCommand) return { Items: [] };
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

  it("denies profile reads before loading personal data when ACCESS has no grant", async () => {
    seedAccess({ access: "none" });
    seed(legacyMemberKey, { sub, botId });
    seed(profileKey, validProfile);

    const response = await accountLambda(event("GET", "/api/profile"));

    expect(response.statusCode).toBe(403);
    expect(accountReads().some((command) => command.input.Key.sk === "PROFILE")).toBe(false);
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
