import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { afterAll, describe, expect, it } from "vitest";

const projectRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporaryDirectories = new Set();

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

async function runtimeTemplate() {
  const runtimeAsset = path.join(projectRoot, "dist/runtime-image");
  expect(
    existsSync(runtimeAsset),
    "build the existing Runtime asset before template acceptance",
  ).toBe(true);
  if (!existsSync(runtimeAsset)) return undefined;

  let project;
  let identityModule;
  let accountModule;
  let chatModule;
  let capacityModule;
  try {
    [project, identityModule, accountModule, chatModule, capacityModule] = await Promise.all([
      import("../../dist/config/project.js"),
      import("../../dist/infra/lib/shared-identity-stack.js"),
      import("../../dist/infra/lib/account-stack.js"),
      import("../../dist/infra/lib/chat-stack.js"),
      import("../../dist/runtime/model-capacity.js"),
    ]);
  } catch (error) {
    expect(
      false,
      `compiled Runtime/ChatStack acceptance modules must be available: ${String(error)}`,
    ).toBe(true);
    return undefined;
  }
  expect(typeof project.resolveEnvironment).toBe("function");
  expect(typeof identityModule.SharedIdentityStack).toBe("function");
  expect(typeof accountModule.AccountStack).toBe("function");
  expect(typeof chatModule.ChatStack).toBe("function");
  expect(capacityModule.maxOutputTokens).toBe(64_000);
  if (
    typeof project.resolveEnvironment !== "function" ||
    typeof identityModule.SharedIdentityStack !== "function" ||
    typeof accountModule.AccountStack !== "function" ||
    typeof chatModule.ChatStack !== "function"
  ) {
    return undefined;
  }

  const outputDirectory = mkdtempSync(path.join(tmpdir(), "multi-chatbot-summary-template-"));
  temporaryDirectories.add(outputDirectory);
  const app = new App({ outdir: outputDirectory });
  const environment = project.resolveEnvironment("dev");
  const botEnvironment = project.resolveEnvironment("dev", "docentes");
  const previousRevision = process.env.REVISION;
  process.env.REVISION = "a".repeat(40);
  try {
    const identity = new identityModule.SharedIdentityStack(
      app,
      `${environment.resourcePrefix}-identity`,
      environment,
    );
    const account = new accountModule.AccountStack(
      app,
      `${botEnvironment.botResourcePrefix}-account`,
      botEnvironment,
      identity.userPool,
    );
    const chat = new chatModule.ChatStack(
      app,
      `${botEnvironment.botResourcePrefix}-chat`,
      botEnvironment,
      identity,
      account,
    );
    const assembly = app.synth();
    const templates = new Map();
    for (const [name, stack] of [
      ["chat", chat],
      ["account", account],
      ["identity", identity],
    ]) {
      const artifact = assembly.manifest.artifacts[stack.node.id];
      expect(
        artifact?.type,
        `synthesized ${name} stack must be present in the real CDK assembly`,
      ).toBe("aws:cloudformation:stack");
      if (artifact?.type !== "aws:cloudformation:stack") return undefined;
      templates.set(
        name,
        JSON.parse(
          readFileSync(path.join(assembly.directory, artifact.properties.templateFile), "utf8"),
        ),
      );
    }
    return Object.fromEntries(templates);
  } finally {
    if (previousRevision === undefined) delete process.env.REVISION;
    else process.env.REVISION = previousRevision;
  }
}

function resourceEntries(template, type) {
  return Object.entries(template?.Resources || {}).filter(([, resource]) => resource.Type === type);
}

function roleIdFromReference(reference) {
  const value = reference?.["Fn::GetAtt"];
  return Array.isArray(value) ? value[0] : typeof value === "string" ? value.split(".")[0] : null;
}

function attachedStatements(template, roleId) {
  const inline =
    template.Resources?.[roleId]?.Properties?.Policies?.flatMap(
      (policy) => policy.PolicyDocument?.Statement || [],
    ) || [];
  const attached = resourceEntries(template, "AWS::IAM::Policy")
    .filter(([, resource]) => JSON.stringify(resource.Properties?.Roles || []).includes(roleId))
    .flatMap(([, resource]) => resource.Properties?.PolicyDocument?.Statement || []);
  return [...inline, ...attached];
}

describe("summary preparation infrastructure acceptance", () => {
  it("configures one Runtime with approved defaults without extra storage or granting the history reader Bedrock", async () => {
    const templates = await runtimeTemplate();
    expect(templates, "a synthesized stack assembly is required").toBeDefined();
    if (!templates) return;
    const { chat: template, account: accountTemplate, identity: identityTemplate } = templates;

    const runtimes = resourceEntries(template, "AWS::BedrockAgentCore::Runtime");
    expect(runtimes, "summary preparation uses the conversation Runtime").toHaveLength(1);
    const runtimeVariables = runtimes[0]?.[1].Properties?.EnvironmentVariables;
    expect(runtimeVariables).toMatchObject({
      SUMMARY_TRIGGER_TOKENS: "128000",
      SUMMARY_RECENT_PAIRS: "4",
      SUMMARY_PREPARATION_TIMEOUT_MS: "3600000",
      MODEL_ID: "global.anthropic.claude-sonnet-4-6",
    });

    const tables = resourceEntries(template, "AWS::DynamoDB::Table");
    expect(tables, "summary versions must stay in the existing conversation table").toHaveLength(1);
    expect(tables[0]?.[0]).toBe("ConversationTable75C14D21");
    const persistentChatResourceTypes = new Set([
      "AWS::DynamoDB::Table",
      "AWS::BedrockAgentCore::Runtime",
      "AWS::Bedrock::KnowledgeBase",
      "AWS::Bedrock::DataSource",
      "AWS::S3::Bucket",
      "AWS::S3Vectors::VectorBucket",
      "AWS::S3Vectors::Index",
    ]);
    expect(
      Object.entries(template.Resources || {})
        .filter(([, resource]) => persistentChatResourceTypes.has(resource.Type))
        .map(([logicalId]) => logicalId)
        .sort(),
    ).toEqual(
      [
        "ConversationTable75C14D21",
        "DocumentsDocumentBucket897CB1F9",
        "DocumentsVectorBucket9B83E6D0",
        "DocumentsVectorIndexD1E04ED4",
        "DocumentsKnowledgeBase6B2C8C67",
        "DocumentsDocumentDataSourceEAB8D31A",
        runtimes[0][0],
      ].sort(),
    );
    expect(resourceEntries(accountTemplate, "AWS::ApiGatewayV2::Api").map(([id]) => id)).toEqual([
      "AccountApi36A667E3",
    ]);
    expect(resourceEntries(accountTemplate, "AWS::DynamoDB::Table").map(([id]) => id)).toEqual([
      "AccountTable95876246",
    ]);
    expect(
      resourceEntries(accountTemplate, "AWS::Cognito::UserPoolClient").map(([id]) => id),
    ).toEqual(["AccountClientBC2B019C"]);
    expect(resourceEntries(identityTemplate, "AWS::Cognito::UserPool").map(([id]) => id)).toEqual([
      "SharedUserPoolC062B7AD",
    ]);
    expect(resourceEntries(template, "AWS::Lambda::Function")).toHaveLength(1);

    const readers = resourceEntries(template, "AWS::Lambda::Function").filter(
      ([, resource]) =>
        resource.Properties?.Environment?.Variables?.HISTORY_INDEX_NAME === "ConversationHistory",
    );
    expect(readers, "the existing history reader must remain the only chat Lambda").toHaveLength(1);
    const historyRoleId = roleIdFromReference(readers[0]?.[1].Properties?.Role);
    expect(historyRoleId, "history reader must keep its scoped role").toBeTruthy();
    const statements = historyRoleId ? attachedStatements(template, historyRoleId) : [];
    expect(
      statements.some((statement) =>
        (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).some((action) =>
          /^bedrock:/i.test(String(action)),
        ),
      ),
    ).toBe(false);
  });
});
