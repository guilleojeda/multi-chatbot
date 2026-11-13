import { describe, expect, it, vi } from "vitest";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { adminSesClientOptions, parseAdminLambdaConfig } from "../../api/admin-config.ts";
import { createAdminHandler } from "../../api/admin.ts";

const catalog = JSON.stringify([
  {
    botId: "docentes",
    projectName: "Docentes",
    accountTableName: "account-docentes",
    conversationTableName: "chat-docentes",
    clientId: "chat-client",
    siteUrl: "https://docentes.example.test/",
    documentTableName: "documents-docentes",
    uploadBucketName: "incoming-docentes",
    documentBucketName: "prepared-docentes",
    incomingPrefix: "incoming/",
    preparedPrefix: "prepared/",
    knowledgeBaseId: "knowledge-base-id",
    dataSourceId: "data-source-id",
    stateMachineArn: "arn:aws:states:us-east-1:118903272638:stateMachine:docentes-admin-documents",
  },
]);

function environment(overrides = {}) {
  return {
    USER_POOL_ID: "pool-id",
    ADMIN_CLIENT_ID: "admin-client",
    ADMIN_GROUP: "global-admin",
    BOT_CATALOG: catalog,
    ...overrides,
  };
}

function event() {
  return {
    version: "2.0",
    rawPath: "/api/admin/bots/docentes/invitations",
    headers: { authorization: "Bearer signed-access-token" },
    requestContext: {
      http: { method: "POST", path: "/api/admin/bots/docentes/invitations" },
      authorizer: {
        jwt: {
          claims: {
            sub: "admin-sub",
            token_use: "access",
            client_id: "admin-client",
            "cognito:groups": ["global-admin"],
          },
        },
      },
    },
    body: JSON.stringify({
      email: "teacher@example.test",
      expectedSub: null,
      expectedRevision: 0,
      operationId: "missing-sender",
    }),
  };
}

function eventWithProjectedGroups(groups, payloadClaims, path = "/api/admin/me", method = "GET") {
  const token = `e30.${Buffer.from(JSON.stringify(payloadClaims)).toString("base64url")}.signature`;
  return {
    version: "2.0",
    rawPath: path,
    headers: { authorization: `Bearer ${token}` },
    requestContext: {
      http: { method, path },
      authorizer: {
        jwt: {
          claims: {
            sub: "admin-sub",
            token_use: "access",
            client_id: "admin-client",
            "cognito:groups": groups,
          },
        },
      },
    },
    ...(method === "POST"
      ? {
          body: JSON.stringify({
            email: "teacher@example.test",
            expectedSub: null,
            expectedRevision: 0,
            operationId: "denied-request",
          }),
        }
      : {}),
  };
}

function adminHandler(config, dependencies = {}) {
  return createAdminHandler({
    config: {
      clientId: config.adminClientId,
      adminGroup: config.adminGroup,
      sender: config.sender,
      invitationTtlMs: config.invitationTtlMs,
      bots: config.bots.map(({ botId, projectName, siteUrl }) => ({
        botId,
        projectName,
        siteUrl,
      })),
    },
    stores: dependencies.stores || {},
    identity: dependencies.identity || { getUserByEmail: vi.fn(), createUser: vi.fn() },
    mail: dependencies.mail || { sendInvitation: vi.fn() },
    now: dependencies.now || (() => 0),
    randomBytes: dependencies.randomBytes || vi.fn(),
  });
}

describe("administrative Lambda configuration", () => {
  it("disables SES client retries so an ambiguous send is never resent automatically", async () => {
    const client = new SESv2Client(adminSesClientOptions("us-east-1"));
    try {
      await expect(client.config.maxAttempts()).resolves.toBe(1);
    } finally {
      client.destroy();
    }
  });

  it("allows a missing production sender while fixing the invitation lifetime and bot catalog", () => {
    const config = parseAdminLambdaConfig(environment());

    expect(config.sender).toBeNull();
    expect(config.invitationTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(config.bots).toEqual([
      {
        botId: "docentes",
        projectName: "Docentes",
        accountTableName: "account-docentes",
        conversationTableName: "chat-docentes",
        clientId: "chat-client",
        siteUrl: "https://docentes.example.test/",
        documentTableName: "documents-docentes",
        uploadBucketName: "incoming-docentes",
        documentBucketName: "prepared-docentes",
        incomingPrefix: "incoming/",
        preparedPrefix: "prepared/",
        knowledgeBaseId: "knowledge-base-id",
        dataSourceId: "data-source-id",
        stateMachineArn:
          "arn:aws:states:us-east-1:118903272638:stateMachine:docentes-admin-documents",
      },
    ]);
  });

  it("rejects insecure and duplicate server catalog entries at startup", () => {
    const insecureCatalog = JSON.stringify([
      {
        botId: "docentes",
        projectName: "Docentes",
        accountTableName: "account-docentes",
        clientId: "chat-client",
        siteUrl: "http://docentes.example.test/",
      },
    ]);
    expect(() => parseAdminLambdaConfig(environment({ BOT_CATALOG: insecureCatalog }))).toThrow(
      /HTTPS origins/,
    );

    const duplicateCatalog = JSON.stringify([
      ...JSON.parse(catalog),
      { ...JSON.parse(catalog)[0], botId: "second" },
    ]);
    expect(() => parseAdminLambdaConfig(environment({ BOT_CATALOG: duplicateCatalog }))).toThrow(
      /must be unique/,
    );
  });

  it.each([
    [
      "missing",
      (bot) => {
        const copy = { ...bot };
        delete copy.conversationTableName;
        return copy;
      },
    ],
    ["blank", (bot) => ({ ...bot, conversationTableName: "  " })],
  ])("rejects a %s conversation table name", (_label, change) => {
    const invalidCatalog = JSON.stringify([change(JSON.parse(catalog)[0])]);

    expect(() => parseAdminLambdaConfig(environment({ BOT_CATALOG: invalidCatalog }))).toThrow(
      /invalid chatbot entry/,
    );
  });

  it("rejects a conversation table shared by distinct chatbot entries", () => {
    const duplicateConversationTable = JSON.stringify([
      JSON.parse(catalog)[0],
      {
        ...JSON.parse(catalog)[0],
        botId: "otro-chatbot",
        projectName: "Otro chatbot",
        accountTableName: "account-otro-chatbot",
      },
    ]);
    expect(() =>
      parseAdminLambdaConfig(environment({ BOT_CATALOG: duplicateConversationTable })),
    ).toThrow(/must be unique/);
  });

  it("fails invitations closed before identity, store, mail, or randomness without a sender", async () => {
    const store = {
      getAccess: vi.fn(),
      getInvitation: vi.fn(),
      registerInvitation: vi.fn(),
      recordInvitationDelivery: vi.fn(),
      reserveActivation: vi.fn(),
      releaseActivation: vi.fn(),
      consumeInvitation: vi.fn(),
    };
    const identity = {
      getUserByEmail: vi.fn(),
      createUser: vi.fn(),
    };
    const mail = { sendInvitation: vi.fn() };
    const randomBytes = vi.fn();
    const config = parseAdminLambdaConfig(environment());
    const handler = adminHandler(config, {
      stores: { docentes: store },
      identity,
      mail,
      randomBytes,
    });

    const response = await handler(event());

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ code: "TRY_AGAIN" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(identity.getUserByEmail).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(mail.sendInvitation).not.toHaveBeenCalled();
    expect(randomBytes).not.toHaveBeenCalled();
  });

  it("reads an array group claim from the same authorizer-validated token when projected claims are strings", async () => {
    const config = parseAdminLambdaConfig(environment());
    const handler = adminHandler(config);
    const payload = {
      sub: "admin-sub",
      client_id: "admin-client",
      token_use: "access",
      "cognito:groups": ["global-admin"],
    };

    const response = await handler(eventWithProjectedGroups("global-admin", payload));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ sub: "admin-sub" });
  });

  it.each([
    ["a non-admin group", ["other-group"], "global-admin"],
    ["a malformed JWT group claim", "global-admin", "global-admin"],
    ["a token whose subject differs from authorizer context", ["global-admin"], "other-sub"],
  ])("rejects %s when projected group claims are strings", async (_label, groups, tokenSub) => {
    const config = parseAdminLambdaConfig(
      environment({ INVITATION_SENDER: "verified-sender@example.test" }),
    );
    const store = {
      getAccess: vi.fn(),
      getInvitation: vi.fn(),
      registerInvitation: vi.fn(),
      recordInvitationDelivery: vi.fn(),
      reserveActivation: vi.fn(),
      releaseActivation: vi.fn(),
      consumeInvitation: vi.fn(),
    };
    const identity = { getUserByEmail: vi.fn(), createUser: vi.fn() };
    const mail = { sendInvitation: vi.fn() };
    const handler = adminHandler(config, {
      stores: { docentes: store },
      identity,
      mail,
    });
    const payload = {
      sub: tokenSub,
      client_id: "admin-client",
      token_use: "access",
      "cognito:groups": groups,
    };

    const response = await handler(
      eventWithProjectedGroups(
        "global-admin",
        payload,
        "/api/admin/bots/docentes/invitations",
        "POST",
      ),
    );

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ code: "FORBIDDEN" });
    expect(identity.getUserByEmail).not.toHaveBeenCalled();
    expect(identity.createUser).not.toHaveBeenCalled();
    expect(store.getAccess).not.toHaveBeenCalled();
    expect(store.registerInvitation).not.toHaveBeenCalled();
    expect(mail.sendInvitation).not.toHaveBeenCalled();
  });
});
