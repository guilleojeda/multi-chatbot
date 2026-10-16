import { CfnOutput, Duration, Stack, Tags } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import type { ResolvedBotEnvironment } from "../../config/project.js";

const handlerPath = fileURLToPath(new URL("../../api/lambda.js", import.meta.url));
const lockFilePath = fileURLToPath(new URL("../../../package-lock.json", import.meta.url));

export class AccountStack extends Stack {
  readonly userPoolClient: cognito.UserPoolClient;
  readonly table: dynamodb.Table;
  readonly handler: nodejs.NodejsFunction;
  readonly httpApi: apigateway.HttpApi;

  constructor(
    scope: Construct,
    id: string,
    environment: ResolvedBotEnvironment,
    userPool: cognito.IUserPool,
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

    this.userPoolClient = new cognito.UserPoolClient(this, "AccountClient", {
      userPool,
      userPoolClientName: `${environment.botResourcePrefix}-account`,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: false,
        adminUserPassword: false,
        custom: false,
      },
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    this.table = new dynamodb.Table(this, "AccountTable", {
      tableName: `${environment.botResourcePrefix}-account-data`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
    });

    this.handler = new nodejs.NodejsFunction(this, "AccountHandler", {
      entry: handlerPath,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(15),
      depsLockFilePath: lockFilePath,
      bundling: {
        bundleAwsSDK: true,
      },
      environment: {
        BOT_ID: environment.botId,
        USER_POOL_ID: userPool.userPoolId,
        CLIENT_ID: this.userPoolClient.userPoolClientId,
        TABLE_NAME: this.table.tableName,
      },
    });

    this.table.grant(this.handler, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem");
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminUpdateUserAttributes",
        ],
        resources: [userPool.userPoolArn],
      }),
    );

    this.httpApi = new apigateway.HttpApi(this, "AccountApi", {
      apiName: `${environment.botResourcePrefix}-account`,
    });
    const integration = new integrations.HttpLambdaIntegration(
      "AccountHandlerIntegration",
      this.handler,
    );
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer(
      "AccountJwtAuthorizer",
      `https://cognito-idp.${environment.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [this.userPoolClient.userPoolClientId] },
    );

    this.httpApi.addRoutes({
      path: "/api/account/invitations/inspect",
      methods: [apigateway.HttpMethod.POST],
      integration,
    });
    this.httpApi.addRoutes({
      path: "/api/account/invitations/accept",
      methods: [apigateway.HttpMethod.POST],
      integration,
    });
    this.httpApi.addRoutes({
      path: "/api/account/me",
      methods: [apigateway.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer,
    });

    new CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
      description: `Shared user pool for ${environment.environment}.`,
    });
    new CfnOutput(this, "ClientId", {
      value: this.userPoolClient.userPoolClientId,
      description: `Public Cognito client for ${environment.botId}.`,
    });
    new CfnOutput(this, "TableName", {
      value: this.table.tableName,
      description: `Invitation and membership table for ${environment.botId}.`,
    });
    new CfnOutput(this, "ApiUrl", {
      value: this.httpApi.apiEndpoint,
      description: `HTTP API endpoint for ${environment.botId}.`,
    });
    new CfnOutput(this, "BotId", {
      value: environment.botId,
      description: "Chatbot identifier for this account stack.",
    });
  }
}
