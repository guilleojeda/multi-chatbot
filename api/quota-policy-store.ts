import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { parseQuotaPolicy, type QuotaPolicy } from "../config/quota-policy.js";

export type QuotaPolicyReader = () => Promise<QuotaPolicy>;

export function createQuotaPolicyReader(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  botId: string,
): QuotaPolicyReader {
  return async () => {
    const result = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `BOT#${botId}`, sk: "QUOTA#POLICY" },
        ConsistentRead: true,
      }),
    );
    return parseQuotaPolicy(result.Item);
  };
}
