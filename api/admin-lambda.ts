import { randomBytes as secureRandomBytes } from "node:crypto";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createAdminHandler } from "./admin.js";
import { adminSesClientOptions, parseAdminLambdaConfig } from "./admin-config.js";
import {
  createAccountStoreAdapter,
  createCognitoIdentityAdapter,
  createSesInvitationMailer,
} from "./aws-adapters.js";
import { createQuotaPolicyReader, createQuotaPolicyWriter } from "./quota-policy-store.js";

const runtimeConfig = parseAdminLambdaConfig();
const identityClient = new CognitoIdentityProviderClient({ region: runtimeConfig.region });
const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: runtimeConfig.region }),
  {
    marshallOptions: { removeUndefinedValues: true },
  },
);
const stores = Object.fromEntries(
  runtimeConfig.bots.map((bot) => [
    bot.botId,
    createAccountStoreAdapter({
      documentClient: dynamoClient,
      tableName: bot.accountTableName,
      now: Date.now,
    }),
  ]),
);
const quotaReaders = Object.fromEntries(
  runtimeConfig.bots.map((bot) => [
    bot.botId,
    createQuotaPolicyReader(dynamoClient, bot.conversationTableName, bot.botId),
  ]),
);
const quotaWriters = Object.fromEntries(
  runtimeConfig.bots.map((bot) => [
    bot.botId,
    createQuotaPolicyWriter(dynamoClient, bot.conversationTableName, bot.botId),
  ]),
);

export const handler = createAdminHandler({
  config: {
    clientId: runtimeConfig.adminClientId,
    adminGroup: runtimeConfig.adminGroup,
    sender: runtimeConfig.sender,
    invitationTtlMs: runtimeConfig.invitationTtlMs,
    bots: runtimeConfig.bots.map(({ botId, projectName, siteUrl }) => ({
      botId,
      projectName,
      siteUrl,
    })),
  },
  stores,
  quotaReaders,
  quotaWriters,
  identity: createCognitoIdentityAdapter({
    client: identityClient,
    userPoolId: runtimeConfig.userPoolId,
    clientId: runtimeConfig.adminClientId,
    region: runtimeConfig.region,
  }),
  mail: createSesInvitationMailer(new SESv2Client(adminSesClientOptions(runtimeConfig.region))),
  now: Date.now,
  randomBytes: secureRandomBytes,
});
