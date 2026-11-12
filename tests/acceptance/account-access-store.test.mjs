import { describe, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mapAccessRecord, maximumAccessRecordSizeBytes } from "../../api/access.ts";
import { createAccountStoreAdapter } from "../../api/aws-adapters.ts";
import { createPhase9AccountTransport } from "../support/phase9-account-transport.mjs";

const now = Date.parse("2026-11-11T15:00:00.000Z");
const tableName = "account-docentes";
const botId = "docentes";
const sub = "teacher-sub";
const tokenHash = "a".repeat(64);
const nextHash = "b".repeat(64);
const expiresAt = now + 7 * 24 * 60 * 60 * 1000;

function accessKey(subject = sub, project = botId) {
  return { pk: `BOT#${project}#USER#${subject}`, sk: "ACCESS" };
}

function invitationKey(hash = tokenHash) {
  return { pk: `INVITE#${hash}`, sk: "INVITATION" };
}

function accessItem(overrides = {}) {
  return {
    ...accessKey(),
    sub,
    botId,
    access: "none",
    revision: 0,
    ...overrides,
  };
}

function invitationItem(overrides = {}) {
  return {
    ...invitationKey(),
    id: tokenHash,
    tokenHash,
    sub,
    botId,
    email: "teacher@example.test",
    expiresAt,
    ttl: Math.ceil(expiresAt / 1000),
    operationId: "operation-1",
    delivery: { status: "unconfirmed" },
    ...overrides,
  };
}

function makeStore(send = vi.fn(async () => ({}))) {
  const documentClient = { send };
  return {
    documentClient,
    store: createAccountStoreAdapter({ documentClient, tableName, now: () => now }),
  };
}

function callRevokeAccess(store, input) {
  expect(typeof store.revokeAccess, "Expected the account store revokeAccess contract").toBe(
    "function",
  );
  return store.revokeAccess(input);
}

function writesOf(transaction) {
  return (transaction.input.TransactItems || []).flatMap((entry) => {
    if (entry.Put) return [{ kind: "Put", ...entry.Put }];
    if (entry.Update) return [{ kind: "Update", ...entry.Update }];
    if (entry.Delete) return [{ kind: "Delete", ...entry.Delete }];
    if (entry.ConditionCheck) return [{ kind: "ConditionCheck", ...entry.ConditionCheck }];
    return [];
  });
}

function writeKey(write) {
  return write.Item || write.Key;
}

function expandedExpression(commandInput, property) {
  const names = commandInput.ExpressionAttributeNames || {};
  return (commandInput[property] || "").replace(
    /#[a-zA-Z0-9_]+/g,
    (alias) => names[alias] || alias,
  );
}

function serializedValues(commandInput) {
  return JSON.stringify(commandInput.ExpressionAttributeValues || {});
}

function hasHashOrRevisionGuard(commandInput, attributeName, hash, observedRevision) {
  const condition = expandedExpression(commandInput, "ConditionExpression");
  const values = serializedValues(commandInput);
  const protectsHash = condition.includes(attributeName) && values.includes(hash);
  const protectsObservedRevision =
    /\brevision\b/i.test(condition) &&
    Object.values(commandInput.ExpressionAttributeValues || {}).includes(observedRevision);
  return protectsHash || protectsObservedRevision;
}

function expectNoLegacyAccessKeys(writes) {
  for (const write of writes) {
    const key = writeKey(write);
    expect(key.pk).not.toContain("MEMBER#");
    expect(key.sk).not.toMatch(/^MEMBER#/);
    expect(key.sk).not.toBe("PENDING_INVITATION");
  }
}

describe("the account access DynamoDB adapter", () => {
  it("reads ACCESS consistently and leaves an absent person absent", async () => {
    const { documentClient, store } = makeStore(vi.fn(async () => ({})));

    const result = await store.getAccess({ sub, botId });

    expect(result).toBeNull();
    expect(documentClient.send).toHaveBeenCalledOnce();
    expect(documentClient.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(documentClient.send.mock.calls[0][0].input).toEqual({
      TableName: tableName,
      Key: accessKey(),
      ConsistentRead: true,
    });
  });

  it("fails closed when the ACCESS record read from DynamoDB is malformed", async () => {
    const { store } = makeStore(
      vi.fn(async () => ({ Item: { ...accessKey(), sub, botId, access: "active" } })),
    );

    await expect(store.getAccess({ sub, botId })).rejects.toThrow();
  });

  it("bounds ACCESS mapping to the complete supported schema and real identity key sizes", () => {
    const unsupported = accessItem({ unsupported: "x".repeat(400 * 1024) });
    const oversizedOperation = accessItem({
      lastAdminOperation: { id: "x".repeat(129), kind: "revoke" },
    });

    expect(maximumAccessRecordSizeBytes({ sub, botId })).toBe(
      798 + 2 * (Buffer.byteLength(botId, "utf8") + Buffer.byteLength(sub, "utf8")),
    );
    expect(mapAccessRecord(unsupported, { sub, botId })).toBeNull();
    expect(mapAccessRecord(oversizedOperation, { sub, botId })).toBeNull();
  });

  it("registers INVITATION and replaces the ACCESS pointer in one CAS transaction", async () => {
    const current = accessItem({
      access: "active",
      revision: 4,
      currentInvitation: { hash: "c".repeat(64), expiresAt: now + 1_000 },
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: current };
      return {};
    });
    const { documentClient, store } = makeStore(send);

    const result = await store.registerInvitation({
      botId,
      sub,
      email: "teacher@example.test",
      tokenHash: nextHash,
      expiresAt,
      expectedRevision: 4,
      operationId: "operation-5",
    });

    expect(result).toMatchObject({ created: true, access: { access: "active", revision: 5 } });
    expect(result.access.currentInvitation).toEqual({ hash: nextHash, expiresAt });
    expect(result.invitation).toMatchObject({
      id: nextHash,
      tokenHash: nextHash,
      sub,
      botId,
      email: "teacher@example.test",
      expiresAt,
      operationId: "operation-5",
    });
    expect(documentClient.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = documentClient.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof TransactWriteCommand);
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    const writes = writesOf(transaction);
    const inviteWrite = writes.find((write) => write.Item?.pk === `INVITE#${nextHash}`);
    const accessWrite = writes.find((write) => writeKey(write).pk === accessKey().pk);
    expect(inviteWrite).toMatchObject({
      kind: "Put",
      Item: {
        ...invitationKey(nextHash),
        id: nextHash,
        tokenHash: nextHash,
        sub,
        botId,
        email: "teacher@example.test",
        expiresAt,
        ttl: Math.ceil(expiresAt / 1000),
        operationId: "operation-5",
      },
    });
    expect(accessWrite).toBeDefined();
    expect(expandedExpression(accessWrite, "ConditionExpression")).toMatch(/revision/i);
    expect(Object.values(accessWrite.ExpressionAttributeValues || {})).toContain(4);
    expect(JSON.stringify(accessWrite)).toContain(nextHash);
    expectNoLegacyAccessKeys(writes);
    expect(writes).toHaveLength(2);
  });

  it("recognizes a confirmed operation ID replay without writing a second invitation", async () => {
    const confirmedAccess = accessItem({
      revision: 2,
      currentInvitation: { hash: tokenHash, expiresAt },
      lastAdminOperation: { id: "same-operation", kind: "invite", invitationHash: tokenHash },
    });
    const confirmedInvitation = invitationItem({
      operationId: "same-operation",
      delivery: { status: "accepted", messageId: "ses-first" },
    });
    const send = vi.fn(async (command) => {
      if (!(command instanceof GetCommand)) throw new Error("Replay must not write");
      if (command.input.Key.sk === "ACCESS") return { Item: confirmedAccess };
      return { Item: confirmedInvitation };
    });
    const { documentClient, store } = makeStore(send);

    const result = await store.registerInvitation({
      botId,
      sub,
      email: "teacher@example.test",
      tokenHash: nextHash,
      expiresAt: now + 2 * 24 * 60 * 60 * 1000,
      expectedRevision: 1,
      operationId: "same-operation",
    });

    expect(result).toMatchObject({
      created: false,
      access: { revision: 2, currentInvitation: { hash: tokenHash } },
      invitation: { tokenHash, delivery: { status: "accepted", messageId: "ses-first" } },
    });
    expect(documentClient.send.mock.calls.every(([command]) => command instanceof GetCommand)).toBe(
      true,
    );
    expect(
      documentClient.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand),
    ).toBe(false);
  });

  it("recognizes a committed invitation after the DynamoDB transaction response is lost", async () => {
    const transport = createPhase9AccountTransport();
    const timeout = Object.assign(new Error("DynamoDB response timed out"), {
      name: "TimeoutError",
    });
    const commands = [];
    const documentClient = {
      async send(command) {
        commands.push(command);
        if (command instanceof TransactWriteCommand) {
          await transport.documentClient.send(command);
          throw timeout;
        }
        return transport.documentClient.send(command);
      },
    };
    const store = createAccountStoreAdapter({ documentClient, tableName, now: () => now });

    const result = await store.registerInvitation({
      botId,
      sub,
      email: "teacher@example.test",
      tokenHash,
      expiresAt,
      expectedRevision: 0,
      operationId: "lost-ack-operation",
    });

    expect(result).toMatchObject({
      created: false,
      access: { sub, botId, currentInvitation: { hash: tokenHash, expiresAt } },
      invitation: { tokenHash, operationId: "lost-ack-operation" },
    });
    expect(commands.filter((command) => command instanceof TransactWriteCommand)).toHaveLength(1);
    expect(transport.items()).toHaveLength(2);
    expectNoLegacyAccessKeys(
      commands
        .filter((command) => command instanceof TransactWriteCommand)
        .flatMap((command) => writesOf(command)),
    );
  });

  it("does not rebase a conflicting invite onto the newer ACCESS revision", async () => {
    let transactionAttempted = false;
    let accessReads = 0;
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        accessReads += 1;
        if (command.input.Key.sk !== "ACCESS") return {};
        return { Item: accessItem({ revision: transactionAttempted ? 8 : 7 }) };
      }
      if (command instanceof TransactWriteCommand) {
        transactionAttempted = true;
        const accessIndex = command.input.TransactItems.findIndex(
          (item) => item.Update?.Key.sk === "ACCESS" || item.Put?.Item.sk === "ACCESS",
        );
        const cancellation = Object.assign(new Error("Conditional transaction failure"), {
          name: "TransactionCanceledException",
          CancellationReasons: command.input.TransactItems.map((_, index) => ({
            Code: index === accessIndex ? "ConditionalCheckFailed" : "None",
          })),
        });
        throw cancellation;
      }
      throw new Error("Unexpected DynamoDB command");
    });
    const { documentClient, store } = makeStore(send);

    await expect(
      store.registerInvitation({
        botId,
        sub,
        email: "teacher@example.test",
        tokenHash: nextHash,
        expiresAt,
        expectedRevision: 7,
        operationId: "stale-operation",
      }),
    ).rejects.toBeDefined();

    const transactions = documentClient.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof TransactWriteCommand);
    expect(transactions).toHaveLength(1);
    const accessWrite = writesOf(transactions[0]).find(
      (write) => writeKey(write).pk === accessKey().pk,
    );
    expect(expandedExpression(accessWrite, "ConditionExpression")).toMatch(/revision/i);
    expect(Object.values(accessWrite.ExpressionAttributeValues || {})).toContain(7);
    expect(accessReads).toBeGreaterThanOrEqual(1);
  });

  it("records a late SES acknowledgement on INVITATION without changing ACCESS", async () => {
    const current = accessItem({
      access: "active",
      revision: 6,
      currentInvitation: { hash: tokenHash, expiresAt },
    });
    const send = vi.fn(async (command) => {
      if (command instanceof UpdateCommand) return {};
      if (command instanceof GetCommand) return { Item: current };
      throw new Error("A delivery acknowledgement must not transact on ACCESS");
    });
    const { documentClient, store } = makeStore(send);

    await store.recordInvitationDelivery({
      botId,
      sub,
      tokenHash,
      operationId: "operation-1",
      delivery: { status: "accepted", messageId: "late-ses-message" },
    });
    const afterAck = await store.getAccess({ sub, botId });

    const update = documentClient.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof UpdateCommand);
    expect(update).toBeInstanceOf(UpdateCommand);
    expect(update.input).toMatchObject({
      TableName: tableName,
      Key: invitationKey(),
    });
    expect(expandedExpression(update.input, "UpdateExpression")).toMatch(/delivery/i);
    const updates = documentClient.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof UpdateCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0].input.Key).toEqual(invitationKey());
    expect(afterAck).toMatchObject({ access: "active", revision: 6 });
    expect(afterAck.currentInvitation).toEqual({ hash: tokenHash, expiresAt });
  });

  it("reserves a first password change only for the current person, bot, and invitation hash", async () => {
    const current = accessItem({
      revision: 12,
      currentInvitation: { hash: tokenHash, expiresAt },
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: current };
      return {};
    });
    const { documentClient, store } = makeStore(send);

    await expect(store.reserveActivation({ sub, botId, tokenHash })).resolves.toBe(true);

    const update = documentClient.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof UpdateCommand);
    expect(update).toBeInstanceOf(UpdateCommand);
    expect(update.input.Key).toEqual(accessKey());
    expect(hasHashOrRevisionGuard(update.input, "currentInvitation", tokenHash, 12)).toBe(true);
    expect(expandedExpression(update.input, "UpdateExpression")).toMatch(/activationClaim/i);
  });

  it("releases only its own activation claim while preserving the current invitation", async () => {
    const current = accessItem({
      revision: 15,
      currentInvitation: { hash: nextHash, expiresAt },
      activationClaim: { invitationHash: tokenHash, claimedAt: new Date(now).toISOString() },
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: current };
      return {};
    });
    const { documentClient, store } = makeStore(send);

    await store.releaseActivation({ sub, botId, tokenHash });

    const update = documentClient.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof UpdateCommand);
    expect(update).toBeInstanceOf(UpdateCommand);
    expect(update.input.Key).toEqual(accessKey());
    expect(hasHashOrRevisionGuard(update.input, "activationClaim", tokenHash, 15)).toBe(true);
    expect(expandedExpression(update.input, "UpdateExpression")).toMatch(/REMOVE/i);
    expect(expandedExpression(update.input, "UpdateExpression")).not.toMatch(/currentInvitation/i);
  });

  it("retries release against a reissued ACCESS revision while preserving the new pointer", async () => {
    const claimedAt = new Date(now).toISOString();
    let reads = 0;
    let updates = 0;
    const conflict = Object.assign(new Error("ACCESS revision changed"), {
      name: "ConditionalCheckFailedException",
    });
    const documentClient = {
      send: vi.fn(async (command) => {
        if (command instanceof GetCommand) {
          reads += 1;
          return {
            Item: accessItem({
              revision: reads === 1 ? 15 : 16,
              currentInvitation: { hash: reads === 1 ? tokenHash : nextHash, expiresAt },
              activationClaim: {
                invitationHash: tokenHash,
                claimedAt,
              },
            }),
          };
        }
        if (command instanceof UpdateCommand) {
          updates += 1;
          if (updates === 1) throw conflict;
          return {};
        }
        throw new Error(`Unexpected command ${command.constructor.name}`);
      }),
    };
    const store = createAccountStoreAdapter({ documentClient, tableName, now: () => now });

    await expect(store.releaseActivation({ sub, botId, tokenHash })).resolves.toBeUndefined();

    const releaseUpdates = documentClient.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof UpdateCommand);
    expect(releaseUpdates).toHaveLength(2);
    expect(Object.values(releaseUpdates[0].input.ExpressionAttributeValues)).toContain(15);
    expect(Object.values(releaseUpdates[1].input.ExpressionAttributeValues)).toContain(16);
    expect(expandedExpression(releaseUpdates[1].input, "UpdateExpression")).toMatch(/REMOVE/i);
    expect(expandedExpression(releaseUpdates[1].input, "UpdateExpression")).not.toMatch(
      /currentInvitation/i,
    );
  });

  it("does not remove a new same-hash claim after an earlier release ACK was lost", async () => {
    const oldClaimedAt = new Date(now).toISOString();
    const newClaimedAt = new Date(now + 1_000).toISOString();
    let updates = 0;
    const conditionalRetryFailure = Object.assign(new Error("The previous release already won"), {
      name: "ConditionalCheckFailedException",
    });
    const documentClient = {
      send: vi.fn(async (command) => {
        if (command instanceof GetCommand) {
          return {
            Item:
              updates === 0
                ? accessItem({
                    revision: 15,
                    currentInvitation: { hash: tokenHash, expiresAt },
                    activationClaim: { invitationHash: tokenHash, claimedAt: oldClaimedAt },
                  })
                : accessItem({
                    revision: 17,
                    currentInvitation: { hash: tokenHash, expiresAt },
                    activationClaim: { invitationHash: tokenHash, claimedAt: newClaimedAt },
                  }),
          };
        }
        if (command instanceof UpdateCommand) {
          updates += 1;
          throw conditionalRetryFailure;
        }
        throw new Error(`Unexpected command ${command.constructor.name}`);
      }),
    };
    const store = createAccountStoreAdapter({ documentClient, tableName, now: () => now });

    await expect(store.releaseActivation({ sub, botId, tokenHash })).resolves.toBeUndefined();

    expect(updates).toBe(1);
    const update = documentClient.send.mock.calls.find(
      ([command]) => command instanceof UpdateCommand,
    )[0];
    expect(Object.values(update.input.ExpressionAttributeValues)).toContain(oldClaimedAt);
    expect(Object.values(update.input.ExpressionAttributeValues)).not.toContain(newClaimedAt);
  });

  it("consumes a valid invitation and grants ACCESS in one transaction without legacy writes", async () => {
    const access = accessItem({
      revision: 1,
      currentInvitation: { hash: tokenHash, expiresAt },
      activationClaim: { invitationHash: tokenHash, claimedAt: new Date(now).toISOString() },
    });
    const invitation = invitationItem();
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "ACCESS" ? access : invitation };
      }
      return {};
    });
    const { documentClient, store } = makeStore(send);

    await expect(store.consumeInvitation({ sub, botId, tokenHash })).resolves.toBe(true);

    const transaction = documentClient.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof TransactWriteCommand);
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    const writes = writesOf(transaction);
    const inviteUpdate = writes.find((write) => write.Key?.pk === `INVITE#${tokenHash}`);
    const accessUpdate = writes.find((write) => write.Key?.pk === accessKey().pk);
    expect(writes).toHaveLength(2);
    expect(inviteUpdate.kind).toBe("Update");
    const inviteCondition = expandedExpression(inviteUpdate, "ConditionExpression");
    expect(inviteCondition).toMatch(/expiresAt/i);
    expect(inviteCondition).toMatch(/usedAt/i);
    expect(inviteCondition).toMatch(/sub/i);
    expect(inviteCondition).toMatch(/botId/i);
    expect(Object.values(inviteUpdate.ExpressionAttributeValues || {})).toContain(now);
    expect(accessUpdate.kind).toBe("Update");
    expect(
      hasHashOrRevisionGuard(accessUpdate, "currentInvitation", tokenHash, access.revision),
    ).toBe(true);
    expect(expandedExpression(accessUpdate, "UpdateExpression")).toMatch(/\baccess\b/i);
    expect(Object.values(accessUpdate.ExpressionAttributeValues || {})).toContain("active");
    expect(expandedExpression(accessUpdate, "UpdateExpression")).toMatch(/revision/i);
    expect(expandedExpression(accessUpdate, "UpdateExpression")).toMatch(/REMOVE/i);
    expect(expandedExpression(accessUpdate, "UpdateExpression")).toMatch(/activationClaim/i);
    expectNoLegacyAccessKeys(writes);
  });

  it("keeps an activation claim for a different link when a confirmed account consumes the current one", async () => {
    const replacementHash = nextHash;
    const priorClaimHash = "c".repeat(64);
    const access = accessItem({
      revision: 3,
      currentInvitation: { hash: replacementHash, expiresAt },
      activationClaim: {
        invitationHash: priorClaimHash,
        claimedAt: new Date(now - 1_000).toISOString(),
      },
    });
    const invitation = invitationItem({
      ...invitationKey(replacementHash),
      id: replacementHash,
      tokenHash: replacementHash,
      operationId: "replacement-operation",
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: command.input.Key.sk === "ACCESS" ? access : invitation };
      }
      return {};
    });
    const { documentClient, store } = makeStore(send);

    await expect(store.consumeInvitation({ sub, botId, tokenHash: replacementHash })).resolves.toBe(
      true,
    );

    const transaction = documentClient.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof TransactWriteCommand);
    const accessUpdate = writesOf(transaction).find((write) => write.Key?.pk === accessKey().pk);
    const updateExpression = expandedExpression(accessUpdate, "UpdateExpression");
    expect(updateExpression).toMatch(/REMOVE/i);
    expect(updateExpression).not.toMatch(/activationClaim/i);
    expect(JSON.stringify(accessUpdate)).not.toMatch(/MEMBER#|PENDING_INVITATION/);
  });

  it("revokes active access and removes its current invitation in one revision-guarded update", async () => {
    const activationClaim = {
      invitationHash: tokenHash,
      claimedAt: new Date(now).toISOString(),
    };
    const current = accessItem({
      access: "active",
      revision: 12,
      currentInvitation: { hash: nextHash, expiresAt },
      activationClaim,
      lastAdminOperation: { id: "prior-invite", kind: "invite", invitationHash: nextHash },
    });
    const transport = createPhase9AccountTransport();
    transport.setItem(tableName, current);
    transport.setItem(tableName, {
      ...invitationKey(nextHash),
      id: nextHash,
      tokenHash: nextHash,
      sub,
      botId,
      email: "teacher@example.test",
      expiresAt,
      ttl: Math.ceil(expiresAt / 1000),
      operationId: "prior-invite",
      delivery: { status: "accepted", messageId: "prior-message" },
    });
    const store = createAccountStoreAdapter({
      documentClient: transport.documentClient,
      tableName,
      now: () => now,
    });

    // The transport applies UpdateExpression but ignores DynamoDB conditions.
    // These assertions inspect the guard emitted by the production adapter.
    const result = await callRevokeAccess(store, {
      sub,
      botId,
      expectedRevision: 12,
      operationId: "revoke-active-12",
    });
    const durable = await store.getAccess({ sub, botId });

    expect(result).toMatchObject({
      created: true,
      access: {
        sub,
        botId,
        access: "revoked",
        revision: 13,
        activationClaim,
        lastAdminOperation: { id: "revoke-active-12", kind: "revoke" },
      },
    });
    expect(result.access).not.toHaveProperty("currentInvitation");
    expect(result.access.lastAdminOperation).toEqual({
      id: "revoke-active-12",
      kind: "revoke",
    });
    expect(durable).toEqual(result.access);
    expect(transport.getItem(tableName, invitationKey(nextHash))).toMatchObject({
      tokenHash: nextHash,
      operationId: "prior-invite",
    });

    const updates = transport.commands.filter((command) => command instanceof UpdateCommand);
    expect(updates).toHaveLength(1);
    expect(
      transport.commands.filter((command) => command instanceof TransactWriteCommand),
    ).toHaveLength(0);
    const update = updates[0].input;
    expect(update.TableName).toBe(tableName);
    expect(update.Key).toEqual(accessKey());
    expect(expandedExpression(update, "ConditionExpression")).toMatch(/revision/i);
    expect(expandedExpression(update, "ConditionExpression")).toMatch(/sub/i);
    expect(expandedExpression(update, "ConditionExpression")).toMatch(/botId/i);
    expect(Object.values(update.ExpressionAttributeValues || {})).toContain(12);
    const updateExpression = expandedExpression(update, "UpdateExpression");
    expect(updateExpression).toMatch(/access/i);
    expect(updateExpression).toMatch(/revision/i);
    expect(updateExpression).toMatch(/lastAdminOperation/i);
    expect(updateExpression).toMatch(/REMOVE/i);
    expect(updateExpression).toMatch(/currentInvitation/i);
    expect(updateExpression).not.toMatch(/activationClaim/i);
    expect(Object.values(update.ExpressionAttributeValues || {})).toContain("revoked");
    expect(Object.values(update.ExpressionAttributeValues || {})).toContainEqual({
      id: "revoke-active-12",
      kind: "revoke",
    });
    expect(serializedValues(update)).not.toContain(tokenHash);
    expect(serializedValues(update)).not.toContain(nextHash);
    expectNoLegacyAccessKeys([
      {
        Key: update.Key,
      },
    ]);
  });

  it.each([
    ["none", "none"],
    ["revoked", "revoked"],
  ])(
    "preserves %s access state while cancelling the current invitation",
    async (initial, expected) => {
      const current = accessItem({
        access: initial,
        revision: 4,
        currentInvitation: { hash: tokenHash, expiresAt },
      });
      const send = vi.fn(async (command) => {
        if (command instanceof GetCommand) return { Item: current };
        if (command instanceof UpdateCommand) return {};
        throw new Error(`Unexpected DynamoDB command ${command.constructor.name}`);
      });
      const { store } = makeStore(send);

      const result = await callRevokeAccess(store, {
        sub,
        botId,
        expectedRevision: 4,
        operationId: `cancel-${initial}-invite`,
      });

      expect(result).toMatchObject({
        created: true,
        access: { access: expected, revision: 5, lastAdminOperation: { kind: "revoke" } },
      });
      expect(result.access).not.toHaveProperty("currentInvitation");
      expect(result.access.lastAdminOperation).toEqual({
        id: `cancel-${initial}-invite`,
        kind: "revoke",
      });
      const updates = send.mock.calls
        .map(([command]) => command)
        .filter((command) => command instanceof UpdateCommand);
      expect(updates).toHaveLength(1);
      expect(expandedExpression(updates[0].input, "UpdateExpression")).toMatch(/REMOVE/i);
      expect(expandedExpression(updates[0].input, "UpdateExpression")).toMatch(
        /currentInvitation/i,
      );
      if (initial === "none") expect(result.access.access).toBe("none");
    },
  );

  it("returns the current durable revoke result for an unambiguous same-ID replay without writing", async () => {
    const recorded = accessItem({
      access: "revoked",
      revision: 13,
      lastAdminOperation: { id: "same-revoke", kind: "revoke" },
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: recorded };
      throw new Error("A revoke replay must not write");
    });
    const { store } = makeStore(send);

    const result = await callRevokeAccess(store, {
      sub,
      botId,
      expectedRevision: 12,
      operationId: "same-revoke",
    });

    expect(result).toMatchObject({
      created: false,
      access: {
        sub,
        botId,
        access: "revoked",
        revision: 13,
        lastAdminOperation: { id: "same-revoke", kind: "revoke" },
      },
    });
    expect(result.access).not.toHaveProperty("pk");
    expect(result.access).not.toHaveProperty("sk");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: accessKey(),
      ConsistentRead: true,
    });
  });

  it("does not replay a revoke after a later operation changed ACCESS", async () => {
    const laterOperation = accessItem({
      access: "revoked",
      revision: 14,
      currentInvitation: { hash: nextHash, expiresAt },
      lastAdminOperation: { id: "later-invite", kind: "invite", invitationHash: nextHash },
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: laterOperation };
      throw new Error("A stale revoke must not write");
    });
    const { store } = makeStore(send);

    await expect(
      callRevokeAccess(store, {
        sub,
        botId,
        expectedRevision: 13,
        operationId: "old-revoke",
      }),
    ).rejects.toMatchObject({ code: "STATE_CHANGED" });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });

  it("does not rebase a revoke when its revision guard loses", async () => {
    let reads = 0;
    let updates = 0;
    const stale = Object.assign(new Error("ACCESS revision changed"), {
      name: "ConditionalCheckFailedException",
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) {
        reads += 1;
        return {
          Item: accessItem({
            access: "active",
            revision: reads === 1 ? 8 : 9,
            currentInvitation: { hash: tokenHash, expiresAt },
          }),
        };
      }
      if (command instanceof UpdateCommand) {
        updates += 1;
        throw stale;
      }
      throw new Error(`Unexpected DynamoDB command ${command.constructor.name}`);
    });
    const { store } = makeStore(send);

    await expect(
      callRevokeAccess(store, {
        sub,
        botId,
        expectedRevision: 8,
        operationId: "stale-revoke",
      }),
    ).rejects.toMatchObject({ code: "STATE_CHANGED" });
    expect(updates).toBe(1);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(send.mock.calls.filter(([command]) => command instanceof UpdateCommand)).toHaveLength(1);
  });

  it("confirms a lost revoke acknowledgement only when a consistent reread identifies its result", async () => {
    const current = accessItem({
      access: "active",
      revision: 3,
      currentInvitation: { hash: tokenHash, expiresAt },
      activationClaim: {
        invitationHash: nextHash,
        claimedAt: new Date(now).toISOString(),
      },
    });
    const transport = createPhase9AccountTransport();
    transport.setItem(tableName, current);
    const timeout = Object.assign(new Error("DynamoDB response timed out"), {
      name: "TimeoutError",
    });
    let lost = false;
    const documentClient = {
      async send(command) {
        if (command instanceof UpdateCommand && !lost) {
          lost = true;
          await transport.documentClient.send(command);
          throw timeout;
        }
        return transport.documentClient.send(command);
      },
    };
    const store = createAccountStoreAdapter({ documentClient, tableName, now: () => now });

    const result = await callRevokeAccess(store, {
      sub,
      botId,
      expectedRevision: 3,
      operationId: "lost-revoke-ack",
    });

    expect(result).toMatchObject({
      created: false,
      access: {
        access: "revoked",
        revision: 4,
        lastAdminOperation: { id: "lost-revoke-ack", kind: "revoke" },
        activationClaim: current.activationClaim,
      },
    });
    expect(result.access).not.toHaveProperty("currentInvitation");
    expect(transport.commands.filter((command) => command instanceof UpdateCommand)).toHaveLength(
      1,
    );
    expect(transport.getItem(tableName, accessKey())).toMatchObject({
      access: "revoked",
      revision: 4,
    });
  });

  it("fails closed when a lost revoke acknowledgement cannot be identified by rereading ACCESS", async () => {
    const current = accessItem({ access: "active", revision: 3 });
    const timeout = Object.assign(new Error("DynamoDB response timed out"), {
      name: "TimeoutError",
    });
    const send = vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: current };
      if (command instanceof UpdateCommand) throw timeout;
      throw new Error(`Unexpected DynamoDB command ${command.constructor.name}`);
    });
    const { store } = makeStore(send);

    await expect(
      callRevokeAccess(store, {
        sub,
        botId,
        expectedRevision: 3,
        operationId: "unconfirmed-revoke",
      }),
    ).rejects.toBeDefined();
    expect(send.mock.calls.filter(([command]) => command instanceof UpdateCommand)).toHaveLength(1);
    expect(send.mock.calls.filter(([command]) => command instanceof GetCommand)).toHaveLength(2);
  });

  it("rejects overlong operation IDs without writing ACCESS or INVITATION", async () => {
    const send = vi.fn();
    const { store } = makeStore(send);
    const tooLong = "x".repeat(129);

    await expect(
      store.registerInvitation({
        botId,
        sub,
        email: "teacher@example.test",
        tokenHash,
        expiresAt,
        expectedRevision: 0,
        operationId: tooLong,
      }),
    ).rejects.toBeDefined();
    await expect(
      callRevokeAccess(store, {
        sub,
        botId,
        expectedRevision: 0,
        operationId: tooLong,
      }),
    ).rejects.toBeDefined();

    expect(
      send.mock.calls.every(([command]) => command instanceof GetCommand),
      "An invalid operation ID may be validated after a read, but must not write",
    ).toBe(true);
  });
});
