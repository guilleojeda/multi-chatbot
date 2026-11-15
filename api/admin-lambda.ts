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
import { parseRecordsApiConfig } from "./records-api-config.js";
import { parseRecordsTestPersonIds } from "./records-test-people.js";
import { createRecordsReader } from "./records-reader.js";
import { createRecordsExportAdministration } from "./records-export-administration.js";
import {
  createRecordsExportExecution,
  createRecordsExportObjects,
} from "./records-export-aws-adapters.js";

const runtimeConfig = parseAdminLambdaConfig();
const hasRecordsConfiguration =
  process.env.RECORDS_CATALOG !== undefined ||
  process.env.RECORDS_EXPORT_STATE_MACHINE_ARN !== undefined;
const recordsConfig = hasRecordsConfiguration
  ? parseRecordsApiConfig(runtimeConfig.bots, process.env)
  : undefined;
const privateTestPeople = parseRecordsTestPersonIds(process.env.RECORDS_TEST_PERSON_IDS);
const configuredBotIds = new Set(recordsConfig?.bots.map((bot) => bot.botId) ?? []);
if (
  [...privateTestPeople.keys()].some((botId) => !configuredBotIds.has(botId)) ||
  (privateTestPeople.size > 0 && !recordsConfig)
) {
  throw new Error("RECORDS_TEST_PERSON_IDS includes a chatbot outside RECORDS_CATALOG.");
}
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
const recordsReaders = recordsConfig
  ? Object.fromEntries(
      recordsConfig.bots.map((recordsBot) => {
        const bot = runtimeConfig.bots.find((candidate) => candidate.botId === recordsBot.botId);
        if (!bot) throw new Error("RECORDS_CATALOG references an unknown chatbot.");
        const testPersonIds = [
          ...new Set([
            ...recordsBot.testPersonIds,
            ...(privateTestPeople.get(recordsBot.botId) ?? []),
          ]),
        ];
        return [
          recordsBot.botId,
          createRecordsReader({
            botId: recordsBot.botId,
            conversationTableName: bot.conversationTableName,
            recordsIndexName: recordsBot.recordsIndexName,
            testPersonIds,
            documentClient: dynamoClient,
            environment: recordsConfig.environment,
            now: Date.now,
          }),
        ];
      }),
    )
  : {};
const recordsExportAdministrations = recordsConfig
  ? (() => {
      const recordsExportExecution = createRecordsExportExecution({
        sfnClient,
        stateMachineArn: recordsConfig.stateMachineArn,
      });
      const recordsExportObjects = createRecordsExportObjects({ s3Client });
      return Object.fromEntries(
        recordsConfig.bots.map((recordsBot) => {
          const bot = runtimeConfig.bots.find((candidate) => candidate.botId === recordsBot.botId);
          if (!bot) throw new Error("RECORDS_CATALOG references an unknown chatbot.");
          return [
            recordsBot.botId,
            createRecordsExportAdministration({
              botId: recordsBot.botId,
              environment: recordsConfig.environment,
              stateMachineArn: recordsConfig.stateMachineArn,
              bucketName: bot.uploadBucketName,
              execution: recordsExportExecution,
              objects: recordsExportObjects,
              now: Date.now,
            }),
          ];
        }),
      );
    })()
  : {};

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
  recordsReaders,
  recordsExportAdministrations,
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
