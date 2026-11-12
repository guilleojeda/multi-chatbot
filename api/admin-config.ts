const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function adminSesClientOptions(region: string) {
  return { region, maxAttempts: 1 };
}

export type AdminLambdaBot = {
  botId: string;
  projectName: string;
  accountTableName: string;
  clientId: string;
  siteUrl: string;
};

export type AdminLambdaConfig = {
  region: string;
  userPoolId: string;
  adminClientId: string;
  adminGroup: string;
  sender: string | null;
  invitationTtlMs: number;
  bots: AdminLambdaBot[];
};

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required Lambda environment variable ${name}.`);
  }
  return value.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSender(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseCatalog(source: string): AdminLambdaBot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("BOT_CATALOG must contain a JSON array.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("BOT_CATALOG must contain at least one chatbot.");
  }

  const bots: AdminLambdaBot[] = [];
  const botIds = new Set<string>();
  const tables = new Set<string>();
  for (const value of parsed) {
    if (
      !isObject(value) ||
      typeof value.botId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.botId) ||
      typeof value.projectName !== "string" ||
      value.projectName.trim() === "" ||
      typeof value.accountTableName !== "string" ||
      value.accountTableName.trim() === "" ||
      typeof value.clientId !== "string" ||
      value.clientId.trim() === "" ||
      typeof value.siteUrl !== "string"
    ) {
      throw new Error("BOT_CATALOG contains an invalid chatbot entry.");
    }

    let site: URL;
    try {
      site = new URL(value.siteUrl);
    } catch {
      throw new Error("BOT_CATALOG contains an invalid chatbot site URL.");
    }
    if (
      site.protocol !== "https:" ||
      site.username !== "" ||
      site.password !== "" ||
      site.search !== "" ||
      site.hash !== ""
    ) {
      throw new Error(
        "BOT_CATALOG chatbot URLs must be HTTPS origins without credentials, query, or fragment.",
      );
    }
    if (botIds.has(value.botId) || tables.has(value.accountTableName)) {
      throw new Error("BOT_CATALOG chatbot IDs and account tables must be unique.");
    }
    botIds.add(value.botId);
    tables.add(value.accountTableName);
    bots.push({
      botId: value.botId,
      projectName: value.projectName.trim(),
      accountTableName: value.accountTableName.trim(),
      clientId: value.clientId.trim(),
      siteUrl: site.toString(),
    });
  }
  return bots;
}

export function parseAdminLambdaConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AdminLambdaConfig {
  const senderValue = environment.INVITATION_SENDER;
  const sender =
    typeof senderValue === "string" && senderValue.trim() !== "" ? senderValue.trim() : null;
  if (sender && !validSender(sender)) {
    throw new Error("INVITATION_SENDER must be an email address when configured.");
  }
  return {
    region: environment.AWS_REGION || environment.AWS_DEFAULT_REGION || "us-east-1",
    userPoolId: required(environment, "USER_POOL_ID"),
    adminClientId: required(environment, "ADMIN_CLIENT_ID"),
    adminGroup: required(environment, "ADMIN_GROUP"),
    sender,
    invitationTtlMs: INVITATION_TTL_MS,
    bots: parseCatalog(required(environment, "BOT_CATALOG")),
  };
}
