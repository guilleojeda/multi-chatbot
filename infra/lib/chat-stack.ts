import {
  AgentRuntimeArtifact,
  ProtocolType,
  Runtime,
  RuntimeAuthorizerConfiguration,
  RuntimeCustomClaim,
  RuntimeNetworkConfiguration,
} from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import { Stack, Tags } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ResolvedBotEnvironment } from "../../config/project.js";
import type { AccountStack } from "./account-stack.js";
import type { SharedIdentityStack } from "./shared-identity-stack.js";

const inferenceProfileId = "global.anthropic.claude-sonnet-4-6";
const modelId = "anthropic.claude-sonnet-4-6";
const globalModelArn = "arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-4-6";
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function resolveRevision(): string {
  const configuredRevision = process.env.REVISION?.trim();
  const revision =
    configuredRevision ||
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  if (!revisionPattern.test(revision)) {
    throw new Error(
      "REVISION must be a full Git commit SHA; set it when synthesizing a source copy.",
    );
  }

  return revision;
}

export class ChatStack extends Stack {
  readonly runtime: Runtime;
  readonly runtimeArn: string;
  readonly runtimeQualifier = "DEFAULT";
  readonly conversationTable: dynamodb.Table;

  constructor(
    scope: Construct,
    id: string,
    environment: ResolvedBotEnvironment,
    identity: SharedIdentityStack,
    account: AccountStack,
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

    this.conversationTable = new dynamodb.Table(this, "ConversationTable", {
      tableName: `${environment.botResourcePrefix}-conversations`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const runtimeAssetPath = path.resolve(process.cwd(), "dist/runtime-image");
    const revision = resolveRevision();
    const inferenceProfileArn = `arn:aws:bedrock:${environment.region}:${environment.account}:inference-profile/${inferenceProfileId}`;
    const sourceModelArn = `arn:aws:bedrock:${environment.region}::foundation-model/${modelId}`;
    this.runtime = new Runtime(this, "ChatRuntime", {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(runtimeAssetPath, {
        platform: ecrAssets.Platform.LINUX_ARM64,
      }),
      protocolConfiguration: ProtocolType.HTTP,
      networkConfiguration: RuntimeNetworkConfiguration.usingPublicNetwork(),
      authorizerConfiguration: RuntimeAuthorizerConfiguration.usingCognito(
        identity.userPool,
        [account.userPoolClient],
        undefined,
        undefined,
        [RuntimeCustomClaim.withStringValue("token_use", "access")],
      ),
      requestHeaderConfiguration: { allowlistedHeaders: ["Authorization"] },
      environmentVariables: {
        BOT_ID: environment.botId,
        ACCOUNT_TABLE_NAME: account.table.tableName,
        CONVERSATION_TABLE_NAME: this.conversationTable.tableName,
        MODEL_ID: inferenceProfileId,
        REVISION: revision,
        AWS_REGION: environment.region,
      },
      tags: {
        project: "multi-chatbot",
        environment: environment.environment,
      },
    });
    this.runtimeArn = this.runtime.agentRuntimeArn;

    account.table.grant(this.runtime.role, "dynamodb:GetItem");
    this.conversationTable.grant(
      this.runtime.role,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    );

    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModelWithResponseStream"],
        resources: [inferenceProfileArn],
        conditions: { StringEquals: { "aws:RequestedRegion": environment.region } },
      }),
    );
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModelWithResponseStream"],
        resources: [sourceModelArn],
        conditions: {
          StringEquals: {
            "aws:RequestedRegion": environment.region,
            "bedrock:InferenceProfileArn": inferenceProfileArn,
          },
        },
      }),
    );
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModelWithResponseStream"],
        resources: [globalModelArn],
        conditions: {
          StringEquals: {
            "aws:RequestedRegion": "unspecified",
            "bedrock:InferenceProfileArn": inferenceProfileArn,
          },
        },
      }),
    );
  }
}
