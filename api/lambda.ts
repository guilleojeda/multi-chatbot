import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createAccountHandler } from "./account.js";
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

const identityClient = new CognitoIdentityProviderClient({ region });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const accountHandler = createAccountHandler({
  config: { botId },
  identity: createCognitoIdentityAdapter({ client: identityClient, userPoolId, clientId, region }),
  store: createAccountStoreAdapter({ documentClient: dynamoClient, tableName }),
  now: Date.now,
});

export const handler: typeof accountHandler = (event) => accountHandler(event);
