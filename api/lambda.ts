import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { siteConfig } from "../config/site.js";
import { createAccountHandler } from "./account.js";
import { createProfileHandler } from "./profile.js";
import { createProfileStoreAdapter } from "./profile-store.js";
import { createAccountStoreAdapter, createCognitoIdentityAdapter } from "./aws-adapters.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required Lambda environment variable ${name}.`);
  return value;
}

const botId = requiredEnvironment("BOT_ID");
const userPoolId = requiredEnvironment("USER_POOL_ID");
const clientId = requiredEnvironment("CLIENT_ID");
const tableName = requiredEnvironment("TABLE_NAME");
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

if (botId !== siteConfig.botId) {
  throw new Error(`No site configuration is available for BOT_ID ${botId}.`);
}

const identityClient = new CognitoIdentityProviderClient({ region });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const accountStore = createAccountStoreAdapter({ documentClient: dynamoClient, tableName });
const accountHandler = createAccountHandler({
  config: { botId },
  identity: createCognitoIdentityAdapter({ client: identityClient, userPoolId, clientId, region }),
  store: accountStore,
  now: Date.now,
});

const profileStore = createProfileStoreAdapter({ documentClient: dynamoClient, tableName });
const profileHandler = createProfileHandler({
  config: { botId, profile: siteConfig.profile },
  store: {
    hasMember: (sub, requestedBotId) => accountStore.hasMember({ sub, botId: requestedBotId }),
    ...profileStore,
  },
  now: Date.now,
});

export const handler: typeof accountHandler = async (event) => {
  const path = event.requestContext?.http?.path || event.rawPath || "";
  if (path === "/api/profile") return profileHandler(event);
  return accountHandler(event);
};
