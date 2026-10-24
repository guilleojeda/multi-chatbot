import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createAccountStoreAdapter } from "./aws-adapters.js";
import { createChatHistoryHandler } from "./chat-history.js";
import { createHistoryStore } from "../runtime/history-store.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required Lambda environment variable ${name}.`);
  return value;
}

const botId = requiredEnvironment("BOT_ID");
const accountTableName = requiredEnvironment("ACCOUNT_TABLE_NAME");
const conversationTableName = requiredEnvironment("CONVERSATION_TABLE_NAME");
const historyIndexName = requiredEnvironment("HISTORY_INDEX_NAME");
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const accountStore = createAccountStoreAdapter({
  documentClient,
  tableName: accountTableName,
});
const historyStore = createHistoryStore({
  documentClient,
  tableName: conversationTableName,
  botId,
  historyIndexName,
  now: Date.now,
});

export const handler = createChatHistoryHandler({
  botId,
  store: historyStore,
  getMembership: ({ sub, botId: requestedBotId }) =>
    accountStore.hasMember({ sub, botId: requestedBotId }),
  now: Date.now,
});
