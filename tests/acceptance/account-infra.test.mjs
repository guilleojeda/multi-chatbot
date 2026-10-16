import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedAccount = "118903272638";
const expectedRegion = "us-east-1";
const expectedBotId = "docentes";
const environments = ["dev", "prod"];
const outputs = new Map();
const outputDirectories = [];

function commandOutput(result) {
  return [result?.error?.message, result?.stdout, result?.stderr].filter(Boolean).join("\n");
}

function synthesize(outputDirectory, environment) {
  return spawnSync(
    npmCommand,
    ["run", "synth", "--", "--output", outputDirectory, "-c", `environment=${environment}`],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 90_000,
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
    },
  );
}

function readAssembly(outputDirectory) {
  const manifest = JSON.parse(readFileSync(path.join(outputDirectory, "manifest.json"), "utf8"));
  const stacks = Object.entries(manifest.artifacts || {})
    .filter(([, artifact]) => artifact.type === "aws:cloudformation:stack")
    .map(([key, artifact]) => ({
      id: artifact.id || key,
      artifact,
      environment: artifact.environment,
      template: JSON.parse(
        readFileSync(path.join(outputDirectory, artifact.properties.templateFile), "utf8"),
      ),
    }));
  const resources = stacks.flatMap((stack) =>
    Object.entries(stack.template.Resources || {}).map(([logicalId, resource]) => ({
      stack,
      logicalId,
      resource,
    })),
  );
  const assetManifests = Object.values(manifest.artifacts || {})
    .filter((artifact) => artifact.type === "cdk:asset-manifest")
    .map((artifact) =>
      JSON.parse(readFileSync(path.join(outputDirectory, artifact.properties.file), "utf8")),
    );
  const fileAssets = assetManifests.flatMap((assetManifest) =>
    Object.entries(assetManifest.files || {}).map(([assetId, fileAsset]) => ({
      assetId,
      fileAsset,
    })),
  );
  return { manifest, stacks, resources, fileAssets };
}

function findStack(assembly, id) {
  return assembly.stacks.find((stack) => stack.id === id);
}

function records(stack, type) {
  if (!stack) return [];
  return Object.entries(stack.template.Resources || {})
    .filter(([, resource]) => !type || resource.Type === type)
    .map(([logicalId, resource]) => ({ stack, logicalId, resource }));
}

function referencesLogicalId(value, logicalId) {
  return typeof logicalId === "string" && JSON.stringify(value ?? null).includes(logicalId);
}

function directlyReferencesLogicalId(value, logicalId) {
  if (Array.isArray(value))
    return value.some((child) => directlyReferencesLogicalId(child, logicalId));
  if (!value || typeof value !== "object") return false;
  if (value.Ref === logicalId) return true;
  const getAtt = value["Fn::GetAtt"];
  if (
    (Array.isArray(getAtt) && getAtt[0] === logicalId) ||
    (typeof getAtt === "string" && getAtt.split(".")[0] === logicalId)
  ) {
    return true;
  }
  const substitution = value["Fn::Sub"];
  if (typeof substitution === "string" && substitution.includes("${" + logicalId + ".")) {
    return true;
  }
  return Object.entries(value).some(
    ([key, child]) => key !== "Fn::ImportValue" && directlyReferencesLogicalId(child, logicalId),
  );
}

function referencesAnyLogicalId(value, resourceRecords) {
  return resourceRecords.some(({ logicalId }) => referencesLogicalId(value, logicalId));
}

function outputRecords(assembly) {
  return assembly.stacks.flatMap((stack) =>
    Object.entries(stack.template.Outputs || {}).map(([logicalId, output]) => ({
      stack,
      logicalId,
      output,
      ...(output.Export?.Name === undefined ? {} : { exportName: output.Export.Name }),
    })),
  );
}

function sameExpression(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function outputReferences(value) {
  if (Array.isArray(value)) return value.flatMap(outputReferences);
  if (!value || typeof value !== "object") return [];
  if (Object.hasOwn(value, "Fn::ImportValue")) {
    return [{ type: "export", exportName: value["Fn::ImportValue"] }];
  }
  const stackOutput = value["Fn::GetStackOutput"];
  if (
    stackOutput &&
    typeof stackOutput === "object" &&
    typeof stackOutput.StackName === "string" &&
    typeof stackOutput.OutputName === "string"
  ) {
    return [
      {
        type: "stack-output",
        stackName: stackOutput.StackName,
        outputName: stackOutput.OutputName,
        region: stackOutput.Region,
      },
    ];
  }
  return Object.values(value).flatMap(outputReferences);
}

function stackCoordinates(stack) {
  const match = /^aws:\/\/([^/]+)\/([^/]+)$/.exec(stack.environment || "");
  return match ? { account: match[1], region: match[2] } : null;
}

function findOutputRecord(reference, assembly, sourceStack) {
  const records = outputRecords(assembly);
  if (reference.type === "export") {
    return records.find(
      (record) =>
        record.exportName !== undefined && sameExpression(record.exportName, reference.exportName),
    );
  }
  const sourceCoordinates = stackCoordinates(sourceStack);
  return records.find((record) => {
    if (record.stack.id !== reference.stackName || record.logicalId !== reference.outputName) {
      return false;
    }
    const targetCoordinates = stackCoordinates(record.stack);
    return Boolean(
      sourceCoordinates &&
      targetCoordinates &&
      sourceCoordinates.account === targetCoordinates.account &&
      sourceCoordinates.region === targetCoordinates.region &&
      (reference.region === undefined || reference.region === targetCoordinates.region),
    );
  });
}

function outputValueReferencesResource(
  outputRecord,
  targetStack,
  targetResource,
  assembly,
  visitedOutputs = new Set(),
) {
  if (
    outputRecord.stack.id === targetStack.id &&
    directlyReferencesLogicalId(outputRecord.output.Value, targetResource.logicalId)
  ) {
    return true;
  }
  const visitKey = outputRecord.stack.id + ":" + outputRecord.logicalId;
  if (visitedOutputs.has(visitKey)) return false;
  const nextVisited = new Set(visitedOutputs).add(visitKey);
  return outputReferences(outputRecord.output.Value).some((reference) => {
    const nextOutput = findOutputRecord(reference, assembly, outputRecord.stack);
    return (
      nextOutput &&
      outputValueReferencesResource(nextOutput, targetStack, targetResource, assembly, nextVisited)
    );
  });
}

function referencesResourceThroughExports(
  value,
  valueStack,
  targetStack,
  targetResource,
  assembly,
) {
  if (
    valueStack.id === targetStack.id &&
    directlyReferencesLogicalId(value, targetResource.logicalId)
  ) {
    return true;
  }
  return outputReferences(value).some((reference) => {
    const outputRecord = findOutputRecord(reference, assembly, valueStack);
    return (
      outputRecord &&
      outputValueReferencesResource(outputRecord, targetStack, targetResource, assembly)
    );
  });
}

function containsString(value, expected) {
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value)) return value.some((child) => containsString(child, expected));
  if (value && typeof value === "object") {
    return Object.values(value).some((child) => containsString(child, expected));
  }
  return false;
}

function sourceMarkerForJsonKey(contents, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = contents.match(
    new RegExp(`"${escapedKey}"\\s*:\\s*(?:"(<<marker:0xbaba:\\d+>>)"|(<<marker:0xbaba:\\d+>>))`),
  );
  return match?.[1] || match?.[2];
}

function sourceMarkerValue(properties, markerName) {
  return (properties?.SourceMarkers || [])
    .flatMap((markerSet) => Object.entries(markerSet))
    .find(([name]) => name === markerName)?.[1];
}

function resourceTags(resource) {
  const tags = resource.Properties?.Tags || resource.Properties?.UserPoolTags || [];
  if (Array.isArray(tags)) {
    return tags.filter((tag) => typeof tag.Key === "string").map(({ Key, Value }) => [Key, Value]);
  }
  return Object.entries(tags).map(([key, value]) => [key, value]);
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  if (statSync(directory).isFile())
    return [{ path: directory, relativePath: path.basename(directory) }];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listFiles(filePath).map((file) => ({
        ...file,
        relativePath: path.posix.join(entry.name, file.relativePath),
      }));
    }
    return entry.isFile() ? [{ path: filePath, relativePath: entry.name }] : [];
  });
}

function assetFiles(outputDirectory, fileAsset) {
  const sourcePath = fileAsset.source?.path;
  if (typeof sourcePath !== "string") return [];
  const resolvedPath = path.resolve(outputDirectory, sourcePath);
  const relativePath = path.relative(outputDirectory, resolvedPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return [];
  if (!existsSync(resolvedPath)) return [];
  if (statSync(resolvedPath).isDirectory()) return listFiles(resolvedPath);

  const listing = spawnSync("unzip", ["-Z1", resolvedPath], { encoding: "utf8" });
  if (listing.status !== 0)
    return [{ path: resolvedPath, relativePath: path.basename(resolvedPath) }];
  return listing.stdout
    .split(/\r?\n/)
    .filter((name) => name && !name.endsWith("/"))
    .map((name) => ({ path: resolvedPath, relativePath: name, archivePath: name }));
}

function readAssetFile(file) {
  if (file.archivePath) {
    const result = spawnSync("unzip", ["-p", file.path, file.archivePath], { encoding: "utf8" });
    return result.status === 0 ? result.stdout : "";
  }
  return readFileSync(file.path, "utf8");
}

function objectKeys(fileAsset) {
  return Object.values(fileAsset.destinations || {})
    .map(({ objectKey }) => objectKey)
    .filter((objectKey) => typeof objectKey === "string");
}

function assetMatchesValue(fileAsset, value) {
  const serialized = JSON.stringify(value);
  return objectKeys(fileAsset).some((objectKey) => serialized.includes(objectKey));
}

function distributionForSite(siteStack) {
  return records(siteStack, "AWS::CloudFront::Distribution");
}

function apiOriginRequestForwardsAuthorization(behavior) {
  // The planned native policy forwards Authorization and removes the viewer Host header.
  return behavior.OriginRequestPolicyId === "b689b0a8-53d0-40ab-baf2-68738e2966ac";
}

function lambdaIamPolicies(accountStack, lambda) {
  const roles = records(accountStack, "AWS::IAM::Role").filter(({ logicalId }) =>
    referencesLogicalId(lambda.resource.Properties?.Role, logicalId),
  );
  const inline = roles.flatMap(({ resource }) => resource.Properties?.Policies || []);
  const standalone = records(accountStack, "AWS::IAM::Policy")
    .filter(({ resource }) => referencesAnyLogicalId(resource.Properties?.Roles, roles))
    .flatMap(({ resource }) => resource.Properties?.PolicyDocument?.Statement || []);
  return {
    roles,
    statements: [
      ...inline.flatMap((policy) => policy.PolicyDocument?.Statement || []),
      ...standalone,
    ],
  };
}

function policyActions(statement) {
  return (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).filter(
    (action) => typeof action === "string",
  );
}

function hasAction(statement, action) {
  return policyActions(statement).some((candidate) => {
    const escaped = candidate
      .toLowerCase()
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".");
    return new RegExp(`^${escaped}$`).test(action.toLowerCase());
  });
}

function verifyEnvironment(environment, result, assembly, outputDirectory) {
  const prefix = `multi-chatbot-${environment}`;
  const botPrefix = `${prefix}-${expectedBotId}`;
  const identity = findStack(assembly, `${prefix}-identity`);
  const account = findStack(assembly, `${botPrefix}-account`);
  const site = findStack(assembly, `${botPrefix}-site`);
  const setup = findStack(assembly, "multi-chatbot-setup");

  expect.soft(result.status, commandOutput(result)).toBe(0);
  expect.soft(setup, "the stable phase 1 setup stack remains in the assembly").toBeDefined();
  expect.soft(identity, `expected shared identity stack ${prefix}-identity`).toBeDefined();
  expect.soft(account, `expected per-chatbot account stack ${botPrefix}-account`).toBeDefined();
  expect.soft(site, `expected per-chatbot site stack ${botPrefix}-site`).toBeDefined();
  if (!identity || !account || !site) return;

  for (const stack of [identity, account, site]) {
    expect
      .soft(stack.environment, `expected ${stack.id} in the configured AWS environment`)
      .toBe(`aws://${expectedAccount}/${expectedRegion}`);
    expect.soft(stack.artifact.properties.tags || {}).toMatchObject({
      project: "multi-chatbot",
      environment,
    });
  }

  const identityPools = records(identity, "AWS::Cognito::UserPool");
  expect
    .soft(identityPools, "the environment identity stack owns one common Cognito pool")
    .toHaveLength(1);
  expect
    .soft(
      records(account, "AWS::Cognito::UserPool").length,
      "a chatbot account stack must consume the environment pool instead of creating another",
    )
    .toBe(0);
  const pool = identityPools[0];
  if (pool) {
    const poolProps = pool.resource.Properties || {};
    expect.soft(poolProps.AdminCreateUserConfig?.AllowAdminCreateUserOnly).toBe(true);
    expect.soft(poolProps.UsernameAttributes).toEqual(["email"]);
    expect.soft(poolProps.AliasAttributes || []).toEqual([]);
    expect.soft(poolProps.UsernameConfiguration?.CaseSensitive).toBe(false);
    if (typeof poolProps.UserPoolName === "string") {
      expect(poolProps.UserPoolName).not.toContain(expectedBotId);
      expect(poolProps.UserPoolName).toContain(prefix);
    }
    expect.soft(resourceTags(pool.resource)).toContainEqual(["project", "multi-chatbot"]);
    expect.soft(resourceTags(pool.resource)).toContainEqual(["environment", environment]);
  }

  const clients = records(account, "AWS::Cognito::UserPoolClient");
  expect
    .soft(clients, "each chatbot has its own direct-browser Cognito app client")
    .toHaveLength(1);
  const client = clients[0];
  if (client) {
    const clientProps = client.resource.Properties || {};
    expect.soft(clientProps.GenerateSecret).toBe(false);
    expect
      .soft(clientProps.UserPoolId, "the app client belongs to the shared environment pool")
      .toBeDefined();
    if (pool) {
      expect
        .soft(
          referencesResourceThroughExports(
            clientProps.UserPoolId,
            account,
            identity,
            pool,
            assembly,
          ),
          "the app client imports this environment's shared user pool",
        )
        .toBe(true);
    }
    const authFlows = clientProps.ExplicitAuthFlows || [];
    expect(authFlows).toContain("ALLOW_REFRESH_TOKEN_AUTH");
    expect(authFlows).toContain("ALLOW_USER_PASSWORD_AUTH");
    expect(authFlows).not.toContain("ALLOW_ADMIN_USER_PASSWORD_AUTH");
    expect(clientProps.EnableTokenRevocation).toBe(true);
  }

  const tables = records(account, "AWS::DynamoDB::Table");
  expect
    .soft(tables.length, "the chatbot account stack must own membership/invitation data")
    .toBeGreaterThan(0);
  for (const table of tables) {
    expect.soft(resourceTags(table.resource)).toContainEqual(["project", "multi-chatbot"]);
    expect.soft(resourceTags(table.resource)).toContainEqual(["environment", environment]);
  }

  const apis = records(account, "AWS::ApiGatewayV2::Api");
  expect.soft(apis, "the chatbot has a dedicated HTTP API").toHaveLength(1);
  const api = apis[0];
  if (api) expect.soft(api.resource.Properties?.ProtocolType).toBe("HTTP");

  const routes = records(account, "AWS::ApiGatewayV2::Route");
  const routeByKey = new Map(
    routes.map(({ resource }) => [resource.Properties?.RouteKey, resource]),
  );
  const inspectRoute = routeByKey.get("POST /api/account/invitations/inspect");
  const acceptRoute = routeByKey.get("POST /api/account/invitations/accept");
  const meRoute = routeByKey.get("GET /api/account/me");
  expect.soft(inspectRoute, "invitation inspection remains public for link entry").toBeDefined();
  expect.soft(acceptRoute, "invitation acceptance remains callable before sign-in").toBeDefined();
  expect.soft(meRoute, "the account API protects its current-member route").toBeDefined();
  for (const [key, route] of [
    ["POST /api/account/invitations/inspect", inspectRoute],
    ["POST /api/account/invitations/accept", acceptRoute],
  ]) {
    if (!route) continue;
    expect.soft(route.Properties?.AuthorizationType, key).toBe("NONE");
    expect.soft(route.Properties?.AuthorizerId, key).toBeUndefined();
  }
  if (meRoute) {
    expect.soft(meRoute.Properties?.AuthorizationType).toBe("JWT");
    const authorizer = records(account, "AWS::ApiGatewayV2::Authorizer").find(({ logicalId }) =>
      referencesLogicalId(meRoute.Properties?.AuthorizerId, logicalId),
    );
    expect.soft(authorizer, "GET /api/account/me uses an API Gateway JWT authorizer").toBeDefined();
    if (authorizer) {
      expect.soft(authorizer.resource.Properties?.AuthorizerType).toBe("JWT");
      const issuer = authorizer.resource.Properties?.JwtConfiguration?.Issuer;
      expect
        .soft(containsString(issuer, "https://cognito-idp.us-east-1.amazonaws.com/"))
        .toBe(true);
      if (pool) {
        expect
          .soft(
            referencesResourceThroughExports(issuer, account, identity, pool, assembly),
            "the API JWT issuer resolves to this environment's shared pool ID",
          )
          .toBe(true);
      }
      if (client) {
        expect
          .soft(
            referencesResourceThroughExports(
              authorizer.resource.Properties?.JwtConfiguration?.Audience,
              account,
              account,
              client,
              assembly,
            ),
            "the API JWT audience matches the chatbot app client",
          )
          .toBe(true);
      }
    }
  }

  const integrations = records(account, "AWS::ApiGatewayV2::Integration");
  const functions = records(account, "AWS::Lambda::Function");
  expect.soft(functions, "the account API runs in an application Lambda").toHaveLength(1);
  const lambda = functions[0];
  if (lambda) {
    expect.soft(lambda.resource.Properties?.Runtime).toBe("nodejs24.x");
    expect.soft(lambda.resource.Properties?.Handler).toEqual(expect.any(String));
    expect.soft(integrations.length).toBeGreaterThan(0);
    for (const integration of integrations) {
      expect(
        referencesLogicalId(integration.resource.Properties?.IntegrationUri, lambda.logicalId),
      ).toBe(true);
    }
    const functionCode = JSON.stringify(lambda.resource.Properties?.Code);
    const codeAsset = assembly.fileAssets.find((asset) =>
      assetMatchesValue(asset.fileAsset, functionCode),
    );
    expect
      .soft(codeAsset, "the checked assembly packages this Lambda's referenced code asset")
      .toBeDefined();
    if (codeAsset) {
      const codeFiles = assetFiles(outputDirectory, codeAsset.fileAsset).filter((file) =>
        /\.(?:c|m)?js$/i.test(file.relativePath),
      );
      expect
        .soft(codeFiles.length, "the Lambda asset contains executable JavaScript")
        .toBeGreaterThan(0);
      const codeText = codeFiles.map(readAssetFile).join("\n");
      expect
        .soft(
          codeText.trim().length > 0,
          "the staged Lambda JavaScript must contain non-empty application code",
        )
        .toBe(true);
      const [handlerModule, handlerExport] = String(
        lambda.resource.Properties?.Handler || "",
      ).split(".");
      expect.soft(handlerModule).toMatch(/^[A-Za-z0-9_./-]+$/);
      expect.soft(handlerExport).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
      expect
        .soft(
          codeFiles.some((file) => file.relativePath.split("/").at(-1) === `${handlerModule}.js`),
          "the configured Lambda handler is present in its packaged code asset",
        )
        .toBe(true);
    }

    const variables = lambda.resource.Properties?.Environment?.Variables || {};
    expect.soft(JSON.stringify(variables)).toMatch(/(?:TABLE|DYNAMO|STORE)/i);
    expect.soft(JSON.stringify(variables)).toMatch(/(?:USER_POOL|COGNITO|IDENTITY)/i);
    expect
      .soft(
        tables.some((table) =>
          referencesResourceThroughExports(variables, account, account, table, assembly),
        ),
      )
      .toBe(true);
    if (pool) {
      expect
        .soft(
          referencesResourceThroughExports(variables, account, identity, pool, assembly),
          "the Lambda is configured with this environment's shared user pool",
        )
        .toBe(true);
    }
    const iam = lambdaIamPolicies(account, lambda);
    expect.soft(iam.roles.length, "the Lambda execution role is explicit").toBeGreaterThan(0);
    const dynamoStatements = iam.statements.filter((statement) =>
      policyActions(statement).some((action) => /^dynamodb:/i.test(action)),
    );
    expect
      .soft(dynamoStatements.length, "the Lambda role has explicit table access")
      .toBeGreaterThan(0);
    expect
      .soft(dynamoStatements.some((statement) => hasAction(statement, "dynamodb:GetItem")))
      .toBe(true);
    expect
      .soft(dynamoStatements.some((statement) => hasAction(statement, "dynamodb:PutItem")))
      .toBe(true);
    expect
      .soft(
        dynamoStatements.some((statement) =>
          tables.some((table) =>
            referencesResourceThroughExports(statement.Resource, account, account, table, assembly),
          ),
        ),
      )
      .toBe(true);
    const identityStatements = iam.statements.filter((statement) =>
      policyActions(statement).some((action) => /^cognito-idp:/i.test(action)),
    );
    expect
      .soft(
        identityStatements.length,
        "the Lambda role can perform its invitation account operations",
      )
      .toBeGreaterThan(0);
    expect
      .soft(
        identityStatements.some((statement) =>
          hasAction(statement, "cognito-idp:AdminSetUserPassword"),
        ),
      )
      .toBe(true);
    expect
      .soft(
        identityStatements.some((statement) =>
          hasAction(statement, "cognito-idp:AdminUpdateUserAttributes"),
        ),
      )
      .toBe(true);
    expect
      .soft(
        identityStatements.some(
          (statement) =>
            hasAction(statement, "cognito-idp:AdminGetUser") ||
            hasAction(statement, "cognito-idp:ListUsers"),
        ),
      )
      .toBe(true);
    if (pool) {
      for (const action of [
        "cognito-idp:AdminSetUserPassword",
        "cognito-idp:AdminUpdateUserAttributes",
      ]) {
        expect
          .soft(
            identityStatements.some(
              (statement) =>
                hasAction(statement, action) &&
                referencesResourceThroughExports(
                  statement.Resource,
                  account,
                  identity,
                  pool,
                  assembly,
                ),
            ),
            `${action} is scoped to this environment's shared user pool`,
          )
          .toBe(true);
      }
    }
  }

  for (const route of [inspectRoute, acceptRoute, meRoute].filter(Boolean)) {
    const routeIntegration = integrations.find(({ logicalId }) =>
      referencesLogicalId(route.Properties?.Target, logicalId),
    );
    expect
      .soft(routeIntegration, `route ${route.Properties?.RouteKey} points to the account Lambda`)
      .toBeDefined();
    if (routeIntegration && lambda) {
      expect(
        referencesLogicalId(routeIntegration.resource.Properties?.IntegrationUri, lambda.logicalId),
      ).toBe(true);
    }
  }

  const siteDistributions = distributionForSite(site);
  expect
    .soft(siteDistributions.length, "the existing public site remains in place")
    .toBeGreaterThan(0);
  let apiProxyBehavior;
  for (const { resource } of siteDistributions) {
    const config = resource.Properties?.DistributionConfig || {};
    apiProxyBehavior = (config.CacheBehaviors || []).find(
      (behavior) => behavior.PathPattern === "/api/*",
    );
    expect.soft(config.DefaultRootObject).toBe("index.html");
    expect.soft(config.Enabled).toBe(true);
  }
  expect
    .soft(apiProxyBehavior, "CloudFront proxies the account API on the existing same-origin site")
    .toBeDefined();
  if (apiProxyBehavior) {
    const origin = siteDistributions
      .flatMap(({ resource }) => resource.Properties?.DistributionConfig?.Origins || [])
      .find(({ Id }) => Id === apiProxyBehavior.TargetOriginId);
    expect.soft(origin, "the /api/* cache behavior has an API origin").toBeDefined();
    if (origin) {
      expect.soft(origin.CustomOriginConfig?.OriginProtocolPolicy).toBe("https-only");
      if (api) {
        expect
          .soft(
            referencesResourceThroughExports(origin.DomainName, site, account, api, assembly),
            "the CloudFront /api origin imports this chatbot's HTTP API endpoint",
          )
          .toBe(true);
      }
    }
    const allowedMethods = Array.isArray(apiProxyBehavior.AllowedMethods)
      ? apiProxyBehavior.AllowedMethods
      : [];
    for (const method of ["GET", "POST", "OPTIONS"]) expect.soft(allowedMethods).toContain(method);
    expect.soft(apiProxyBehavior.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
    expect.soft(apiOriginRequestForwardsAuthorization(apiProxyBehavior)).toBe(true);
  }

  const deploymentResources = records(site, "Custom::CDKBucketDeployment");
  const configAsset = deploymentResources
    .flatMap((deployment) =>
      assembly.fileAssets
        .filter((asset) => assetMatchesValue(asset.fileAsset, deployment.resource.Properties))
        .flatMap((asset) =>
          assetFiles(outputDirectory, asset.fileAsset)
            .filter((file) => file.relativePath.split("/").at(-1) === "public-config.json")
            .map((file) => ({ ...deployment, asset, file })),
        ),
    )
    .at(0);
  expect
    .soft(configAsset, "the site deployment references its runtime configuration asset")
    .toBeDefined();
  expect
    .soft(configAsset?.file, "public-config.json is packaged in the checked site assembly")
    .toBeDefined();
  if (configAsset?.file) {
    const contents = readAssetFile(configAsset.file);
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(contents.replace(/<<marker:0xbaba:\d+>>/g, "null"));
    } catch (error) {
      expect
        .soft(error, "public-config.json remains parseable after token placeholders")
        .toBeNull();
    }
    expect.soft(parsedConfig).toMatchObject({
      region: expectedRegion,
      botId: expectedBotId,
      apiBaseUrl: "/api",
    });
    for (const key of ["userPoolId", "clientId"]) {
      expect.soft(Object.hasOwn(parsedConfig || {}, key)).toBe(true);
    }
    expect
      .soft(JSON.stringify(parsedConfig || {}))
      .not.toMatch(/clientSecret|password|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/i);
    const deploymentProperties = configAsset.resource.Properties || {};
    expect.soft(deploymentProperties.SourceMarkers).toBeDefined();
    for (const [key, targetStack, targetResource] of [
      ["userPoolId", identity, pool],
      ["clientId", account, client],
    ]) {
      if (!targetResource) continue;
      const marker = sourceMarkerForJsonKey(contents, key);
      expect.soft(marker, `public-config.json ${key} is a deploy-time token`).toBeDefined();
      const markerValue = sourceMarkerValue(deploymentProperties, marker);
      expect
        .soft(markerValue, `public-config.json ${key} has a source marker binding`)
        .toBeDefined();
      expect
        .soft(
          referencesResourceThroughExports(
            markerValue,
            site,
            targetStack,
            targetResource,
            assembly,
          ),
          `public-config.json ${key} resolves to the intended resource`,
        )
        .toBe(true);
    }
  }

  const dependencies = new Set(assembly.manifest.artifacts[account.id]?.dependencies || []);
  expect
    .soft(dependencies, "the per-chatbot account stack imports its common identity pool")
    .toContain(identity.id);
  const siteDependencies = new Set(assembly.manifest.artifacts[site.id]?.dependencies || []);
  expect
    .soft(siteDependencies, "the site consumes configuration/origin outputs from the account stack")
    .toContain(account.id);
  expect
    .soft(dependencies.has(site.id), "the account stack must not depend on the site stack")
    .toBe(false);
  expect
    .soft(
      new Set(assembly.manifest.artifacts[identity.id]?.dependencies || []).has(account.id) ||
        new Set(assembly.manifest.artifacts[identity.id]?.dependencies || []).has(site.id),
      "the shared identity stack must not depend on per-chatbot stacks",
    )
    .toBe(false);

  const applicationTags = [
    ...identityPools,
    ...tables,
    ...apis,
    ...functions,
    ...siteDistributions,
  ];
  for (const record of applicationTags) {
    const tags = resourceTags(record.resource);
    expect
      .soft(tags, `${record.stack.id}/${record.logicalId} has project/environment tags`)
      .toContainEqual(["project", "multi-chatbot"]);
    expect
      .soft(tags, `${record.stack.id}/${record.logicalId} has the environment tag`)
      .toContainEqual(["environment", environment]);
  }
}

beforeAll(() => {
  for (const environment of environments) {
    const outputDirectory = mkdtempSync(
      path.join(tmpdir(), `multi-chatbot-account-${environment}-`),
    );
    outputDirectories.push(outputDirectory);
    const result = synthesize(outputDirectory, environment);
    let assembly;
    if (result.status === 0 && existsSync(path.join(outputDirectory, "manifest.json"))) {
      assembly = readAssembly(outputDirectory);
    }
    outputs.set(environment, { result, assembly, outputDirectory });
  }
}, 200_000);

afterAll(() => {
  for (const outputDirectory of outputDirectories)
    rmSync(outputDirectory, { recursive: true, force: true });
});

describe("account and shared identity CDK assembly", () => {
  it.each(environments)(
    "synthesizes the approved %s account and API boundaries",
    (environment) => {
      const output = outputs.get(environment);
      expect(output, `expected a ${environment} synth result`).toBeDefined();
      if (output?.assembly) {
        verifyEnvironment(environment, output.result, output.assembly, output.outputDirectory);
      } else {
        expect(
          commandOutput(output?.result),
          `synthesis must produce ${environment} resources`,
        ).toContain("multi-chatbot");
        expect(output?.result?.status, commandOutput(output?.result)).toBe(0);
      }
    },
    120_000,
  );

  it("keeps the environment identity and per-chatbot data/resources separate", () => {
    const dev = outputs.get("dev");
    const prod = outputs.get("prod");
    expect(dev?.assembly, "dev assembly must synthesize").toBeDefined();
    expect(prod?.assembly, "prod assembly must synthesize").toBeDefined();
    if (!dev?.assembly || !prod?.assembly) return;

    const devIdentity = findStack(dev.assembly, "multi-chatbot-dev-identity");
    const prodIdentity = findStack(prod.assembly, "multi-chatbot-prod-identity");
    const devAccount = findStack(dev.assembly, "multi-chatbot-dev-docentes-account");
    const prodAccount = findStack(prod.assembly, "multi-chatbot-prod-docentes-account");
    expect(devIdentity).toBeDefined();
    expect(prodIdentity).toBeDefined();
    expect(devAccount).toBeDefined();
    expect(prodAccount).toBeDefined();
    if (!devIdentity || !prodIdentity || !devAccount || !prodAccount) return;

    const devPoolName = records(devIdentity, "AWS::Cognito::UserPool")[0]?.resource.Properties
      ?.UserPoolName;
    const prodPoolName = records(prodIdentity, "AWS::Cognito::UserPool")[0]?.resource.Properties
      ?.UserPoolName;
    if (devPoolName && prodPoolName) expect(devPoolName).not.toBe(prodPoolName);
    const devTables = records(devAccount, "AWS::DynamoDB::Table");
    const prodTables = records(prodAccount, "AWS::DynamoDB::Table");
    expect(devTables.length).toBeGreaterThan(0);
    expect(prodTables.length).toBeGreaterThan(0);
    const devTableNames = devTables
      .map(({ resource }) => resource.Properties?.TableName)
      .filter((name) => typeof name === "string");
    const prodTableNames = prodTables
      .map(({ resource }) => resource.Properties?.TableName)
      .filter((name) => typeof name === "string");
    expect(devTableNames.some((name) => prodTableNames.includes(name))).toBe(false);
    expect(records(devAccount, "AWS::Cognito::UserPoolClient").length).toBe(1);
    expect(records(prodAccount, "AWS::Cognito::UserPoolClient").length).toBe(1);
  });
});
