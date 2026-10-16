import { DefaultStackSynthesizer, Stack, Tags } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { projectConfig, type ResolvedEnvironment } from "../../config/project.js";

type SetupEnvironment = Pick<ResolvedEnvironment, "account" | "region" | "environment">;

const githubOidcProviderArn = `arn:aws:iam::${projectConfig.account}:oidc-provider/token.actions.githubusercontent.com`;
const githubSubjects = [
  "repo:guilleojeda@18320860/multi-chatbot@1409472663:ref:refs/tags/dev",
  "repo:guilleojeda@18320860/multi-chatbot@1409472663:ref:refs/tags/prod",
];
const bootstrapRoleNames = [
  "deploy-role",
  "file-publishing-role",
  "image-publishing-role",
  "lookup-role",
].map(
  (roleName) =>
    `arn:aws:iam::${projectConfig.account}:role/cdk-hnb659fds-${roleName}-${projectConfig.account}-${projectConfig.region}`,
);

export class SetupStack extends Stack {
  constructor(scope: Construct, id: string, environment: SetupEnvironment) {
    super(scope, id, {
      env: { account: environment.account, region: environment.region },
      synthesizer: new DefaultStackSynthesizer(),
    });

    Tags.of(this).add("project", "multi-chatbot");

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "ExistingGitHubOidcProvider",
      githubOidcProviderArn,
    );
    const githubActionsRole = new iam.Role(this, "GitHubActionsRole", {
      roleName: "multi-chatbot-github-actions",
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": githubSubjects,
        },
      }),
      description: "GitHub Actions access to this project's standard CDK bootstrap roles.",
    });

    githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: bootstrapRoleNames,
      }),
    );
  }
}
