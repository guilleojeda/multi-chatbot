import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveEnvironment } from "../../dist/config/project.js";
import { AccountStack } from "../../dist/infra/lib/account-stack.js";
import { SharedIdentityStack } from "../../dist/infra/lib/shared-identity-stack.js";

const outputDirectory = mkdtempSync(path.join(tmpdir(), "multi-chatbot-profile-infra-"));
const stacks = new Map();
const profileBotIds = ["bot-uno", "bot-dos"];

beforeAll(() => {
  const app = new App({ outdir: outputDirectory });

  for (const environment of ["dev", "prod"]) {
    const resolvedEnvironment = resolveEnvironment(environment);
    const identity = new SharedIdentityStack(
      app,
      `${resolvedEnvironment.resourcePrefix}-identity`,
      resolvedEnvironment,
    );
    const botIds = environment === "dev" ? ["docentes", ...profileBotIds] : ["docentes"];

    for (const botId of botIds) {
      const resolvedBot = resolveEnvironment(environment, botId);
      const account = new AccountStack(
        app,
        `${resolvedBot.botResourcePrefix}-account`,
        resolvedBot,
        identity.userPool,
      );
      stacks.set(`${environment}:${botId}`, {
        environment,
        botId,
        identity,
        account,
      });
    }
  }

  const identityTemplates = new Map();
  for (const stack of stacks.values()) {
    if (!identityTemplates.has(stack.environment)) {
      identityTemplates.set(stack.environment, Template.fromStack(stack.identity));
    }
    stack.template = Template.fromStack(stack.account);
    stack.identityTemplate = identityTemplates.get(stack.environment);
  }
}, 60_000);

afterAll(() => rmSync(outputDirectory, { recursive: true, force: true }));

function resources(template, type) {
  return Object.entries(template.findResources(type)).map(([logicalId, resource]) => ({
    logicalId,
    resource,
    properties: resource.Properties || {},
  }));
}

function onlyResource(template, type) {
  const matches = resources(template, type);
  expect(matches, `expected one ${type}`).toHaveLength(1);
  return matches[0];
}

function routeByKey(template) {
  return new Map(
    resources(template, "AWS::ApiGatewayV2::Route").map(({ resource }) => [
      resource.Properties?.RouteKey,
      resource,
    ]),
  );
}

function logicalIdFromGetAtt(reference) {
  const getAtt = reference?.["Fn::GetAtt"];
  if (Array.isArray(getAtt)) return getAtt[0];
  if (typeof getAtt === "string") return getAtt.split(".")[0];
  return undefined;
}

function referencesOutput(value, stackName, outputLogicalId, output) {
  if (Array.isArray(value)) {
    return value.some((child) => referencesOutput(child, stackName, outputLogicalId, output));
  }
  if (!value || typeof value !== "object") return false;

  const stackOutput = value["Fn::GetStackOutput"];
  if (stackOutput?.StackName === stackName && stackOutput?.OutputName === outputLogicalId) {
    return true;
  }
  if (
    Object.hasOwn(value, "Fn::ImportValue") &&
    output.Export?.Name !== undefined &&
    JSON.stringify(value["Fn::ImportValue"]) === JSON.stringify(output.Export.Name)
  ) {
    return true;
  }
  return Object.values(value).some((child) =>
    referencesOutput(child, stackName, outputLogicalId, output),
  );
}

function userPoolOutput(stack) {
  const pool = onlyResource(stack.identityTemplate, "AWS::Cognito::UserPool");
  const outputs = stack.identityTemplate.toJSON().Outputs || {};
  const matches = Object.entries(outputs).filter(([, output]) =>
    JSON.stringify(output.Value || {}).includes(pool.logicalId),
  );
  expect(matches.length, "the existing user pool ID output remains available").toBeGreaterThan(0);
  return { outputs: matches, pool };
}

function referencesSharedUserPool(value, stack) {
  const identityPool = userPoolOutput(stack);
  return identityPool.outputs.some(([logicalId, output]) =>
    referencesOutput(value, stack.identity.node.id, logicalId, output),
  );
}

function dynamoPolicyStatements(template, lambdaLogicalId) {
  const lambda = template.findResources("AWS::Lambda::Function")[lambdaLogicalId];
  const roleLogicalId = logicalIdFromGetAtt(lambda?.Properties?.Role);
  const role = template.findResources("AWS::IAM::Role")[roleLogicalId];
  const inlineStatements = (role?.Properties?.Policies || []).flatMap(
    (policy) => policy.PolicyDocument?.Statement || [],
  );
  const attachedStatements = resources(template, "AWS::IAM::Policy")
    .filter(({ properties }) => JSON.stringify(properties.Roles || {}).includes(roleLogicalId))
    .flatMap(({ properties }) => properties.PolicyDocument?.Statement || []);
  return [...inlineStatements, ...attachedStatements].filter((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.some((action) => typeof action === "string" && /^dynamodb:/i.test(action));
  });
}

function expectStableAccountConstructs(stack) {
  const expectedChildren = [
    "AccountClient",
    "AccountTable",
    "AccountHandler",
    "AccountApi",
    "UserPoolId",
    "ClientId",
    "TableName",
    "ApiUrl",
    "BotId",
  ];
  for (const childId of expectedChildren) {
    expect(stack.account.node.tryFindChild(childId), `existing construct ${childId}`).toBeDefined();
  }
  expect(stack.identity.node.tryFindChild("SharedUserPool")).toBeDefined();
  expect(stack.identity.node.tryFindChild("UserPoolId")).toBeDefined();

  for (const [childId, value] of [
    ["UserPoolId", stack.identity.userPool.userPoolId],
    ["ClientId", stack.account.userPoolClient.userPoolClientId],
    ["TableName", stack.account.table.tableName],
    ["ApiUrl", stack.account.httpApi.apiEndpoint],
    ["BotId", stack.botId],
  ]) {
    expect(stack.account.node.tryFindChild(childId)?.value).toBe(value);
  }
}

describe("profile CDK acceptance", () => {
  it.each(["dev", "prod"])(
    "%s profile endpoints reuse the account API, Lambda, and Cognito JWT authorizer",
    (environment) => {
      const stack = stacks.get(`${environment}:docentes`);
      expect(stack).toBeDefined();
      if (!stack) return;

      const { template, account, botId } = stack;
      const api = onlyResource(template, "AWS::ApiGatewayV2::Api");
      const lambda = onlyResource(template, "AWS::Lambda::Function");
      const table = onlyResource(template, "AWS::DynamoDB::Table");
      const client = onlyResource(template, "AWS::Cognito::UserPoolClient");
      const integrations = resources(template, "AWS::ApiGatewayV2::Integration");
      const authorizers = resources(template, "AWS::ApiGatewayV2::Authorizer");
      const routes = routeByKey(template);

      expect(integrations).toHaveLength(1);
      expect(authorizers).toHaveLength(1);
      const inspect = routes.get("POST /api/account/invitations/inspect");
      const accept = routes.get("POST /api/account/invitations/accept");
      const me = routes.get("GET /api/account/me");
      const profileGet = routes.get("GET /api/profile");
      const profilePut = routes.get("PUT /api/profile");

      expect(inspect, "invitation inspection stays public").toBeDefined();
      expect(accept, "invitation acceptance stays public").toBeDefined();
      expect(me, "the existing member route stays protected").toBeDefined();
      expect(profileGet, "GET /api/profile must be deployed").toBeDefined();
      expect(profilePut, "PUT /api/profile must be deployed").toBeDefined();
      if (!inspect || !accept || !me || !profileGet || !profilePut) return;
      expect(resources(template, "AWS::ApiGatewayV2::Route")).toHaveLength(5);

      for (const route of [inspect, accept]) {
        expect(route.Properties?.AuthorizationType).toBe("NONE");
        expect(route.Properties?.AuthorizerId).toBeUndefined();
      }

      const authorizer = authorizers[0];
      expect(authorizer.logicalId).toContain("AccountJwtAuthorizer");
      for (const route of [me, profileGet, profilePut]) {
        expect(route.Properties?.AuthorizationType).toBe("JWT");
        expect(route.Properties?.AuthorizerId).toEqual({ Ref: authorizer.logicalId });
        expect(route.Properties?.ApiId).toEqual({ Ref: api.logicalId });
      }

      const jwt = authorizer.properties.JwtConfiguration || {};
      expect(JSON.stringify(jwt.Issuer)).toContain(
        `https://cognito-idp.${account.region}.amazonaws.com/`,
      );
      expect(referencesSharedUserPool(jwt.Issuer, stack)).toBe(true);
      expect(jwt.Audience).toEqual([{ Ref: client.logicalId }]);
      expect(referencesSharedUserPool(client.properties.UserPoolId, stack)).toBe(true);

      const integration = integrations[0];
      expect(integration.logicalId).toContain("AccountHandlerIntegration");
      expect(integration.properties.IntegrationUri).toEqual({
        "Fn::GetAtt": [lambda.logicalId, "Arn"],
      });
      for (const route of [inspect, accept, me, profileGet, profilePut]) {
        expect(JSON.stringify(route.Properties?.Target)).toContain(integration.logicalId);
      }

      expect(table.properties.TableName).toBe(`multi-chatbot-${environment}-${botId}-account-data`);
      expect(client.properties.UserPoolClientName).toBe(
        `multi-chatbot-${environment}-${botId}-account`,
      );
      expect(api.properties.Name).toBe(`multi-chatbot-${environment}-${botId}-account`);
      const pool = onlyResource(stack.identityTemplate, "AWS::Cognito::UserPool");
      expect(pool.properties.UserPoolName).toBe(`multi-chatbot-${environment}-identity`);
      expectStableAccountConstructs(stack);
    },
  );

  it.each(["dev", "prod"])(
    "%s profile storage keeps the existing table and grants only its current key operations",
    (environment) => {
      const stack = stacks.get(`${environment}:docentes`);
      expect(stack).toBeDefined();
      if (!stack) return;

      const { template } = stack;
      const lambda = onlyResource(template, "AWS::Lambda::Function");
      const table = onlyResource(template, "AWS::DynamoDB::Table");
      const statements = dynamoPolicyStatements(template, lambda.logicalId);
      const actions = new Set(
        statements.flatMap((statement) =>
          (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).filter(
            (action) => typeof action === "string",
          ),
        ),
      );

      expect(actions).toEqual(
        new Set(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]),
      );
      expect(
        statements.every((statement) =>
          JSON.stringify(statement.Resource || {}).includes(table.logicalId),
        ),
      ).toBe(true);
      expect(resources(template, "AWS::DynamoDB::Table")).toHaveLength(1);
      expect(resources(template, "AWS::Lambda::Function")).toHaveLength(1);
      expect(resources(template, "AWS::ApiGatewayV2::Api")).toHaveLength(1);
    },
  );

  it("keeps two configured-at-test-time bots isolated while sharing their dev identity pool", () => {
    const bots = profileBotIds.map((botId) => stacks.get(`dev:${botId}`));
    expect(bots.every(Boolean)).toBe(true);
    if (bots.some((stack) => !stack)) return;

    const [first, second] = bots;
    const firstTable = onlyResource(first.template, "AWS::DynamoDB::Table");
    const secondTable = onlyResource(second.template, "AWS::DynamoDB::Table");
    const firstClient = onlyResource(first.template, "AWS::Cognito::UserPoolClient");
    const secondClient = onlyResource(second.template, "AWS::Cognito::UserPoolClient");

    expect(firstTable.properties.TableName).not.toBe(secondTable.properties.TableName);
    expect(referencesSharedUserPool(firstClient.properties.UserPoolId, first)).toBe(true);
    expect(referencesSharedUserPool(secondClient.properties.UserPoolId, second)).toBe(true);
    expect(firstClient.properties.UserPoolId).toEqual(secondClient.properties.UserPoolId);

    for (const stack of bots) {
      const lambda = onlyResource(stack.template, "AWS::Lambda::Function");
      const table = onlyResource(stack.template, "AWS::DynamoDB::Table");
      const variables = lambda.properties.Environment?.Variables || {};
      expect(variables.BOT_ID).toBe(stack.botId);
      expect(variables.TABLE_NAME).toEqual({ Ref: table.logicalId });
    }
  });
});
