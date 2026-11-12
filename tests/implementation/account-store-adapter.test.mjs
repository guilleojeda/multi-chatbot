import { describe, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createAccountStoreAdapter } from "../../api/aws-adapters.ts";

const now = 1_800_000_000_000;
const tokenHash = "a".repeat(64);
const input = { tokenHash, sub: "user-123", botId: "bot-aurora" };
const accessKey = { pk: "BOT#bot-aurora#USER#user-123", sk: "ACCESS" };
const invitationKey = { pk: `INVITE#${tokenHash}`, sk: "INVITATION" };
const access = {
  ...accessKey,
  sub: input.sub,
  botId: input.botId,
  access: "none",
  revision: 2,
  currentInvitation: { hash: tokenHash, expiresAt: now + 60_000 },
  activationClaim: { invitationHash: tokenHash, claimedAt: new Date(now - 1).toISOString() },
};
const invitation = {
  ...invitationKey,
  id: tokenHash,
  tokenHash,
  botId: input.botId,
  sub: input.sub,
  email: "teacher@example.test",
  expiresAt: now + 60_000,
  operationId: "operation-1",
  delivery: { status: "unconfirmed" },
};

function transactionCanceled(cancellationReasons) {
  const error = new Error("Transaction was canceled.");
  error.name = "TransactionCanceledException";
  if (cancellationReasons !== undefined) error.CancellationReasons = cancellationReasons;
  return error;
}

function makeStore(responses) {
  const documentClient = { send: vi.fn() };
  for (const response of responses) {
    if (response instanceof Error) documentClient.send.mockRejectedValueOnce(response);
    else documentClient.send.mockResolvedValueOnce(response);
  }
  return {
    documentClient,
    store: createAccountStoreAdapter({
      documentClient,
      tableName: "account-table",
      now: () => now,
    }),
  };
}

describe("the DynamoDB account store adapter", () => {
  it("recognizes a consumed invitation after a transaction cancellation without reasons", async () => {
    const cancellation = transactionCanceled(undefined);
    const { documentClient, store } = makeStore([
      { Item: access },
      { Item: invitation },
      cancellation,
      { Item: { ...invitation, usedAt: new Date(now - 1).toISOString() } },
    ]);

    await expect(store.consumeInvitation(input)).resolves.toBe(false);

    expect(documentClient.send).toHaveBeenCalledTimes(4);
    const commands = documentClient.send.mock.calls.map(([command]) => command);
    expect(commands[2]).toBeInstanceOf(TransactWriteCommand);
    expect(commands[3]).toBeInstanceOf(GetCommand);
    expect(commands[3].input).toMatchObject({
      TableName: "account-table",
      Key: invitationKey,
      ConsistentRead: true,
    });
  });

  it("does not report an unknown transaction cancellation as a consumed invitation", async () => {
    const cancellation = transactionCanceled(undefined);
    const { documentClient, store } = makeStore([
      { Item: access },
      { Item: invitation },
      cancellation,
      { Item: invitation },
    ]);

    await expect(store.consumeInvitation(input)).rejects.toBe(cancellation);
    expect(documentClient.send).toHaveBeenCalledTimes(4);
  });

  it("recognizes a conditional ACCESS conflict without writing another grant", async () => {
    const cancellation = transactionCanceled([
      { Code: "None" },
      { Code: "ConditionalCheckFailed" },
    ]);
    const { documentClient, store } = makeStore([
      { Item: access },
      { Item: invitation },
      cancellation,
    ]);

    await expect(store.consumeInvitation(input)).resolves.toBe(false);
    const transaction = documentClient.send.mock.calls[2][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    const writes = transaction.input.TransactItems.flatMap((operation) => Object.values(operation));
    expect(writes).toHaveLength(2);
    expect(writes.every((write) => write.TableName === "account-table")).toBe(true);
    expect(JSON.stringify(writes)).not.toMatch(/MEMBER#|PENDING_INVITATION/);
  });
});
