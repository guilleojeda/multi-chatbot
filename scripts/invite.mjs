#!/usr/bin/env node

import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { randomBytes } from "node:crypto";
import { siteConfig } from "../dist/config/site.js";
import { projectConfig } from "../dist/config/project.js";
import {
  createAccountStoreAdapter,
  createCognitoIdentityAdapter,
  createSesInvitationMailer,
} from "../dist/api/aws-adapters.js";
import { provisionInvitation } from "../dist/api/invitations.js";

const invitationTtlMs = 7 * 24 * 60 * 60 * 1000;
const approvedSender = "sxvintage@gmail.com";

class OperatorError extends Error {}

function usage() {
  return [
    "Usage: node scripts/invite.mjs --environment dev --email person@example.com --sender sxvintage@gmail.com",
    "Optional: --region us-east-1 --account-stack STACK --site-stack STACK",
  ].join("\n");
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--help" || name === "-h") return { help: true };
    if (!name.startsWith("--")) throw new Error("Options must start with --.");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
    if (values.has(name)) throw new Error(`Option ${name} was provided more than once.`);
    values.set(name, value);
    index += 1;
  }

  const allowed = new Set([
    "--environment",
    "--email",
    "--sender",
    "--region",
    "--account-stack",
    "--site-stack",
  ]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown option ${name}.`);
  }

  const environment = values.get("--environment") || "dev";
  const email = values.get("--email")?.trim().toLowerCase();
  const sender = values.get("--sender")?.trim().toLowerCase();
  const region =
    values.get("--region") ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    projectConfig.region;
  if (environment !== "dev" && environment !== "prod") {
    throw new Error("Environment must be dev or prod.");
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Provide a valid recipient with --email.");
  }
  if (!sender || sender !== approvedSender) {
    throw new Error(`Provide the approved sender with --sender ${approvedSender}.`);
  }

  const stackPrefix = `multi-chatbot-${environment}-${siteConfig.botId}`;
  return {
    environment,
    email,
    sender,
    region,
    accountStack: values.get("--account-stack") || `${stackPrefix}-account`,
    siteStack: values.get("--site-stack") || `${stackPrefix}-site`,
  };
}

async function readStackOutputs(client, stackName) {
  const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = response.Stacks?.[0];
  if (!stack) throw new OperatorError(`CloudFormation stack ${stackName} was not found.`);
  return new Map(
    (stack.Outputs || []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]),
  );
}

function requiredOutput(outputs, name, stackName) {
  const value = outputs.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new OperatorError(`Stack ${stackName} is missing the ${name} output.`);
  }
  return value;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Invalid command options."}\n${usage()}\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  try {
    const cloudFormation = new CloudFormationClient({ region: options.region });
    const accountOutputs = await readStackOutputs(cloudFormation, options.accountStack);
    const siteOutputs = await readStackOutputs(cloudFormation, options.siteStack);
    const userPoolId = requiredOutput(accountOutputs, "UserPoolId", options.accountStack);
    const clientId = requiredOutput(accountOutputs, "ClientId", options.accountStack);
    const tableName = requiredOutput(accountOutputs, "TableName", options.accountStack);
    const outputBotId = accountOutputs.get("BotId");
    if (outputBotId && outputBotId !== siteConfig.botId) {
      throw new OperatorError(
        "The account stack bot does not match this checkout's site configuration.",
      );
    }
    const siteUrl = requiredOutput(siteOutputs, "PublicSiteUrl", options.siteStack);
    const cognitoClient = new CognitoIdentityProviderClient({ region: options.region });
    const dynamoClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: options.region }),
      {
        marshallOptions: { removeUndefinedValues: true },
      },
    );
    const sesClient = new SESv2Client({ region: options.region });
    const identity = createCognitoIdentityAdapter({
      client: cognitoClient,
      userPoolId,
      clientId,
      region: options.region,
    });
    const store = createAccountStoreAdapter({ documentClient: dynamoClient, tableName });
    const mail = createSesInvitationMailer(sesClient);

    const result = await provisionInvitation(
      {
        config: {
          botId: siteConfig.botId,
          projectName: siteConfig.projectName,
          siteUrl,
          sender: options.sender,
          invitationTtlMs,
        },
        identity,
        store,
        mail,
        now: Date.now,
        randomBytes,
      },
      { email: options.email },
    );

    process.stdout.write(
      [
        "Invitation email accepted by SES.",
        `bot=${result.botId}`,
        `sub=${result.sub}`,
        `expiresAt=${new Date(result.expiresAt).toISOString()}`,
        ...(result.messageId ? [`messageId=${result.messageId}`] : []),
      ].join(" ") + "\n",
    );
  } catch (error) {
    if (error instanceof OperatorError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      const errorName =
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        typeof error.name === "string" &&
        /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
          ? ` (${error.name})`
          : "";
      process.stderr.write(
        `Invitation could not be sent${errorName}. Check the stack outputs, AWS permissions, and SES sender and recipient verification, then retry. No delivery is confirmed.\n`,
      );
    }
    process.exitCode = 1;
  }
}

await main();
