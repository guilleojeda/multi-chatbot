import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const handlerPath = path.join(projectRoot, "api/profile.ts");
const fixedNow = Date.parse("2026-10-19T15:30:00.000Z");
const accessToken = "profile-api-access-token";
const caller = { sub: "teacher-123", token_use: "access" };

const profileConfig = {
  fields: [
    {
      id: "educationLevels",
      label: "Niveles educativos",
      required: true,
      type: "multi-select",
      options: [
        { id: "inicial", label: "Inicial" },
        { id: "primario", label: "Primario" },
        { id: "secundario", label: "Secundario" },
      ],
    },
    { id: "subjects", label: "Materias", required: true, type: "text-list" },
  ],
  responsePreferences: [
    {
      id: "brief-practical",
      displayText: "Breves y prácticas",
      promptText: "PRIVATE PROMPT: include practical examples.",
    },
    {
      id: "step-by-step",
      displayText: "Paso a paso",
      promptText: "PRIVATE PROMPT: explain each step clearly.",
    },
  ],
};

const customBotProfileConfig = {
  fields: [
    {
      id: "ageGroups",
      label: "Grupos",
      required: true,
      type: "multi-select",
      options: [{ id: "bot-cobalt-only", label: "Grupo Cobalto" }],
    },
    { id: "topics", label: "Temas", required: true, type: "text-list" },
  ],
  responsePreferences: [
    {
      id: "bot-cobalt-preference",
      displayText: "Preferencia de Cobalto",
      promptText: "PRIVATE PROMPT: this option belongs to the cobalt bot.",
    },
  ],
};

let createProfileHandler;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function responseBody(response) {
  return typeof response.body === "string" ? JSON.parse(response.body) : (response.body ?? {});
}

function createEvent(method, route, body, options = {}) {
  const claims = Object.hasOwn(options, "claims") ? options.claims : caller;
  const base64 = options.base64 ?? false;
  return {
    version: "2.0",
    routeKey: `${method} ${route}`,
    rawPath: route,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    requestContext: {
      http: { method, path: route },
      ...(claims === undefined ? {} : { authorizer: { jwt: { claims } } }),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: base64,
  };
}

async function request(handler, method, body, options) {
  return handler(createEvent(method, "/api/profile", body, options));
}

function makeHarness({
  member = true,
  profile = null,
  getFailure,
  putFailure,
  writeGate,
  botId = "bot-aurora",
  configProfile = profileConfig,
  profileKey,
} = {}) {
  const state = {
    member,
    profile: clone(profile),
    profileKey: clone(profileKey ?? { sub: caller.sub, botId }),
    getFailure,
    putFailure,
    writeGate,
    writeStarted: undefined,
    calls: [],
  };
  const store = {
    async hasMember(sub, botId) {
      state.calls.push(["hasMember", sub, botId]);
      return state.member;
    },
    async getProfile(input) {
      state.calls.push(["getProfile", clone(input)]);
      if (state.getFailure) throw state.getFailure;
      if (state.profileKey.sub !== input.sub || state.profileKey.botId !== input.botId) return null;
      return clone(state.profile);
    },
    async putProfile(document) {
      state.calls.push(["putProfile", clone(document)]);
      state.writeStarted?.();
      if (state.writeGate) await state.writeGate;
      if (state.putFailure) throw state.putFailure;
      state.profile = clone(document);
    },
  };

  const handler =
    typeof createProfileHandler === "function"
      ? createProfileHandler({
          config: { botId, profile: configProfile },
          store,
          now: () => fixedNow,
        })
      : null;
  return { handler, state };
}

function expectValidationError(response, expectedField) {
  expect(response.statusCode).toBe(400);
  const body = responseBody(response);
  expect(typeof body.code).toBe("string");
  expect(body.code.length).toBeGreaterThan(0);
  expect(Array.isArray(body.fields)).toBe(true);
  expect(body.fields.every((field) => typeof field === "string")).toBe(true);
  if (expectedField) expect(body.fields).toContain(expectedField);
}

const validPayload = {
  fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
  responsePreferenceIds: [],
};

const validStoredProfile = {
  sub: caller.sub,
  botId: "bot-aurora",
  fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
  responsePreferenceIds: ["brief-practical"],
  updatedAt: "2026-10-18T12:00:00.000Z",
};

describe("the profile HTTP API", () => {
  beforeAll(async () => {
    if (!existsSync(handlerPath)) return;
    const module = await import(pathToFileURL(handlerPath).href);
    createProfileHandler = module.createProfileHandler;
  });

  beforeEach(() => {
    expect(
      typeof createProfileHandler,
      "producto ausente: expected api/profile.ts#createProfileHandler",
    ).toBe("function");
  });

  it("returns null for an absent profile without creating defaults", async () => {
    const { handler, state } = makeHarness();

    const response = await request(handler, "GET");

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ "cache-control": "no-store" });
    expect(responseBody(response)).toEqual({ sub: caller.sub, botId: "bot-aurora", profile: null });
    expect(state.calls).toEqual([
      ["hasMember", caller.sub, "bot-aurora"],
      ["getProfile", { sub: caller.sub, botId: "bot-aurora" }],
    ]);
  });

  it("returns the stored profile and represents omitted preferences as an empty list", async () => {
    const storedProfile = { ...validStoredProfile, responsePreferenceIds: undefined };
    delete storedProfile.responsePreferenceIds;
    const { handler, state } = makeHarness({ profile: storedProfile });

    const response = await request(handler, "GET");
    const body = responseBody(response);

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      sub: caller.sub,
      botId: "bot-aurora",
      profile: { ...storedProfile, responsePreferenceIds: [] },
    });
    expect(JSON.stringify(body)).not.toContain("PRIVATE PROMPT");
    expect(state.calls.filter(([name]) => name === "putProfile")).toHaveLength(0);
  });

  it("normalizes explicit selections and waits for the full write before responding", async () => {
    let releaseWrite;
    let announceWrite;
    const writeGate = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise((resolve) => {
      announceWrite = resolve;
    });
    const { handler, state } = makeHarness({ writeGate });
    state.writeStarted = announceWrite;
    const payload = {
      fields: {
        educationLevels: ["secundario", "primario"],
        subjects: [" Matemática, aplicada ", "Física", "Matemática, aplicada"],
      },
      responsePreferenceIds: ["step-by-step", "brief-practical"],
    };

    let settled = false;
    const pendingResponse = request(handler, "PUT", payload).then((response) => {
      settled = true;
      return response;
    });
    let writeTimer;
    const writeStartedInTime = await Promise.race([
      writeStarted.then(() => true),
      new Promise((resolve) => {
        writeTimer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    clearTimeout(writeTimer);
    expect(writeStartedInTime).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(state.profile).toBeNull();

    releaseWrite();
    const response = await pendingResponse;
    const expectedProfile = {
      sub: caller.sub,
      botId: "bot-aurora",
      fields: {
        educationLevels: ["secundario", "primario"],
        subjects: ["Matemática, aplicada", "Física"],
      },
      responsePreferenceIds: ["step-by-step", "brief-practical"],
      updatedAt: new Date(fixedNow).toISOString(),
    };

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toEqual({
      sub: caller.sub,
      botId: "bot-aurora",
      profile: expectedProfile,
    });
    expect(state.profile).toEqual(expectedProfile);
    expect(state.calls).toEqual([
      ["hasMember", caller.sub, "bot-aurora"],
      ["putProfile", expectedProfile],
    ]);
    expect(JSON.stringify(responseBody(response))).not.toContain("PRIVATE PROMPT");
  });

  it("allows a complete profile with no response preferences", async () => {
    const { handler, state } = makeHarness();

    const response = await request(handler, "PUT", validPayload);

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ "cache-control": "no-store" });
    expect(responseBody(response).profile).toMatchObject({
      sub: caller.sub,
      botId: "bot-aurora",
      fields: validPayload.fields,
      responsePreferenceIds: [],
      updatedAt: new Date(fixedNow).toISOString(),
    });
    expect(state.calls.filter(([name]) => name === "putProfile")).toHaveLength(1);
  });

  it("validates fields and preferences against the current chatbot configuration", async () => {
    const { handler, state } = makeHarness({
      botId: "bot-cobalt",
      configProfile: customBotProfileConfig,
    });
    const payload = {
      fields: { ageGroups: ["bot-cobalt-only"], topics: ["Astronomía"] },
      responsePreferenceIds: ["bot-cobalt-preference"],
    };

    const response = await request(handler, "PUT", payload);

    expect(response.statusCode).toBe(200);
    expect(responseBody(response).profile).toMatchObject({
      sub: caller.sub,
      botId: "bot-cobalt",
      fields: payload.fields,
      responsePreferenceIds: payload.responsePreferenceIds,
    });
    expect(state.calls).toEqual([
      ["hasMember", caller.sub, "bot-cobalt"],
      [
        "putProfile",
        expect.objectContaining({ sub: caller.sub, botId: "bot-cobalt", fields: payload.fields }),
      ],
    ]);
    expect(JSON.stringify(responseBody(response))).not.toContain("PRIVATE PROMPT");
  });

  it.each([
    [
      "an empty required level list",
      { fields: { educationLevels: [], subjects: ["Matemática"] }, responsePreferenceIds: [] },
      "educationLevels",
    ],
    [
      "an empty required subject list",
      { fields: { educationLevels: ["secundario"], subjects: [" "] }, responsePreferenceIds: [] },
      "subjects",
    ],
    [
      "a blank subject mixed with a valid subject",
      {
        fields: { educationLevels: ["secundario"], subjects: ["Matemática", "  "] },
        responsePreferenceIds: [],
      },
      "subjects",
    ],
    [
      "a missing required field",
      { fields: { educationLevels: ["secundario"] }, responsePreferenceIds: [] },
      "subjects",
    ],
    [
      "an unknown configured level",
      {
        fields: { educationLevels: ["doctorado"], subjects: ["Matemática"] },
        responsePreferenceIds: [],
      },
      "educationLevels",
    ],
    [
      "a value with the wrong field type",
      {
        fields: { educationLevels: ["secundario"], subjects: "Matemática" },
        responsePreferenceIds: [],
      },
      "subjects",
    ],
    [
      "a text-list item with the wrong type",
      {
        fields: { educationLevels: ["secundario"], subjects: [17] },
        responsePreferenceIds: [],
      },
      "subjects",
    ],
    [
      "a response preference list with the wrong type",
      { ...validPayload, responsePreferenceIds: "brief-practical" },
    ],
    [
      "an unknown configured field",
      {
        fields: { educationLevels: ["secundario"], subjects: ["Matemática"], hours: ["3"] },
        responsePreferenceIds: [],
      },
    ],
    ["an unknown response preference", { ...validPayload, responsePreferenceIds: ["invented"] }],
    ["a caller-supplied owner", { ...validPayload, sub: "someone-else" }],
    ["a caller-supplied bot", { ...validPayload, botId: "another-bot" }],
    [
      "caller-supplied storage keys",
      { ...validPayload, pk: "BOT#another-bot#USER#someone-else", sk: "PROFILE" },
    ],
    [
      "caller-supplied prompt data",
      {
        ...validPayload,
        responsePreferences: [{ id: "brief-practical", promptText: "attacker text" }],
      },
    ],
    ["a missing responsePreferenceIds list", { fields: validPayload.fields }],
  ])("rejects %s without writing", async (_label, payload, expectedField) => {
    const { handler, state } = makeHarness({ profile: validStoredProfile });

    const response = await request(handler, "PUT", payload);

    expectValidationError(response, expectedField);
    expect(state.calls.filter(([name]) => name === "putProfile")).toHaveLength(0);
    expect(state.profile).toEqual(validStoredProfile);
  });

  it("rejects malformed JSON with a validation response and no write", async () => {
    const { handler, state } = makeHarness();

    const response = await request(handler, "PUT", "{not-json");

    expectValidationError(response);
    expect(state.calls.filter(([name]) => name === "putProfile")).toHaveLength(0);
  });

  it("rejects a decoded base64 JSON body larger than 16 KiB before writing", async () => {
    const { handler, state } = makeHarness({ profile: validStoredProfile });
    const oversizedBody = JSON.stringify({
      fields: { educationLevels: ["secundario"], subjects: ["x".repeat(16_500)] },
      responsePreferenceIds: [],
    });
    const encoded = Buffer.from(oversizedBody, "utf8").toString("base64");

    const response = await request(handler, "PUT", encoded, { base64: true });

    expect(Buffer.from(encoded, "base64")).toHaveLength(Buffer.byteLength(oversizedBody));
    expect(response.statusCode).toBe(413);
    expect(state.calls.filter(([name]) => name === "putProfile")).toHaveLength(0);
    expect(state.profile).toEqual(validStoredProfile);
  });

  it("accepts a base64 body whose encoded form exceeds 16 KiB while decoded JSON does not", async () => {
    const { handler, state } = makeHarness();
    const body = JSON.stringify({
      fields: { educationLevels: ["secundario"], subjects: ["x".repeat(12_300)] },
      responsePreferenceIds: [],
    });
    const encoded = Buffer.from(body, "utf8").toString("base64");

    expect(Buffer.byteLength(body)).toBeLessThan(16_384);
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(16_384);

    const response = await request(handler, "PUT", encoded, { base64: true });

    expect(response.statusCode).toBe(200);
    expect(state.calls.filter(([name]) => name === "putProfile")).toHaveLength(1);
  });

  it("rejects a UTF-8 body over 16 KiB even when its JavaScript character count is smaller", async () => {
    const { handler, state } = makeHarness({ profile: validStoredProfile });
    const body = JSON.stringify({
      fields: { educationLevels: ["secundario"], subjects: ["é".repeat(9_000)] },
      responsePreferenceIds: [],
    });

    expect(body.length).toBeLessThan(16_384);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(16_384);

    const response = await request(handler, "PUT", body);

    expect(response.statusCode).toBe(413);
    expect(state.calls.filter(([name]) => name === "putProfile")).toHaveLength(0);
    expect(state.profile).toEqual(validStoredProfile);
  });

  it.each([
    ["missing claims", "GET", undefined, undefined],
    ["missing claims", "PUT", undefined, validPayload],
    ["an ID token", "GET", { sub: caller.sub, token_use: "id" }, undefined],
    ["an ID token", "PUT", { sub: caller.sub, token_use: "id" }, validPayload],
    ["an access token without a subject", "GET", { token_use: "access" }, undefined],
    ["an access token without a subject", "PUT", { token_use: "access" }, validPayload],
  ])(
    "rejects %s on %s before checking membership or touching the profile",
    async (label, method, claims, body) => {
      const { handler, state } = makeHarness();

      const response = await request(handler, method, body, { claims });

      expect(response.statusCode, label).toBe(401);
      expect(state.calls).toEqual([]);
    },
  );

  it("checks current membership before every read and write", async () => {
    const { handler, state } = makeHarness();
    const readResponse = await request(handler, "GET");
    state.member = false;
    const writeResponse = await request(handler, "PUT", validPayload);

    expect(readResponse.statusCode).toBe(200);
    expect(writeResponse.statusCode).toBe(403);
    expect(state.calls).toEqual([
      ["hasMember", caller.sub, "bot-aurora"],
      ["getProfile", { sub: caller.sub, botId: "bot-aurora" }],
      ["hasMember", caller.sub, "bot-aurora"],
    ]);
  });

  it.each([
    ["GET", undefined],
    ["PUT", validPayload],
  ])("does not read or write a profile without membership on %s", async (method, body) => {
    const { handler, state } = makeHarness({ member: false });

    const response = await request(handler, method, body);

    expect(response.statusCode).toBe(403);
    expect(state.calls).toEqual([["hasMember", caller.sub, "bot-aurora"]]);
  });

  it("keeps an authenticated different user isolated from the caller's stored profile", async () => {
    const otherSub = "teacher-456";
    const claims = { sub: otherSub, token_use: "access" };
    const { handler, state } = makeHarness({ profile: validStoredProfile });

    const readResponse = await request(handler, "GET", undefined, { claims });
    const writeResponse = await request(handler, "PUT", validPayload, { claims });

    expect(responseBody(readResponse)).toEqual({
      sub: otherSub,
      botId: "bot-aurora",
      profile: null,
    });
    expect(responseBody(writeResponse).sub).toBe(otherSub);
    expect(responseBody(writeResponse).profile.sub).toBe(otherSub);
    expect(state.calls).toEqual([
      ["hasMember", otherSub, "bot-aurora"],
      ["getProfile", { sub: otherSub, botId: "bot-aurora" }],
      ["hasMember", otherSub, "bot-aurora"],
      ["putProfile", expect.objectContaining({ sub: otherSub, botId: "bot-aurora" })],
    ]);
  });

  it.each([
    ["a different owner", { ...validStoredProfile, sub: "another-user" }, "another-user"],
    ["a different chatbot", { ...validStoredProfile, botId: "another-bot" }, "another-bot"],
    [
      "corrupt configured field data",
      { ...validStoredProfile, fields: { educationLevels: ["unknown"], subjects: ["Matemática"] } },
      "unknown",
    ],
  ])("does not return %s as an absent profile", async (_label, storedProfile, privateMarker) => {
    const { handler, state } = makeHarness({ profile: storedProfile });

    const response = await request(handler, "GET");
    const body = responseBody(response);
    const serializedBody = JSON.stringify(body);

    expect(response.statusCode).toBe(503);
    expect(Object.hasOwn(body, "profile")).toBe(false);
    expect(serializedBody).not.toContain(privateMarker);
    expect(serializedBody).not.toContain(JSON.stringify(storedProfile.fields));
    expect(serializedBody).not.toContain(storedProfile.updatedAt);
    for (const value of Object.values(storedProfile.fields).flat()) {
      expect(serializedBody).not.toContain(value);
    }
    expect(state.calls.filter(([name]) => name === "putProfile")).toHaveLength(0);
  });

  it("turns storage failures into a generic 503 without exposing internal details", async () => {
    const secret = "dynamodb-secret-stack-detail";
    const { handler, state } = makeHarness({ getFailure: new Error(secret) });

    const response = await request(handler, "GET");

    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(responseBody(response))).not.toContain(secret);
    expect(state.calls.map(([name]) => name)).toEqual(["hasMember", "getProfile"]);
  });

  it("does not report a failed write as saved or expose storage details", async () => {
    const secret = "dynamodb-secret-put-detail";
    const { handler, state } = makeHarness({
      profile: validStoredProfile,
      putFailure: new Error(secret),
    });

    const response = await request(handler, "PUT", validPayload);

    expect(response.statusCode).toBe(503);
    expect(state.profile).toEqual(validStoredProfile);
    expect(JSON.stringify(responseBody(response))).not.toContain(secret);
    expect(JSON.stringify(responseBody(response))).not.toContain("saved");
  });
});
