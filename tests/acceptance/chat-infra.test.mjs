import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
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

function sourceMarkerForJsonKey(contents, key) {
  const match = contents.match(new RegExp(`"${key}"\\s*:\\s*(<<marker:0xbaba:\\d+>>)`, "i"));
  return match?.[1];
}

function sourceMarkerValue(template, marker) {
  for (const deployment of records(template, "Custom::CDKBucketDeployment")) {
    for (const sourceMarkers of deployment.properties.SourceMarkers || []) {
      if (Object.hasOwn(sourceMarkers, marker)) return sourceMarkers[marker];
    }
  }
  return undefined;
}

function tagPairs(tags) {
  if (Array.isArray(tags)) {
    return tags.filter((tag) => typeof tag.Key === "string").map(({ Key, Value }) => [Key, Value]);
  }
  if (Array.isArray(tags?.Items)) {
    return tags.Items.filter((tag) => typeof tag.Key === "string").map(({ Key, Value }) => [
      Key,
      Value,
    ]);
  }
  return Object.entries(tags || {});
}

function tagValue(tags, key) {
  return tagPairs(tags).find(([tagKey]) => tagKey === key)?.[1];
}

function stackTemplate(assembly, stackId) {
  const artifact = assembly.manifest.artifacts[stackId];
  if (!artifact || artifact.type !== "aws:cloudformation:stack") return undefined;
  return JSON.parse(
    readFileSync(path.join(assembly.directory, artifact.properties.templateFile), "utf8"),
  );
}

function assetManifest(assembly, stackId) {
  const artifact = assembly.manifest.artifacts[`${stackId}.assets`];
  if (!artifact || artifact.type !== "cdk:asset-manifest") return undefined;
  return JSON.parse(readFileSync(path.join(assembly.directory, artifact.properties.file), "utf8"));
}

function listFiles(directory, prefix = "") {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const filePath = path.join(directory, name);
    return statSync(filePath).isDirectory() ? listFiles(filePath, relativePath) : [relativePath];
  });
}

async function scenarioFor(environment, botIds = ["docentes"]) {
  const cacheKey = `${environment}:${[...botIds].sort().join(",")}`;
  expect(
    existsSync(chatStackSource),
    `ChatStack source must exist before acceptance case ${cacheKey} can run`,
  ).toBe(true);
  if (!existsSync(chatStackSource)) return undefined;

  const cached = scenarioCache.get(cacheKey);
  if (cached) return cached;

  const { ChatStack } = await import("../../dist/infra/lib/chat-stack.js");
  expect(typeof ChatStack, `ChatStack export is required for ${cacheKey}`).toBe("function");
  if (typeof ChatStack !== "function") return undefined;

  const outputDirectory = mkdtempSync(path.join(tmpdir(), `multi-chatbot-chat-${environment}-`));
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
      chatId: chat.node.id,
      siteId: site.node.id,
      account,
      chat,
      site,
    });
  }

  const assembly = app.synth();
  const scenario = {
    environment,
    identityId: identity.node.id,
    identity,
    bots,
    assembly,
    outputDirectory,
  };
  scenarioCache.set(cacheKey, scenario);
  return scenario;
}

function accountRoleBedrockActions(accountTemplate) {
  const lambda = onlyRecord(accountTemplate, "AWS::Lambda::Function");
  const roleId = logicalIdFromGetAtt(lambda.properties.Role);
  return rolePolicies(accountTemplate, roleId)
    .flatMap(actions)
    .filter((action) => typeof action === "string" && /^bedrock:/i.test(action));
}

function referencedStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(referencedStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(referencedStrings);
  return [];
}

function templateString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(templateString).join("");
  if (!value || typeof value !== "object") return String(value ?? "");
  if (value.Ref === "AWS::Partition") return "aws";
  if (Array.isArray(value["Fn::Join"])) {
    const [separator, pieces] = value["Fn::Join"];
    return (pieces || []).map(templateString).join(separator);
  }
  if (typeof value["Fn::Sub"] === "string") {
    return value["Fn::Sub"].replaceAll("${AWS::Partition}", "aws");
  }
  return JSON.stringify(value);
}

function resourceArns(statement) {
  const resource = statement.Resource;
  return (Array.isArray(resource) ? resource : [resource]).map(templateString);
}

function conditionValues(statement, conditionKey) {
  const values = [];
  descendants(statement.Condition || {}, (node) => {
    if (Object.hasOwn(node, conditionKey)) values.push(...referencedStrings(node[conditionKey]));
  });
  return values;
}

function publicConfigFile(assembly, siteId) {
  const manifest = assetManifest(assembly, siteId);
  if (!manifest) return undefined;
  const stagedDirectories = Object.values(manifest.files || {})
    .filter(({ source }) => source?.packaging === "zip")
    .map(({ source }) => path.resolve(assembly.directory, source.path))
    .filter((sourcePath) => {
      const relative = path.relative(assembly.directory, sourcePath);
      return !relative.startsWith("..") && !path.isAbsolute(relative) && existsSync(sourcePath);
    });
  const matches = stagedDirectories.flatMap((directory) => {
    const filePath = path.join(directory, "public-config.json");
    return existsSync(filePath) ? [filePath] : [];
  });
  expect(matches, `public-config.json should be staged in ${siteId}'s checked asset`).toHaveLength(
    1,
  );
  return matches[0];
}

function runtimeConfig(scenario, bot) {
  const configPath = publicConfigFile(scenario.assembly, bot.siteId);
  if (!configPath) return undefined;
  const contents = readFileSync(configPath, "utf8");
  return { contents, parsed: JSON.parse(contents.replace(/<<marker:0xbaba:\d+>>/g, "null")) };
}

function runtimeRoleId(chatTemplate) {
  const runtime = onlyRecord(chatTemplate, "AWS::BedrockAgentCore::Runtime");
  return logicalIdFromGetAtt(runtime.properties.RoleArn);
}

function matchingActions(statements, prefix) {
  return statements.flatMap(actions).filter((action) => {
    return typeof action === "string" && action.toLowerCase().startsWith(prefix.toLowerCase());
  });
}

describe("chat infrastructure acceptance", () => {
  it.each(["dev", "prod"])(
    "%s provisions an isolated JWT-protected Runtime and on-demand conversation table",
    async (environment) => {
      const scenario = await scenarioFor(environment);
      expect(scenario, `expected the ${environment} infrastructure scenario`).toBeDefined();
      if (!scenario) return;

      const bot = scenario.bots.get("docentes");
      expect(bot, `expected ${environment}:docentes`).toBeDefined();
      if (!bot) return;

      const chatTemplate = stackTemplate(scenario.assembly, bot.chatId);
      const accountTemplate = stackTemplate(scenario.assembly, bot.accountId);
      const identityTemplate = stackTemplate(scenario.assembly, scenario.identityId);
      expect(chatTemplate, "the synthesized ChatStack must be present").toBeDefined();
      expect(accountTemplate, "the existing AccountStack must be present").toBeDefined();
      expect(identityTemplate, "the shared Cognito stack must be present").toBeDefined();
      if (!chatTemplate || !accountTemplate || !identityTemplate) return;

      const runtime = onlyRecord(chatTemplate, "AWS::BedrockAgentCore::Runtime");
      const conversationTable = onlyRecord(chatTemplate, "AWS::DynamoDB::Table");
      const properties = runtime.properties;
      const authorizer = properties.AuthorizerConfiguration?.CustomJWTAuthorizer;
      const accountClient = onlyRecord(accountTemplate, "AWS::Cognito::UserPoolClient");
      const identityPool = onlyRecord(identityTemplate, "AWS::Cognito::UserPool");

      // These are the existing resources: the new protocol updates their code and data.
      expect(runtime.logicalId).toBe("ChatRuntime82B3183A");
      expect(conversationTable.logicalId).toBe("ConversationTable75C14D21");
      if (environment === "dev") {
        expect(properties.AgentRuntimeName).toBe("multichatbotdevdocenteschatChatRuntimeCA8B680F");
        expect(conversationTable.properties.TableName).toBe(
          "multi-chatbot-dev-docentes-conversations",
        );
      }

      expect(properties.ProtocolConfiguration).toBe("HTTP");
      expect(properties.RequestHeaderConfiguration?.RequestHeaderAllowlist).toEqual([
        "Authorization",
      ]);
      expect(authorizer, "Runtime must use its Cognito JWT authorizer").toBeDefined();
      expect(
        referencesExportedOutput(
          authorizer?.DiscoveryUrl,
          identityTemplate,
          scenario.identity.stackName,
          identityPool.logicalId,
        ),
      ).toBe(true);
      expect(authorizer?.AllowedClients).toHaveLength(1);
      expect(
        referencesExportedOutput(
          authorizer?.AllowedClients,
          accountTemplate,
          bot.account.stackName,
          accountClient.logicalId,
        ),
      ).toBe(true);
      expect(authorizer?.AllowedAudience || []).toEqual([]);
      expect(authorizer?.AllowedScopes || []).toEqual([]);
      expect(authorizer?.CustomClaims).toEqual([
        expect.objectContaining({
          InboundTokenClaimName: "token_use",
          InboundTokenClaimValueType: "STRING",
          AuthorizingClaimMatchValue: {
            ClaimMatchOperator: "EQUALS",
            ClaimMatchValue: { MatchValueString: "access" },
          },
        }),
      ]);

      expect(conversationTable.properties.BillingMode).toBe("PAY_PER_REQUEST");
      expect(conversationTable.properties.KeySchema).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ KeyType: "HASH" }),
          expect.objectContaining({ KeyType: "RANGE" }),
        ]),
      );
      expect(conversationTable.properties.TimeToLiveSpecification).toBeUndefined();
      expect(conversationTable.properties.GlobalSecondaryIndexes || []).toEqual([]);
      expect(conversationTable.properties.LocalSecondaryIndexes || []).toEqual([]);
      expect(conversationTable.properties.TableName).toContain(
        bot.botEnvironment.botResourcePrefix,
      );

      for (const record of [runtime, conversationTable]) {
        const tags = tagPairs(record.properties.Tags);
        expect(tags).toContainEqual(["project", "multi-chatbot"]);
        expect(tags).toContainEqual(["environment", environment]);
      }

      expect(records(chatTemplate, "AWS::BedrockAgentCore::RuntimeEndpoint")).toHaveLength(0);
      expect(records(chatTemplate, "AWS::ApiGatewayV2::Api")).toHaveLength(0);
      expect(records(chatTemplate, "AWS::Lambda::Function")).toHaveLength(0);
      expect(records(chatTemplate, "AWS::CloudFront::Distribution")).toHaveLength(0);
      expect(records(chatTemplate, "AWS::DynamoDB::Table")).toHaveLength(1);
      expect(records(accountTemplate, "AWS::ApiGatewayV2::Api")).toHaveLength(1);
      expect(records(accountTemplate, "AWS::Lambda::Function")).toHaveLength(1);
      expect(records(accountTemplate, "AWS::DynamoDB::Table")).toHaveLength(1);
      expect(records(identityTemplate, "AWS::Cognito::UserPool")).toHaveLength(1);
      expect(accountRoleBedrockActions(accountTemplate)).toEqual([]);
    },
  );

  it.each(["dev", "prod"])(
    "%s Runtime can read only the account/profile record and owns all conversation writes",
    async (environment) => {
      const scenario = await scenarioFor(environment);
      expect(scenario, `expected the ${environment} infrastructure scenario`).toBeDefined();
      if (!scenario) return;

      const bot = scenario.bots.get("docentes");
      expect(bot, `expected ${environment}:docentes`).toBeDefined();
      if (!bot) return;

      const chatTemplate = stackTemplate(scenario.assembly, bot.chatId);
      const accountTemplate = stackTemplate(scenario.assembly, bot.accountId);
      expect(chatTemplate).toBeDefined();
      expect(accountTemplate).toBeDefined();
      if (!chatTemplate || !accountTemplate) return;

      const runtimeRole = runtimeRoleId(chatTemplate);
      expect(runtimeRole, "Runtime role ARN must point to a role in ChatStack").toBeDefined();
      if (!runtimeRole) return;

      const statements = rolePolicies(chatTemplate, runtimeRole);
      const dynamoStatements = statements.filter(
        (statement) => matchingActions([statement], "dynamodb:").length > 0,
      );
      const accountTable = onlyRecord(accountTemplate, "AWS::DynamoDB::Table");
      const conversationTable = onlyRecord(chatTemplate, "AWS::DynamoDB::Table");
      const accountReads = dynamoStatements.filter((statement) => {
        const actionsForStatement = matchingActions([statement], "dynamodb:");
        return (
          actionsForStatement.includes("dynamodb:GetItem") &&
          !actionsForStatement.some((action) => action !== "dynamodb:GetItem") &&
          referencesExportedOutput(
            statement.Resource,
            accountTemplate,
            bot.account.stackName,
            accountTable.logicalId,
          )
        );
      });
      const conversationWrites = dynamoStatements.filter((statement) =>
        referencesResource(statement.Resource, conversationTable.logicalId),
      );
      const accountTableActions = new Set(matchingActions(accountReads, "dynamodb:"));
      const conversationActions = new Set(matchingActions(conversationWrites, "dynamodb:"));

      expect(accountTableActions).toEqual(new Set(["dynamodb:GetItem"]));
      expect([...conversationActions]).toEqual(
        expect.arrayContaining([
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:ConditionCheckItem",
        ]),
      );
      expect(
        [...conversationActions].every((action) =>
          [
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:ConditionCheckItem",
          ].includes(action),
        ),
      ).toBe(true);
      expect(
        dynamoStatements.every((statement) => {
          return (
            referencesExportedOutput(
              statement.Resource,
              accountTemplate,
              bot.account.stackName,
              accountTable.logicalId,
            ) || referencesResource(statement.Resource, conversationTable.logicalId)
          );
        }),
        "Runtime DynamoDB grants must name only this bot's profile and conversation tables",
      ).toBe(true);
      expect(
        dynamoStatements
          .flatMap(actions)
          .some(
            (action) => typeof action === "string" && /(?:Scan|Batch|Delete|PartiQL)/i.test(action),
          ),
      ).toBe(false);
    },
  );

  it.each(["dev", "prod"])(
    "%s Runtime invokes only Sonnet 4.6 through its agreed global inference profile",
    async (environment) => {
      const scenario = await scenarioFor(environment);
      expect(scenario, `expected the ${environment} infrastructure scenario`).toBeDefined();
      if (!scenario) return;

      const bot = scenario.bots.get("docentes");
      expect(bot, `expected ${environment}:docentes`).toBeDefined();
      if (!bot) return;

      const chatTemplate = stackTemplate(scenario.assembly, bot.chatId);
      expect(chatTemplate).toBeDefined();
      if (!chatTemplate) return;

      const roleId = runtimeRoleId(chatTemplate);
      expect(roleId).toBeDefined();
      if (!roleId) return;
      const bedrockStatements = rolePolicies(chatTemplate, roleId).filter(
        (statement) => matchingActions([statement], "bedrock:").length > 0,
      );
      const modelActions = new Set(matchingActions(bedrockStatements, "bedrock:"));
      const profileArn =
        "arn:aws:bedrock:us-east-1:118903272638:inference-profile/global.anthropic.claude-sonnet-4-6";
      const sourceModelArn =
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6";
      const globalModelArn = "arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-4-6";
      const generationStatements = bedrockStatements.filter((statement) =>
        matchingActions([statement], "bedrock:").includes("bedrock:InvokeModelWithResponseStream"),
      );
      const countTokenStatements = bedrockStatements.filter((statement) =>
        matchingActions([statement], "bedrock:").includes("bedrock:CountTokens"),
      );
      const generationResources = new Set(generationStatements.flatMap(resourceArns));
      const countTokenResources = new Set(countTokenStatements.flatMap(resourceArns));
      const resources = new Set(bedrockStatements.flatMap(resourceArns));

      expect(modelActions).toEqual(
        new Set(["bedrock:InvokeModelWithResponseStream", "bedrock:CountTokens"]),
      );
      expect(generationResources).toEqual(new Set([profileArn, sourceModelArn, globalModelArn]));
      expect(countTokenResources).toEqual(new Set([sourceModelArn]));
      expect(resources).toEqual(new Set([profileArn, sourceModelArn, globalModelArn]));
      expect(
        [...resources].every((resource) => !resource.includes("*")),
        "Bedrock grants may not name other models, profiles, or wildcard resources",
      ).toBe(true);
      expect(bedrockStatements.every((statement) => statement.Effect === "Allow")).toBe(true);
      const statementsFor = (arn) =>
        generationStatements.filter((statement) => resourceArns(statement).includes(arn));
      const profileStatements = statementsFor(profileArn);
      const sourceModelStatements = statementsFor(sourceModelArn);
      const globalModelStatements = statementsFor(globalModelArn);

      expect(profileStatements.length).toBeGreaterThan(0);
      expect(sourceModelStatements.length).toBeGreaterThan(0);
      expect(globalModelStatements.length).toBeGreaterThan(0);
      expect(
        profileStatements.some((statement) =>
          conditionValues(statement, "aws:RequestedRegion").includes("us-east-1"),
        ),
      ).toBe(true);
      expect(
        sourceModelStatements.some(
          (statement) =>
            conditionValues(statement, "aws:RequestedRegion").includes("us-east-1") &&
            conditionValues(statement, "bedrock:InferenceProfileArn").includes(profileArn),
        ),
      ).toBe(true);
      expect(
        globalModelStatements.some(
          (statement) =>
            conditionValues(statement, "aws:RequestedRegion").includes("unspecified") &&
            conditionValues(statement, "bedrock:InferenceProfileArn").includes(profileArn),
        ),
      ).toBe(true);
      expect(
        profileStatements.every(
          (statement) => conditionValues(statement, "bedrock:InferenceProfileArn").length === 0,
        ),
      ).toBe(true);
    },
  );

  it.each(["dev", "prod"])(
    "%s publishes only the Runtime ARN and qualifier as public chat configuration",
    async (environment) => {
      const scenario = await scenarioFor(environment);
      expect(scenario, `expected the ${environment} infrastructure scenario`).toBeDefined();
      if (!scenario) return;
      const bot = scenario.bots.get("docentes");
      expect(bot).toBeDefined();
      if (!bot) return;
      expect(bot.chat.runtimeArn).toBeDefined();
      expect(bot.chat.runtimeQualifier).toBe("DEFAULT");

      const siteTemplate = stackTemplate(scenario.assembly, bot.siteId);
      expect(siteTemplate).toBeDefined();
      if (!siteTemplate) return;

      const configAsset = runtimeConfig(scenario, bot);
      expect(configAsset, "the checked public config asset must exist").toBeDefined();
      if (!configAsset) return;

      const { parsed, contents } = configAsset;
      expect(parsed).toMatchObject({
        region: "us-east-1",
        botId: "docentes",
        apiBaseUrl: "/api",
        runtimeQualifier: "DEFAULT",
      });
      expect(parsed.runtimeArn).toBeNull();
      expect(parsed.userPoolId).toBeNull();
      expect(parsed.clientId).toBeNull();
      expect(Object.keys(parsed).sort()).toEqual(
        [
          "apiBaseUrl",
          "botId",
          "clientId",
          "region",
          "runtimeArn",
          "runtimeQualifier",
          "userPoolId",
        ].sort(),
      );
      expect(contents).not.toMatch(
        /secret|password|token|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/i,
      );

      const runtimeArnMarker = sourceMarkerForJsonKey(contents, "runtimeArn");
      expect(
        runtimeArnMarker,
        "runtime ARN must be injected from the checked CDK output",
      ).toBeDefined();
      const runtimeArnSource = sourceMarkerValue(siteTemplate, runtimeArnMarker);
      expect(runtimeArnSource, "runtime ARN marker must be bound in site deployment").toBeDefined();
      const chatTemplate = stackTemplate(scenario.assembly, bot.chatId);
      expect(chatTemplate).toBeDefined();
      if (!chatTemplate) return;
      const runtime = onlyRecord(chatTemplate, "AWS::BedrockAgentCore::Runtime");
      expect(
        referencesExportedOutput(
          runtimeArnSource,
          chatTemplate,
          bot.chat.stackName,
          runtime.logicalId,
        ),
        "public config must reference this bot's Runtime output",
      ).toBe(true);
      for (const key of ["userPoolId", "clientId"]) {
        const marker = sourceMarkerForJsonKey(contents, key);
        expect(marker, `${key} remains a deploy-time public identifier`).toBeDefined();
        expect(sourceMarkerValue(siteTemplate, marker)).toBeDefined();
      }

      const distributions = records(siteTemplate, "AWS::CloudFront::Distribution");
      expect(distributions).toHaveLength(1);
      for (const { properties } of distributions) {
        const cacheBehaviors = properties.DistributionConfig?.CacheBehaviors || [];
        expect(cacheBehaviors.map(({ PathPattern }) => PathPattern)).toEqual(["/api/*"]);
      }
      expect(records(siteTemplate, "AWS::BedrockAgentCore::Runtime")).toHaveLength(0);
    },
  );

  it("keeps per-chatbot and per-environment Runtime and table identities separate", async () => {
    const dev = await scenarioFor("dev", ["docentes", "bot-uno", "bot-dos"]);
    expect(dev, "expected the dev multi-bot scenario").toBeDefined();
    if (!dev) return;
    const prod = await scenarioFor("prod");
    expect(prod, "expected the prod scenario").toBeDefined();
    if (!prod) return;

    const devBots = ["docentes", "bot-uno", "bot-dos"].map((botId) => dev.bots.get(botId));
    expect(devBots.every(Boolean)).toBe(true);
    if (devBots.some((bot) => !bot)) return;
    const prodBot = prod.bots.get("docentes");
    expect(prodBot).toBeDefined();
    if (!prodBot) return;

    const recordsByBot = devBots.map((bot) => {
      const template = stackTemplate(dev.assembly, bot.chatId);
      expect(template).toBeDefined();
      if (!template) return undefined;
      return {
        runtime: onlyRecord(template, "AWS::BedrockAgentCore::Runtime"),
        table: onlyRecord(template, "AWS::DynamoDB::Table"),
        config: runtimeConfig(dev, bot),
      };
    });
    const prodTemplate = stackTemplate(prod.assembly, prodBot.chatId);
    expect(prodTemplate).toBeDefined();
    if (!prodTemplate) return;
    const prodRuntime = onlyRecord(prodTemplate, "AWS::BedrockAgentCore::Runtime");
    const prodTable = onlyRecord(prodTemplate, "AWS::DynamoDB::Table");

    const names = [
      ...recordsByBot.flatMap((record) => [record?.table.properties.TableName]),
      prodTable.properties.TableName,
    ];
    expect(new Set(names.map((name) => JSON.stringify(name))).size).toBe(names.length);
    const runtimeNames = [
      ...recordsByBot.flatMap((record) => [record?.runtime.properties.AgentRuntimeName]),
      prodRuntime.properties.AgentRuntimeName,
    ];
    expect(new Set(runtimeNames.map((name) => JSON.stringify(name))).size).toBe(
      runtimeNames.length,
    );
    expect(recordsByBot.map((record) => record?.config?.parsed.botId)).toEqual([
      "docentes",
      "bot-uno",
      "bot-dos",
    ]);
    expect(recordsByBot.map((record) => record?.config?.parsed.runtimeQualifier)).toEqual([
      "DEFAULT",
      "DEFAULT",
      "DEFAULT",
    ]);
    expect(tagValue(recordsByBot[0]?.runtime.properties.Tags, "environment")).toBe("dev");
    expect(tagValue(prodRuntime.properties.Tags, "environment")).toBe("prod");
  });

  it("stages a self-contained Node 24 ARM64 Runtime image", async () => {
    const scenario = await scenarioFor("dev");
    expect(scenario, "expected the dev infrastructure scenario").toBeDefined();
    if (!scenario) return;
    const bot = scenario.bots.get("docentes");
    expect(bot).toBeDefined();
    if (!bot) return;

    const manifest = assetManifest(scenario.assembly, bot.chatId);
    expect(manifest, "ChatStack must have a checked asset manifest").toBeDefined();
    if (!manifest) return;
    const dockerImages = Object.values(manifest.dockerImages || {});
    expect(dockerImages, "the checked assembly must contain the Runtime image asset").toHaveLength(
      1,
    );
    if (dockerImages.length !== 1) return;

    const source = dockerImages[0].source || {};
    expect(source.platform).toBe("linux/arm64");
    expect(typeof source.directory).toBe("string");
    const assetDirectory = path.resolve(scenario.outputDirectory, source.directory || "missing");
    const relativeAssetPath = path.relative(scenario.outputDirectory, assetDirectory);
    expect(relativeAssetPath.startsWith("..") || path.isAbsolute(relativeAssetPath)).toBe(false);
    expect(existsSync(assetDirectory) && statSync(assetDirectory).isDirectory()).toBe(true);
    if (!existsSync(assetDirectory)) return;

    const dockerFileName = source.dockerFile || "Dockerfile";
    const dockerFilePath = path.join(assetDirectory, dockerFileName);
    expect(existsSync(dockerFilePath), "the Runtime asset stages its Dockerfile").toBe(true);
    if (!existsSync(dockerFilePath)) return;
    const dockerfile = readFileSync(dockerFilePath, "utf8");
    const files = listFiles(assetDirectory);
    const javascriptFiles = files.filter(
      (file) => /\.(?:m?js|cjs)$/.test(file) && !file.startsWith("node_modules/"),
    );
    expect(javascriptFiles.length).toBeGreaterThan(0);
    expect(dockerfile).toMatch(
      /\b(?:FROM|ARG\s+[A-Za-z_][\w]*=)\s*[^\s]*node(?:js)?:24[^\s]*@sha256:[a-f0-9]{64}/im,
    );
    expect(dockerfile).toMatch(/\bCOPY\b/i);
    expect(dockerfile).not.toMatch(/\b(?:npm|pnpm|yarn)\s+(?:install|ci|add)\b/i);
  }, 60_000);
});
