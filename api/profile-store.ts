import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { ProfileDocument, StoredProfile } from "../config/profile.js";

function profileKey(input: { sub: string; botId: string }) {
  return { pk: `BOT#${input.botId}#USER#${input.sub}`, sk: "PROFILE" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return isRecord(value) && Object.values(value).every((items) => isStringArray(items));
}

export function createProfileStoreAdapter(input: {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
}) {
  const { documentClient, tableName } = input;

  return {
    async getProfile(key: { sub: string; botId: string }): Promise<StoredProfile | null> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: profileKey(key),
          ConsistentRead: true,
        }),
      );
      const storedItem: unknown = result.Item;
      if (storedItem === undefined) return null;
      if (
        !isRecord(storedItem) ||
        typeof storedItem.sub !== "string" ||
        typeof storedItem.botId !== "string" ||
        !isStringArrayRecord(storedItem.fields) ||
        typeof storedItem.updatedAt !== "string"
      ) {
        throw new Error("Stored profile record is invalid.");
      }

      if (Object.hasOwn(storedItem, "responsePreferenceIds")) {
        if (!isStringArray(storedItem.responsePreferenceIds)) {
          throw new Error("Stored profile preferences are invalid.");
        }
        return {
          sub: storedItem.sub,
          botId: storedItem.botId,
          fields: storedItem.fields,
          responsePreferenceIds: storedItem.responsePreferenceIds,
          updatedAt: storedItem.updatedAt,
        };
      }

      return {
        sub: storedItem.sub,
        botId: storedItem.botId,
        fields: storedItem.fields,
        updatedAt: storedItem.updatedAt,
      };
    },

    async putProfile(profile: ProfileDocument): Promise<void> {
      await documentClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...profileKey(profile),
            sub: profile.sub,
            botId: profile.botId,
            fields: profile.fields,
            ...(profile.responsePreferenceIds.length > 0
              ? { responsePreferenceIds: profile.responsePreferenceIds }
              : {}),
            updatedAt: profile.updatedAt,
          },
        }),
      );
    },
  };
}
