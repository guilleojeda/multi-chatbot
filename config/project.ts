const account = "118903272638";
const region = "us-east-1";

export const projectConfig = {
  account,
  region,
  initialModelId: "anthropic.claude-sonnet-4-6",
  desiredModelIds: ["anthropic.claude-haiku-5-5", "openai.gpt-6-luna"],
} as const;

export type EnvironmentName = "dev" | "prod";
export type ResolvedEnvironment = {
  account: typeof projectConfig.account;
  region: typeof projectConfig.region;
  environment: EnvironmentName;
  resourcePrefix: string;
  tags: { environment: EnvironmentName };
  initialModelId: typeof projectConfig.initialModelId;
};
export type ResolvedBotEnvironment = ResolvedEnvironment & {
  botId: string;
  botResourcePrefix: string;
};

const environmentPrefixes: Record<EnvironmentName, string> = {
  dev: "multi-chatbot-dev",
  prod: "multi-chatbot-prod",
};

const botIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function resolveEnvironment(
  environment: string,
  botId?: string,
): ResolvedEnvironment | ResolvedBotEnvironment {
  let resolvedName: EnvironmentName;
  if (environment === "dev") {
    resolvedName = "dev";
  } else if (environment === "prod") {
    resolvedName = "prod";
  } else {
    throw new Error(`Unknown environment: ${environment}`);
  }

  if (botId !== undefined && (typeof botId !== "string" || !botIdPattern.test(botId))) {
    throw new Error(
      `Invalid botId: ${botId}. Use 1-32 lowercase letters, digits, or interior hyphens.`,
    );
  }

  const resourcePrefix = environmentPrefixes[resolvedName];
  const resolved: ResolvedEnvironment = {
    account,
    region,
    environment: resolvedName,
    resourcePrefix,
    tags: { environment: resolvedName },
    initialModelId: projectConfig.initialModelId,
  };

  if (botId === undefined) return resolved;

  return {
    ...resolved,
    botId,
    botResourcePrefix: `${resourcePrefix}-${botId}`,
  };
}
