import type { AdminLambdaBot } from "./admin-config.js";
import { projectConfig } from "../config/project.js";

export type RecordsApiBotConfig = {
  botId: string;
  recordsIndexName: string;
  testPersonIds: string[];
};

export type RecordsApiConfig = {
  environment: string;
  stateMachineArn: string;
  bots: RecordsApiBotConfig[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required Lambda environment variable ${name}.`);
  }
  return value.trim();
}

function parseRecordsCatalog(source: string, botCatalog: AdminLambdaBot[]): RecordsApiBotConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("RECORDS_CATALOG must contain a JSON array.");
  }
  if (!Array.isArray(parsed) || parsed.length !== botCatalog.length) {
    throw new Error("RECORDS_CATALOG must describe every configured chatbot.");
  }

  const botIds = new Set(botCatalog.map((bot) => bot.botId));
  const seen = new Set<string>();
  const configured: RecordsApiBotConfig[] = [];
  for (const entry of parsed) {
    if (
      !isObject(entry) ||
      typeof entry.botId !== "string" ||
      !botIds.has(entry.botId) ||
      seen.has(entry.botId) ||
      typeof entry.recordsIndexName !== "string" ||
      entry.recordsIndexName.trim() !== entry.recordsIndexName ||
      !/^[A-Za-z0-9_.-]{3,255}$/.test(entry.recordsIndexName) ||
      (entry.testPersonIds !== undefined && !Array.isArray(entry.testPersonIds)) ||
      (Array.isArray(entry.testPersonIds) &&
        entry.testPersonIds.some(
          (sub) =>
            typeof sub !== "string" || sub.length === 0 || sub.trim() !== sub || sub.length > 256,
        )) ||
      (Array.isArray(entry.testPersonIds) &&
        new Set(entry.testPersonIds).size !== entry.testPersonIds.length)
    ) {
      throw new Error("RECORDS_CATALOG contains an invalid chatbot entry.");
    }
    seen.add(entry.botId);
    configured.push({
      botId: entry.botId,
      recordsIndexName: entry.recordsIndexName,
      testPersonIds: Array.isArray(entry.testPersonIds)
        ? ([...entry.testPersonIds] as string[])
        : [],
    });
  }
  if (seen.size !== botIds.size) {
    throw new Error("RECORDS_CATALOG must describe every configured chatbot.");
  }
  return configured;
}

export function parseRecordsApiConfig(
  botCatalog: AdminLambdaBot[],
  environment: NodeJS.ProcessEnv = process.env,
): RecordsApiConfig {
  const stage = required(environment, "ENVIRONMENT");
  if (stage !== "dev" && stage !== "prod") {
    throw new Error("ENVIRONMENT must identify a configured deployment stage.");
  }
  const stateMachineArn = required(environment, "RECORDS_EXPORT_STATE_MACHINE_ARN");
  const match = /^arn:[^:]+:states:([^:]+):([0-9]{12}):stateMachine:([A-Za-z0-9_-]+)$/.exec(
    stateMachineArn,
  );
  if (
    !match ||
    match[1] !== projectConfig.region ||
    match[2] !== projectConfig.account ||
    match[3] !== `multi-chatbot-${stage}-admin-records-export`
  ) {
    throw new Error(
      "RECORDS_EXPORT_STATE_MACHINE_ARN must identify this environment's export workflow.",
    );
  }
  return {
    environment: stage,
    stateMachineArn,
    bots: parseRecordsCatalog(required(environment, "RECORDS_CATALOG"), botCatalog),
  };
}
