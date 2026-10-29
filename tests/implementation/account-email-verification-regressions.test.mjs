import { describe, expect, it } from "vitest";
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
  const memberships = new Set();
  let invitationReserved = kind === "partial";

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
    async getInvitation() {
      return {
        id: "invitation-123",
        sub: userSub,
        email: invitedEmail,
        botId,
        expiresAt: 2_000_000,
        ...(kind === "partial" ? { reservedAt: "2026-10-28T00:00:00.000Z" } : {}),
      };
    },
    async reserveInvitation({ sub, botId: requestedBotId }) {
      if (sub !== userSub || requestedBotId !== botId || invitationReserved) return false;
      invitationReserved = true;
      return true;
    },
    async releaseInvitation() {
      invitationReserved = false;
    },
    async useInvitationAndAddMember({ sub, botId: requestedBotId }) {
      if (sub !== userSub || requestedBotId !== botId || !invitationReserved) return false;
      memberships.add(`${requestedBotId}:${sub}`);
      invitationReserved = false;
      return true;
    },
    async hasMember({ sub, botId: requestedBotId }) {
      return memberships.has(`${requestedBotId}:${sub}`);
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

  return { response, user, memberships, sentCommands };
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
      expect(result.memberships).toEqual(new Set([`${botId}:${userSub}`]));
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
