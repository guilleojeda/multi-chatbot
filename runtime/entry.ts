import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import type { ContentTypeParserConfig } from "bedrock-agentcore/runtime";
import { createAccountStoreAdapter } from "../api/aws-adapters.js";
import { createProfileStoreAdapter } from "../api/profile-store.js";
import { siteConfig } from "../config/site.js";
import { createChatHandler, createChatInvocationHandler } from "./chat.js";
import { createConversationStoreAdapter } from "./conversation-store.js";
import { createBedrockTokenCounter, createStrandsGenerator } from "./provider.js";

const approvedModelId = "global.anthropic.claude-sonnet-4-6";
type JsonParserRequest = Parameters<ContentTypeParserConfig["parser"]>[0];
type JsonParserCallback = NonNullable<Parameters<ContentTypeParserConfig["parser"]>[2]>;

function parseApplicationJson(
  request: JsonParserRequest,
  body: string | Buffer,
  done: JsonParserCallback,
): void {
  if (typeof body !== "string") {
    done(new TypeError("Expected an application/json string body."));
    return;
  }
  request.server.getDefaultJsonParser("error", "error")(request, body, done);
}

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
const countInputTokens = createBedrockTokenCounter({ region });
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
  countInputTokens,
  generate,
  now: Date.now,
});

const runtimeApp: { instance?: BedrockAgentCoreApp } = {};
const taskRegistry = {
  addAsyncTask(name: string, metadata?: Record<string, unknown>): number {
    if (!runtimeApp.instance) throw new Error("Runtime task registry is not initialized.");
    return runtimeApp.instance.addAsyncTask(name, metadata);
  },
  completeAsyncTask(taskId: number): boolean {
    if (!runtimeApp.instance) throw new Error("Runtime task registry is not initialized.");
    return runtimeApp.instance.completeAsyncTask(taskId);
  },
};

const app = new BedrockAgentCoreApp({
  invocationHandler: createChatInvocationHandler(chat, taskRegistry),
  config: {
    logging: { enabled: false },
    contentTypeParsers: [
      {
        contentType: "application/json",
        parseAs: "string",
        bodyLimit: 32 * 1024 * 1024,
        parser: parseApplicationJson,
      },
    ],
  },
});

runtimeApp.instance = app;
app.run();
