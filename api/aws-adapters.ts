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
} from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import {
  mapAccessRecord,
  mapInvitationRecord,
  isValidOperationId,
  StateChangedError,
  type AccessRecord,
  type ActivationInput,
  type InvitationDelivery,
  type InvitationRecord,
  type RevokeAccessInput,
  type RevokeAccessResult,
  type RecordInvitationDeliveryInput,
  type RegisterInvitationInput,
  type RegisterInvitationResult,
} from "./access.js";
import type { InvitationUser } from "./invitations.js";

type CognitoUser = {
  sub: string;
  email: string;
  emailVerified: boolean;
  status?: string;
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

    async markEmailVerified(input: { sub: string; email: string }): Promise<void> {
      await client.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: input.sub,
          UserAttributes: [
            { Name: "email", Value: input.email },
            { Name: "email_verified", Value: "true" },
          ],
        }),
      );
    },
  };
}

function inviteKey(tokenHash: string) {
  return { pk: `INVITE#${tokenHash}`, sk: "INVITATION" };
}

function accessKey(botId: string, sub: string) {
  return { pk: `BOT#${botId}#USER#${sub}`, sk: "ACCESS" };
}

function sameDelivery(left: InvitationDelivery, right: InvitationDelivery): boolean {
  return left.status === right.status && left.messageId === right.messageId;
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

function transactionConditionFailed(error: Record<string, unknown>, index: number): boolean {
  const reasons = error.CancellationReasons;
  const reason = Array.isArray(reasons) ? reasons[index] : undefined;
  return (
    typeof reason === "object" &&
    reason !== null &&
    "Code" in reason &&
    (reason as { Code?: unknown }).Code === "ConditionalCheckFailed"
  );
}

function cancellationReasons(error: Record<string, unknown>): unknown[] | null {
  return Array.isArray(error.CancellationReasons) ? error.CancellationReasons : null;
}

export function createAccountStoreAdapter({
  documentClient,
  tableName,
  now = Date.now,
}: {
  documentClient: DynamoDBDocumentClient;
} & TableOptions) {
  async function getAccess(input: { sub: string; botId: string }): Promise<AccessRecord | null> {
    const result = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: accessKey(input.botId, input.sub),
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;
    const access = mapAccessRecord(result.Item, input);
    if (!access) throw new Error("Stored account access record is invalid.");
    return access;
  }

  async function getInvitation(tokenHash: string): Promise<InvitationRecord | null> {
    const result = await documentClient.send(
      new GetCommand({ TableName: tableName, Key: inviteKey(tokenHash), ConsistentRead: true }),
    );
    if (!result.Item) return null;
    const invitation = mapInvitationRecord(result.Item);
    if (!invitation || invitation.tokenHash !== tokenHash)
      throw new Error("Stored invitation record is invalid.");
    return invitation;
  }

  async function readReplay(
    input: RegisterInvitationInput,
    access: AccessRecord | null,
  ): Promise<RegisterInvitationResult | null> {
    if (!access) return null;
    const operation = access.lastAdminOperation;
    if (!operation || operation.id !== input.operationId) return null;
    if (operation.kind !== "invite") {
      throw new StateChangedError("The prior administrative operation is not an invitation.");
    }
    const invitation = await getInvitation(operation.invitationHash);
    if (
      !invitation ||
      invitation.operationId !== input.operationId ||
      invitation.botId !== input.botId ||
      invitation.sub !== input.sub
    ) {
      throw new StateChangedError("The prior invitation operation can no longer be confirmed.");
    }
    return { access, invitation, created: false };
  }

  async function registerInvitation(
    input: RegisterInvitationInput,
  ): Promise<RegisterInvitationResult> {
    if (!isValidOperationId(input.operationId)) {
      throw new TypeError("Invitation operation ID must contain between 1 and 128 characters.");
    }
    const identity = { sub: input.sub, botId: input.botId };
    const access = await getAccess(identity);
    const replay = await readReplay(input, access);
    if (replay) return replay;
    const revision = access?.revision ?? 0;
    if (revision !== input.expectedRevision) throw new StateChangedError();

    const invitation: InvitationRecord = {
      id: input.tokenHash,
      tokenHash: input.tokenHash,
      botId: input.botId,
      sub: input.sub,
      email: input.email,
      expiresAt: input.expiresAt,
      operationId: input.operationId,
      delivery: { status: "unconfirmed" },
    };
    const nextRevision = revision + 1;
    const createdAccess: AccessRecord = {
      ...(access ?? { sub: input.sub, botId: input.botId, access: "none" as const }),
      revision: nextRevision,
      currentInvitation: { hash: input.tokenHash, expiresAt: input.expiresAt },
      lastAdminOperation: {
        id: input.operationId,
        kind: "invite",
        invitationHash: input.tokenHash,
      },
    };
    const invitationPut = {
      Put: {
        TableName: tableName,
        Item: {
          ...inviteKey(input.tokenHash),
          ...invitation,
          ttl: Math.ceil(input.expiresAt / 1000),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    };
    const accessWrite = access
      ? {
          Update: {
            TableName: tableName,
            Key: accessKey(input.botId, input.sub),
            UpdateExpression:
              "SET #currentInvitation = :currentInvitation, #revision = :nextRevision, #lastAdminOperation = :lastAdminOperation",
            ConditionExpression:
              "attribute_exists(pk) AND #sub = :sub AND #botId = :botId AND #revision = :expectedRevision",
            ExpressionAttributeNames: {
              "#currentInvitation": "currentInvitation",
              "#revision": "revision",
              "#lastAdminOperation": "lastAdminOperation",
              "#sub": "sub",
              "#botId": "botId",
            },
            ExpressionAttributeValues: {
              ":currentInvitation": { hash: input.tokenHash, expiresAt: input.expiresAt },
              ":nextRevision": nextRevision,
              ":lastAdminOperation": {
                id: input.operationId,
                kind: "invite",
                invitationHash: input.tokenHash,
              },
              ":sub": input.sub,
              ":botId": input.botId,
              ":expectedRevision": input.expectedRevision,
            },
          },
        }
      : {
          Put: {
            TableName: tableName,
            Item: {
              ...accessKey(input.botId, input.sub),
              sub: input.sub,
              botId: input.botId,
              access: "none",
              revision: nextRevision,
              currentInvitation: { hash: input.tokenHash, expiresAt: input.expiresAt },
              lastAdminOperation: {
                id: input.operationId,
                kind: "invite",
                invitationHash: input.tokenHash,
              },
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        };

    try {
      await documentClient.send(
        new TransactWriteCommand({ TransactItems: [invitationPut, accessWrite] }),
      );
      return { access: createdAccess, invitation, created: true };
    } catch (error) {
      const canceled = transactionCanceled(error);
      const reasons = canceled ? cancellationReasons(error) : null;
      if (canceled && reasons && transactionConditionFailed(error, 1)) {
        const current = await getAccess(identity);
        const committedReplay = await readReplay(input, current);
        if (committedReplay) return committedReplay;
        throw new StateChangedError();
      }

      try {
        const current = await getAccess(identity);
        const committedReplay = await readReplay(input, current);
        if (committedReplay) return committedReplay;
        if ((current?.revision ?? 0) !== input.expectedRevision) throw new StateChangedError();
      } catch (reconcileError) {
        if (reconcileError instanceof StateChangedError) throw reconcileError;
      }
      throw error;
    }
  }

  function confirmedRevokeReplay(
    input: RevokeAccessInput,
    access: AccessRecord | null,
  ): RevokeAccessResult | null {
    const operation = access?.lastAdminOperation;
    if (!access || !operation || operation.id !== input.operationId) return null;
    if (
      operation.kind === "revoke" &&
      access.revision === input.expectedRevision + 1 &&
      access.access !== "active"
    ) {
      return { access, created: false };
    }
    throw new StateChangedError("The prior revocation is no longer the current ACCESS result.");
  }

  async function revokeAccess(input: RevokeAccessInput): Promise<RevokeAccessResult> {
    if (
      !isValidOperationId(input.operationId) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    ) {
      throw new TypeError("Revocation operation details are invalid.");
    }
    const identity = { sub: input.sub, botId: input.botId };
    const access = await getAccess(identity);
    if (!access) throw new StateChangedError("The account has no current ACCESS record.");

    const replay = confirmedRevokeReplay(input, access);
    if (replay) return replay;
    if (access.revision !== input.expectedRevision) throw new StateChangedError();
    const nextRevision = input.expectedRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) throw new StateChangedError();

    const nextAccess: AccessRecord = {
      ...access,
      access: access.access === "active" ? "revoked" : access.access,
      revision: nextRevision,
      lastAdminOperation: { id: input.operationId, kind: "revoke" },
    };
    delete nextAccess.currentInvitation;

    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: accessKey(input.botId, input.sub),
          UpdateExpression:
            "SET #access = :access, #revision = :nextRevision, #lastAdminOperation = :lastAdminOperation REMOVE #currentInvitation",
          ConditionExpression:
            "attribute_exists(pk) AND #sub = :sub AND #botId = :botId AND #revision = :expectedRevision",
          ExpressionAttributeNames: {
            "#access": "access",
            "#revision": "revision",
            "#lastAdminOperation": "lastAdminOperation",
            "#currentInvitation": "currentInvitation",
            "#sub": "sub",
            "#botId": "botId",
          },
          ExpressionAttributeValues: {
            ":access": nextAccess.access,
            ":nextRevision": nextRevision,
            ":lastAdminOperation": nextAccess.lastAdminOperation,
            ":sub": input.sub,
            ":botId": input.botId,
            ":expectedRevision": input.expectedRevision,
          },
        }),
      );
      return { access: nextAccess, created: true };
    } catch (error) {
      const conditional = conditionalFailure(error);
      let current: AccessRecord | null;
      try {
        current = await getAccess(identity);
      } catch {
        throw error;
      }
      const committedReplay = confirmedRevokeReplay(input, current);
      if (committedReplay) return committedReplay;
      if (conditional || current?.revision !== input.expectedRevision) {
        throw new StateChangedError();
      }
      throw error;
    }
  }

  async function recordInvitationDelivery(input: RecordInvitationDeliveryInput): Promise<void> {
    if (!isValidOperationId(input.operationId)) {
      throw new TypeError("Invitation operation ID must contain between 1 and 128 characters.");
    }
    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: inviteKey(input.tokenHash),
          UpdateExpression: "SET #delivery = :delivery",
          ConditionExpression:
            "attribute_exists(pk) AND #sub = :sub AND #botId = :botId AND #operationId = :operationId AND #delivery.#status = :unconfirmed",
          ExpressionAttributeNames: {
            "#sub": "sub",
            "#botId": "botId",
            "#operationId": "operationId",
            "#delivery": "delivery",
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":sub": input.sub,
            ":botId": input.botId,
            ":operationId": input.operationId,
            ":unconfirmed": "unconfirmed",
            ":delivery": input.delivery,
          },
        }),
      );
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const existing = await getInvitation(input.tokenHash);
      if (
        existing?.sub === input.sub &&
        existing.botId === input.botId &&
        existing.operationId === input.operationId &&
        sameDelivery(existing.delivery, input.delivery)
      ) {
        return;
      }
      throw new StateChangedError("Invitation delivery status no longer matches this operation.");
    }
  }

  async function reserveActivation(input: ActivationInput): Promise<boolean> {
    const access = await getAccess({ sub: input.sub, botId: input.botId });
    const currentInvitation = access?.currentInvitation;
    const timestamp = now();
    if (
      !access ||
      !currentInvitation ||
      currentInvitation.hash !== input.tokenHash ||
      currentInvitation.expiresAt <= timestamp ||
      access.activationClaim
    ) {
      return false;
    }

    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: accessKey(input.botId, input.sub),
          UpdateExpression: "SET #activationClaim = :claim, #revision = :nextRevision",
          ConditionExpression:
            "attribute_exists(pk) AND #sub = :sub AND #botId = :botId AND #revision = :revision AND #currentInvitation.#hash = :tokenHash AND #currentInvitation.#expiresAt > :now AND attribute_not_exists(#activationClaim)",
          ExpressionAttributeNames: {
            "#activationClaim": "activationClaim",
            "#revision": "revision",
            "#sub": "sub",
            "#botId": "botId",
            "#currentInvitation": "currentInvitation",
            "#hash": "hash",
            "#expiresAt": "expiresAt",
          },
          ExpressionAttributeValues: {
            ":claim": {
              invitationHash: input.tokenHash,
              claimedAt: new Date(timestamp).toISOString(),
            },
            ":revision": access.revision,
            ":nextRevision": access.revision + 1,
            ":sub": input.sub,
            ":botId": input.botId,
            ":tokenHash": input.tokenHash,
            ":now": timestamp,
          },
        }),
      );
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async function releaseActivation(input: ActivationInput): Promise<void> {
    let access = await getAccess({ sub: input.sub, botId: input.botId });
    const claimedAt = access?.activationClaim?.claimedAt;
    while (
      access?.activationClaim?.invitationHash === input.tokenHash &&
      access.activationClaim.claimedAt === claimedAt
    ) {
      try {
        await documentClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: accessKey(input.botId, input.sub),
            UpdateExpression: "SET #revision = :nextRevision REMOVE #activationClaim",
            ConditionExpression:
              "attribute_exists(pk) AND #sub = :sub AND #botId = :botId AND #revision = :revision AND #activationClaim.#invitationHash = :tokenHash AND #activationClaim.#claimedAt = :claimedAt",
            ExpressionAttributeNames: {
              "#revision": "revision",
              "#activationClaim": "activationClaim",
              "#sub": "sub",
              "#botId": "botId",
              "#invitationHash": "invitationHash",
              "#claimedAt": "claimedAt",
            },
            ExpressionAttributeValues: {
              ":revision": access.revision,
              ":nextRevision": access.revision + 1,
              ":sub": input.sub,
              ":botId": input.botId,
              ":tokenHash": input.tokenHash,
              ":claimedAt": claimedAt,
            },
          }),
        );
        return;
      } catch (error) {
        if (conditionalFailure(error)) {
          access = await getAccess({ sub: input.sub, botId: input.botId });
          continue;
        }
        const current = await getAccess({ sub: input.sub, botId: input.botId });
        if (
          current?.activationClaim?.invitationHash !== input.tokenHash ||
          current.activationClaim.claimedAt !== claimedAt
        ) {
          return;
        }
        throw error;
      }
    }
  }

  async function consumeInvitation(input: ActivationInput): Promise<boolean> {
    const [access, invitation] = await Promise.all([
      getAccess({ sub: input.sub, botId: input.botId }),
      getInvitation(input.tokenHash),
    ]);
    const currentInvitation = access?.currentInvitation;
    const timestamp = now();
    if (
      !access ||
      !currentInvitation ||
      currentInvitation.hash !== input.tokenHash ||
      !invitation ||
      invitation.sub !== input.sub ||
      invitation.botId !== input.botId ||
      invitation.expiresAt !== currentInvitation.expiresAt ||
      currentInvitation.expiresAt <= timestamp ||
      invitation.usedAt
    ) {
      return false;
    }

    const claimed = access.activationClaim?.invitationHash === input.tokenHash;
    const invitationUpdate = {
      Update: {
        TableName: tableName,
        Key: inviteKey(input.tokenHash),
        UpdateExpression: "SET #usedAt = :usedAt",
        ConditionExpression:
          "attribute_exists(pk) AND #id = :tokenHash AND #tokenHash = :tokenHash AND #sub = :sub AND #botId = :botId AND #expiresAt > :now AND attribute_not_exists(#usedAt)",
        ExpressionAttributeNames: {
          "#id": "id",
          "#tokenHash": "tokenHash",
          "#sub": "sub",
          "#botId": "botId",
          "#expiresAt": "expiresAt",
          "#usedAt": "usedAt",
        },
        ExpressionAttributeValues: {
          ":usedAt": new Date(timestamp).toISOString(),
          ":tokenHash": input.tokenHash,
          ":sub": input.sub,
          ":botId": input.botId,
          ":now": timestamp,
        },
      },
    };
    const accessUpdate = {
      Update: {
        TableName: tableName,
        Key: accessKey(input.botId, input.sub),
        UpdateExpression: claimed
          ? "SET #access = :active, #revision = :nextRevision REMOVE #currentInvitation, #activationClaim"
          : "SET #access = :active, #revision = :nextRevision REMOVE #currentInvitation",
        ConditionExpression:
          "attribute_exists(pk) AND #sub = :sub AND #botId = :botId AND #revision = :revision AND #currentInvitation.#hash = :tokenHash AND #currentInvitation.#expiresAt > :now",
        ExpressionAttributeNames: {
          "#access": "access",
          "#revision": "revision",
          "#currentInvitation": "currentInvitation",
          "#hash": "hash",
          "#expiresAt": "expiresAt",
          "#sub": "sub",
          "#botId": "botId",
          ...(claimed ? { "#activationClaim": "activationClaim" } : {}),
        },
        ExpressionAttributeValues: {
          ":active": "active",
          ":nextRevision": access.revision + 1,
          ":revision": access.revision,
          ":sub": input.sub,
          ":botId": input.botId,
          ":tokenHash": input.tokenHash,
          ":now": timestamp,
        },
      },
    };

    try {
      await documentClient.send(
        new TransactWriteCommand({ TransactItems: [invitationUpdate, accessUpdate] }),
      );
      return true;
    } catch (error) {
      if (transactionCanceled(error)) {
        const reasons = cancellationReasons(error);
        if (
          reasons &&
          (transactionConditionFailed(error, 0) || transactionConditionFailed(error, 1))
        )
          return false;
        if (!reasons) {
          try {
            const current = await getInvitation(input.tokenHash);
            if (current?.usedAt && current.sub === input.sub && current.botId === input.botId)
              return false;
          } catch {
            throw error;
          }
        }
      }
      throw error;
    }
  }

  return {
    getAccess,
    getInvitation,
    registerInvitation,
    revokeAccess,
    recordInvitationDelivery,
    reserveActivation,
    releaseActivation,
    consumeInvitation,
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
                    "Abrí este enlace para aceptar la invitación:",
                    input.url,
                    "",
                    "Si tu cuenta es nueva, elegí una contraseña para activarla y verificar tu email.",
                    "Si tu cuenta ya está activa, iniciá sesión con tu contraseña actual.",
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
