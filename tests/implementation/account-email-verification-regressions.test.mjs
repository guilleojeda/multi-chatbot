import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  GetUserCommand,
  UpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { createAccountHandler } from "../../api/account.ts";
import { createCognitoIdentityAdapter } from "../../api/aws-adapters.ts";

const invitedEmail = "teacher@example.test";
const changedEmail = "unproved@example.test";
const userSub = "invited-user-123";
const botId = "bot-aurora";
const invitationToken = "token-from-the-invitation-link";
const invitationHash = createHash("sha256").update(invitationToken).digest("hex");
const accessToken = `header.${Buffer.from(
  JSON.stringify({
    iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool",
    client_id: "public-client",
    token_use: "access",
    sub: userSub,
    exp: 10_000,
  }),
).toString("base64url")}.signature`;

function userAttributes(user) {
  return [
    { Name: "sub", Value: user.sub },
    { Name: "email", Value: user.email },
    { Name: "email_verified", Value: String(user.emailVerified) },
  ];
}

async function acceptDuringConcurrentEmailChange(kind) {
  const user = {
    sub: userSub,
    email: invitedEmail,
    emailVerified: false,
    status: kind === "new" ? "FORCE_CHANGE_PASSWORD" : "CONFIRMED",
    password: kind === "new" ? null : "password-set-before-interruption",
  };
  const sentCommands = [];
  const access = {
    sub: userSub,
    botId,
    access: "none",
    revision: 1,
    currentInvitation: { hash: invitationHash, expiresAt: 2_000_000 },
    ...(kind === "partial"
      ? { activationClaim: { invitationHash, claimedAt: "2026-10-28T00:00:00.000Z" } }
      : {}),
  };
  const invitation = {
    id: invitationHash,
    tokenHash: invitationHash,
    sub: userSub,
    email: invitedEmail,
    botId,
    expiresAt: 2_000_000,
    operationId: "operation-1",
    delivery: { status: "unconfirmed" },
  };

  const client = {
    async send(command) {
      sentCommands.push(command);

      if (command instanceof AdminGetUserCommand) {
        return { UserStatus: user.status, UserAttributes: userAttributes(user) };
      }

      if (command instanceof AdminSetUserPasswordCommand) {
        user.status = "CONFIRMED";
        user.password = command.input.Password;
        // The new user can authenticate with the permanent password and update email
        // before the handler's following privileged verification request.
        await client.send(
          new UpdateUserAttributesCommand({
            AccessToken: accessToken,
            UserAttributes: [{ Name: "email", Value: changedEmail }],
          }),
        );
        return {};
      }

      if (command instanceof GetUserCommand) {
        const attestedAttributes = userAttributes(user);
        // Return the authenticated invited identity while a concurrent native update
        // changes the current attribute before account acceptance continues.
        await client.send(
          new UpdateUserAttributesCommand({
            AccessToken: command.input.AccessToken,
            UserAttributes: [{ Name: "email", Value: changedEmail }],
          }),
        );
        return { UserAttributes: attestedAttributes };
      }

      if (command instanceof UpdateUserAttributesCommand) {
        for (const attribute of command.input.UserAttributes || []) {
          if (attribute.Name === "email") {
            user.email = attribute.Value;
            user.emailVerified = false;
          }
        }
        return {};
      }

      if (command instanceof AdminUpdateUserAttributesCommand) {
        for (const attribute of command.input.UserAttributes || []) {
          if (attribute.Name === "email") user.email = attribute.Value;
          if (attribute.Name === "email_verified") user.emailVerified = attribute.Value === "true";
        }
        return {};
      }

      throw new Error(`Unexpected Cognito command: ${command.constructor.name}`);
    },
  };

  const identity = createCognitoIdentityAdapter({
    client,
    userPoolId: "us-east-1_testpool",
    clientId: "public-client",
    region: "us-east-1",
    now: () => 1_000_000,
  });
  const store = {
    async getInvitation(tokenHash) {
      return tokenHash === invitationHash ? { ...invitation } : null;
    },
    async getAccess({ sub, botId: requestedBotId }) {
      return sub === userSub && requestedBotId === botId ? { ...access } : null;
    },
    async reserveActivation({ sub, botId: requestedBotId, tokenHash }) {
      if (
        sub !== userSub ||
        requestedBotId !== botId ||
        tokenHash !== invitationHash ||
        access.activationClaim
      )
        return false;
      access.activationClaim = {
        invitationHash,
        claimedAt: new Date(1_000_000).toISOString(),
      };
      access.revision += 1;
      return true;
    },
    async releaseActivation({ sub, botId: requestedBotId, tokenHash }) {
      if (
        sub === userSub &&
        requestedBotId === botId &&
        access.activationClaim?.invitationHash === tokenHash
      ) {
        delete access.activationClaim;
        access.revision += 1;
      }
    },
    async consumeInvitation({ sub, botId: requestedBotId, tokenHash }) {
      if (
        sub !== userSub ||
        requestedBotId !== botId ||
        tokenHash !== invitationHash ||
        invitation.usedAt ||
        access.currentInvitation?.hash !== tokenHash
      )
        return false;
      invitation.usedAt = new Date(1_000_000).toISOString();
      access.access = "active";
      access.revision += 1;
      delete access.currentInvitation;
      if (access.activationClaim?.invitationHash === tokenHash) delete access.activationClaim;
      return true;
    },
  };
  const handler = createAccountHandler({
    config: { botId },
    identity,
    store,
    now: () => 1_000_000,
  });

  const response = await handler({
    requestContext: {
      http: { method: "POST", path: "/api/account/invitations/accept" },
    },
    headers: kind === "partial" ? { authorization: `Bearer ${accessToken}` } : {},
    body: JSON.stringify({
      token: invitationToken,
      ...(kind === "new" ? { password: "Correct-Horse-42!" } : {}),
    }),
  });

  return { response, user, access, sentCommands };
}

describe("email verification while accepting invitations", () => {
  it.each(["new", "partial"])(
    "keeps the invitation email as the verified address for a %s account despite a concurrent native change",
    async (kind) => {
      const result = await acceptDuringConcurrentEmailChange(kind);

      expect(result.response.statusCode).toBe(200);
      expect(JSON.parse(result.response.body)).toEqual({ status: "accepted" });
      expect(result.user.email).toBe(invitedEmail);
      expect(result.user.emailVerified).toBe(true);
      expect(result.user.status).toBe("CONFIRMED");
      expect(result.access.access).toBe("active");
      if (kind === "new") {
        expect(result.user.password).toBe("Correct-Horse-42!");
        expect(
          result.sentCommands.some((command) => command instanceof AdminSetUserPasswordCommand),
        ).toBe(true);
      } else {
        expect(result.user.password).toBe("password-set-before-interruption");
        expect(
          result.sentCommands.some((command) => command instanceof AdminSetUserPasswordCommand),
        ).toBe(false);
      }

      const update = result.sentCommands.find(
        (command) => command instanceof AdminUpdateUserAttributesCommand,
      );
      expect(update?.input).toMatchObject({
        Username: userSub,
        UserAttributes: [
          { Name: "email", Value: invitedEmail },
          { Name: "email_verified", Value: "true" },
        ],
      });
    },
  );
});
