import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App } from "aws-cdk-lib";
import { afterAll, describe, expect, it } from "vitest";
import { resolveEnvironment } from "../../dist/config/project.js";
import { AccountStack } from "../../dist/infra/lib/account-stack.js";
import { PublicSiteStack } from "../../dist/infra/lib/public-site-stack.js";
import { SharedIdentityStack } from "../../dist/infra/lib/shared-identity-stack.js";

const temporaryDirectories = new Set();
const scenarioCache = new Map();
const expectedRuntimeId = "ChatRuntime82B3183A";
const expectedConversationTableId = "ConversationTable75C14D21";

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

function namedResourceIdentity(record, propertyName, stackName) {
  const name = record.properties[propertyName];
  expect(name, `${record.logicalId} must declare ${propertyName} for isolation`).toBeDefined();
  return templateString(name, stackName);
}

function referencesNamedResource(configuration, resource, arnProperty, nameProperty, nameField) {
  if (configuration?.[arnProperty] !== undefined) {
    return referencesResource(configuration[arnProperty], resource.logicalId);
  }
  return (
    configuration?.[nameProperty] !== undefined &&
    templateString(configuration[nameProperty]) === templateString(resource.properties[nameField])
  );
}

function resourceArns(statement) {
  const resource = statement.Resource;
  return (Array.isArray(resource) ? resource : [resource]).map(templateString);
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

function runtimeRoleId(template) {
  const runtime = onlyRecord(template, "AWS::BedrockAgentCore::Runtime");
  return logicalIdFromGetAtt(runtime.properties.RoleArn);
}

async function scenarioFor(environment, botIds = ["docentes"]) {
  const cacheKey = `${environment}:${[...botIds].sort().join(",")}`;
  const cached = scenarioCache.get(cacheKey);
  if (cached) return cached;

  const { ChatStack } = await import("../../dist/infra/lib/chat-stack.js");
  expect(typeof ChatStack, "ChatStack export is required for document infrastructure tests").toBe(
    "function",
  );
  if (typeof ChatStack !== "function") return undefined;

  const outputDirectory = mkdtempSync(
    path.join(tmpdir(), `multi-chatbot-documents-${environment}-`),
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
      accountId: account.node.id,
      chatId: chat.node.id,
      chatStackName: chat.stackName,
      siteId: site.node.id,
      account,
      chat,
      site,
    });
  }

  const scenario = {
    environment,
    identityId: identity.node.id,
    identity,
    bots,
    assembly: app.synth(),
  };
  scenarioCache.set(cacheKey, scenario);
  return scenario;
}

function scenarioResources(scenario, bot) {
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

function expectTagged(resource, environment) {
  expect(tagPairs(resource.properties.Tags)).toContainEqual(["project", "multi-chatbot"]);
  expect(tagValue(resource.properties.Tags, "environment")).toBe(environment);
}

describe("chat documents infrastructure template acceptance", () => {
  it.each(["dev", "prod"])(
    "%s synthesizes a private document source, Titan V2 S3 Vectors KB, and scoped Runtime Retrieve",
    async (environment) => {
      const scenario = await scenarioFor(environment);
      expect(scenario, `expected the ${environment} template scenario`).toBeDefined();
      if (!scenario) return;
      const bot = scenario.bots.get("docentes");
      expect(bot).toBeDefined();
      if (!bot) return;
      const templates = scenarioResources(scenario, bot);
      if (!templates) return;
      const { chatTemplate, accountTemplate, identityTemplate, siteTemplate } = templates;

      const runtime = onlyRecord(chatTemplate, "AWS::BedrockAgentCore::Runtime");
      const conversationTable = onlyRecord(chatTemplate, "AWS::DynamoDB::Table");
      const documentBucket = onlyRecord(chatTemplate, "AWS::S3::Bucket");
      const vectorBucket = onlyRecord(chatTemplate, "AWS::S3Vectors::VectorBucket");
      const vectorIndex = onlyRecord(chatTemplate, "AWS::S3Vectors::Index");
      const knowledgeBase = onlyRecord(chatTemplate, "AWS::Bedrock::KnowledgeBase");
      const dataSource = onlyRecord(chatTemplate, "AWS::Bedrock::DataSource");
      const webBucket = onlyRecord(siteTemplate, "AWS::S3::Bucket");
      const identityPool = onlyRecord(identityTemplate, "AWS::Cognito::UserPool");
      const accountClient = onlyRecord(accountTemplate, "AWS::Cognito::UserPoolClient");

      // The existing Runtime and conversation table keep their deployed identities.
      expect(runtime.logicalId).toBe(expectedRuntimeId);
      expect(conversationTable.logicalId).toBe(expectedConversationTableId);
      expect(documentBucket.logicalId).not.toBe(webBucket.logicalId);
      expect(documentBucket.properties.WebsiteConfiguration).toBeUndefined();
      expect(documentBucket.properties.PublicAccessBlockConfiguration).toMatchObject({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      for (const retained of [documentBucket, vectorBucket, vectorIndex]) {
        expect(retained.resource.DeletionPolicy).toBe("Retain");
        expect(retained.resource.UpdateReplacePolicy).toBe("Retain");
        expectTagged(retained, environment);
      }

      const indexProperties = vectorIndex.properties;
      expect(indexProperties.Dimension).toBe(1024);
      expect(String(indexProperties.DataType).toLowerCase()).toBe("float32");
      expect(String(indexProperties.DistanceMetric).toLowerCase()).toBe("cosine");
      expect(
        referencesNamedResource(
          indexProperties,
          vectorBucket,
          "VectorBucketArn",
          "VectorBucketName",
          "VectorBucketName",
        ),
      ).toBe(true);
      const reserved = indexProperties.MetadataConfiguration?.NonFilterableMetadataKeys || [];
      expect(reserved).toEqual(
        expect.arrayContaining(["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"]),
      );

      const kbProperties = knowledgeBase.properties;
      const vectorConfiguration = kbProperties.StorageConfiguration?.S3VectorsConfiguration;
      expect(kbProperties.KnowledgeBaseConfiguration?.Type).toBe("VECTOR");
      expect(vectorConfiguration).toBeDefined();
      expect(
        referencesNamedResource(
          vectorConfiguration,
          vectorBucket,
          "VectorBucketArn",
          "VectorBucketName",
          "VectorBucketName",
        ),
      ).toBe(true);
      expect(
        referencesNamedResource(
          vectorConfiguration,
          vectorIndex,
          "IndexArn",
          "IndexName",
          "IndexName",
        ),
      ).toBe(true);
      const vectorKnowledgeConfiguration =
        kbProperties.KnowledgeBaseConfiguration?.VectorKnowledgeBaseConfiguration;
      expect(templateString(vectorKnowledgeConfiguration?.EmbeddingModelArn)).toContain(
        "amazon.titan-embed-text-v2:0",
      );
      expect(
        vectorKnowledgeConfiguration?.EmbeddingModelConfiguration
          ?.BedrockEmbeddingModelConfiguration,
      ).toMatchObject({
        Dimensions: 1024,
        EmbeddingDataType: expect.stringMatching(/float32/i),
      });
      expect(dataSource.properties.KnowledgeBaseId).toBeDefined();
      expect(
        referencesResource(dataSource.properties.KnowledgeBaseId, knowledgeBase.logicalId),
      ).toBe(true);
      const sourceConfiguration = dataSource.properties.DataSourceConfiguration?.S3Configuration;
      expect(referencesResource(sourceConfiguration?.BucketArn, documentBucket.logicalId)).toBe(
        true,
      );
      const documentPrefix = sourceConfiguration?.InclusionPrefixes?.[0];
      expect(typeof documentPrefix).toBe("string");
      expect(documentPrefix.length).toBeGreaterThan(0);
      const chunking = dataSource.properties.VectorIngestionConfiguration?.ChunkingConfiguration;
      expect(chunking).toMatchObject({
        ChunkingStrategy: "FIXED_SIZE",
        FixedSizeChunkingConfiguration: { MaxTokens: 500, OverlapPercentage: 20 },
      });
      expect(dataSource.properties.DataDeletionPolicy).toBe("RETAIN");

      const runtimeRole = runtimeRoleId(chatTemplate);
      const kbRole = logicalIdFromGetAtt(kbProperties.RoleArn);
      expect(runtimeRole).toBeDefined();
      expect(kbRole).toBeDefined();
      if (!runtimeRole || !kbRole) return;
      const runtimeStatements = rolePolicies(chatTemplate, runtimeRole);
      const authorizer = runtime.properties.AuthorizerConfiguration?.CustomJWTAuthorizer;
      expect(
        referencesExportedOutput(
          authorizer?.DiscoveryUrl,
          identityTemplate,
          scenario.identity.stackName,
          identityPool.logicalId,
        ),
        "Runtime must keep using the shared Cognito user pool",
      ).toBe(true);
      expect(
        referencesExportedOutput(
          authorizer?.AllowedClients,
          accountTemplate,
          bot.account.stackName,
          accountClient.logicalId,
        ),
        "Runtime must keep using this chatbot's Cognito client",
      ).toBe(true);
      const retrieveStatements = runtimeStatements.filter((statement) =>
        actions(statement).includes("bedrock:Retrieve"),
      );
      expect(retrieveStatements.length).toBeGreaterThan(0);
      expect(
        retrieveStatements.every((statement) =>
          referencesResource(statement.Resource, knowledgeBase.logicalId),
        ),
      ).toBe(true);
      expect(
        referencesResource(runtime.properties.EnvironmentVariables, knowledgeBase.logicalId),
        "Runtime configuration must resolve its own Knowledge Base",
      ).toBe(true);
      const runtimeBedrockActions = runtimeStatements
        .flatMap(actions)
        .filter(
          (action) => typeof action === "string" && action.toLowerCase().startsWith("bedrock:"),
        );
      expect(
        runtimeBedrockActions.some((action) =>
          /(?:Create|Update|Delete|Ingestion|Associate)/i.test(action),
        ),
      ).toBe(false);
      expect(
        runtimeStatements
          .flatMap(actions)
          .some((action) => typeof action === "string" && /^(?:s3|s3vectors):/i.test(action)),
      ).toBe(false);

      const kbStatements = rolePolicies(chatTemplate, kbRole);
      const role = chatTemplate.Resources[kbRole];
      expect(JSON.stringify(role?.Properties?.AssumeRolePolicyDocument).toLowerCase()).toContain(
        "bedrock.amazonaws.com",
      );
      const sourceReadStatements = kbStatements.filter((statement) =>
        actions(statement).some((action) => ["s3:GetObject", "s3:ListBucket"].includes(action)),
      );
      expect(sourceReadStatements.length).toBeGreaterThan(0);
      expect(
        sourceReadStatements.every((statement) =>
          referencesResource(statement.Resource, documentBucket.logicalId),
        ),
      ).toBe(true);
      const getObjectStatements = sourceReadStatements.filter((statement) =>
        actions(statement).includes("s3:GetObject"),
      );
      expect(getObjectStatements.length).toBeGreaterThan(0);
      expect(
        getObjectStatements.every((statement) =>
          resourceArns(statement).some((arn) => arn.includes(`/${documentPrefix}`)),
        ),
        "KB object reads must be limited to the data source prefix",
      ).toBe(true);
      const listBucketStatements = sourceReadStatements.filter((statement) =>
        actions(statement).includes("s3:ListBucket"),
      );
      expect(listBucketStatements.length).toBeGreaterThan(0);
      expect(
        listBucketStatements.every((statement) =>
          JSON.stringify(statement.Condition).includes(documentPrefix),
        ),
        "KB listing must use the data source prefix condition",
      ).toBe(true);
      const embeddingStatements = kbStatements.filter((statement) =>
        actions(statement).includes("bedrock:InvokeModel"),
      );
      expect(embeddingStatements.length).toBeGreaterThan(0);
      expect(
        embeddingStatements.every((statement) =>
          resourceArns(statement).some((arn) => arn.includes("amazon.titan-embed-text-v2:0")),
        ),
      ).toBe(true);
      const vectorStatements = kbStatements.filter((statement) =>
        actions(statement).some(
          (action) => typeof action === "string" && action.startsWith("s3vectors:"),
        ),
      );
      expect(vectorStatements.length).toBeGreaterThan(0);
      expect(
        vectorStatements.every((statement) =>
          referencesResource(statement.Resource, vectorIndex.logicalId),
        ),
      ).toBe(true);

      expectTagged(documentBucket, environment);
      expectTagged(vectorIndex, environment);
      expectTagged(knowledgeBase, environment);
      expectTagged(runtime, environment);
      const accountLambdaRole = logicalIdFromGetAtt(
        onlyRecord(accountTemplate, "AWS::Lambda::Function").properties.Role,
      );
      expect(
        rolePolicies(accountTemplate, accountLambdaRole)
          .flatMap(actions)
          .filter((action) => typeof action === "string" && action.startsWith("bedrock:")),
      ).toEqual([]);
    },
  );

  it("gives each bot and environment its own Runtime, document bucket, vector index, and KB", async () => {
    const botIds = ["docentes", "bot-uno", "bot-dos"];
    const dev = await scenarioFor("dev", botIds);
    const prod = await scenarioFor("prod");
    expect(dev).toBeDefined();
    expect(prod).toBeDefined();
    if (!dev || !prod) return;

    const configurations = [
      ...botIds.map((botId) => ({ scenario: dev, botId, environment: "dev" })),
      { scenario: prod, botId: "docentes", environment: "prod" },
    ].map(({ scenario, botId, environment }) => {
      const bot = scenario.bots.get(botId);
      expect(bot).toBeDefined();
      if (!bot) return undefined;
      const template = stackTemplate(scenario.assembly, bot.chatId);
      expect(template).toBeDefined();
      if (!template) return undefined;
      return {
        scenario,
        environment,
        botId,
        stackName: bot.chatStackName,
        runtime: onlyRecord(template, "AWS::BedrockAgentCore::Runtime"),
        table: onlyRecord(template, "AWS::DynamoDB::Table"),
        documentBucket: onlyRecord(template, "AWS::S3::Bucket"),
        vectorBucket: onlyRecord(template, "AWS::S3Vectors::VectorBucket"),
        vectorIndex: onlyRecord(template, "AWS::S3Vectors::Index"),
        knowledgeBase: onlyRecord(template, "AWS::Bedrock::KnowledgeBase"),
        dataSource: onlyRecord(template, "AWS::Bedrock::DataSource"),
      };
    });
    expect(configurations.every(Boolean)).toBe(true);
    if (configurations.some((configuration) => !configuration)) return;

    const runtimeNames = configurations.map((configuration) =>
      namedResourceIdentity(configuration.runtime, "AgentRuntimeName", configuration.stackName),
    );
    const tableNames = configurations.map((configuration) =>
      namedResourceIdentity(configuration.table, "TableName", configuration.stackName),
    );
    const documentBucketNames = configurations.map((configuration) =>
      namedResourceIdentity(configuration.documentBucket, "BucketName", configuration.stackName),
    );
    const vectorBucketNames = configurations.map((configuration) =>
      namedResourceIdentity(
        configuration.vectorBucket,
        "VectorBucketName",
        configuration.stackName,
      ),
    );
    const vectorIndexNames = configurations.map(
      (configuration, index) =>
        `${vectorBucketNames[index]}/${namedResourceIdentity(
          configuration.vectorIndex,
          "IndexName",
          configuration.stackName,
        )}`,
    );
    const knowledgeBaseNames = configurations.map((configuration) =>
      namedResourceIdentity(configuration.knowledgeBase, "Name", configuration.stackName),
    );
    const dataSourceNames = configurations.map((configuration) =>
      namedResourceIdentity(configuration.dataSource, "Name", configuration.stackName),
    );
    for (const [resourceKind, names] of [
      ["Runtime", runtimeNames],
      ["conversation table", tableNames],
      ["document bucket", documentBucketNames],
      ["vector bucket", vectorBucketNames],
      ["vector index", vectorIndexNames],
      ["Knowledge Base", knowledgeBaseNames],
      ["data source", dataSourceNames],
    ]) {
      expect(new Set(names).size, `${resourceKind} physical names must be separate`).toBe(
        names.length,
      );
    }
    for (const configuration of configurations) {
      expect(configuration.runtime.properties.EnvironmentVariables?.BOT_ID).toBe(
        configuration.botId,
      );
      expectTagged(configuration.runtime, configuration.environment);
      expectTagged(configuration.table, configuration.environment);
      expectTagged(configuration.documentBucket, configuration.environment);
      expectTagged(configuration.vectorBucket, configuration.environment);
      expectTagged(configuration.vectorIndex, configuration.environment);
      expectTagged(configuration.knowledgeBase, configuration.environment);
      const template = stackTemplate(
        configuration.scenario.assembly,
        configuration.scenario.bots.get(configuration.botId).chatId,
      );
      const runtimeRole = runtimeRoleId(template);
      const knowledgeBaseRole = logicalIdFromGetAtt(configuration.knowledgeBase.properties.RoleArn);
      const retrieveStatements = rolePolicies(template, runtimeRole).filter((statement) =>
        actions(statement).includes("bedrock:Retrieve"),
      );
      expect(retrieveStatements.length).toBeGreaterThan(0);
      expect(
        retrieveStatements.every((statement) =>
          referencesResource(statement.Resource, configuration.knowledgeBase.logicalId),
        ),
      ).toBe(true);
      expect(
        referencesResource(
          configuration.runtime.properties.EnvironmentVariables,
          configuration.knowledgeBase.logicalId,
        ),
      ).toBe(true);
      const vectorConfiguration =
        configuration.knowledgeBase.properties.StorageConfiguration?.S3VectorsConfiguration;
      expect(
        referencesNamedResource(
          vectorConfiguration,
          configuration.vectorBucket,
          "VectorBucketArn",
          "VectorBucketName",
          "VectorBucketName",
        ),
      ).toBe(true);
      expect(
        referencesNamedResource(
          vectorConfiguration,
          configuration.vectorIndex,
          "IndexArn",
          "IndexName",
          "IndexName",
        ),
      ).toBe(true);
      const knowledgeBaseStatements = rolePolicies(template, knowledgeBaseRole);
      expect(
        referencesResource(
          configuration.dataSource.properties.DataSourceConfiguration?.S3Configuration?.BucketArn,
          configuration.documentBucket.logicalId,
        ),
      ).toBe(true);
      expect(
        referencesResource(
          configuration.dataSource.properties.KnowledgeBaseId,
          configuration.knowledgeBase.logicalId,
        ),
      ).toBe(true);
      const sourceReadStatements = knowledgeBaseStatements.filter((statement) =>
        actions(statement).some((action) => ["s3:GetObject", "s3:ListBucket"].includes(action)),
      );
      const documentPrefix =
        configuration.dataSource.properties.DataSourceConfiguration?.S3Configuration
          ?.InclusionPrefixes?.[0];
      expect(typeof documentPrefix).toBe("string");
      expect(documentPrefix.length).toBeGreaterThan(0);
      expect(sourceReadStatements.length).toBeGreaterThan(0);
      expect(
        sourceReadStatements.every((statement) =>
          referencesResource(statement.Resource, configuration.documentBucket.logicalId),
        ),
      ).toBe(true);
      const objectReadStatements = sourceReadStatements.filter((statement) =>
        actions(statement).includes("s3:GetObject"),
      );
      expect(objectReadStatements.length).toBeGreaterThan(0);
      expect(
        objectReadStatements.every((statement) =>
          resourceArns(statement).some((arn) => arn.includes(`/${documentPrefix}`)),
        ),
      ).toBe(true);
      const bucketListStatements = sourceReadStatements.filter((statement) =>
        actions(statement).includes("s3:ListBucket"),
      );
      expect(bucketListStatements.length).toBeGreaterThan(0);
      expect(
        bucketListStatements.every((statement) =>
          JSON.stringify(statement.Condition).includes(documentPrefix),
        ),
      ).toBe(true);
      const vectorStatements = knowledgeBaseStatements.filter((statement) =>
        actions(statement).some(
          (action) => typeof action === "string" && action.startsWith("s3vectors:"),
        ),
      );
      expect(vectorStatements.length).toBeGreaterThan(0);
      expect(
        vectorStatements.every((statement) =>
          referencesResource(statement.Resource, configuration.vectorIndex.logicalId),
        ),
      ).toBe(true);
    }
  }, 60_000);
});
