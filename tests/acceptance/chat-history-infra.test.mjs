import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { afterAll, describe, expect, it } from "vitest";
import { resolveEnvironment } from "../../dist/config/project.js";
import { AccountStack } from "../../dist/infra/lib/account-stack.js";
import { PublicSiteStack } from "../../dist/infra/lib/public-site-stack.js";
import { SharedIdentityStack } from "../../dist/infra/lib/shared-identity-stack.js";

const projectRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const chatStackSource = path.join(projectRoot, "infra/lib/chat-stack.ts");
const temporaryDirectories = new Set();
const scenarioCache = new Map();
const expectedRuntimeId = "ChatRuntime82B3183A";
const expectedConversationTableId = "ConversationTable75C14D21";
const disabledCachePolicyId = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function records(template, type) {
  return Object.entries(template.Resources || {})
    .filter(([, resource]) => resource.Type === type)
    .map(([logicalId, resource]) => ({
      logicalId,
      resource,
      properties: resource.Properties || {},
    }));
}

function onlyRecord(template, type, message = `expected one ${type}`) {
  const matches = records(template, type);
  expect(matches, message).toHaveLength(1);
  return matches[0];
}

function actions(statement) {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function rolePolicies(template, roleLogicalId) {
  const role = template.Resources?.[roleLogicalId];
  const inline = (role?.Properties?.Policies || []).flatMap(
    (policy) => policy.PolicyDocument?.Statement || [],
  );
  const attached = records(template, "AWS::IAM::Policy")
    .filter(({ properties }) => JSON.stringify(properties.Roles || {}).includes(roleLogicalId))
    .flatMap(({ properties }) => properties.PolicyDocument?.Statement || []);
  return [...inline, ...attached];
}

function logicalIdFromGetAtt(reference) {
  const getAtt = reference?.["Fn::GetAtt"];
  if (Array.isArray(getAtt)) return getAtt[0];
  if (typeof getAtt === "string") return getAtt.split(".")[0];
  return undefined;
}

function descendants(value, visit) {
  if (Array.isArray(value)) {
    for (const child of value) descendants(child, visit);
  } else if (value && typeof value === "object") {
    visit(value);
    for (const child of Object.values(value)) descendants(child, visit);
  }
}

function referencesResource(value, logicalId) {
  let matched = false;
  descendants(value, (node) => {
    const getAtt = node["Fn::GetAtt"];
    if (
      node.Ref === logicalId ||
      getAtt === logicalId ||
      (Array.isArray(getAtt) && getAtt[0] === logicalId)
    ) {
      matched = true;
    }
  });
  return matched;
}

function templateString(value, stackName) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => templateString(entry, stackName)).join("");
  if (!value || typeof value !== "object") return String(value ?? "");
  if (value.Ref === "AWS::Partition") return "aws";
  if (value.Ref === "AWS::StackName") return stackName ?? "${AWS::StackName}";
  if (Array.isArray(value["Fn::Join"])) {
    const [separator, pieces] = value["Fn::Join"];
    return (pieces || []).map((piece) => templateString(piece, stackName)).join(separator);
  }
  if (typeof value["Fn::Sub"] === "string") {
    return value["Fn::Sub"]
      .replaceAll("${AWS::Partition}", "aws")
      .replaceAll("${AWS::StackName}", stackName ?? "${AWS::StackName}");
  }
  return JSON.stringify(value);
}

function outputsForResource(template, logicalId) {
  return Object.entries(template.Outputs || {}).filter(([, output]) =>
    JSON.stringify(output.Value || {}).includes(logicalId),
  );
}

function referencesExportedOutput(value, template, stackName, logicalId) {
  const outputs = outputsForResource(template, logicalId);
  if (outputs.length === 0) return false;
  let matched = false;
  descendants(value, (node) => {
    const imported = node["Fn::ImportValue"];
    if (
      outputs.some(
        ([, output]) =>
          output.Export?.Name !== undefined &&
          JSON.stringify(imported) === JSON.stringify(output.Export.Name),
      )
    ) {
      matched = true;
    }
    const stackOutput = node["Fn::GetStackOutput"];
    if (
      stackOutput?.StackName === stackName &&
      outputs.some(([outputName]) => stackOutput.OutputName === outputName)
    ) {
      matched = true;
    }
  });
  return matched;
}

function referencesStackResource(value, resource, sourceTemplate, sourceStackName) {
  return (
    referencesResource(value, resource.logicalId) ||
    referencesExportedOutput(value, sourceTemplate, sourceStackName, resource.logicalId)
  );
}

function stackTemplate(assembly, stackId) {
  const artifact = assembly.manifest.artifacts[stackId];
  if (!artifact || artifact.type !== "aws:cloudformation:stack") return undefined;
  return JSON.parse(
    readFileSync(path.join(assembly.directory, artifact.properties.templateFile), "utf8"),
  );
}

function namedIdentity(record, field, stackName) {
  const name = record.properties[field];
  expect(name, `${record.logicalId} must declare ${field}`).toBeDefined();
  return templateString(name, stackName);
}

async function scenarioFor(environment, botIds = ["docentes"]) {
  const cacheKey = `${environment}:${[...botIds].sort().join(",")}`;
  const cached = scenarioCache.get(cacheKey);
  if (cached) return cached;

  expect(
    existsSync(chatStackSource),
    "ChatStack source must exist for history infrastructure acceptance",
  ).toBe(true);
  if (!existsSync(chatStackSource)) return undefined;
  const { ChatStack } = await import("../../dist/infra/lib/chat-stack.js");
  expect(
    typeof ChatStack,
    "ChatStack export is required for chat history infrastructure tests",
  ).toBe("function");
  if (typeof ChatStack !== "function") return undefined;

  const outputDirectory = mkdtempSync(path.join(tmpdir(), `multi-chatbot-history-${environment}-`));
  temporaryDirectories.add(outputDirectory);
  const app = new App({ outdir: outputDirectory });
  const resolvedEnvironment = resolveEnvironment(environment);
  const identity = new SharedIdentityStack(
    app,
    `${resolvedEnvironment.resourcePrefix}-identity`,
    resolvedEnvironment,
  );
  const bots = new Map();

  for (const botId of botIds) {
    const botEnvironment = resolveEnvironment(environment, botId);
    const account = new AccountStack(
      app,
      `${botEnvironment.botResourcePrefix}-account`,
      botEnvironment,
      identity.userPool,
    );
    const chat = new ChatStack(
      app,
      `${botEnvironment.botResourcePrefix}-chat`,
      botEnvironment,
      identity,
      account,
    );
    const site = new PublicSiteStack(
      app,
      `${botEnvironment.botResourcePrefix}-site`,
      botEnvironment,
      identity,
      account,
      chat,
    );
    bots.set(botId, {
      botEnvironment,
      accountId: account.node.id,
      accountStackName: account.stackName,
      chatId: chat.node.id,
      chatStackName: chat.stackName,
      siteId: site.node.id,
      account,
    });
  }

  const scenario = {
    environment,
    identityId: identity.node.id,
    identityStackName: identity.stackName,
    bots,
    assembly: app.synth(),
  };
  scenarioCache.set(cacheKey, scenario);
  return scenario;
}

function scenarioTemplates(scenario, bot) {
  const chatTemplate = stackTemplate(scenario.assembly, bot.chatId);
  const accountTemplate = stackTemplate(scenario.assembly, bot.accountId);
  const siteTemplate = stackTemplate(scenario.assembly, bot.siteId);
  const identityTemplate = stackTemplate(scenario.assembly, scenario.identityId);
  expect(chatTemplate, "synthesized ChatStack is required").toBeDefined();
  expect(accountTemplate, "synthesized AccountStack is required").toBeDefined();
  expect(siteTemplate, "synthesized PublicSiteStack is required").toBeDefined();
  expect(identityTemplate, "synthesized shared identity stack is required").toBeDefined();
  if (!chatTemplate || !accountTemplate || !siteTemplate || !identityTemplate) return undefined;
  return { chatTemplate, accountTemplate, siteTemplate, identityTemplate };
}

function historyFunction(template) {
  const candidates = records(template, "AWS::Lambda::Function").filter(({ properties }) => {
    const variables = properties.Environment?.Variables || {};
    return (
      variables.BOT_ID !== undefined &&
      variables.ACCOUNT_TABLE_NAME !== undefined &&
      variables.CONVERSATION_TABLE_NAME !== undefined
    );
  });
  expect(candidates, "ChatStack must own the chat history and reconciliation Lambda").toHaveLength(
    1,
  );
  return candidates[0];
}

function assertHistoryInfrastructure(
  templates,
  environment,
  botId,
  chatStackName,
  accountStackName,
  scenario,
) {
  const { chatTemplate, accountTemplate, siteTemplate, identityTemplate } = templates;
  const runtime = onlyRecord(chatTemplate, "AWS::BedrockAgentCore::Runtime");
  const table = onlyRecord(chatTemplate, "AWS::DynamoDB::Table");
  const api = onlyRecord(accountTemplate, "AWS::ApiGatewayV2::Api");
  const accountTable = onlyRecord(accountTemplate, "AWS::DynamoDB::Table");
  const pool = onlyRecord(identityTemplate, "AWS::Cognito::UserPool");
  const client = onlyRecord(accountTemplate, "AWS::Cognito::UserPoolClient");
  const historyHandler = historyFunction(chatTemplate);

  expect(runtime.logicalId).toBe(expectedRuntimeId);
  expect(table.logicalId).toBe(expectedConversationTableId);
  expect(records(chatTemplate, "AWS::ApiGatewayV2::Api")).toHaveLength(0);
  expect(records(chatTemplate, "AWS::Cognito::UserPool")).toHaveLength(0);
  expect(records(chatTemplate, "AWS::DynamoDB::Table")).toHaveLength(1);
  expect(records(accountTemplate, "AWS::ApiGatewayV2::Api")).toHaveLength(1);
  expect(historyHandler.properties.Runtime).toBe("nodejs24.x");
  expect(historyHandler.properties.Environment?.Variables).toMatchObject({ BOT_ID: botId });
  expect(
    referencesStackResource(
      historyHandler.properties.Environment?.Variables?.CONVERSATION_TABLE_NAME,
      table,
      chatTemplate,
      chatStackName,
    ),
  ).toBe(true);
  expect(
    referencesStackResource(
      historyHandler.properties.Environment?.Variables?.ACCOUNT_TABLE_NAME,
      accountTable,
      accountTemplate,
      accountStackName,
    ),
  ).toBe(true);

  const indexes = table.properties.GlobalSecondaryIndexes || [];
  const historyIndex = indexes.find(({ IndexName }) => IndexName === "ConversationHistory");
  expect(
    historyIndex,
    "the existing conversation table must own the sparse history GSI",
  ).toBeDefined();
  expect(historyIndex).toMatchObject({
    KeySchema: [
      { AttributeName: "historyOwner", KeyType: "HASH" },
      { AttributeName: "historyOrder", KeyType: "RANGE" },
    ],
    Projection: { ProjectionType: "KEYS_ONLY" },
  });
  expect(
    (table.properties.AttributeDefinitions || []).map(({ AttributeName }) => AttributeName),
  ).toEqual(expect.arrayContaining(["pk", "sk", "historyOwner", "historyOrder"]));

  const routes = records(chatTemplate, "AWS::ApiGatewayV2::Route");
  const conversationRoute = routes.find(
    ({ properties }) => properties.RouteKey === "GET /api/chat/conversations",
  );
  expect(conversationRoute, "the history list must use the existing HTTP API").toBeDefined();
  expect(
    routes.some(({ properties }) =>
      properties.RouteKey?.startsWith("GET /api/chat/conversations/"),
    ),
  ).toBe(true);
  for (const { properties } of routes) {
    if (!properties.RouteKey?.startsWith("GET /api/chat/conversations")) continue;
    expect(properties.AuthorizationType).toBe("JWT");
    expect(properties.AuthorizerId).toBeDefined();
  }
  expect(
    routes.every(({ properties }) =>
      referencesStackResource(properties.ApiId, api, accountTemplate, accountStackName),
    ),
    "history routes must attach to AccountStack's existing HTTP API",
  ).toBe(true);

  const integrations = records(chatTemplate, "AWS::ApiGatewayV2::Integration");
  expect(
    integrations.some(({ properties }) =>
      referencesResource(properties.IntegrationUri, historyHandler.logicalId),
    ),
    "the new history routes must invoke the ChatStack Lambda",
  ).toBe(true);
  const authorizerIds = routes
    .filter(({ properties }) => properties.RouteKey?.startsWith("GET /api/chat/conversations"))
    .map(({ properties }) => properties.AuthorizerId);
  const authorizers = [
    ...records(chatTemplate, "AWS::ApiGatewayV2::Authorizer"),
    ...records(accountTemplate, "AWS::ApiGatewayV2::Authorizer"),
  ];
  const authorizer = authorizers.find(({ logicalId }) => {
    const sourceTemplate = records(chatTemplate, "AWS::ApiGatewayV2::Authorizer").some(
      (candidate) => candidate.logicalId === logicalId,
    )
      ? chatTemplate
      : accountTemplate;
    const sourceStackName = sourceTemplate === chatTemplate ? chatStackName : accountStackName;
    return authorizerIds.some((id) =>
      referencesStackResource(id, { logicalId }, sourceTemplate, sourceStackName),
    );
  });
  expect(authorizer, "history routes must use a JWT authorizer").toBeDefined();
  if (authorizer) {
    expect(authorizer.properties.AuthorizerType).toBe("JWT");
    expect(authorizer.properties.JwtConfiguration?.Audience).toBeDefined();
    expect(
      referencesStackResource(
        authorizer.properties.JwtConfiguration?.Audience,
        client,
        accountTemplate,
        accountStackName,
      ),
    ).toBe(true);
    const issuer = authorizer.properties.JwtConfiguration?.Issuer;
    expect(typeof issuer === "string" || issuer !== undefined).toBe(true);
    expect(
      referencesStackResource(issuer, pool, identityTemplate, scenario.identityStackName),
      "the JWT issuer must use the environment's existing shared Cognito pool",
    ).toBe(true);
  }

  const historyRole = logicalIdFromGetAtt(historyHandler.properties.Role);
  const statements = rolePolicies(chatTemplate, historyRole);
  const allowedActions = new Set([
    "dynamodb:GetItem",
    "dynamodb:Query",
    "dynamodb:UpdateItem",
    "dynamodb:ConditionCheckItem",
    "dynamodb:TransactWriteItems",
  ]);
  const dynamoStatements = statements.filter((statement) =>
    actions(statement).some(
      (action) => typeof action === "string" && action.startsWith("dynamodb:"),
    ),
  );
  expect(dynamoStatements.length).toBeGreaterThan(0);
  for (const statement of statements) {
    const statementActions = actions(statement);
    expect(
      statementActions.some((action) => /^(?:bedrock|s3|s3vectors):/i.test(String(action))),
    ).toBe(false);
    expect(statementActions.some((action) => /^dynamodb:Scan$/i.test(String(action)))).toBe(false);
    expect(
      statementActions.every(
        (action) => !String(action).startsWith("dynamodb:") || allowedActions.has(action),
      ),
    ).toBe(true);
  }
  expect(
    dynamoStatements.some(
      (statement) =>
        actions(statement).includes("dynamodb:GetItem") &&
        referencesStackResource(
          statement.Resource,
          accountTable,
          accountTemplate,
          accountStackName,
        ),
    ),
    "history authorization must read application membership from this bot's account table",
  ).toBe(true);
  expect(
    dynamoStatements.some(
      (statement) =>
        actions(statement).includes("dynamodb:Query") &&
        referencesResource(statement.Resource, table.logicalId) &&
        JSON.stringify(statement.Resource).includes("ConversationHistory"),
    ),
    "history listing must query only the conversation table's history index",
  ).toBe(true);
  for (const statement of dynamoStatements) {
    expect(
      referencesResource(statement.Resource, table.logicalId) ||
        referencesStackResource(
          statement.Resource,
          accountTable,
          accountTemplate,
          accountStackName,
        ),
      "history Lambda permissions must stay on its conversation table/index and membership table",
    ).toBe(true);
  }

  expect(
    records(accountTemplate, "AWS::ApiGatewayV2::Route").some(({ properties }) =>
      properties.RouteKey?.startsWith("GET /api/chat/conversations"),
    ),
  ).toBe(false);
  expect(records(accountTemplate, "AWS::Lambda::Function")).toHaveLength(1);
  const accountArtifact = scenario.assembly.manifest.artifacts[scenario.bots.get(botId).accountId];
  expect(accountArtifact?.dependencies || []).not.toContain(scenario.bots.get(botId).chatId);

  const distributions = records(siteTemplate, "AWS::CloudFront::Distribution");
  expect(distributions).toHaveLength(1);
  const apiBehavior = distributions[0].properties.DistributionConfig?.CacheBehaviors?.find(
    ({ PathPattern }) => PathPattern === "/api/*",
  );
  expect(apiBehavior, "the existing /api proxy must remain available").toBeDefined();
  expect(apiBehavior?.CachePolicyId).toBe(disabledCachePolicyId);
  expect(
    referencesStackResource(
      apiBehavior &&
        distributions[0].properties.DistributionConfig?.Origins?.find(
          ({ Id }) => Id === apiBehavior.TargetOriginId,
        )?.DomainName,
      api,
      accountTemplate,
      accountStackName,
    ),
  ).toBe(true);
  expectTagged(table, environment);
  expectTagged(runtime, environment);
}

function expectTagged(record, environment) {
  const tags = record.properties.Tags;
  const pairs = Array.isArray(tags)
    ? tags.map(({ Key, Value }) => [Key, Value])
    : Object.entries(tags || {});
  expect(pairs).toContainEqual(["project", "multi-chatbot"]);
  expect(pairs).toContainEqual(["environment", environment]);
}

describe("chat history infrastructure template acceptance", () => {
  it.each(["dev", "prod"])(
    "%s keeps the Runtime, table, Cognito, and HTTP API boundaries while adding history routes",
    async (environment) => {
      const scenario = await scenarioFor(environment);
      expect(scenario, `expected the ${environment} template scenario`).toBeDefined();
      if (!scenario) return;
      const bot = scenario.bots.get("docentes");
      expect(bot).toBeDefined();
      if (!bot) return;
      const templates = scenarioTemplates(scenario, bot);
      if (!templates) return;
      assertHistoryInfrastructure(
        templates,
        environment,
        "docentes",
        bot.chatStackName,
        bot.accountStackName,
        scenario,
      );
      const runtime = onlyRecord(templates.chatTemplate, "AWS::BedrockAgentCore::Runtime");
      const table = onlyRecord(templates.chatTemplate, "AWS::DynamoDB::Table");
      const api = onlyRecord(templates.accountTemplate, "AWS::ApiGatewayV2::Api");
      const client = onlyRecord(templates.accountTemplate, "AWS::Cognito::UserPoolClient");
      const pool = onlyRecord(templates.identityTemplate, "AWS::Cognito::UserPool");
      expect(runtime.logicalId).toBe(expectedRuntimeId);
      expect(table.logicalId).toBe(expectedConversationTableId);
      expect(api.properties.ApiName).toBe(
        `${resolveEnvironment(environment, "docentes").botResourcePrefix}-account`,
      );
      expect(client.properties.UserPoolId).toBeDefined();
      expect(pool.properties.UserPoolName).toBeDefined();
    },
  );

  it("keeps history table and runtime identities separated by bot and environment", async () => {
    const dev = await scenarioFor("dev", ["docentes", "bot-uno"]);
    const prod = await scenarioFor("prod", ["docentes"]);
    expect(dev).toBeDefined();
    expect(prod).toBeDefined();
    if (!dev || !prod) return;

    const configurations = [
      ...["docentes", "bot-uno"].map((botId) => ({ scenario: dev, botId, environment: "dev" })),
      { scenario: prod, botId: "docentes", environment: "prod" },
    ].map(({ scenario, botId, environment }) => {
      const bot = scenario.bots.get(botId);
      expect(bot).toBeDefined();
      if (!bot) return undefined;
      const templates = scenarioTemplates(scenario, bot);
      if (!templates) return undefined;
      const table = onlyRecord(templates.chatTemplate, "AWS::DynamoDB::Table");
      const runtime = onlyRecord(templates.chatTemplate, "AWS::BedrockAgentCore::Runtime");
      const handler = historyFunction(templates.chatTemplate);
      const api = onlyRecord(templates.accountTemplate, "AWS::ApiGatewayV2::Api");
      const accountTable = onlyRecord(templates.accountTemplate, "AWS::DynamoDB::Table");
      assertHistoryInfrastructure(
        templates,
        environment,
        botId,
        bot.chatStackName,
        bot.accountStackName,
        scenario,
      );
      return {
        environment,
        botId,
        tableName: namedIdentity(table, "TableName", bot.chatStackName),
        runtimeName: namedIdentity(runtime, "AgentRuntimeName", bot.chatStackName),
        accountApiName: namedIdentity(api, "ApiName", bot.accountStackName),
        accountTableName: namedIdentity(accountTable, "TableName", bot.accountStackName),
        handler,
        stack: bot,
        templates,
      };
    });
    expect(configurations.every(Boolean)).toBe(true);
    if (configurations.some((configuration) => !configuration)) return;

    expect(new Set(configurations.map(({ tableName }) => tableName)).size).toBe(
      configurations.length,
    );
    expect(new Set(configurations.map(({ runtimeName }) => runtimeName)).size).toBe(
      configurations.length,
    );
    expect(new Set(configurations.map(({ accountApiName }) => accountApiName)).size).toBe(
      configurations.length,
    );
    expect(new Set(configurations.map(({ accountTableName }) => accountTableName)).size).toBe(
      configurations.length,
    );
    for (const configuration of configurations) {
      expect(configuration.handler.properties.Environment?.Variables?.BOT_ID).toBe(
        configuration.botId,
      );
      expect(
        configuration.handler.properties.Environment?.Variables?.CONVERSATION_TABLE_NAME,
      ).toBeDefined();
      const historyIndex = onlyRecord(
        configuration.templates.chatTemplate,
        "AWS::DynamoDB::Table",
      ).properties.GlobalSecondaryIndexes?.find(
        ({ IndexName }) => IndexName === "ConversationHistory",
      );
      expect(historyIndex).toBeDefined();
      expectTagged(
        onlyRecord(configuration.templates.chatTemplate, "AWS::DynamoDB::Table"),
        configuration.environment,
      );
    }
  });
});
