import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App } from "aws-cdk-lib";
import { afterAll, describe, expect, it } from "vitest";
import { resolveEnvironment } from "../../dist/config/project.js";
import { AccountStack } from "../../dist/infra/lib/account-stack.js";
import { AdminStack } from "../../dist/infra/lib/admin-stack.js";
import { ChatStack } from "../../dist/infra/lib/chat-stack.js";
import { PublicSiteStack } from "../../dist/infra/lib/public-site-stack.js";
import { SharedIdentityStack } from "../../dist/infra/lib/shared-identity-stack.js";
import {
  assetFiles,
  dependencies,
  findStack,
  lambdaPolicies,
  parseJsonTemplateValue,
  readAssembly,
  readAssetFile,
  records,
  referencesResource,
  removeSynthesisDirectory,
  resourceAsset,
  sameStackReference,
  statementActions,
} from "../support/phase9-admin-infra.mjs";

const environments = ["dev", "prod"];
const scenarios = new Map();
const temporaryDirectories = new Set();

afterAll(() => {
  for (const directory of temporaryDirectories) removeSynthesisDirectory(directory);
});

async function scenarioFor(environment, botIds = ["docentes"]) {
  const cacheKey = `${environment}:${[...botIds].sort().join(",")}`;
  const cached = scenarios.get(cacheKey);
  if (cached) return cached;

  const outputDirectory = mkdtempSync(
    path.join(tmpdir(), `multi-chatbot-doc-admin-${environment}-`),
  );
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
      account,
      accountId: account.node.id,
      chat,
      chatId: chat.node.id,
      chatStackName: chat.stackName,
      site,
      siteId: site.node.id,
    });
  }

  const admin = new AdminStack(
    app,
    `${resolvedEnvironment.resourcePrefix}-admin`,
    resolvedEnvironment,
    identity,
    [...bots].map(([botId, bot]) => ({
      botId,
      projectName: `Project ${botId}`,
      account: bot.account,
      chat: bot.chat,
      site: bot.site,
    })),
  );
  const cloudAssembly = app.synth();
  const assembly = readAssembly(cloudAssembly.directory);
  const scenario = {
    environment,
    assembly,
    identity: findStack(assembly, identity.node.id),
    admin: findStack(assembly, admin.node.id),
    bots,
  };
  scenarios.set(cacheKey, scenario);
  return scenario;
}

function templateOf(scenario, stackId) {
  return findStack(scenario.assembly, stackId);
}

function getAttLogicalId(value) {
  const getAtt = value?.["Fn::GetAtt"];
  if (Array.isArray(getAtt)) return getAtt[0];
  if (typeof getAtt === "string") return getAtt.split(".")[0];
  return undefined;
}

function policyStatements(stack, lambda) {
  return lambdaPolicies(stack, lambda).statements;
}

function statementsForResource(
  statements,
  value,
  valueStack,
  targetStack,
  targetResource,
  assembly,
) {
  return statements.filter((statement) =>
    referencesResource(statement.Resource, valueStack, targetStack, targetResource, assembly),
  );
}

function envValue(lambda, name) {
  return lambda.properties.Environment?.Variables?.[name];
}

function conversationTable(chatTemplate) {
  const runtime = records(chatTemplate, "AWS::BedrockAgentCore::Runtime")[0];
  const conversationTableReference =
    runtime?.properties.EnvironmentVariables?.CONVERSATION_TABLE_NAME;
  const matches = records(chatTemplate, "AWS::DynamoDB::Table").filter(({ logicalId }) =>
    sameStackReference(conversationTableReference, logicalId),
  );
  expect(matches, "Runtime's configured conversation table remains in ChatStack").toHaveLength(1);
  return matches[0];
}

function documentTableFor(chatTemplate, adminCatalog, admin, chat, assembly) {
  const conversation = conversationTable(chatTemplate);
  const matches = records(chatTemplate, "AWS::DynamoDB::Table").filter(
    (table) =>
      table.logicalId !== conversation.logicalId &&
      referencesResource(adminCatalog, admin, chat, table, assembly),
  );
  expect(matches, "the server catalog references a separate per-bot document table").toHaveLength(
    1,
  );
  return matches[0];
}

function routeRecords(admin, pathAndMethod) {
  return records(admin, "AWS::ApiGatewayV2::Route").filter(
    ({ properties }) => properties.RouteKey === pathAndMethod,
  );
}

function apiHandler(scenario) {
  const lambdas = records(scenario.admin, "AWS::Lambda::Function");
  const candidates = lambdas.filter(({ properties }) => {
    const variables = properties.Environment?.Variables || {};
    return Boolean(
      variables.BOT_CATALOG &&
      variables.USER_POOL_ID &&
      variables.ADMIN_CLIENT_ID &&
      variables.ADMIN_GROUP,
    );
  });
  const integrations = records(scenario.admin, "AWS::ApiGatewayV2::Integration");
  const matches = candidates.filter(({ logicalId }) =>
    integrations.some(({ properties }) =>
      referencesResource(
        properties.IntegrationUri,
        scenario.admin,
        scenario.admin,
        { logicalId },
        scenario.assembly,
      ),
    ),
  );
  expect(matches, "the admin HTTP API targets its application handler").toHaveLength(1);
  return matches[0];
}

function adminWebsiteDeployment(scenario) {
  const deployments = records(scenario.admin, "Custom::CDKBucketDeployment");
  const matches = deployments.filter((deployment) =>
    records(scenario.admin, "AWS::S3::Bucket").some(({ logicalId }) =>
      referencesResource(
        deployment.properties.DestinationBucketName,
        scenario.admin,
        scenario.admin,
        { logicalId },
        scenario.assembly,
      ),
    ),
  );
  return matches.find(({ properties }) =>
    resourceAssetsForDeployment(scenario, properties).some((asset) =>
      asset.files.some(({ relativePath }) => path.basename(relativePath) === "public-config.json"),
    ),
  );
}

function incomingBuckets(scenario) {
  return records(scenario.admin, "AWS::S3::Bucket").filter(({ properties }) =>
    (properties.LifecycleConfiguration?.Rules || []).some(
      (rule) => (rule.Filter?.Prefix || rule.Prefix) === "incoming/",
    ),
  );
}

function receiptConfigFile(scenario) {
  const deployment = adminWebsiteDeployment(scenario);
  expect(deployment, "AdminStack stages its browser configuration asset").toBeDefined();
  if (!deployment) return undefined;
  const assets = resourceAssetsForDeployment(scenario, deployment.properties);
  const files = assets.flatMap((asset) =>
    asset.files
      .filter(({ relativePath }) => path.basename(relativePath) === "public-config.json")
      .map((file) => ({ asset, file })),
  );
  expect(files, "public-config.json is present in the deployed admin asset").toHaveLength(1);
  return files[0]?.file;
}

function resourceAssetsForDeployment(scenario, deploymentProperties) {
  const serialized = JSON.stringify(deploymentProperties);
  return assetFiles(scenario.assembly, scenario.admin).filter(({ fileAsset }) =>
    Object.values(fileAsset.destinations || {}).some(
      ({ objectKey }) => typeof objectKey === "string" && serialized.includes(objectKey),
    ),
  );
}

function projectTokenizedJson(value, tokens = []) {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map((child) => projectTokenizedJson(child, tokens)).join("");
  if (!value || typeof value !== "object") return String(value ?? "");
  const joined = value["Fn::Join"];
  if (Array.isArray(joined) && joined.length === 2) {
    const [separator, pieces] = joined;
    return pieces.map((piece) => projectTokenizedJson(piece, tokens)).join(separator);
  }
  const tokenId = tokens.push(value) - 1;
  return `__TEMPLATE_TOKEN_${tokenId}__`;
}

function catalogView(expression) {
  const tokens = [];
  const projected = projectTokenizedJson(expression, tokens);
  try {
    return { parsed: JSON.parse(projected), tokens };
  } catch {
    return undefined;
  }
}

function catalogEntries(value) {
  if (Array.isArray(value)) return value.flatMap(catalogEntries);
  if (!value || typeof value !== "object") return [];
  const current = typeof value.botId === "string" ? [value] : [];
  return [...current, ...Object.values(value).flatMap(catalogEntries)];
}

function tokenIndexes(value) {
  if (typeof value === "string") {
    return [...value.matchAll(/__TEMPLATE_TOKEN_(\d+)__/g)].map((match) => Number(match[1]));
  }
  if (Array.isArray(value)) return value.flatMap(tokenIndexes);
  if (value && typeof value === "object") return Object.values(value).flatMap(tokenIndexes);
  return [];
}

function catalogEntryReferences(entry, catalog, resource, valueStack, targetStack, assembly) {
  return tokenIndexes(entry).some((tokenId) =>
    referencesResource(catalog.tokens[tokenId], valueStack, targetStack, resource, assembly),
  );
}

function flattenedStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenedStrings);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [key, ...flattenedStrings(child)]);
  }
  return [];
}

function workerAndStateMachine(scenario) {
  const machines = records(scenario.admin, "AWS::StepFunctions::StateMachine");
  expect(machines, "AdminStack owns a durable document workflow").toHaveLength(1);
  if (machines.length !== 1) return {};
  const machine = machines[0];
  const lambdas = records(scenario.admin, "AWS::Lambda::Function");
  const workers = lambdas.filter(({ logicalId }) =>
    referencesResource(
      machine.properties,
      scenario.admin,
      scenario.admin,
      { logicalId },
      scenario.assembly,
    ),
  );
  expect(workers, "the state machine definition names its worker Lambda").toHaveLength(1);
  return { machine, worker: workers[0] };
}

function rolePolicyStatements(stack, roleLogicalId) {
  const role = records(stack, "AWS::IAM::Role").find(
    ({ logicalId }) => logicalId === roleLogicalId,
  );
  const inline = (role?.properties.Policies || []).flatMap(
    (policy) => policy.PolicyDocument?.Statement || [],
  );
  const attached = records(stack, "AWS::IAM::Policy")
    .filter(({ properties }) => sameStackReference(properties.Roles, roleLogicalId))
    .flatMap(({ properties }) => properties.PolicyDocument?.Statement || []);
  return [...inline, ...attached];
}

function templateString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(templateString).join("");
  if (!value || typeof value !== "object") return String(value ?? "");
  const joined = value["Fn::Join"];
  if (Array.isArray(joined) && joined.length === 2) {
    const [separator, pieces] = joined;
    return pieces.map(templateString).join(separator);
  }
  if (typeof value["Fn::Sub"] === "string") return value["Fn::Sub"];
  return JSON.stringify(value);
}

function roleStatements(scenario, lambda) {
  return policyStatements(scenario.admin, lambda);
}

function reachable(definition, fromName, toName) {
  const states = definition?.States || {};
  const pending = [fromName];
  const visited = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (current === toName) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const state = states[current];
    if (!state) continue;
    if (state.Next) pending.push(state.Next);
    if (state.Default) pending.push(state.Default);
    for (const choice of state.Choices || []) if (choice.Next) pending.push(choice.Next);
    for (const catcher of state.Catch || []) if (catcher.Next) pending.push(catcher.Next);
  }
  return false;
}

function workerTaskPayload(state) {
  const directPayload = state.Parameters || state.Arguments;
  const payload =
    state.Parameters?.Payload ||
    state.Arguments?.Payload ||
    (directPayload &&
    typeof directPayload === "object" &&
    Object.keys(directPayload).some((key) => ["botId", "botId.$"].includes(key))
      ? directPayload
      : undefined);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key.replace(/\.\$$/, ""), value]),
  );
  return normalized;
}

function stringIncludes(value, expected) {
  return JSON.stringify(value ?? null).includes(expected);
}

function resourceItems(value) {
  return Array.isArray(value) ? value : [value];
}

function hasS3PrefixScope(statement, prefix) {
  const actions = statementActions(statement);
  const resources = resourceItems(statement.Resource);
  if (actions.some((action) => /Object/i.test(action))) {
    return resources.every((resource) => stringIncludes(resource, prefix));
  }
  if (actions.includes("s3:ListBucket")) return stringIncludes(statement.Condition, prefix);
  return actions.every((action) => action === "s3:GetBucketLocation");
}

function adminBot(scenario, botId) {
  const bot = scenario.bots.get(botId);
  expect(bot, `the checked ${scenario.environment}:${botId} chatbot is synthesized`).toBeDefined();
  if (!bot) return undefined;
  const chatTemplate = templateOf(scenario, bot.chatId);
  expect(chatTemplate, `${botId} ChatStack is present in the assembly`).toBeDefined();
  if (!chatTemplate) return undefined;
  const handler = apiHandler(scenario);
  const catalog = envValue(handler, "BOT_CATALOG");
  expect(catalog, "the server-side bot catalog is supplied to the API handler").toBeDefined();
  const documentTable = documentTableFor(
    chatTemplate,
    catalog,
    scenario.admin,
    findStack(scenario.assembly, bot.chatId),
    scenario.assembly,
  );
  const catalogParsed = catalogView(catalog);
  const entry = catalogEntries(catalogParsed?.parsed).find((value) => value.botId === botId);
  expect(entry, `the server catalog has a distinct ${botId} entry`).toBeDefined();
  return {
    ...bot,
    chatTemplate,
    catalog,
    catalogParsed,
    catalogEntry: entry,
    documentTable,
    conversationTable: conversationTable(chatTemplate),
  };
}

function documentBucketFor(scenario, bot) {
  const buckets = records(bot.chatTemplate, "AWS::S3::Bucket");
  expect(buckets, "ChatStack keeps one private prepared-document bucket").toHaveLength(1);
  return buckets[0];
}

describe("phase 11.1 document administration infrastructure acceptance", () => {
  it.each(environments)(
    "%s wires authenticated document routes, a scoped upload bucket, and an autonomous worker",
    async (environment) => {
      const scenario = await scenarioFor(environment);
      expect(scenario.admin, `${environment} AdminStack is present`).toBeDefined();
      if (!scenario.admin) return;

      const admin = scenario.admin;
      const assembly = scenario.assembly;
      const handler = apiHandler(scenario);
      const { machine, worker } = workerAndStateMachine(scenario);
      expect(machine).toBeDefined();
      expect(worker).toBeDefined();
      if (!machine || !worker) return;

      const adminClient = records(admin, "AWS::Cognito::UserPoolClient")[0];
      const authorizer = records(admin, "AWS::ApiGatewayV2::Authorizer").find(
        ({ properties }) => properties.AuthorizerType === "JWT",
      );
      expect(adminClient).toBeDefined();
      expect(authorizer).toBeDefined();
      const validityUnits = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 };
      const tokenSeconds =
        adminClient?.properties.AccessTokenValidity *
        (validityUnits[adminClient?.properties.TokenValidityUnits?.AccessToken || "hours"] || 0);
      expect(
        tokenSeconds,
        "the admin access token remains no longer than 60 minutes",
      ).toBeLessThanOrEqual(3600);
      expect(tokenSeconds).toBeGreaterThan(0);

      const documentRoutes = [
        "GET /api/admin/bots/{botId}/documents",
        "POST /api/admin/bots/{botId}/document-operations",
        "POST /api/admin/bots/{botId}/document-operations/{operationId}/start",
        "GET /api/admin/bots/{botId}/document-operations/{operationId}",
      ];
      for (const routeKey of documentRoutes) {
        const matches = routeRecords(admin, routeKey);
        expect(matches, `${routeKey} is exposed by the admin API`).toHaveLength(1);
        const route = matches[0];
        expect(route.properties.AuthorizationType).toBe("JWT");
        expect(
          sameStackReference(route.properties.AuthorizerId, authorizer?.logicalId),
          `${routeKey} uses the admin JWT authorizer`,
        ).toBe(true);
        const integrations = records(admin, "AWS::ApiGatewayV2::Integration");
        expect(
          integrations.some(({ logicalId }) =>
            sameStackReference(route.properties.Target, logicalId),
          ),
          `${routeKey} reaches an application integration`,
        ).toBe(true);
      }
      expect(authorizer?.properties.JwtConfiguration?.Audience).toEqual(
        expect.arrayContaining([expect.anything()]),
      );
      expect(
        referencesResource(
          authorizer?.properties.JwtConfiguration?.Audience,
          admin,
          admin,
          adminClient,
          assembly,
        ),
        "the protected routes accept the admin app client audience",
      ).toBe(true);

      const docBot = adminBot(scenario, "docentes");
      if (!docBot) return;
      const documentBucket = documentBucketFor(scenario, docBot);
      expect(documentBucket).toBeDefined();
      if (!documentBucket) return;

      expect(docBot.documentTable.logicalId).not.toBe(docBot.conversationTable.logicalId);
      expect(records(docBot.chatTemplate, "AWS::DynamoDB::Table")).toContainEqual(
        expect.objectContaining({ logicalId: docBot.documentTable.logicalId }),
      );
      expect(docBot.documentTable.properties.TimeToLiveSpecification).toBeUndefined();
      expect(docBot.documentTable.properties.AttributeDefinitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ AttributeName: "pk" }),
          expect.objectContaining({ AttributeName: "sk" }),
        ]),
      );
      expect(
        dependencies(assembly, admin).has(docBot.chatId),
        "AdminStack consumes the bot's private resources",
      ).toBe(true);
      expect(
        dependencies(assembly, findStack(assembly, docBot.chatId)).has(admin.id),
        "ChatStack does not depend on AdminStack",
      ).toBe(false);
      const chatStack = findStack(assembly, docBot.chatId);
      const knowledgeBase = records(docBot.chatTemplate, "AWS::Bedrock::KnowledgeBase")[0];
      const dataSource = records(docBot.chatTemplate, "AWS::Bedrock::DataSource")[0];
      expect(
        catalogEntryReferences(
          docBot.catalogEntry,
          docBot.catalogParsed,
          docBot.documentTable,
          admin,
          chatStack,
          assembly,
        ),
      ).toBe(true);
      expect(
        catalogEntryReferences(
          docBot.catalogEntry,
          docBot.catalogParsed,
          documentBucket,
          admin,
          chatStack,
          assembly,
        ),
      ).toBe(true);
      expect(
        catalogEntryReferences(
          docBot.catalogEntry,
          docBot.catalogParsed,
          knowledgeBase,
          admin,
          chatStack,
          assembly,
        ),
      ).toBe(true);
      expect(
        catalogEntryReferences(
          docBot.catalogEntry,
          docBot.catalogParsed,
          dataSource,
          admin,
          chatStack,
          assembly,
        ),
      ).toBe(true);
      expect(JSON.stringify(docBot.catalogEntry)).toContain("prepared/");
      expect(JSON.stringify(docBot.catalogEntry)).toContain("incoming/");
      const apiDynamo = roleStatements(scenario, handler).filter((statement) =>
        statementActions(statement).some((action) => action.startsWith("dynamodb:")),
      );
      const apiDocumentDynamo = statementsForResource(
        apiDynamo,
        handler,
        admin,
        chatStack,
        docBot.documentTable,
        assembly,
      );
      expect(apiDocumentDynamo.length).toBeGreaterThan(0);
      expect(
        apiDocumentDynamo.every((statement) =>
          referencesResource(statement.Resource, admin, chatStack, docBot.documentTable, assembly),
        ),
        "API state access targets the document table, separate from conversations",
      ).toBe(true);

      const receipts = incomingBuckets(scenario);
      expect(receipts, "AdminStack has a separate temporary receipt bucket").toHaveLength(1);
      const receipt = receipts[0];
      expect(receipt.properties.PublicAccessBlockConfiguration).toMatchObject({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(
        catalogEntryReferences(
          docBot.catalogEntry,
          docBot.catalogParsed,
          receipt,
          admin,
          admin,
          assembly,
        ),
        "the docentes catalog entry selects its own AdminStack receipt bucket",
      ).toBe(true);
      const receiptPolicies = records(admin, "AWS::S3::BucketPolicy").filter(({ properties }) =>
        referencesResource(properties.Bucket, admin, admin, receipt, assembly),
      );
      expect(receiptPolicies, "the temporary receipt bucket has its own HTTPS policy").toHaveLength(
        1,
      );
      const receiptPolicyStatements =
        receiptPolicies[0]?.properties.PolicyDocument?.Statement || [];
      expect(receiptPolicyStatements.length).toBeGreaterThan(0);
      expect(
        receiptPolicyStatements.every((statement) => statement.Effect === "Deny"),
        "the receipt policy grants no public access",
      ).toBe(true);
      expect(
        receiptPolicyStatements.some((statement) => {
          const secureTransport = statement.Condition?.Bool?.["aws:SecureTransport"];
          return (
            statement.Effect === "Deny" &&
            (secureTransport === "false" || secureTransport === false) &&
            referencesResource(statement.Resource, admin, admin, receipt, assembly)
          );
        }),
        "the receipt bucket rejects insecure transport",
      ).toBe(true);
      expect(
        catalogEntryReferences(
          docBot.catalogEntry,
          docBot.catalogParsed,
          machine,
          admin,
          admin,
          assembly,
        ),
        "the server catalog binds document operations to the shared executor",
      ).toBe(true);
      const distribution = records(admin, "AWS::CloudFront::Distribution")[0];
      const rules = receipt.properties.CorsConfiguration?.CorsRules || [];
      expect(rules, "the receipt bucket configures browser upload CORS").toHaveLength(1);
      const cors = rules[0];
      expect(cors.AllowedMethods).toEqual(["POST"]);
      expect(cors.AllowedOrigins).toHaveLength(1);
      expect(
        referencesResource(cors.AllowedOrigins, admin, admin, distribution, assembly),
        "receipt CORS accepts exactly this AdminStack distribution origin",
      ).toBe(true);
      expect(cors.AllowedHeaders?.length).toBeGreaterThan(0);
      expect(cors.AllowedHeaders.map((header) => header.toLowerCase())).toContain("content-type");
      expect(cors.AllowedHeaders).not.toContain("*");
      expect(
        (receipt.properties.LifecycleConfiguration?.Rules || []).some(
          (rule) =>
            (rule.Filter?.Prefix || rule.Prefix) === "incoming/" && rule.ExpirationInDays === 1,
        ),
        "unpromoted uploads expire from the incoming prefix after one day",
      ).toBe(true);
      expect(receipt.properties.VersioningConfiguration).toBeUndefined();
      expect(receipt.properties.NotificationConfiguration).toBeUndefined();
      expect(documentBucket.properties.NotificationConfiguration).toBeUndefined();

      const apiStatements = roleStatements(scenario, handler);
      const apiS3 = apiStatements.filter((statement) =>
        statementActions(statement).some((action) => action.toLowerCase().startsWith("s3:")),
      );
      expect(apiS3.length).toBeGreaterThan(0);
      const apiS3Actions = [...new Set(apiS3.flatMap(statementActions))].sort();
      expect(apiS3Actions).toEqual(["s3:GetObject", "s3:PutObject"]);
      expect(
        apiS3.every(
          (statement) =>
            resourceItems(statement.Resource).every(
              (resource) =>
                referencesResource(resource, admin, admin, receipt, assembly) &&
                stringIncludes(resource, "incoming/"),
            ) &&
            statementActions(statement).every((action) =>
              ["s3:GetObject", "s3:PutObject"].includes(action),
            ),
        ),
        "the API signs uploads and checks receipt metadata only under incoming/",
      ).toBe(true);
      expect(
        apiStatements.flatMap(statementActions).filter((action) => action.startsWith("bedrock:")),
      ).toEqual([]);
      expect(
        apiStatements.flatMap(statementActions).filter((action) => action.startsWith("lambda:")),
      ).toEqual([]);

      const machineStatements = roleStatements(scenario, handler).filter((statement) =>
        statementActions(statement).some((action) => action.startsWith("states:")),
      );
      const stateActions = [...new Set(machineStatements.flatMap(statementActions))].sort();
      expect(stateActions).toEqual(["states:DescribeExecution", "states:StartExecution"]);
      expect(
        machineStatements.every((statement) =>
          referencesResource(statement.Resource, admin, admin, machine, assembly),
        ),
        "the API starts and reads only this environment's executor",
      ).toBe(true);
      expect(
        referencesResource(envValue(handler, "BOT_CATALOG"), admin, admin, machine, assembly),
        "the server-side catalog resolves the environment's executor",
      ).toBe(true);

      expect(machine.properties.StateMachineType).toBe("STANDARD");
      const definition = parseJsonTemplateValue(machine.properties.DefinitionString);
      expect(definition, "the synthesized state-machine definition is inspectable").toBeDefined();
      if (!definition) return;
      const states = definition.States || {};
      const tasks = Object.entries(states).filter(([, state]) => state.Type === "Task");
      const workerPayloads = tasks.map(([name, state]) => ({
        name,
        state,
        payload: workerTaskPayload(state),
      }));
      expect(workerPayloads.length).toBeGreaterThanOrEqual(5);
      expect(workerPayloads.every(({ payload }) => payload)).toBe(true);
      for (const { payload } of workerPayloads) {
        expect(Object.keys(payload).sort()).toEqual(["botId", "operationId", "step"]);
        expect(payload.botId).toBe("$.botId");
        expect(payload.operationId).toBe("$.operationId");
        expect(typeof payload.step).toBe("string");
      }
      expect(
        new Set(workerPayloads.map(({ payload }) => payload.step)).size,
      ).toBeGreaterThanOrEqual(5);
      const orderedSteps = [
        "validate",
        "promote",
        "start-ingestion",
        "observe-ingestion",
        "finish",
      ].map((step) => workerPayloads.find((task) => task.payload.step === step));
      expect(orderedSteps.every(Boolean)).toBe(true);
      for (const [index, task] of orderedSteps.slice(0, -1).entries()) {
        expect(reachable(definition, task.name, orderedSteps[index + 1].name)).toBe(true);
      }
      expect(
        workerPayloads.filter(
          (task) =>
            task.payload.step !== "finish" &&
            reachable(definition, orderedSteps[4].name, task.name),
        ),
        "no worker effect follows the final result write",
      ).toEqual([]);
      const waits = Object.entries(states)
        .filter(([, state]) => state.Type === "Wait")
        .map(([name]) => name);
      expect(waits.length).toBeGreaterThan(0);
      expect(
        waits.some((name) => states[name].Seconds === 30),
        "the executor waits thirty seconds between ingestion observations",
      ).toBe(true);
      expect(
        waits.some(
          (wait) =>
            reachable(definition, orderedSteps[3].name, wait) &&
            reachable(definition, wait, orderedSteps[3].name),
        ),
        "the worker observes ingestion in a wait-and-read loop",
      ).toBe(true);
      const timeoutSeconds = definition.TimeoutSeconds;
      expect(
        Number.isSafeInteger(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds <= 86_400,
      ).toBe(true);
      const uploadEffect = workerPayloads.find(({ payload }) => payload.step === "promote");
      expect(uploadEffect, "the workflow has a distinct source promotion step").toBeDefined();
      if (uploadEffect) expect(uploadEffect.state.Retry || []).toEqual([]);
      expect(
        workerPayloads.every(
          ({ payload }) => !Object.keys(payload).some((key) => /file|s3|bucket|key/i.test(key)),
        ),
        "file metadata, S3 keys, and bytes do not enter workflow task payloads",
      ).toBe(true);
      const terminalOutcomes = Object.values(states).flatMap((state) =>
        (state.Choices || []).filter((choice) =>
          /failed|unconfirmed/i.test(JSON.stringify(choice)),
        ),
      );
      for (const outcome of terminalOutcomes) {
        expect(
          workerPayloads.filter(
            (task) =>
              task.payload.step !== "finish" && reachable(definition, outcome.Next, task.name),
          ),
          "failed or unconfirmed outcomes cannot reach another worker effect",
        ).toEqual([]);
      }

      const workerStatements = roleStatements(scenario, worker);
      const workerDynamo = workerStatements.filter((statement) =>
        statementActions(statement).some((action) => action.startsWith("dynamodb:")),
      );
      const documentDynamo = statementsForResource(
        workerDynamo,
        worker,
        admin,
        findStack(assembly, docBot.chatId),
        docBot.documentTable,
        assembly,
      );
      expect(documentDynamo.length).toBeGreaterThan(0);
      expect(
        workerDynamo.every((statement) =>
          referencesResource(
            statement.Resource,
            admin,
            findStack(assembly, docBot.chatId),
            docBot.documentTable,
            assembly,
          ),
        ),
        "the worker cannot read or write account or conversation tables",
      ).toBe(true);

      const workerS3 = workerStatements.filter((statement) =>
        statementActions(statement).some((action) => action.toLowerCase().startsWith("s3:")),
      );
      expect(workerS3.length).toBeGreaterThan(0);
      expect(
        workerS3.some(
          (statement) =>
            statementActions(statement).includes("s3:DeleteObject") &&
            resourceItems(statement.Resource).some(
              (resource) =>
                referencesResource(
                  resource,
                  admin,
                  findStack(assembly, docBot.chatId),
                  documentBucket,
                  assembly,
                ) && stringIncludes(resource, "prepared/"),
            ),
        ),
        "the worker can retire prior and withdrawn prepared sources",
      ).toBe(true);
      expect(
        workerS3.every((statement) => {
          const resources = resourceItems(statement.Resource);
          const objectActions = statementActions(statement).some((action) =>
            /Object$/.test(action),
          );
          const bucketList = statementActions(statement).includes("s3:ListBucket");
          const scope = `${JSON.stringify(statement.Resource)} ${JSON.stringify(statement.Condition)}`;
          return resources.every((resource) => {
            const incoming =
              referencesResource(resource, admin, admin, receipt, assembly) &&
              (!objectActions || stringIncludes(resource, "incoming/"));
            const prepared =
              referencesResource(
                resource,
                admin,
                findStack(assembly, docBot.chatId),
                documentBucket,
                assembly,
              ) &&
              (!objectActions || stringIncludes(resource, "prepared/"));
            return (
              (incoming || prepared) &&
              (!bucketList || scope.includes("incoming/") || scope.includes("prepared/"))
            );
          });
        }),
        "worker object permissions name only temporary incoming or prepared bot paths",
      ).toBe(true);

      const workerBedrock = workerStatements.filter((statement) =>
        statementActions(statement).some((action) => action.startsWith("bedrock:")),
      );
      const bedrockActions = [...new Set(workerBedrock.flatMap(statementActions))].sort();
      expect(bedrockActions).toEqual(
        expect.arrayContaining([
          "bedrock:GetIngestionJob",
          "bedrock:ListIngestionJobs",
          "bedrock:StartIngestionJob",
          "bedrock:GetKnowledgeBaseDocuments",
        ]),
      );
      expect(
        workerBedrock.every((statement) =>
          referencesResource(
            statement.Resource,
            admin,
            findStack(assembly, docBot.chatId),
            knowledgeBase,
            assembly,
          ),
        ),
        "job and document observations stay within this bot's Knowledge Base",
      ).toBe(true);
      expect(
        bedrockActions.some((action) => /InvokeModel|CountTokens/i.test(action)),
        "the ingestion worker has no generation or embedding model grant",
      ).toBe(false);

      expect(worker.properties.Runtime).toBe("nodejs24.x");
      const workerAsset = resourceAsset(assembly, admin, worker.properties.Code);
      expect(workerAsset, "the state machine invokes a bundled worker asset").toBeDefined();
      expect(
        workerAsset?.files.some(({ relativePath }) => /\.m?js$/i.test(path.basename(relativePath))),
      ).toBe(true);
      expect(workerAsset?.files.some((file) => readAssetFile(file).length > 0)).toBe(true);
      expect(
        referencesResource(
          machine.properties,
          admin,
          admin,
          { logicalId: worker.logicalId },
          assembly,
        ),
      ).toBe(true);
      const workerPermissions = records(admin, "AWS::Lambda::Permission").filter(({ properties }) =>
        referencesResource(
          properties.FunctionName,
          admin,
          admin,
          { logicalId: worker.logicalId },
          assembly,
        ),
      );
      if (workerPermissions.length > 0) {
        expect(
          workerPermissions.every(
            ({ properties }) =>
              properties.Principal === "states.amazonaws.com" &&
              referencesResource(properties.SourceArn, admin, admin, machine, assembly),
          ),
          "Step Functions is the only configured event source allowed to invoke the worker",
        ).toBe(true);
      }
      const stateMachineRoleId = getAttLogicalId(machine.properties.RoleArn);
      const stateMachineStatements = rolePolicyStatements(admin, stateMachineRoleId);
      const workerInvokeStatements = stateMachineStatements.filter((statement) =>
        statementActions(statement).includes("lambda:InvokeFunction"),
      );
      expect(workerInvokeStatements.length).toBeGreaterThan(0);
      expect(
        workerInvokeStatements.every((statement) =>
          referencesResource(
            statement.Resource,
            admin,
            admin,
            { logicalId: worker.logicalId },
            assembly,
          ),
        ),
        "the state-machine role can invoke only its worker Lambda",
      ).toBe(true);
      expect(
        referencesResource(
          machine.properties.DefinitionString,
          admin,
          admin,
          { logicalId: worker.logicalId },
          assembly,
        ),
        "the synthesized workflow definition itself references the worker",
      ).toBe(true);
      expect(
        records(admin, "AWS::Lambda::EventSourceMapping").filter(({ properties }) =>
          referencesResource(
            properties.FunctionName,
            admin,
            admin,
            { logicalId: worker.logicalId },
            assembly,
          ),
        ),
      ).toEqual([]);
      expect(records(admin, "AWS::SQS::Queue")).toEqual([]);
      expect(records(admin, "AWS::Events::Rule")).toEqual([]);

      const publicConfig = receiptConfigFile(scenario);
      expect(publicConfig).toBeDefined();
      if (publicConfig) {
        const text = readAssetFile(publicConfig).replace(/<<marker:0xbaba:\d+>>/g, "null");
        const parsed = JSON.parse(text);
        const allConfigFields = flattenedStrings(parsed).join(" ").toLowerCase();
        expect(allConfigFields).not.toMatch(
          /bucket|prepared\/|incoming\/|knowledge.?base|data.?source|state.?machine|workflow.?arn|secret.?key|presigned|credentials/,
        );
        expect(text).not.toMatch(/arn:(?:aws|aws-us-gov):/i);
        expect(text).not.toMatch(/X-Amz-(?:Credential|Signature|Security-Token)/i);
      }
    },
  );

  it("keeps document tables, buckets, KBs, and catalogs isolated per bot and environment", async () => {
    const dev = await scenarioFor("dev", ["docentes", "bot-uno"]);
    const prod = await scenarioFor("prod");
    expect(dev.admin).toBeDefined();
    expect(prod.admin).toBeDefined();
    if (!dev.admin || !prod.admin) return;

    const configs = [
      { scenario: dev, botId: "docentes", environment: "dev" },
      { scenario: dev, botId: "bot-uno", environment: "dev" },
      { scenario: prod, botId: "docentes", environment: "prod" },
    ].map(({ scenario, botId, environment }) => {
      const bot = adminBot(scenario, botId);
      if (!bot) return undefined;
      const bucket = documentBucketFor(scenario, bot);
      const knowledgeBase = records(bot.chatTemplate, "AWS::Bedrock::KnowledgeBase")[0];
      const dataSource = records(bot.chatTemplate, "AWS::Bedrock::DataSource")[0];
      const receipts = incomingBuckets(scenario).filter(({ logicalId }) =>
        catalogEntryReferences(
          bot.catalogEntry,
          bot.catalogParsed,
          { logicalId },
          scenario.admin,
          scenario.admin,
          scenario.assembly,
        ),
      );
      expect(
        receipts,
        `${environment}:${botId} has a distinct receipt bucket reference`,
      ).toHaveLength(1);
      return {
        scenario,
        botId,
        ...bot,
        environment,
        bucket,
        knowledgeBase,
        dataSource,
        receipt: receipts[0],
      };
    });
    expect(configs.every(Boolean)).toBe(true);
    if (configs.some((item) => !item)) return;

    for (const [label, values] of [
      ["document table", configs.map(({ documentTable }) => documentTable.properties.TableName)],
      ["prepared bucket", configs.map(({ bucket }) => bucket.properties.BucketName)],
      ["receipt bucket", configs.map(({ receipt }) => receipt.properties.BucketName)],
      ["Knowledge Base", configs.map(({ knowledgeBase }) => knowledgeBase.properties.Name)],
      ["data source", configs.map(({ dataSource }) => dataSource.properties.Name)],
    ]) {
      expect(
        new Set(values.map((value) => JSON.stringify(value))).size,
        `${label} names are unique`,
      ).toBe(values.length);
    }

    for (const {
      scenario,
      botId,
      documentTable,
      bucket,
      receipt,
      knowledgeBase,
      dataSource,
      catalogParsed,
      catalogEntry,
    } of configs) {
      const handler = apiHandler(scenario);
      const apiStatements = roleStatements(scenario, handler);
      const { worker } = workerAndStateMachine(scenario);
      expect(worker, `${scenario.environment} has a document worker`).toBeDefined();
      if (!worker) continue;
      const workerStatements = roleStatements(scenario, worker);
      expect(catalogEntry?.botId).toBe(botId);
      expect(
        catalogEntryReferences(
          catalogEntry,
          catalogParsed,
          documentTable,
          scenario.admin,
          findStack(scenario.assembly, scenario.bots.get(botId).chatId),
          scenario.assembly,
        ),
      ).toBe(true);
      expect(
        catalogEntryReferences(
          catalogEntry,
          catalogParsed,
          dataSource,
          scenario.admin,
          findStack(scenario.assembly, scenario.bots.get(botId).chatId),
          scenario.assembly,
        ),
      ).toBe(true);
      expect(
        catalogEntryReferences(
          catalogEntry,
          catalogParsed,
          bucket,
          scenario.admin,
          findStack(scenario.assembly, scenario.bots.get(botId).chatId),
          scenario.assembly,
        ),
      ).toBe(true);
      expect(
        catalogEntryReferences(
          catalogEntry,
          catalogParsed,
          knowledgeBase,
          scenario.admin,
          findStack(scenario.assembly, scenario.bots.get(botId).chatId),
          scenario.assembly,
        ),
      ).toBe(true);
      expect(
        catalogEntryReferences(
          catalogEntry,
          catalogParsed,
          receipt,
          scenario.admin,
          scenario.admin,
          scenario.assembly,
        ),
      ).toBe(true);
      const botChat = findStack(scenario.assembly, scenario.bots.get(botId).chatId);
      const apiDocTableGrants = statementsForResource(
        apiStatements.filter((statement) =>
          statementActions(statement).some((action) => action.startsWith("dynamodb:")),
        ),
        handler,
        scenario.admin,
        botChat,
        documentTable,
        scenario.assembly,
      );
      const workerDocTableGrants = statementsForResource(
        workerStatements.filter((statement) =>
          statementActions(statement).some((action) => action.startsWith("dynamodb:")),
        ),
        worker,
        scenario.admin,
        botChat,
        documentTable,
        scenario.assembly,
      );
      const workerKnowledgeBaseGrants = statementsForResource(
        workerStatements.filter((statement) =>
          statementActions(statement).some((action) => action.startsWith("bedrock:")),
        ),
        worker,
        scenario.admin,
        botChat,
        knowledgeBase,
        scenario.assembly,
      );
      const apiReceiptGrants = statementsForResource(
        apiStatements.filter((statement) =>
          statementActions(statement).some((action) => action.startsWith("s3:")),
        ),
        handler,
        scenario.admin,
        scenario.admin,
        receipt,
        scenario.assembly,
      );
      const apiPreparedGrants = statementsForResource(
        apiStatements.filter((statement) =>
          statementActions(statement).some((action) => action.startsWith("s3:")),
        ),
        handler,
        scenario.admin,
        botChat,
        bucket,
        scenario.assembly,
      );
      const workerReceiptGrants = statementsForResource(
        workerStatements.filter((statement) =>
          statementActions(statement).some((action) => action.startsWith("s3:")),
        ),
        worker,
        scenario.admin,
        scenario.admin,
        receipt,
        scenario.assembly,
      );
      const workerPreparedGrants = statementsForResource(
        workerStatements.filter((statement) =>
          statementActions(statement).some((action) => action.startsWith("s3:")),
        ),
        worker,
        scenario.admin,
        botChat,
        bucket,
        scenario.assembly,
      );
      expect(apiDocTableGrants.length).toBeGreaterThan(0);
      expect(workerDocTableGrants.length).toBeGreaterThan(0);
      expect(workerKnowledgeBaseGrants.length).toBeGreaterThan(0);
      expect(apiReceiptGrants.length).toBeGreaterThan(0);
      expect(apiPreparedGrants).toEqual([]);
      expect(workerReceiptGrants.length).toBeGreaterThan(0);
      expect(workerPreparedGrants.length).toBeGreaterThan(0);
      expect(
        apiReceiptGrants.every(
          (statement) =>
            statementActions(statement).every((action) =>
              ["s3:GetObject", "s3:PutObject"].includes(action),
            ) &&
            resourceItems(statement.Resource).every((resource) =>
              stringIncludes(resource, "incoming/"),
            ),
        ),
      ).toBe(true);
      expect(
        workerPreparedGrants.every((statement) => hasS3PrefixScope(statement, "prepared/")),
      ).toBe(true);
      expect(
        workerReceiptGrants.every((statement) => hasS3PrefixScope(statement, "incoming/")),
      ).toBe(true);
    }
  });

  it.each(environments)(
    "%s preserves Runtime Retrieve, the prepared-only source, and the approved embedding configuration",
    async (environment) => {
      const scenario = await scenarioFor(environment);
      const bot = adminBot(scenario, "docentes");
      if (!bot) return;
      const runtime = records(bot.chatTemplate, "AWS::BedrockAgentCore::Runtime")[0];
      const runtimeRoleId = getAttLogicalId(runtime.properties.RoleArn);
      const runtimeStatements = lambdaPolicies(findStack(scenario.assembly, bot.chatId), {
        logicalId: runtimeRoleId,
        properties: { Role: runtime.properties.RoleArn },
      }).statements;
      const actions = runtimeStatements
        .flatMap(statementActions)
        .filter((action) => action.startsWith("bedrock:"));
      expect(actions).toContain("bedrock:Retrieve");
      expect(actions.some((action) => /Ingestion|KnowledgeBaseDocuments/i.test(action))).toBe(
        false,
      );
      const retrieve = runtimeStatements.filter((statement) =>
        statementActions(statement).includes("bedrock:Retrieve"),
      );

      const knowledgeBase = records(bot.chatTemplate, "AWS::Bedrock::KnowledgeBase")[0];
      const vectorIndex = records(bot.chatTemplate, "AWS::S3Vectors::Index")[0];
      const dataSource = records(bot.chatTemplate, "AWS::Bedrock::DataSource")[0];
      const source = dataSource.properties.DataSourceConfiguration?.S3Configuration;
      const preparedPrefix = source?.InclusionPrefixes?.[0];
      expect(preparedPrefix).toBe("prepared/");
      expect(JSON.stringify(source)).not.toContain("incoming/");
      expect(dataSource.properties.ParsingConfiguration).toBeUndefined();
      expect(
        dataSource.properties.VectorIngestionConfiguration?.ChunkingConfiguration,
      ).toMatchObject({
        ChunkingStrategy: "FIXED_SIZE",
        FixedSizeChunkingConfiguration: { MaxTokens: 500, OverlapPercentage: 20 },
      });
      expect(vectorIndex.properties.Dimension).toBe(1024);
      expect(String(vectorIndex.properties.DistanceMetric).toLowerCase()).toBe("cosine");
      expect(
        templateString(
          knowledgeBase.properties.KnowledgeBaseConfiguration?.VectorKnowledgeBaseConfiguration
            ?.EmbeddingModelArn,
        ),
      ).toContain("amazon.titan-embed-text-v2:0");
      expect(
        referencesResource(
          runtime.properties.EnvironmentVariables,
          findStack(scenario.assembly, bot.chatId),
          findStack(scenario.assembly, bot.chatId),
          knowledgeBase,
          scenario.assembly,
        ),
      ).toBe(true);
      const runtimeStack = findStack(scenario.assembly, bot.chatId);
      expect(
        retrieve.length > 0 &&
          retrieve.every((statement) =>
            referencesResource(
              statement.Resource,
              runtimeStack,
              runtimeStack,
              knowledgeBase,
              scenario.assembly,
            ),
          ),
        "Runtime Retrieve remains limited to its existing Knowledge Base",
      ).toBe(true);
    },
  );
});
