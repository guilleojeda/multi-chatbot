import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { createAccountStoreAdapter } from "../api/aws-adapters.js";
import { createProfileStoreAdapter } from "../api/profile-store.js";
import { siteConfig } from "../config/site.js";
import { createChatHandler } from "./chat.js";
import { createConversationStoreAdapter } from "./conversation-store.js";
import { createStrandsGenerator } from "./provider.js";

const approvedModelId = "global.anthropic.claude-sonnet-4-6";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const botId = requiredEnv("BOT_ID");
const accountTableName = requiredEnv("ACCOUNT_TABLE_NAME");
const conversationTableName = requiredEnv("CONVERSATION_TABLE_NAME");
const modelId = requiredEnv("MODEL_ID");
const revision = requiredEnv("REVISION");
const region = requiredEnv("AWS_REGION");
if (modelId !== approvedModelId) throw new Error("Unsupported model configuration.");

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const accounts = createAccountStoreAdapter({ documentClient, tableName: accountTableName });
const profiles = createProfileStoreAdapter({ documentClient, tableName: accountTableName });
const store = createConversationStoreAdapter({
  documentClient,
  tableName: conversationTableName,
});
const generate = createStrandsGenerator({ region });
const chat = createChatHandler({
  config: {
    botId,
    profile: siteConfig.profile,
    modelId,
    revision,
    systemPrompt:
      "Ayudá en español con tareas de enseñanza, consultas de información y preparación de materiales. Usá conocimiento general. No tenés acceso a la web ni a archivos: si te piden consultar una fuente actual o un documento, explicá que no podés acceder y ofrecé ayudar con conocimiento general cuando sea útil. No afirmes haber consultado fuentes, archivos ni documentos del proyecto; tampoco inventes citas. Si falta un dato indispensable, preguntá antes de asumir; si alcanza para responder, indicá brevemente cualquier supuesto relevante. Si hay discrepancias relevantes, explicalas con claridad y sin presentar conclusiones discutibles como indiscutibles.",
  },
  accounts,
  profiles,
  store,
  generate,
  now: Date.now,
  newQueryId: () => crypto.randomUUID(),
});

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process(payload, context) {
      const events = chat(payload, context);
      return (async function* () {
        for await (const event of events) {
          yield { event: event.type, data: event };
        }
      })();
    },
  },
  config: { logging: { enabled: false } },
});

app.run();
