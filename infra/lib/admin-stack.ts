import { CfnOutput, Duration, Fn, Stack, Tags } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import { adminConfig, type ResolvedEnvironment } from "../../config/project.js";
import type { AccountStack } from "./account-stack.js";
import type { ChatStack } from "./chat-stack.js";
import type { PublicSiteStack } from "./public-site-stack.js";
import type { SharedIdentityStack } from "./shared-identity-stack.js";

const handlerPath = fileURLToPath(new URL("../../api/admin-lambda.js", import.meta.url));
const lockFilePath = fileURLToPath(new URL("../../../package-lock.json", import.meta.url));
const websiteAssetPath = fileURLToPath(new URL("../../admin-web", import.meta.url));

type AdminBot = {
  botId: string;
  projectName: string;
  account: AccountStack;
  chat: ChatStack;
  site: PublicSiteStack;
};

export class AdminStack extends Stack {
  readonly userPoolClient: cognito.UserPoolClient;
  readonly handler: nodejs.NodejsFunction;
  readonly httpApi: apigateway.HttpApi;
  readonly websiteBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly groupName = adminConfig.groupName;
  readonly siteUrl: string;

  constructor(
    scope: Construct,
    id: string,
    environment: ResolvedEnvironment,
    identity: SharedIdentityStack,
    bots: readonly AdminBot[],
  ) {
    super(scope, id, {
      env: { account: environment.account, region: environment.region },
      tags: {
        project: "multi-chatbot",
        environment: environment.environment,
      },
    });

    Tags.of(this).add("project", "multi-chatbot");
    Tags.of(this).add("environment", environment.environment);

    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      groupName: this.groupName,
      userPoolId: identity.userPool.userPoolId,
      description: `Global administrators for ${environment.environment}.`,
    });

    this.userPoolClient = new cognito.UserPoolClient(this, "AdminClient", {
      userPool: identity.userPool,
      userPoolClientName: `${environment.resourcePrefix}-admin`,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: false,
        adminUserPassword: false,
        custom: false,
      },
      accessTokenValidity: Duration.hours(1),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    const botCatalog = bots.map(({ botId, projectName, account, chat, site }) => ({
      botId,
      projectName,
      accountTableName: account.table.tableName,
      conversationTableName: chat.conversationTable.tableName,
      clientId: account.userPoolClient.userPoolClientId,
      siteUrl: site.siteUrl,
    }));
    const invitationSender = adminConfig.invitationSenderByEnvironment[environment.environment];

    this.handler = new nodejs.NodejsFunction(this, "AdminHandler", {
      entry: handlerPath,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(20),
      depsLockFilePath: lockFilePath,
      bundling: { bundleAwsSDK: true },
      environment: {
        USER_POOL_ID: identity.userPool.userPoolId,
        ADMIN_CLIENT_ID: this.userPoolClient.userPoolClientId,
        ADMIN_GROUP: this.groupName,
        BOT_CATALOG: JSON.stringify(botCatalog),
        ...(invitationSender ? { INVITATION_SENDER: invitationSender } : {}),
      },
    });

    for (const bot of bots) {
      bot.account.table.grant(
        this.handler,
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
      );
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["dynamodb:GetItem"],
          resources: [bot.chat.conversationTable.tableArn],
          conditions: {
            "ForAllValues:StringEquals": {
              "dynamodb:LeadingKeys": [`BOT#${bot.botId}`],
            },
            Null: { "dynamodb:LeadingKeys": "false" },
          },
        }),
      );
    }
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser"],
        resources: [identity.userPool.userPoolArn],
      }),
    );
    if (invitationSender) {
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: [
            `arn:${Stack.of(this).partition}:ses:${environment.region}:${environment.account}:identity/${invitationSender}`,
          ],
        }),
      );
    }

    this.httpApi = new apigateway.HttpApi(this, "AdminApi", {
      apiName: `${environment.resourcePrefix}-admin`,
    });
    const integration = new integrations.HttpLambdaIntegration(
      "AdminHandlerIntegration",
      this.handler,
    );
    const authorizer = new authorizers.HttpJwtAuthorizer(
      "AdminJwtAuthorizer",
      `https://cognito-idp.${environment.region}.amazonaws.com/${identity.userPool.userPoolId}`,
      { jwtAudience: [this.userPoolClient.userPoolClientId] },
    );
    const adminRoutes = [
      ["AdminMeRoute", "/api/admin/me", apigateway.HttpMethod.GET],
      ["AdminBotsRoute", "/api/admin/bots", apigateway.HttpMethod.GET],
      ["AdminQuotaRoute", "/api/admin/bots/{botId}/quota", apigateway.HttpMethod.GET],
      [
        "AdminRevokeAccessRoute",
        "/api/admin/bots/{botId}/access/revoke",
        apigateway.HttpMethod.POST,
      ],
      [
        "AdminPeopleLookupRoute",
        "/api/admin/bots/{botId}/people/lookup",
        apigateway.HttpMethod.POST,
      ],
      ["AdminInvitationRoute", "/api/admin/bots/{botId}/invitations", apigateway.HttpMethod.POST],
    ] as const;
    for (const [routeId, routePath, method] of adminRoutes) {
      new apigateway.HttpRoute(this, routeId, {
        httpApi: this.httpApi,
        routeKey: apigateway.HttpRouteKey.with(routePath, method),
        integration,
        authorizer,
      });
    }

    this.websiteBucket = new s3.Bucket(this, "AdminWebsiteBucket", {
      bucketName: `${environment.resourcePrefix}-admin-site-assets-${environment.account}-${environment.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    const apiOrigin = new origins.HttpOrigin(
      Fn.select(2, Fn.split("/", this.httpApi.apiEndpoint)),
      { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY },
    );
    this.distribution = new cloudfront.Distribution(this, "AdminWebsiteDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: apiOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
    });

    new s3deploy.BucketDeployment(this, "AdminWebsiteDeployment", {
      sources: [
        s3deploy.Source.asset(websiteAssetPath),
        s3deploy.Source.jsonData("public-config.json", {
          environment: environment.environment,
          region: environment.region,
          userPoolId: identity.userPool.userPoolId,
          clientId: this.userPoolClient.userPoolClientId,
          apiBaseUrl: "/api",
        }),
      ],
      destinationBucket: this.websiteBucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
    });

    this.siteUrl = `https://${this.distribution.distributionDomainName}`;
    new CfnOutput(this, "AdminSiteUrl", {
      value: this.siteUrl,
      description: `Administration site URL for ${environment.environment}.`,
    });
    new CfnOutput(this, "AdminClientId", {
      value: this.userPoolClient.userPoolClientId,
      description: `Public Cognito client for the ${environment.environment} admin site.`,
    });
    new CfnOutput(this, "AdminGroupName", {
      value: this.groupName,
      description: `Global admin group in the ${environment.environment} user pool.`,
    });
  }
}
