import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  GetUserCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import type { InvitationUser } from "./invitations.js";

type CognitoUser = {
  sub: string;
  email: string;
  emailVerified: boolean;
  status?: string;
};

type DbInvitation = {
  id: string;
  tokenHash: string;
  botId: string;
  sub: string;
  email: string;
  kind?: "new" | "existing";
  expiresAt: number;
  usedAt?: string | null;
  reservedAt?: string | number | null;
};

type TableOptions = { tableName: string; now?: () => number };

function attributesToMap(attributes: { Name?: string; Value?: string }[] | undefined) {
  const values = new Map<string, string>();
  for (const attribute of attributes || []) {
    if (attribute.Name && attribute.Value !== undefined)
      values.set(attribute.Name, attribute.Value);
  }
  return values;
}

function cognitoUser(
  attributes: { Name?: string; Value?: string }[] | undefined,
  status?: string,
): CognitoUser {
  const values = attributesToMap(attributes);
  const sub = values.get("sub");
  const email = values.get("email");
  if (!sub || !email)
    throw new Error("Cognito returned an account without its required identity attributes.");
  return {
    sub,
    email,
    emailVerified: values.get("email_verified") === "true",
    ...(status ? { status } : {}),
  };
}

function jwtClaims(accessToken: string): Record<string, unknown> | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cognitoNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "UserNotFoundException"
  );
}

function invalidAccessToken(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    ["NotAuthorizedException", "InvalidParameterException"].includes(
      String((error as { name?: unknown }).name),
    )
  );
}

export function createCognitoIdentityAdapter(input: {
  client: CognitoIdentityProviderClient;
  userPoolId: string;
  clientId: string;
  region: string;
  now?: () => number;
}) {
  const { client, userPoolId, clientId, region } = input;
  const now = input.now || Date.now;
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;

  return {
    async getUserByEmail(email: string): Promise<CognitoUser | null> {
      try {
        const result = await client.send(
          new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }),
        );
        return cognitoUser(result.UserAttributes, result.UserStatus);
      } catch (error) {
        if (cognitoNotFound(error)) return null;
        throw error;
      }
    },

    async createUser(input: { email: string; messageAction: "SUPPRESS" }): Promise<InvitationUser> {
      const result = await client.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: input.email,
          MessageAction: input.messageAction,
          UserAttributes: [
            { Name: "email", Value: input.email },
            { Name: "email_verified", Value: "false" },
          ],
        }),
      );
      return cognitoUser(result.User?.Attributes, result.User?.UserStatus);
    },

    async getCaller(accessToken: string) {
      const claims = jwtClaims(accessToken);
      if (
        claims?.iss !== issuer ||
        claims.client_id !== clientId ||
        claims.token_use !== "access" ||
        typeof claims.sub !== "string" ||
        typeof claims.exp !== "number" ||
        claims.exp * 1000 <= now()
      ) {
        return null;
      }

      try {
        const result = await client.send(new GetUserCommand({ AccessToken: accessToken }));
        const user = cognitoUser(result.UserAttributes);
        if (user.sub !== claims.sub) return null;
        return { sub: user.sub, email: user.email, token_use: "access" as const };
      } catch (error) {
        if (invalidAccessToken(error)) return null;
        throw error;
      }
    },

    async setPermanentPassword(input: { sub: string; password: string }): Promise<void> {
      await client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: input.sub,
          Password: input.password,
          Permanent: true,
        }),
      );
    },

    async markEmailVerified(input: { sub: string }): Promise<void> {
      await client.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: input.sub,
          UserAttributes: [{ Name: "email_verified", Value: "true" }],
        }),
      );
    },
  };
}

function inviteKey(tokenHash: string) {
  return { pk: `INVITE#${tokenHash}`, sk: "INVITATION" };
}

function memberKey(botId: string, sub: string) {
  return { pk: `BOT#${botId}`, sk: `MEMBER#${sub}` };
}

function pendingKey(botId: string, sub: string) {
  return { pk: `BOT#${botId}#USER#${sub}`, sk: "PENDING_INVITATION" };
}

function mapInvitation(value: Record<string, unknown> | undefined): DbInvitation | null {
  if (
    !value ||
    typeof value.tokenHash !== "string" ||
    typeof value.botId !== "string" ||
    typeof value.sub !== "string" ||
    typeof value.email !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    return null;
  }
  return {
    id: typeof value.id === "string" ? value.id : value.tokenHash,
    tokenHash: value.tokenHash,
    botId: value.botId,
    sub: value.sub,
    email: value.email,
    ...(value.kind === "new" || value.kind === "existing" ? { kind: value.kind } : {}),
    expiresAt: value.expiresAt,
    ...(typeof value.usedAt === "string" ? { usedAt: value.usedAt } : {}),
    ...(typeof value.reservedAt === "string" || typeof value.reservedAt === "number"
      ? { reservedAt: value.reservedAt }
      : {}),
  };
}

function conditionalFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ConditionalCheckFailedException"
  );
}

function transactionCanceled(error: unknown): error is Record<string, unknown> {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  return (error as { name?: unknown }).name === "TransactionCanceledException";
}

function invitationConditionFailed(error: Record<string, unknown>): boolean {
  const reasons = error.CancellationReasons;
  const first = Array.isArray(reasons) ? reasons[0] : undefined;
  return (
    typeof first === "object" &&
    first !== null &&
    "Code" in first &&
    (first as { Code?: unknown }).Code === "ConditionalCheckFailed"
  );
}

function hasCancellationReasons(error: Record<string, unknown>): boolean {
  return Array.isArray(error.CancellationReasons) && error.CancellationReasons.length > 0;
}

export function createAccountStoreAdapter({
  documentClient,
  tableName,
  now = Date.now,
}: {
  documentClient: DynamoDBDocumentClient;
} & TableOptions) {
  return {
    async getInvitation(tokenHash: string): Promise<DbInvitation | null> {
      const result = await documentClient.send(
        new GetCommand({ TableName: tableName, Key: inviteKey(tokenHash), ConsistentRead: true }),
      );
      return mapInvitation(result.Item);
    },

    async reserveInvitation(input: {
      invitationId: string;
      sub: string;
      botId: string;
    }): Promise<boolean> {
      try {
        await documentClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: inviteKey(input.invitationId),
            UpdateExpression: "SET #reservedAt = :reservedAt",
            ConditionExpression:
              "attribute_exists(pk) AND #sub = :sub AND #botId = :botId AND attribute_not_exists(usedAt) AND attribute_not_exists(#reservedAt)",
            ExpressionAttributeNames: {
              "#reservedAt": "reservedAt",
              "#sub": "sub",
              "#botId": "botId",
            },
            ExpressionAttributeValues: {
              ":reservedAt": new Date(now()).toISOString(),
              ":sub": input.sub,
              ":botId": input.botId,
            },
          }),
        );
        return true;
      } catch (error) {
        if (conditionalFailure(error)) return false;
        throw error;
      }
    },

    async releaseInvitation(input: {
      invitationId: string;
      sub: string;
      botId: string;
    }): Promise<void> {
      try {
        await documentClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: inviteKey(input.invitationId),
            UpdateExpression: "REMOVE #reservedAt",
            ConditionExpression:
              "attribute_exists(pk) AND #sub = :sub AND #botId = :botId AND attribute_not_exists(usedAt)",
            ExpressionAttributeNames: {
              "#reservedAt": "reservedAt",
              "#sub": "sub",
              "#botId": "botId",
            },
            ExpressionAttributeValues: { ":sub": input.sub, ":botId": input.botId },
          }),
        );
      } catch (error) {
        if (conditionalFailure(error)) return;
        throw error;
      }
    },

    async useInvitationAndAddMember(input: {
      invitationId: string;
      sub: string;
      botId: string;
    }): Promise<boolean> {
      const usedAt = new Date(now()).toISOString();
      try {
        await documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: tableName,
                  Key: inviteKey(input.invitationId),
                  UpdateExpression: "SET usedAt = :usedAt REMOVE reservedAt",
                  ConditionExpression:
                    "attribute_exists(pk) AND #sub = :sub AND #botId = :botId AND attribute_exists(reservedAt) AND attribute_not_exists(usedAt)",
                  ExpressionAttributeNames: { "#sub": "sub", "#botId": "botId" },
                  ExpressionAttributeValues: {
                    ":sub": input.sub,
                    ":botId": input.botId,
                    ":usedAt": usedAt,
                  },
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    ...memberKey(input.botId, input.sub),
                    sub: input.sub,
                    botId: input.botId,
                  },
                  ConditionExpression:
                    "attribute_not_exists(pk) OR (#sub = :sub AND #botId = :botId)",
                  ExpressionAttributeNames: { "#sub": "sub", "#botId": "botId" },
                  ExpressionAttributeValues: {
                    ":sub": input.sub,
                    ":botId": input.botId,
                  },
                },
              },
            ],
          }),
        );
        return true;
      } catch (error) {
        if (transactionCanceled(error)) {
          if (invitationConditionFailed(error)) return false;
          if (!hasCancellationReasons(error)) {
            try {
              const current = await documentClient.send(
                new GetCommand({
                  TableName: tableName,
                  Key: inviteKey(input.invitationId),
                  ConsistentRead: true,
                }),
              );
              const invitation = mapInvitation(current.Item);
              if (
                invitation?.usedAt &&
                invitation.sub === input.sub &&
                invitation.botId === input.botId
              ) {
                return false;
              }
            } catch {
              throw error;
            }
          }
        }
        throw error;
      }
    },

    async hasMember(input: { sub: string; botId: string }): Promise<boolean> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: memberKey(input.botId, input.sub),
          ConsistentRead: true,
        }),
      );
      return result.Item?.sub === input.sub && result.Item?.botId === input.botId;
    },

    async replacePendingInvitation(input: {
      botId: string;
      sub: string;
      email: string;
      kind: "new" | "existing";
      tokenHash: string;
      expiresAt: number;
    }): Promise<void> {
      const pointerKey = pendingKey(input.botId, input.sub);
      const pointer = await documentClient.send(
        new GetCommand({ TableName: tableName, Key: pointerKey, ConsistentRead: true }),
      );
      const previousTokenHash = pointer.Item?.tokenHash;
      if (previousTokenHash !== undefined && typeof previousTokenHash !== "string") {
        throw new Error("Stored pending invitation pointer is invalid.");
      }

      const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [];
      if (previousTokenHash) {
        transactItems.push({ Delete: { TableName: tableName, Key: inviteKey(previousTokenHash) } });
      }
      transactItems.push({
        Put: {
          TableName: tableName,
          Item: {
            ...inviteKey(input.tokenHash),
            id: input.tokenHash,
            tokenHash: input.tokenHash,
            botId: input.botId,
            sub: input.sub,
            email: input.email,
            kind: input.kind,
            expiresAt: input.expiresAt,
            ttl: Math.ceil(input.expiresAt / 1000),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      });
      transactItems.push({
        Put: {
          TableName: tableName,
          Item: {
            ...pointerKey,
            botId: input.botId,
            sub: input.sub,
            tokenHash: input.tokenHash,
            updatedAt: new Date(now()).toISOString(),
            ttl: Math.ceil(input.expiresAt / 1000),
          },
          ConditionExpression: previousTokenHash
            ? "#tokenHash = :previousTokenHash"
            : "attribute_not_exists(pk)",
          ...(previousTokenHash
            ? {
                ExpressionAttributeNames: { "#tokenHash": "tokenHash" },
                ExpressionAttributeValues: { ":previousTokenHash": previousTokenHash },
              }
            : {}),
        },
      });
      await documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
    },
  };
}

export function createSesInvitationMailer(client: SESv2Client) {
  return {
    async sendInvitation(input: {
      from: string;
      to: string;
      projectName: string;
      url: string;
      expiresAt: number;
    }): Promise<{ messageId?: string }> {
      const expiry = new Date(input.expiresAt).toLocaleString("es-AR", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "America/Argentina/Cordoba",
      });
      const result = await client.send(
        new SendEmailCommand({
          FromEmailAddress: input.from,
          Destination: { ToAddresses: [input.to] },
          Content: {
            Simple: {
              Subject: { Data: `Invitación a ${input.projectName}`, Charset: "UTF-8" },
              Body: {
                Text: {
                  Data: [
                    `Recibiste una invitación para acceder a ${input.projectName}.`,
                    "",
                    "Abrí este enlace para elegir tu contraseña y verificar tu email:",
                    input.url,
                    "",
                    `El enlace vence el ${expiry}. Si no esperabas esta invitación, podés ignorar este mensaje.`,
                  ].join("\n"),
                  Charset: "UTF-8",
                },
              },
            },
          },
        }),
      );
      return result.MessageId ? { messageId: result.MessageId } : {};
    },
  };
}
