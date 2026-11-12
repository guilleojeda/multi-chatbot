import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { createPhase9AccountTransport } from "../support/phase9-account-transport.mjs";

const aws = vi.hoisted(() => ({
  stacks: new Map(),
  cloudFormationConfigs: [],
  cloudFormationCommands: [],
  cognitoConfigs: [],
  cognitoCommands: [],
  sesConfigs: [],
  sesCommands: [],
  transport: null,
  existingUser: null,
  messageId: "ses-accepted-message",
}));

// Only AWS service clients are substituted; scripts/invite.mjs and its dist application modules run directly.
vi.mock("@aws-sdk/client-cloudformation", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    CloudFormationClient: class {
      constructor(config) {
        aws.cloudFormationConfigs.push(config);
      }

      async send(command) {
        aws.cloudFormationCommands.push(command);
        if (!(command instanceof actual.DescribeStacksCommand)) {
          throw new Error(`Unexpected CloudFormation command: ${command.constructor.name}`);
        }
        const outputs = aws.stacks.get(command.input.StackName);
        return outputs ? { Stacks: [{ Outputs: outputs }] } : { Stacks: [] };
      }
    },
  };
});

vi.mock("@aws-sdk/client-cognito-identity-provider", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    CognitoIdentityProviderClient: class {
      constructor(config) {
        aws.cognitoConfigs.push(config);
      }

      async send(command) {
        aws.cognitoCommands.push(command);
        if (command instanceof actual.AdminGetUserCommand) return aws.existingUser;
        throw new Error(`Unexpected Cognito command: ${command.constructor.name}`);
      }
    },
  };
});

vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    SESv2Client: class {
      constructor(config) {
        aws.sesConfigs.push(config);
      }

      async send(command) {
        aws.sesCommands.push(command);
        if (!(command instanceof actual.SendEmailCommand)) {
          throw new Error(`Unexpected SES command: ${command.constructor.name}`);
        }
        return { MessageId: aws.messageId };
      }
    },
  };
});

vi.mock("@aws-sdk/lib-dynamodb", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DynamoDBDocumentClient: class {
      static from() {
        return aws.transport.documentClient;
      }
    },
  };
});

const accountStack = "multi-chatbot-dev-docentes-account";
const siteStack = "multi-chatbot-dev-docentes-site";
const region = "us-east-1";
const email = "teacher@example.test";
const sender = "sxvintage@gmail.com";
const sub = "existing-teacher-sub";
const userPoolId = "us-east-1_devPool";
const clientId = "dev-chat-client";
const tableName = "dev-docentes-account";
const siteUrl = "https://docentes.dev.example.test";

function outputs(entries) {
  return entries.map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));
}

function resetAwsHarness() {
  aws.stacks.clear();
  aws.cloudFormationConfigs.length = 0;
  aws.cloudFormationCommands.length = 0;
  aws.cognitoConfigs.length = 0;
  aws.cognitoCommands.length = 0;
  aws.sesConfigs.length = 0;
  aws.sesCommands.length = 0;
  aws.transport = createPhase9AccountTransport();
  aws.existingUser = {
    UserAttributes: [
      { Name: "sub", Value: sub },
      { Name: "email", Value: email },
      { Name: "email_verified", Value: "true" },
    ],
    UserStatus: "CONFIRMED",
  };
  aws.stacks.set(
    accountStack,
    outputs([
      ["UserPoolId", userPoolId],
      ["ClientId", clientId],
      ["TableName", tableName],
      ["BotId", "docentes"],
    ]),
  );
  aws.stacks.set(siteStack, outputs([["PublicSiteUrl", siteUrl]]));
}

afterEach(() => {
  vi.restoreAllMocks();
  resetAwsHarness();
});

describe("scripts/invite.mjs bootstrap", () => {
  it("uses dev outputs and the real invitation flow to register ACCESS/INVITE and send to the selected bot", async () => {
    resetAwsHarness();
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    let stdout = "";
    let stderr = "";
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk, encoding) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding || "utf8");
      return true;
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk, encoding) => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding || "utf8");
      return true;
    });
    process.argv = [
      process.execPath,
      "scripts/invite.mjs",
      "--environment",
      "dev",
      "--email",
      email,
      "--sender",
      sender,
      "--region",
      region,
      "--account-stack",
      accountStack,
      "--site-stack",
      siteStack,
    ];
    process.exitCode = 0;

    try {
      await import("../../scripts/invite.mjs");

      expect(process.exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("Invitation email accepted by SES.");
      expect(stdout).toContain("bot=docentes");
      expect(stdout).toContain(`messageId=${aws.messageId}`);
      expect(aws.cloudFormationConfigs).toEqual([{ region }]);
      expect(aws.cloudFormationCommands).toHaveLength(2);
      expect(
        aws.cloudFormationCommands.every((command) => command instanceof DescribeStacksCommand),
      ).toBe(true);
      expect(aws.cloudFormationCommands.map((command) => command.input.StackName)).toEqual([
        accountStack,
        siteStack,
      ]);

      expect(aws.cognitoConfigs).toEqual([{ region }]);
      expect(aws.cognitoCommands.length).toBeGreaterThan(0);
      expect(aws.cognitoCommands.every((command) => command instanceof AdminGetUserCommand)).toBe(
        true,
      );
      expect(
        aws.cognitoCommands.every(
          (command) => command.input.UserPoolId === userPoolId && command.input.Username === email,
        ),
      ).toBe(true);
      expect(
        aws.cognitoCommands.some(
          (command) =>
            command instanceof AdminCreateUserCommand ||
            command instanceof AdminSetUserPasswordCommand ||
            command instanceof AdminUpdateUserAttributesCommand,
        ),
      ).toBe(false);

      expect(aws.sesConfigs).toEqual([{ region, maxAttempts: 1 }]);
      expect(aws.sesCommands).toHaveLength(1);
      expect(aws.sesCommands[0]).toBeInstanceOf(SendEmailCommand);
      const mail = aws.sesCommands[0].input;
      expect(mail.FromEmailAddress).toBe(sender);
      expect(mail.Destination.ToAddresses).toEqual([email]);
      expect(mail.Content.Simple.Subject.Data).toContain("Asistente para docentes");
      expect(aws.messageId).toBeTruthy();

      const emailBody = mail.Content.Simple.Body.Text.Data;
      expect(emailBody).toContain("Asistente para docentes");
      const siteOrigin = new URL(siteUrl).origin;
      const invitationLink = emailBody
        .split(/\r?\n/)
        .find((line) => line.startsWith(`${siteOrigin}/#/invite?`));
      expect(invitationLink).toBeTruthy();
      const url = new URL(invitationLink);
      expect(url.origin).toBe(siteOrigin);
      expect(url.pathname).toBe("/");
      expect(url.hash.startsWith("#/invite?")).toBe(true);
      const token = new URLSearchParams(url.hash.slice("#/invite?".length)).get("token");
      expect(token).toBeTruthy();
      expect(stdout).not.toContain(token);
      expect(stdout).not.toContain(siteOrigin);
      expect(stdout).not.toMatch(/token=|tokenHash|INVITE#[a-f0-9]{64}/i);

      const items = aws.transport.items();
      const access = items.find((item) => item.sk === "ACCESS");
      const invitation = items.find((item) => item.sk === "INVITATION");
      expect(access).toMatchObject({
        pk: `BOT#docentes#USER#${sub}`,
        sk: "ACCESS",
        sub,
        botId: "docentes",
        access: "none",
        revision: 1,
      });
      expect(invitation).toMatchObject({
        sk: "INVITATION",
        botId: "docentes",
        sub,
        email,
        expiresAt: expect.any(Number),
      });
      expect(invitation.pk).toMatch(/^INVITE#[a-f0-9]{64}$/);
      const tokenHash = createHash("sha256").update(token).digest("hex");
      expect(invitation.tokenHash).toBe(tokenHash);
      expect(invitation).not.toHaveProperty("token");
      expect(access.currentInvitation.hash).toBe(tokenHash);
      expect(items).toHaveLength(2);
      expect(
        items.some(
          (item) =>
            item.pk.startsWith("MEMBER#") ||
            item.sk.startsWith("MEMBER#") ||
            item.sk === "PENDING_INVITATION",
        ),
      ).toBe(false);
      const tableNames = aws.transport.commands.flatMap((command) =>
        command.input.TransactItems
          ? command.input.TransactItems.map((operation) => Object.values(operation)[0].TableName)
          : [command.input.TableName],
      );
      expect(tableNames.length).toBeGreaterThan(0);
      expect(new Set(tableNames)).toEqual(new Set([tableName]));
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
    }
  });
});
