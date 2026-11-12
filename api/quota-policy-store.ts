import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { parseQuotaPolicy, type QuotaPolicy } from "../config/quota-policy.js";

export type QuotaPolicyReader = () => Promise<QuotaPolicy>;

export type QuotaPolicyUpdateInput = {
  previous: QuotaPolicy;
  next: QuotaPolicy;
};

export type QuotaPolicyWriter = (input: QuotaPolicyUpdateInput) => Promise<QuotaPolicy>;

function policyKey(botId: string) {
  return { pk: `BOT#${botId}`, sk: "QUOTA#POLICY" };
}

export function createQuotaPolicyReader(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  botId: string,
): QuotaPolicyReader {
  return async () => {
    const result = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: policyKey(botId),
        ConsistentRead: true,
      }),
    );
    return parseQuotaPolicy(result.Item);
  };
}

export function createQuotaPolicyWriter(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  botId: string,
): QuotaPolicyWriter {
  return async ({ previous, next }) => {
    await documentClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: policyKey(botId),
        UpdateExpression:
          "SET #dailyLimit = :nextDailyLimit, #monthlyLimit = :nextMonthlyLimit, #revision = :nextRevision",
        ConditionExpression:
          "#dailyLimit = :previousDailyLimit AND #monthlyLimit = :previousMonthlyLimit AND #revision = :previousRevision",
        ExpressionAttributeNames: {
          "#dailyLimit": "dailyLimit",
          "#monthlyLimit": "monthlyLimit",
          "#revision": "revision",
        },
        ExpressionAttributeValues: {
          ":previousDailyLimit": previous.dailyLimit,
          ":previousMonthlyLimit": previous.monthlyLimit,
          ":previousRevision": previous.revision,
          ":nextDailyLimit": next.dailyLimit,
          ":nextMonthlyLimit": next.monthlyLimit,
          ":nextRevision": next.revision,
        },
      }),
    );
    return next;
  };
}
