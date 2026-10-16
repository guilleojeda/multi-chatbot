import { App } from "aws-cdk-lib";
import { resolveEnvironment } from "../../config/project.js";
import { siteConfig } from "../../config/site.js";
import { AccountStack } from "../lib/account-stack.js";
import { PublicSiteStack } from "../lib/public-site-stack.js";
import { SharedIdentityStack } from "../lib/shared-identity-stack.js";
import { SetupStack } from "../lib/setup-stack.js";

const app = new App();
const environment = app.node.tryGetContext("environment") ?? "dev";
const resolvedSiteEnvironment = resolveEnvironment(environment, siteConfig.botId);

if (!("botResourcePrefix" in resolvedSiteEnvironment)) {
  throw new Error(`Environment ${environment} did not resolve a chatbot resource prefix.`);
}

new SetupStack(app, "multi-chatbot-setup", resolvedSiteEnvironment);
const identity = new SharedIdentityStack(
  app,
  `${resolvedSiteEnvironment.resourcePrefix}-identity`,
  resolvedSiteEnvironment,
);
const account = new AccountStack(
  app,
  `${resolvedSiteEnvironment.botResourcePrefix}-account`,
  resolvedSiteEnvironment,
  identity.userPool,
);
new PublicSiteStack(
  app,
  `${resolvedSiteEnvironment.botResourcePrefix}-site`,
  resolvedSiteEnvironment,
  identity,
  account,
);
