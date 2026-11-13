import { randomBytes as secureRandomBytes, randomUUID } from "node:crypto";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SFNClient } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createAdminHandler } from "./admin.js";
import { adminSesClientOptions, parseAdminLambdaConfig } from "./admin-config.js";
import {
  createAccountStoreAdapter,
  createCognitoIdentityAdapter,
  createSesInvitationMailer,
} from "./aws-adapters.js";
import { createQuotaPolicyReader, createQuotaPolicyWriter } from "./quota-policy-store.js";
import { createDocumentAdministration } from "./document-administration.js";
import {
  createDocumentExecution,
  createDocumentObjects,
  createDocumentUploadSigner,
} from "./document-aws-adapters.js";
import { createDocumentStore } from "./document-store.js";

const runtimeConfig = parseAdminLambdaConfig();
const identityClient = new CognitoIdentityProviderClient({ region: runtimeConfig.region });
const s3Client = new S3Client({ region: runtimeConfig.region, maxAttempts: 2 });
const sfnClient = new SFNClient({ region: runtimeConfig.region, maxAttempts: 1 });
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
const documentObjects = createDocumentObjects({ s3Client });
const documentUploadSigner = createDocumentUploadSigner({ s3Client, now: Date.now });
const documentAdministrations = Object.fromEntries(
  runtimeConfig.bots.map((bot) => [
    bot.botId,
    createDocumentAdministration({
      botId: bot.botId,
      store: createDocumentStore({
        documentClient: dynamoClient,
        tableName: bot.documentTableName,
        botId: bot.botId,
        now: Date.now,
      }),
      uploadBucketName: bot.uploadBucketName,
      documentBucketName: bot.documentBucketName,
      incomingPrefix: bot.incomingPrefix,
      preparedPrefix: bot.preparedPrefix,
      uploadSigner: documentUploadSigner,
      objects: documentObjects,
      execution: createDocumentExecution({
        sfnClient,
        stateMachineArn: bot.stateMachineArn,
      }),
      now: Date.now,
      randomUUID,
    }),
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
  documentAdministrations,
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
