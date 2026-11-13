import { createHash } from "node:crypto";
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
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
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import { adminConfig, type ResolvedEnvironment } from "../../config/project.js";
import type { DocumentBotResources } from "../../api/document-config.js";
import type { AccountStack } from "./account-stack.js";
import type { ChatStack } from "./chat-stack.js";
import type { PublicSiteStack } from "./public-site-stack.js";
import type { SharedIdentityStack } from "./shared-identity-stack.js";

const handlerPath = fileURLToPath(new URL("../../api/admin-lambda.js", import.meta.url));
const workerPath = fileURLToPath(new URL("../../api/document-worker-lambda.js", import.meta.url));
const lockFilePath = fileURLToPath(new URL("../../../package-lock.json", import.meta.url));
const websiteAssetPath = fileURLToPath(new URL("../../admin-web", import.meta.url));
const incomingPrefix = "incoming/";
const preparedObjectPattern = "prepared/*";

type AdminBot = {
  botId: string;
  projectName: string;
  account: AccountStack;
  chat: ChatStack;
  site: PublicSiteStack;
};

function uploadBucketName(environment: ResolvedEnvironment, botId: string): string {
  const botHash = createHash("sha256")
    .update(`${environment.environment}:${botId}`)
    .digest("hex")
    .slice(0, 8);
  const botSlug = botId.slice(0, 10);

  return `${environment.resourcePrefix}-u-${botSlug}-${botHash}-${environment.account}-${environment.region}`;
}

function documentTask(
  scope: Construct,
  id: string,
  worker: lambda.IFunction,
  step: string,
  retryOnServiceExceptions: boolean,
): tasks.LambdaInvoke {
  return new tasks.LambdaInvoke(scope, id, {
    lambdaFunction: worker,
    payload: sfn.TaskInput.fromObject({
      botId: sfn.JsonPath.stringAt("$.botId"),
      operationId: sfn.JsonPath.stringAt("$.operationId"),
      step,
    }),
    payloadResponseOnly: true,
    resultPath: "$.stepResult",
    retryOnServiceExceptions,
  });
}

function documentWorkflow(scope: Construct, worker: lambda.IFunction): sfn.IChainable {
  const finish = documentTask(scope, "FinishDocumentOperation", worker, "finish", true);
  const validate = documentTask(scope, "ValidateReceivedDocument", worker, "validate", true);
  const promote = documentTask(scope, "PromoteDocumentSource", worker, "promote", false);
  const startIngestion = documentTask(
    scope,
    "StartDocumentIngestion",
    worker,
    "start-ingestion",
    true,
  );
  const observeIngestion = documentTask(
    scope,
    "ObserveDocumentIngestion",
    worker,
    "observe-ingestion",
    true,
  );
  const waitForIngestion = new sfn.Wait(scope, "WaitForDocumentIngestion", {
    time: sfn.WaitTime.duration(Duration.seconds(30)),
  }).next(observeIngestion);
  const waitToStartIngestion = new sfn.Wait(scope, "WaitToStartDocumentIngestion", {
    time: sfn.WaitTime.duration(Duration.seconds(30)),
  }).next(startIngestion);
  const invalidState = new sfn.Fail(scope, "InvalidDocumentWorkflowState", {
    error: "InvalidDocumentWorkflowState",
  });
  const isFailure = () =>
    sfn.Condition.or(
      sfn.Condition.stringEquals("$.stepResult.status", "failed"),
      sfn.Condition.stringEquals("$.stepResult.status", "unconfirmed"),
    );
  const validationResult = new sfn.Choice(scope, "DocumentValidationResult")
    .when(sfn.Condition.stringEquals("$.stepResult.status", "ready"), promote)
    .when(isFailure(), finish)
    .otherwise(invalidState);
  const promotionResult = new sfn.Choice(scope, "DocumentPromotionResult")
    .when(sfn.Condition.stringEquals("$.stepResult.status", "ready"), startIngestion)
    .when(isFailure(), finish)
    .otherwise(invalidState);
  const startResult = new sfn.Choice(scope, "DocumentIngestionStartResult")
    .when(sfn.Condition.stringEquals("$.stepResult.status", "ready"), observeIngestion)
    .when(sfn.Condition.stringEquals("$.stepResult.status", "waiting"), waitToStartIngestion)
    .when(isFailure(), finish)
    .otherwise(invalidState);
  const observationResult = new sfn.Choice(scope, "DocumentIngestionObservation")
    .when(sfn.Condition.stringEquals("$.stepResult.status", "waiting"), waitForIngestion)
    .when(
      sfn.Condition.or(
        sfn.Condition.stringEquals("$.stepResult.status", "completed"),
        sfn.Condition.stringEquals("$.stepResult.status", "failed"),
        sfn.Condition.stringEquals("$.stepResult.status", "unconfirmed"),
      ),
      finish,
    )
    .otherwise(invalidState);

  validate.next(validationResult);
  promote.next(promotionResult);
  startIngestion.next(startResult);
  observeIngestion.next(observationResult);

  return sfn.Chain.start(validate);
}

export class AdminStack extends Stack {
  readonly userPoolClient: cognito.UserPoolClient;
  readonly handler: nodejs.NodejsFunction;
  readonly documentWorker: nodejs.NodejsFunction;
  readonly documentStateMachine: sfn.StateMachine;
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

    const uploadBuckets = new Map<string, s3.Bucket>();
    const workerCatalog: DocumentBotResources[] = bots.map(({ botId, chat }) => {
      const hash = createHash("sha256").update(botId).digest("hex").slice(0, 8);
      const uploadBucket = new s3.Bucket(this, `DocumentUploadBucket${hash}`, {
        bucketName: uploadBucketName(environment, botId),
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        lifecycleRules: [
          {
            id: "ExpireIncomingReceipts",
            prefix: incomingPrefix,
            expiration: Duration.days(1),
          },
        ],
        removalPolicy: RemovalPolicy.DESTROY,
      });
      Tags.of(uploadBucket).add("botId", botId);
      uploadBuckets.set(botId, uploadBucket);

      return {
        botId,
        documentTableName: chat.documents.documentTable.tableName,
        uploadBucketName: uploadBucket.bucketName,
        documentBucketName: chat.documents.documentBucket.bucketName,
        incomingPrefix,
        preparedPrefix: chat.documents.preparedDocumentsPrefix,
        knowledgeBaseId: chat.documents.knowledgeBase.attrKnowledgeBaseId,
        dataSourceId: chat.documents.dataSource.attrDataSourceId,
      };
    });

    const invitationSender = adminConfig.invitationSenderByEnvironment[environment.environment];
    this.documentWorker = new nodejs.NodejsFunction(this, "DocumentWorker", {
      entry: workerPath,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.minutes(15),
      depsLockFilePath: lockFilePath,
      bundling: { bundleAwsSDK: true },
      environment: { BOT_CATALOG: JSON.stringify(workerCatalog) },
    });

    const workflow = documentWorkflow(this, this.documentWorker);
    this.documentStateMachine = new sfn.StateMachine(this, "DocumentOperations", {
      stateMachineName: `${environment.resourcePrefix}-document-operations`,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(workflow),
      timeout: Duration.hours(24),
    });

    const apiBotCatalog = bots.map(({ botId, projectName, account, chat, site }) => {
      const documentResources = workerCatalog.find((resource) => resource.botId === botId);
      if (!documentResources) throw new Error(`Document resources are missing for ${botId}.`);
      return {
        projectName,
        accountTableName: account.table.tableName,
        conversationTableName: chat.conversationTable.tableName,
        clientId: account.userPoolClient.userPoolClientId,
        siteUrl: site.siteUrl,
        ...documentResources,
        stateMachineArn: this.documentStateMachine.stateMachineArn,
      };
    });

    this.httpApi = new apigateway.HttpApi(this, "AdminApi", {
      apiName: `${environment.resourcePrefix}-admin`,
    });
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

    for (const bucket of uploadBuckets.values()) {
      bucket.addCorsRule({
        allowedMethods: [s3.HttpMethods.POST],
        allowedOrigins: [`https://${this.distribution.distributionDomainName}`],
        allowedHeaders: ["Content-Type"],
      });
    }

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
        BOT_CATALOG: JSON.stringify(apiBotCatalog),
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
          actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
          resources: [bot.chat.conversationTable.tableArn],
          conditions: {
            "ForAllValues:StringEquals": {
              "dynamodb:LeadingKeys": [`BOT#${bot.botId}`],
            },
            Null: { "dynamodb:LeadingKeys": "false" },
          },
        }),
      );

      const documentTableArn = bot.chat.documents.documentTable.tableArn;
      const documentTableActions = [
        "dynamodb:ConditionCheckItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:TransactWriteItems",
        "dynamodb:UpdateItem",
      ];
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: documentTableActions,
          resources: [documentTableArn],
        }),
      );

      const uploadBucket = uploadBuckets.get(bot.botId);
      if (!uploadBucket) throw new Error(`Upload bucket is missing for ${bot.botId}.`);
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject"],
          resources: [uploadBucket.arnForObjects(`${incomingPrefix}*`)],
        }),
      );
      this.documentWorker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: documentTableActions,
          resources: [documentTableArn],
        }),
      );
      this.documentWorker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetObject"],
          resources: [uploadBucket.arnForObjects(`${incomingPrefix}*`)],
        }),
      );
      this.documentWorker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"],
          resources: [bot.chat.documents.documentBucket.arnForObjects(preparedObjectPattern)],
        }),
      );
      this.documentWorker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            "bedrock:GetIngestionJob",
            "bedrock:GetKnowledgeBaseDocuments",
            "bedrock:ListIngestionJobs",
            "bedrock:StartIngestionJob",
          ],
          resources: [bot.chat.documents.knowledgeBase.attrKnowledgeBaseArn],
        }),
      );
    }

    this.documentStateMachine.grants.startExecution(this.handler);
    this.documentStateMachine.grants.execution(this.handler, "states:DescribeExecution");

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
      ["AdminQuotaUpdateRoute", "/api/admin/bots/{botId}/quota", apigateway.HttpMethod.PUT],
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
      ["AdminDocumentsRoute", "/api/admin/bots/{botId}/documents", apigateway.HttpMethod.GET],
      [
        "AdminDocumentOperationsRoute",
        "/api/admin/bots/{botId}/document-operations",
        apigateway.HttpMethod.POST,
      ],
      [
        "AdminStartDocumentOperationRoute",
        "/api/admin/bots/{botId}/document-operations/{operationId}/start",
        apigateway.HttpMethod.POST,
      ],
      [
        "AdminGetDocumentOperationRoute",
        "/api/admin/bots/{botId}/document-operations/{operationId}",
        apigateway.HttpMethod.GET,
      ],
    ] as const;
    for (const [routeId, routePath, method] of adminRoutes) {
      new apigateway.HttpRoute(this, routeId, {
        httpApi: this.httpApi,
        routeKey: apigateway.HttpRouteKey.with(routePath, method),
        integration,
        authorizer,
      });
    }

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
