import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedSubjects = [
  "repo:guilleojeda@18320860/multi-chatbot@1409472663:ref:refs/tags/dev",
  "repo:guilleojeda@18320860/multi-chatbot@1409472663:ref:refs/tags/prod",
];
const providerArn = "arn:aws:iam::118903272638:oidc-provider/token.actions.githubusercontent.com";

function descendants(value, visit) {
  if (Array.isArray(value)) {
    for (const child of value) descendants(child, visit);
    return;
  }
  if (value && typeof value === "object") {
    visit(value);
    for (const child of Object.values(value)) descendants(child, visit);
  }
}

function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return [];
}

function exactConditionValues(condition, claim) {
  const found = [];
  const exactOperators = new Set([
    "StringEquals",
    "ForAnyValue:StringEquals",
    "ForAllValues:StringEquals",
  ]);
  for (const [operator, values] of Object.entries(condition || {})) {
    if (exactOperators.has(operator) && values && typeof values === "object") {
      found.push(...strings(values[claim]));
    }
  }
  return found;
}

function list(value) {
  return Array.isArray(value) ? value : [value];
}

function hasExactProvider(principal) {
  return (
    principal !== null &&
    typeof principal === "object" &&
    !Array.isArray(principal) &&
    principal.Federated === providerArn &&
    Object.keys(principal).length === 1
  );
}

function actionAllowsWebIdentity(action) {
  if (typeof action !== "string") return true;
  const expression = [...action.toLowerCase()]
    .map((character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${expression}$`).test("sts:assumerolewithwebidentity");
}

function statementActions(statement) {
  if (Object.hasOwn(statement, "NotAction")) return [undefined];
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function webIdentityAllowStatements(policy) {
  return list(policy.Statement || []).filter((statement) => {
    return (
      statement.Effect === "Allow" && statementActions(statement).some(actionAllowsWebIdentity)
    );
  });
}

function tagPairs(value) {
  const pairs = [];
  descendants(value, (node) => {
    if (typeof node.Key === "string" && Object.hasOwn(node, "Value")) {
      pairs.push([node.Key, node.Value]);
    }
    if (typeof node.key === "string" && Object.hasOwn(node, "value")) {
      pairs.push([node.key, node.value]);
    }
    if (node.tags && !Array.isArray(node.tags) && typeof node.tags === "object") {
      for (const [key, value] of Object.entries(node.tags)) pairs.push([key, value]);
    }
  });
  return pairs;
}

function synthesize(outputDirectory, environment) {
  const args = ["run", "synth", "--", "--output", outputDirectory];
  if (environment) args.push("-c", `environment=${environment}`);

  return spawnSync(npmCommand, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 45_000,
    env: {
      ...process.env,
      CDK_OUTDIR: outputDirectory,
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_SESSION_TOKEN: "",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_CONFIG_FILE: path.join(outputDirectory, "no-aws-config"),
      AWS_SHARED_CREDENTIALS_FILE: path.join(outputDirectory, "no-aws-credentials"),
    },
  });
}

function commandOutput(result) {
  return [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
}

function verifySharedSetup(outputDirectory) {
  const manifest = JSON.parse(readFileSync(path.join(outputDirectory, "manifest.json"), "utf8"));
  const stacks = Object.values(manifest.artifacts).filter(
    (artifact) => artifact.type === "aws:cloudformation:stack",
  );
  expect(stacks.length).toBeGreaterThan(0);
  for (const stack of stacks) {
    expect(stack.environment).toBe("aws://118903272638/us-east-1");
    expect(stack.properties.bootstrapStackVersionSsmParameter).toBe(
      "/cdk-bootstrap/hnb659fds/version",
    );
    expect(stack.properties.requiresBootstrapStackVersion).toBeGreaterThan(0);
  }

  const templates = stacks.map((stack) =>
    JSON.parse(readFileSync(path.join(outputDirectory, stack.properties.templateFile), "utf8")),
  );
  const resources = templates.flatMap((template) => Object.values(template.Resources || {}));
  expect(resources.length).toBeGreaterThan(0);
  expect(resources.some(({ Type }) => Type === "AWS::IAM::OIDCProvider")).toBe(false);
  const applicationResourcePattern =
    /^(?:AWS::(?:S3|S3Vectors|CloudFront|DynamoDB|Lambda|ApiGateway(?:V2)?|Cognito|Bedrock|BedrockAgentCore)::)/;
  const applicationResourceTypes = resources
    .map(({ Type }) => Type)
    .filter((type) => applicationResourcePattern.test(type));
  expect(applicationResourceTypes).toEqual([]);

  const roleResources = resources.filter(({ Type }) => Type === "AWS::IAM::Role");
  expect(roleResources.length).toBeGreaterThan(0);
  for (const role of roleResources) {
    const roleTags = tagPairs(role.Properties?.Tags || []);
    expect(roleTags).toContainEqual(["project", "multi-chatbot"]);
    expect(roleTags.some(([key]) => key === "environment")).toBe(false);
  }

  const webIdentityPolicies = roleResources.flatMap(({ Properties }) =>
    webIdentityAllowStatements(Properties?.AssumeRolePolicyDocument || {}),
  );
  expect(webIdentityPolicies.length).toBeGreaterThan(0);

  const audiences = [];
  const subjects = [];
  for (const statement of webIdentityPolicies) {
    expect(
      statementActions(statement).map((action) =>
        typeof action === "string" ? action.toLowerCase() : null,
      ),
    ).toEqual(["sts:assumerolewithwebidentity"]);
    expect(hasExactProvider(statement.Principal)).toBe(true);
    const statementAudiences = exactConditionValues(
      statement.Condition,
      "token.actions.githubusercontent.com:aud",
    );
    const statementSubjects = exactConditionValues(
      statement.Condition,
      "token.actions.githubusercontent.com:sub",
    );
    expect(new Set(statementAudiences)).toEqual(new Set(["sts.amazonaws.com"]));
    expect(statementSubjects.length).toBeGreaterThan(0);
    audiences.push(...statementAudiences);
    subjects.push(...statementSubjects);
  }
  expect(new Set(audiences)).toEqual(new Set(["sts.amazonaws.com"]));
  expect([...new Set(subjects)].sort()).toEqual([...expectedSubjects].sort());
}

describe("real CDK setup synthesis", () => {
  it.each(["dev", "prod"])(
    "synthesizes the shared setup for %s with exact GitHub trust",
    async (environment) => {
      const outputDirectory = mkdtempSync(path.join(tmpdir(), "multi-chatbot-cdk-out-"));
      try {
        const result = synthesize(outputDirectory, environment);
        expect(result.status, commandOutput(result)).toBe(0);
        verifySharedSetup(outputDirectory);

        const compiledConfig = await import(
          `${pathToFileURL(path.join(projectRoot, "dist/config/project.js")).href}?acceptance=${Date.now()}`
        );
        expect(compiledConfig.resolveEnvironment(environment)).toMatchObject({
          account: "118903272638",
          region: "us-east-1",
          environment,
          tags: { environment },
        });
      } finally {
        rmSync(outputDirectory, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("rejects an unknown CDK environment context", () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), "multi-chatbot-cdk-invalid-"));
    try {
      const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
      expect(packageJson.scripts.synth, "npm synth script must be present").toEqual(
        expect.any(String),
      );
      const result = synthesize(outputDirectory, "invalid");
      const output = commandOutput(result);
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("invalid");
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
