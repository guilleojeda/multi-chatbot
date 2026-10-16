import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { createAccountStoreAdapter } from "../../api/aws-adapters.ts";

const input = { invitationId: "token-hash", sub: "user-123", botId: "bot-aurora" };
const item = {
  pk: "INVITE#token-hash",
  sk: "INVITATION",
  id: "token-hash",
  tokenHash: "token-hash",
  botId: input.botId,
  sub: input.sub,
  email: "teacher@example.test",
  expiresAt: 1_800_000_000_000,
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
      now: () => 1_800_000_000_000,
    }),
  };
}

describe("the DynamoDB account store adapter", () => {
  it("recognizes an already-used invitation after a transaction cancellation without reasons", async () => {
    const cancellation = transactionCanceled(undefined);
    const { documentClient, store } = makeStore([
      cancellation,
      { Item: { ...item, usedAt: "2026-10-16T12:00:00.000Z" } },
    ]);

    await expect(store.useInvitationAndAddMember(input)).resolves.toBe(false);

    expect(documentClient.send).toHaveBeenCalledTimes(2);
    const followUpRead = documentClient.send.mock.calls[1][0];
    expect(followUpRead).toBeInstanceOf(GetCommand);
    expect(followUpRead.input).toMatchObject({
      TableName: "account-table",
      Key: { pk: "INVITE#token-hash", sk: "INVITATION" },
      ConsistentRead: true,
    });
  });

  it("does not report an unknown transaction cancellation as an invitation conflict", async () => {
    const cancellation = transactionCanceled(undefined);
    const { documentClient, store } = makeStore([cancellation, { Item: item }]);

    await expect(store.useInvitationAndAddMember(input)).rejects.toBe(cancellation);
    expect(documentClient.send).toHaveBeenCalledTimes(2);
  });

  it("does not convert a membership condition failure into an invitation conflict", async () => {
    const cancellation = transactionCanceled([
      { Code: "None" },
      { Code: "ConditionalCheckFailed" },
    ]);
    const { documentClient, store } = makeStore([cancellation]);

    await expect(store.useInvitationAndAddMember(input)).rejects.toBe(cancellation);
    expect(documentClient.send).toHaveBeenCalledTimes(1);
  });
});
