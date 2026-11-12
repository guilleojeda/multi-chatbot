import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assetFiles,
  commandOutput,
  dependencies,
  findStack,
  lambdaPolicies,
  makeSynthesisDirectory,
  markerValue,
  onlyRecord,
  readAssembly,
  readAssetFile,
  records,
  referencesResource,
  removeSynthesisDirectory,
  resourceAsset,
  resourceAssets,
  sameStackReference,
  sourceMarker,
  statementActions,
  synthesize,
  tags,
} from "../support/phase9-admin-infra.mjs";

const expectedRegion = "us-east-1";
const expectedBotId = "docentes";
const testSender = "sxvintage@gmail.com";
const environments = ["dev", "prod"];
const scenarios = new Map();
const synthesisDirectories = [];

function scenarioFor(environment) {
  const scenario = scenarios.get(environment);
  expect(scenario, `expected the ${environment} synthesis result`).toBeDefined();
  if (!scenario) return undefined;

  expect(scenario.result?.status, commandOutput(scenario.result)).toBe(0);
  expect(scenario.assembly, `${environment} synthesis must produce a Cloud Assembly`).toBeDefined();
  if (!scenario.assembly) return undefined;

  const prefix = `multi-chatbot-${environment}`;
  const admin = findStack(scenario.assembly, `${prefix}-admin`);
  const identity = findStack(scenario.assembly, `${prefix}-identity`);
  const account = findStack(scenario.assembly, `${prefix}-${expectedBotId}-account`);
  const site = findStack(scenario.assembly, `${prefix}-${expectedBotId}-site`);
  expect(admin, `the shared ${environment} admin stack must be present`).toBeDefined();
  expect(identity, `the shared ${environment} identity stack must be present`).toBeDefined();
  expect(
    account,
    `the ${environment} ${expectedBotId} account stack must be present`,
  ).toBeDefined();
  expect(site, `the ${environment} ${expectedBotId} site stack must be present`).toBeDefined();
  if (!admin || !identity || !account || !site) return undefined;
  return { ...scenario, admin, identity, account, site };
}

function stackTagPairs(stack) {
  const value = stack.artifact.properties?.tags || {};
  return Object.entries(value);
}

function resourceTagValue(resource, key) {
  return tags(resource.resource).find(([tagKey]) => tagKey === key)?.[1];
}

function exportedOutput(stack, name) {
  return Object.entries(stack.template.Outputs || {}).find(
    ([logicalId, output]) => logicalId === name || output.Description === name,
  );
}

function statementResources(statement) {
  return Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
}

function stringValueHas(value, fragment) {
  return JSON.stringify(value ?? null).includes(fragment);
}

function isCloudFrontAuthorizationPolicy(policyId) {
  return policyId === "b689b0a8-53d0-40ab-baf2-68738e2966ac";
}

function forwardsAuthorization(stack, behavior) {
  if (isCloudFrontAuthorizationPolicy(behavior.OriginRequestPolicyId)) return true;
  if (behavior.ForwardedValues?.Headers?.includes("Authorization")) return true;
  const policy = records(stack, "AWS::CloudFront::OriginRequestPolicy").find(({ logicalId }) =>
    sameStackReference(behavior.OriginRequestPolicyId, logicalId),
  );
  const headers = policy?.properties.OriginRequestPolicyConfig?.HeadersConfig;
  return (
    headers?.HeaderBehavior === "allViewer" ||
    (headers?.HeaderBehavior === "whitelist" && headers.Headers?.Items?.includes("Authorization"))
  );
}

function cachingIsDisabled(stack, behavior) {
  if (behavior.CachePolicyId === "4135ea2d-6df8-44a3-9df3-4b5a84be39ad") return true;
  if (
    behavior.ForwardedValues &&
    behavior.MinTTL === 0 &&
    behavior.DefaultTTL === 0 &&
    behavior.MaxTTL === 0
  ) {
    return true;
  }
  const policy = records(stack, "AWS::CloudFront::CachePolicy").find(({ logicalId }) =>
    sameStackReference(behavior.CachePolicyId, logicalId),
  );
  const config = policy?.properties.CachePolicyConfig;
  return Boolean(config && config.MinTTL === 0 && config.DefaultTTL === 0 && config.MaxTTL === 0);
}

function applicationLambda(scenario) {
  const lambdas = records(scenario.admin, "AWS::Lambda::Function");
  const integrations = records(scenario.admin, "AWS::ApiGatewayV2::Integration");
  const backendLambdas = lambdas.filter(({ logicalId }) =>
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
  expect(backendLambdas, "the HTTP API integrates with one application Lambda").toHaveLength(1);
  return backendLambdas[0];
}

function publicConfigAsset(scenario, deployment) {
  const deploymentAssets = resourceAssets(scenario.assembly, scenario.admin, deployment.properties);
  const configFiles = deploymentAssets.flatMap((asset) =>
    asset.files
      .filter(({ relativePath }) => pathBaseName(relativePath) === "public-config.json")
      .map((file) => ({ ...file, assetId: asset.assetId })),
  );
  expect(
    deploymentAssets.length,
    "the admin deployment references assets in its own stack",
  ).toBeGreaterThan(0);
  expect(configFiles, "the admin deployment includes public-config.json").toHaveLength(1);
  return configFiles[0];
}

function pathBaseName(value) {
  return value.split(/[\\/]/).at(-1);
}

function parsePublicConfig(file) {
  if (!file) return undefined;
  const contents = readAssetFile(file);
  let parsed;
  try {
    parsed = JSON.parse(contents.replace(/<<marker:0xbaba:\d+>>/g, "null"));
  } catch (error) {
    expect(
      error,
      "the staged admin public configuration is valid JSON after CDK token substitution",
    ).toBeNull();
  }
  return { contents, parsed };
}

function resourceActions(statements, servicePrefix) {
  return statements
    .flatMap(statementActions)
    .filter((action) => action.toLowerCase().startsWith(servicePrefix.toLowerCase()));
}

function parseJsonEnvironmentValues(variables) {
  return Object.values(variables).flatMap((value) => {
    if (typeof value !== "string") return [];
    try {
      return [JSON.parse(value)];
    } catch {
      return [];
    }
  });
}

function configuredBotIds(value) {
  if (Array.isArray(value)) return value.flatMap(configuredBotIds);
  if (!value || typeof value !== "object") return [];
  const ids = typeof value.botId === "string" ? [value.botId] : [];
  return [...ids, ...Object.values(value).flatMap(configuredBotIds)];
}

function accessTokenSeconds(client) {
  const units = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 };
  const validity = client.AccessTokenValidity;
  const unit = client.TokenValidityUnits?.AccessToken || "hours";
  return typeof validity === "number" && units[unit] ? validity * units[unit] : undefined;
}

function isOacReadAllow(statement, distribution, bucket, admin, assembly) {
  const actions = statementActions(statement);
  return (
    statement.Effect === "Allow" &&
    statement.Principal?.Service === "cloudfront.amazonaws.com" &&
    actions.includes("s3:GetObject") &&
    referencesResource(statement.Resource, admin, admin, bucket, assembly) &&
    referencesResource(statement.Condition, admin, admin, distribution, assembly)
  );
}

function isInsecureTransportDeny(statement, bucket, admin, assembly) {
  const secureTransport = statement.Condition?.Bool?.["aws:SecureTransport"];
  return (
    statement.Effect === "Deny" &&
    (secureTransport === "false" || secureTransport === false) &&
    referencesResource(statement.Resource, admin, admin, bucket, assembly)
  );
}

beforeAll(() => {
  for (const environment of environments) {
    const directory = makeSynthesisDirectory(environment);
    synthesisDirectories.push(directory);
    const result = synthesize(directory, environment);
    const manifestPath = `${directory}/manifest.json`;
    const assembly =
      result.status === 0 && existsSync(manifestPath) ? readAssembly(directory) : undefined;
    scenarios.set(environment, { environment, directory, result, assembly });
  }
}, 240_000);

afterAll(() => {
  for (const directory of synthesisDirectories) removeSynthesisDirectory(directory);
});

describe("phase 9.1 admin infrastructure acceptance", () => {
  it.each(environments)("synthesizes one shared, bot-separated %s admin stack", (environment) => {
    const scenario = scenarioFor(environment);
    if (!scenario) return;

    const { assembly, admin, identity, account, site } = scenario;
    expect(admin.id).toBe(`multi-chatbot-${environment}-admin`);
    expect(admin.artifact.environment).toBe(`aws://118903272638/${expectedRegion}`);
    expect(stackTagPairs(admin)).toContainEqual(["project", "multi-chatbot"]);
    expect(stackTagPairs(admin)).toContainEqual(["environment", environment]);

    expect(records(admin, "AWS::Cognito::UserPool")).toHaveLength(0);
    expect(records(admin, "AWS::Cognito::UserPoolClient")).toHaveLength(1);
    expect(records(admin, "AWS::Cognito::UserPoolGroup")).toHaveLength(1);
    expect(records(admin, "AWS::ApiGatewayV2::Api")).toHaveLength(1);
    expect(records(admin, "AWS::Lambda::Function").length).toBeGreaterThan(0);
    expect(applicationLambda(scenario)).toBeDefined();
    expect(records(admin, "AWS::S3::Bucket")).toHaveLength(1);
    expect(records(admin, "AWS::CloudFront::Distribution")).toHaveLength(1);
    expect(records(admin, "AWS::BedrockAgentCore::Runtime")).toHaveLength(0);

    expect(records(account, "AWS::Cognito::UserPool")).toHaveLength(0);
    expect(records(account, "AWS::Cognito::UserPoolClient")).toHaveLength(1);
    expect(records(site, "AWS::CloudFront::Distribution")).toHaveLength(1);
    expect(dependencies(assembly, admin)).toContain(identity.id);
    expect(dependencies(assembly, admin)).toContain(account.id);
    expect(dependencies(assembly, admin)).toContain(site.id);
    expect(dependencies(assembly, account)).not.toContain(admin.id);
    expect(dependencies(assembly, site)).not.toContain(admin.id);
    expect(dependencies(assembly, identity)).not.toContain(admin.id);

    for (const { resource } of [
      ...records(admin, "AWS::ApiGatewayV2::Api"),
      applicationLambda(scenario),
      ...records(admin, "AWS::S3::Bucket"),
      ...records(admin, "AWS::CloudFront::Distribution"),
    ]) {
      expect(resourceTagValue({ resource }, "project")).toBe("multi-chatbot");
      expect(resourceTagValue({ resource }, "environment")).toBe(environment);
    }
  });

  it.each(environments)(
    "uses the existing %s pool and protects every admin route with its client audience",
    (environment) => {
      const scenario = scenarioFor(environment);
      if (!scenario) return;

      const { assembly, admin, identity } = scenario;
      const identityPool = onlyRecord(identity, "AWS::Cognito::UserPool");
      const adminClient = onlyRecord(admin, "AWS::Cognito::UserPoolClient");
      const group = onlyRecord(admin, "AWS::Cognito::UserPoolGroup");
      const api = onlyRecord(admin, "AWS::ApiGatewayV2::Api");
      const authorizers = records(admin, "AWS::ApiGatewayV2::Authorizer");
      const routes = records(admin, "AWS::ApiGatewayV2::Route");
      const lambda = applicationLambda(scenario);
      const integrations = records(admin, "AWS::ApiGatewayV2::Integration");

      expect(adminClient.properties.GenerateSecret).toBe(false);
      expect(adminClient.properties.ExplicitAuthFlows).toContain("ALLOW_USER_PASSWORD_AUTH");
      expect(adminClient.properties.ExplicitAuthFlows).toContain("ALLOW_REFRESH_TOKEN_AUTH");
      expect(adminClient.properties.ExplicitAuthFlows).not.toContain(
        "ALLOW_ADMIN_USER_PASSWORD_AUTH",
      );
      expect(adminClient.properties.EnableTokenRevocation).toBe(true);
      expect(accessTokenSeconds(adminClient.properties)).toBe(3600);
      expect(
        referencesResource(
          adminClient.properties.UserPoolId,
          admin,
          identity,
          identityPool,
          assembly,
        ),
      ).toBe(true);

      expect(group.properties.RoleArn).toBeUndefined();
      expect(
        referencesResource(group.properties.UserPoolId, admin, identity, identityPool, assembly),
      ).toBe(true);
      expect(api.properties.ProtocolType).toBe("HTTP");
      expect(routes.length).toBeGreaterThan(0);
      expect(integrations.length).toBeGreaterThan(0);
      expect(authorizers).toHaveLength(1);
      const authorizer = authorizers[0];
      expect(authorizer.properties.AuthorizerType).toBe("JWT");
      expect(authorizer.properties.IdentitySource).toContain("$request.header.Authorization");
      expect(
        referencesResource(
          authorizer.properties.JwtConfiguration?.Issuer,
          admin,
          identity,
          identityPool,
          assembly,
        ),
      ).toBe(true);
      expect(
        referencesResource(
          authorizer.properties.JwtConfiguration?.Audience,
          admin,
          admin,
          adminClient,
          assembly,
        ),
      ).toBe(true);
      expect(JSON.stringify(authorizer.properties.JwtConfiguration?.Issuer)).toContain(
        expectedRegion,
      );

      for (const { properties } of routes) {
        const routeKey = properties.RouteKey || "";
        expect(routeKey).toMatch(/^\S+ \/api\/admin(?:\/|$)/);
        expect(properties.AuthorizationType).toBe("JWT");
        expect(sameStackReference(properties.AuthorizerId, authorizer.logicalId)).toBe(true);
        expect(sameStackReference(properties.ApiId, api.logicalId)).toBe(true);
        const integration = integrations.find(({ logicalId }) =>
          sameStackReference(properties.Target, logicalId),
        );
        expect(
          integration,
          `route ${routeKey} targets a configured Lambda integration`,
        ).toBeDefined();
        expect(
          referencesResource(
            integration?.properties.IntegrationUri,
            admin,
            admin,
            lambda,
            assembly,
          ),
        ).toBe(true);
      }
      expect(routes.map(({ properties }) => properties.RouteKey)).toContain("GET /api/admin/bots");
    },
  );

  it.each(environments)(
    "publishes only the admin runtime config and private HTTPS site assets for %s",
    (environment) => {
      const scenario = scenarioFor(environment);
      if (!scenario) return;

      const { assembly, admin, identity, site } = scenario;
      const bucket = onlyRecord(admin, "AWS::S3::Bucket");
      const distribution = onlyRecord(admin, "AWS::CloudFront::Distribution");
      const originAccess = onlyRecord(admin, "AWS::CloudFront::OriginAccessControl");
      const distributionConfig = distribution.properties.DistributionConfig;
      const origins = distributionConfig?.Origins || [];
      const s3Origin = origins.find(({ OriginAccessControlId }) =>
        sameStackReference(OriginAccessControlId, originAccess.logicalId),
      );
      expect(distributionConfig?.Enabled).toBe(true);
      expect(distributionConfig?.DefaultRootObject).toBe("index.html");
      expect(distributionConfig?.DefaultCacheBehavior?.ViewerProtocolPolicy).toBe(
        "redirect-to-https",
      );
      expect(s3Origin, "the website origin uses its own CloudFront OAC").toBeDefined();
      expect(s3Origin?.S3OriginConfig?.OriginAccessIdentity).toBe("");
      expect(originAccess.properties.OriginAccessControlConfig).toMatchObject({
        OriginAccessControlOriginType: "s3",
        SigningBehavior: "always",
        SigningProtocol: "sigv4",
      });
      expect(bucket.properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });

      const bucketPolicies = records(admin, "AWS::S3::BucketPolicy");
      expect(bucketPolicies).toHaveLength(1);
      const statements = bucketPolicies[0].properties.PolicyDocument?.Statement || [];
      expect(
        statements.some((statement) =>
          isOacReadAllow(statement, distribution, bucket, admin, assembly),
        ),
        "the OAC has a narrowly scoped read grant",
      ).toBe(true);
      expect(
        statements.some((statement) => isInsecureTransportDeny(statement, bucket, admin, assembly)),
        "the website bucket rejects insecure transport",
      ).toBe(true);

      const apiBehavior = (distributionConfig?.CacheBehaviors || []).find(
        ({ PathPattern }) => PathPattern === "/api/*",
      );
      expect(apiBehavior, "the admin site proxies its API on /api/*").toBeDefined();
      expect(cachingIsDisabled(admin, apiBehavior || {})).toBe(true);
      expect(forwardsAuthorization(admin, apiBehavior || {})).toBe(true);
      expect(apiBehavior?.AllowedMethods).toEqual(
        expect.arrayContaining(["GET", "HEAD", "OPTIONS", "POST"]),
      );
      const apiOrigin = origins.find(({ Id }) => Id === apiBehavior?.TargetOriginId);
      expect(apiOrigin?.CustomOriginConfig?.OriginProtocolPolicy).toBe("https-only");
      const api = onlyRecord(admin, "AWS::ApiGatewayV2::Api");
      expect(referencesResource(apiOrigin?.DomainName, admin, admin, api, assembly)).toBe(true);

      const deployments = records(admin, "Custom::CDKBucketDeployment");
      expect(deployments.length).toBeGreaterThan(0);
      const deploymentWithConfig = deployments.find(({ properties }) =>
        resourceAssets(assembly, admin, properties).some((asset) =>
          asset.files.some(
            ({ relativePath }) => pathBaseName(relativePath) === "public-config.json",
          ),
        ),
      );
      expect(
        deploymentWithConfig,
        "the admin app and its runtime config are staged by this stack",
      ).toBeDefined();
      const configFile = deploymentWithConfig && publicConfigAsset(scenario, deploymentWithConfig);
      const deploymentAssets = deploymentWithConfig
        ? resourceAssets(assembly, admin, deploymentWithConfig.properties)
        : [];
      const deploymentFiles = deploymentAssets.flatMap((asset) =>
        asset.files.map((file) => ({ ...file, assetId: asset.assetId })),
      );
      const webFiles = deploymentFiles;
      expect(webFiles.some(({ relativePath }) => pathBaseName(relativePath) === "index.html")).toBe(
        true,
      );
      expect(webFiles.some(({ relativePath }) => /\.m?js$/i.test(pathBaseName(relativePath)))).toBe(
        true,
      );
      const botSiteAssetIds = new Set(assetFiles(assembly, site).map(({ assetId }) => assetId));
      expect(deploymentAssets.some(({ assetId }) => botSiteAssetIds.has(assetId))).toBe(false);

      const configAssetContents = parsePublicConfig(configFile);
      const config = configAssetContents?.parsed;
      expect(config).toEqual({
        environment,
        region: expectedRegion,
        userPoolId: null,
        clientId: null,
        apiBaseUrl: "/api",
      });
      expect(
        sourceMarker(configAssetContents?.contents || "", "userPoolId"),
        "public userPoolId is supplied from this environment's identity stack",
      ).toBeDefined();
      expect(
        sourceMarker(configAssetContents?.contents || "", "clientId"),
        "public clientId is supplied from the admin app client",
      ).toBeDefined();
      const pool = onlyRecord(identity, "AWS::Cognito::UserPool");
      const client = onlyRecord(admin, "AWS::Cognito::UserPoolClient");
      for (const [key, targetStack, targetResource] of [
        ["userPoolId", identity, pool],
        ["clientId", admin, client],
      ]) {
        const marker = sourceMarker(configAssetContents?.contents || "", key);
        const source = markerValue(admin, marker);
        expect(source, `${key} marker has an assembly source`).toBeDefined();
        expect(referencesResource(source, admin, targetStack, targetResource, assembly)).toBe(true);
      }
    },
  );

  it.each(environments)(
    "limits the %s admin Lambda to account, pool, and configured invitation email access",
    (environment) => {
      const scenario = scenarioFor(environment);
      if (!scenario) return;

      const { assembly, admin, identity, account, site } = scenario;
      const lambda = applicationLambda(scenario);
      const lambdaAsset = resourceAsset(assembly, admin, lambda.properties.Code);
      expect(lambdaAsset, "the admin Lambda code is in this stack's checked assets").toBeDefined();
      expect(
        lambdaAsset?.files.some(({ relativePath }) => /\.m?js$/i.test(pathBaseName(relativePath))),
      ).toBe(true);
      const pool = onlyRecord(identity, "AWS::Cognito::UserPool");
      const accountTable = onlyRecord(account, "AWS::DynamoDB::Table");
      const accountClient = onlyRecord(account, "AWS::Cognito::UserPoolClient");
      const siteDistribution = onlyRecord(site, "AWS::CloudFront::Distribution");
      const variables = lambda.properties.Environment?.Variables || {};
      const serializedVariables = JSON.stringify(variables);

      expect(lambda.properties.Runtime).toBe("nodejs24.x");
      expect(serializedVariables).toContain(expectedBotId);
      expect(
        referencesResource(variables, admin, account, accountTable, assembly),
        "the server catalog selects the docentes account table from the checked assembly",
      ).toBe(true);
      expect(
        referencesResource(variables, admin, account, accountClient, assembly),
        "the invitation config uses docentes' existing Cognito app client",
      ).toBe(true);
      expect(
        referencesResource(variables, admin, site, siteDistribution, assembly),
        "the invitation acceptance URL comes from the docentes site output",
      ).toBe(true);
      expect(serializedVariables).toContain("siteUrl");
      expect(serializedVariables).toContain("botId");
      const botIds = parseJsonEnvironmentValues(variables).flatMap(configuredBotIds);
      expect(botIds).toEqual([expectedBotId]);

      const { statements } = lambdaPolicies(admin, lambda);
      const dynamoStatements = statements.filter(
        (statement) => resourceActions([statement], "dynamodb:").length > 0,
      );
      expect(dynamoStatements.length).toBeGreaterThan(0);
      for (const statement of dynamoStatements) {
        for (const resource of statementResources(statement)) {
          expect(resource).toBeDefined();
          expect(
            referencesResource(resource, admin, account, accountTable, assembly),
            "DynamoDB access is scoped to the account table in the server catalog",
          ).toBe(true);
        }
      }

      const cognitoActions = resourceActions(statements, "cognito-idp:");
      expect([...new Set(cognitoActions)].sort()).toEqual([
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminGetUser",
      ]);
      const cognitoStatements = statements.filter(
        (statement) => resourceActions([statement], "cognito-idp:").length > 0,
      );
      for (const statement of cognitoStatements) {
        expect(
          referencesResource(statement.Resource, admin, identity, pool, assembly),
          "Cognito invitation identity operations target the environment's existing pool",
        ).toBe(true);
      }
      for (const forbidden of [
        "cognito-idp:AdminSetUserPassword",
        "cognito-idp:AdminUpdateUserAttributes",
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminRemoveUserFromGroup",
      ]) {
        expect(cognitoActions).not.toContain(forbidden);
      }

      const sesStatements = statements.filter(
        (statement) => resourceActions([statement], "ses:").length > 0,
      );
      const sendEmailStatements = sesStatements.filter((statement) =>
        resourceActions([statement], "ses:").includes("ses:SendEmail"),
      );
      if (environment === "dev") {
        expect(sendEmailStatements.length).toBeGreaterThan(0);
        expect(
          sendEmailStatements
            .flatMap(statementResources)
            .some((resource) => stringValueHas(resource, testSender)),
        ).toBe(true);
        expect(serializedVariables.includes(testSender)).toBe(true);
      } else if (sesStatements.length > 0) {
        const sesResources = sesStatements.flatMap(statementResources);
        expect(sesResources.length).toBeGreaterThan(0);
        for (const resource of sesResources) {
          expect(JSON.stringify(resource)).not.toContain("*");
          expect(stringValueHas(resource, testSender)).toBe(false);
        }
      }
      expect(resourceActions(statements, "bedrock:")).toEqual([]);
      expect(
        statements.some((statement) =>
          resourceActions([statement], "dynamodb:").some((action) => action === "dynamodb:Scan"),
        ),
      ).toBe(false);
      expect(exportedOutput(site, "PublicSiteUrl")).toBeDefined();
    },
  );

  it("keeps dev and prod admin identities, destinations, and senders separate", () => {
    const dev = scenarioFor("dev");
    const prod = scenarioFor("prod");
    if (!dev || !prod) return;

    const devPool = onlyRecord(dev.identity, "AWS::Cognito::UserPool");
    const prodPool = onlyRecord(prod.identity, "AWS::Cognito::UserPool");
    const devAdminClient = onlyRecord(dev.admin, "AWS::Cognito::UserPoolClient");
    const prodAdminClient = onlyRecord(prod.admin, "AWS::Cognito::UserPoolClient");
    const devTable = onlyRecord(dev.account, "AWS::DynamoDB::Table");
    const prodTable = onlyRecord(prod.account, "AWS::DynamoDB::Table");
    const devLambda = applicationLambda(dev);
    const prodLambda = applicationLambda(prod);

    expect(dev.identity.id).not.toBe(prod.identity.id);
    expect(dev.admin.id).not.toBe(prod.admin.id);
    expect(JSON.stringify(devPool.resource)).not.toBe(JSON.stringify(prodPool.resource));
    expect(JSON.stringify(devAdminClient.resource)).not.toBe(
      JSON.stringify(prodAdminClient.resource),
    );
    expect(JSON.stringify(devTable.resource.Properties?.TableName)).not.toBe(
      JSON.stringify(prodTable.resource.Properties?.TableName),
    );
    expect(JSON.stringify(devLambda.properties.Environment)).toContain("dev");
    expect(JSON.stringify(prodLambda.properties.Environment)).toContain("prod");
    expect(JSON.stringify(prodLambda.properties.Environment)).not.toContain(testSender);
  });
});
