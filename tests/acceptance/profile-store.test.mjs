import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const adapterPath = path.join(projectRoot, "api/profile-store.ts");
const tableName = "account-data-dev";
const input = { sub: "teacher-123", botId: "bot-aurora" };
const ownerBotCases = [
  [
    "same bot, another user",
    { sub: "teacher-456", botId: "bot-aurora" },
    { pk: "BOT#bot-aurora#USER#teacher-456", sk: "PROFILE" },
  ],
  [
    "same user, another bot",
    { sub: "teacher-123", botId: "bot-cobalt" },
    { pk: "BOT#bot-cobalt#USER#teacher-123", sk: "PROFILE" },
  ],
  ["the original user and bot", input, { pk: "BOT#bot-aurora#USER#teacher-123", sk: "PROFILE" }],
];

let createProfileStoreAdapter;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function makeStore(responses = []) {
  const documentClient = { send: vi.fn() };
  for (const response of responses) {
    if (response instanceof Error) documentClient.send.mockRejectedValueOnce(response);
    else documentClient.send.mockResolvedValueOnce(response);
  }
  const store =
    typeof createProfileStoreAdapter === "function"
      ? createProfileStoreAdapter({ documentClient, tableName })
      : null;
  return { documentClient, store };
}

describe("the DynamoDB profile store adapter", () => {
  beforeAll(async () => {
    if (!existsSync(adapterPath)) return;
    const module = await import(pathToFileURL(adapterPath).href);
    createProfileStoreAdapter = module.createProfileStoreAdapter;
  });

  beforeEach(() => {
    expect(
      typeof createProfileStoreAdapter,
      "producto ausente: expected api/profile-store.ts#createProfileStoreAdapter",
    ).toBe("function");
  });

  it.each(ownerBotCases)(
    "reads by the expected key for %s",
    async (_label, ownerBot, expectedKey) => {
      const item = {
        ...expectedKey,
        sub: ownerBot.sub,
        botId: ownerBot.botId,
        fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
        responsePreferenceIds: ["brief-practical"],
        updatedAt: "2026-10-19T15:30:00.000Z",
      };
      const { documentClient, store } = makeStore([{ Item: item }]);

      await expect(store.getProfile(ownerBot)).resolves.toEqual({
        sub: ownerBot.sub,
        botId: ownerBot.botId,
        fields: item.fields,
        responsePreferenceIds: ["brief-practical"],
        updatedAt: item.updatedAt,
      });

      expect(documentClient.send).toHaveBeenCalledTimes(1);
      const command = documentClient.send.mock.calls[0][0];
      expect(command).toBeInstanceOf(GetCommand);
      expect(command.input).toEqual({
        TableName: tableName,
        Key: expectedKey,
        ConsistentRead: true,
      });
    },
  );

  it("returns null only when the profile item is absent", async () => {
    const { documentClient, store } = makeStore([{}]);

    await expect(store.getProfile(input)).resolves.toBeNull();
    expect(documentClient.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });

  it("omits absent preference IDs from the mapped storage document", async () => {
    const item = {
      pk: "BOT#bot-aurora#USER#teacher-123",
      sk: "PROFILE",
      sub: input.sub,
      botId: input.botId,
      fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
      updatedAt: "2026-10-19T15:30:00.000Z",
    };
    const { store } = makeStore([{ Item: item }]);

    const document = await store.getProfile(input);

    expect(document).toEqual({
      sub: input.sub,
      botId: input.botId,
      fields: item.fields,
      updatedAt: item.updatedAt,
    });
    expect(Object.hasOwn(document, "responsePreferenceIds")).toBe(false);
  });

  it.each(ownerBotCases)(
    "writes the complete profile at the expected key for %s without unrelated attributes",
    async (_label, ownerBot, expectedKey) => {
      const profile = {
        sub: ownerBot.sub,
        botId: ownerBot.botId,
        fields: { educationLevels: ["secundario"], subjects: ["Matemática, aplicada"] },
        responsePreferenceIds: ["brief-practical"],
        updatedAt: "2026-10-19T15:30:00.000Z",
      };
      const { documentClient, store } = makeStore([{}]);

      await store.putProfile(profile);

      expect(documentClient.send).toHaveBeenCalledTimes(1);
      const command = documentClient.send.mock.calls[0][0];
      expect(command).toBeInstanceOf(PutCommand);
      expect(command.input).toEqual({
        TableName: tableName,
        Item: {
          ...expectedKey,
          sub: ownerBot.sub,
          botId: ownerBot.botId,
          fields: profile.fields,
          responsePreferenceIds: ["brief-practical"],
          updatedAt: profile.updatedAt,
        },
      });
    },
  );

  it("replaces the whole record and omits the preference attribute when selections are cleared", async () => {
    const persisted = new Map();
    const documentClient = {
      send: vi.fn(async (command) => {
        expect(command).toBeInstanceOf(PutCommand);
        const key = `${command.input.Item.pk}/${command.input.Item.sk}`;
        persisted.set(key, clone(command.input.Item));
        return {};
      }),
    };
    const store = createProfileStoreAdapter({ documentClient, tableName });

    await store.putProfile({
      ...input,
      fields: { educationLevels: ["secundario"], subjects: ["Matemática", "Física"] },
      responsePreferenceIds: ["brief-practical", "step-by-step"],
      updatedAt: "2026-10-19T15:30:00.000Z",
    });
    await store.putProfile({
      ...input,
      fields: { educationLevels: ["primario"], subjects: ["Ciencias"] },
      responsePreferenceIds: [],
      updatedAt: "2026-10-19T15:35:00.000Z",
    });

    const savedRecord = persisted.get("BOT#bot-aurora#USER#teacher-123/PROFILE");
    expect(savedRecord).toEqual({
      pk: "BOT#bot-aurora#USER#teacher-123",
      sk: "PROFILE",
      sub: input.sub,
      botId: input.botId,
      fields: { educationLevels: ["primario"], subjects: ["Ciencias"] },
      updatedAt: "2026-10-19T15:35:00.000Z",
    });
    expect(Object.hasOwn(savedRecord, "responsePreferenceIds")).toBe(false);
    expect(documentClient.send).toHaveBeenCalledTimes(2);
  });
});
