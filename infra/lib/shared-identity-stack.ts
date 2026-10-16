import { CfnOutput, Stack, Tags } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import type { ResolvedEnvironment } from "../../config/project.js";

export class SharedIdentityStack extends Stack {
  readonly userPool: cognito.UserPool;

  constructor(scope: Construct, id: string, environment: ResolvedEnvironment) {
    super(scope, id, {
      env: { account: environment.account, region: environment.region },
      tags: {
        project: "multi-chatbot",
        environment: environment.environment,
      },
    });

    Tags.of(this).add("project", "multi-chatbot");
    Tags.of(this).add("environment", environment.environment);

    const recoveryEmailConfig =
      environment.environment === "dev"
        ? {
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            email: cognito.UserPoolEmail.withSES({ fromEmail: "sxvintage@gmail.com" }),
          }
        : { accountRecovery: cognito.AccountRecovery.NONE };

    this.userPool = new cognito.UserPool(this, "SharedUserPool", {
      userPoolName: `${environment.resourcePrefix}-identity`,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      selfSignUpEnabled: false,
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      ...recoveryEmailConfig,
    });

    new CfnOutput(this, "UserPoolId", {
      value: this.userPool.userPoolId,
      description: `Shared identity pool for ${environment.environment}.`,
    });
  }
}
