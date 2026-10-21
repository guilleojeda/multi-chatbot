import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const chatApiPath = path.join(projectRoot, "web/chat-api.ts");
const chatScreenPath = path.join(projectRoot, "web/ChatScreen.tsx");
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const firstQueryId = "a4bfbc9f-3699-4a93-b120-a03c0204bc67";
const secondQueryId = "b0d7cf70-ae36-49f4-a1b9-2837633a54ca";
const config = {
  region: "us-east-1",
  userPoolId: "us-east-1_example",
  clientId: "web-client",
  apiBaseUrl: "/api",
  botId: "docentes",
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
  runtimeQualifier: "DEFAULT",
};

const quotaMessagePrefix = "Llegaste al límite de uso, vas a poder seguir usando la aplicación en ";

function event(type, fields = {}) {
  return { type, ...fields };
}

function frame(payload) {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(events, { close = true } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const item of events) controller.enqueue(encoder.encode(frame(item)));
      if (close) controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(snapshot, status = 200) {
  return new Response(JSON.stringify(snapshot), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function makeSession({ token = "access-token", restore } = {}) {
  return {
    accessToken: vi.fn(() => token),
    idToken: vi.fn(() => "id-token-must-not-be-used"),
    restore: vi.fn(restore || (async () => null)),
  };
}

function startRequest(overrides = {}) {
  return {
    version: 2,
    operation: "start",
    conversationId,
    queryId: firstQueryId,
    baseOrdinal: 0,
    text: "Prepará una actividad de porcentajes.",
    ...overrides,
  };
}

async function loadStreamChat() {
  expect(existsSync(chatApiPath), "Expected the client at web/chat-api.ts").toBe(true);
  const module = await import(pathToFileURL(chatApiPath).href);
  expect(typeof module.streamChat).toBe("function");
  return module.streamChat;
}

async function renderChatScreen(state) {
  expect(existsSync(chatScreenPath), "Expected ChatScreen at web/ChatScreen.tsx").toBe(true);
  const [{ ChatScreen }, ReactModule, server] = await Promise.all([
    import(pathToFileURL(chatScreenPath).href),
    import("react"),
    import("react-dom/server"),
  ]);
  const React = ReactModule.default || ReactModule;
  const renderToStaticMarkup = server.renderToStaticMarkup || server.default?.renderToStaticMarkup;
  return renderToStaticMarkup(
    React.createElement(ChatScreen, {
      state,
      onSubmit: () => undefined,
      onSignOut: () => undefined,
      onRetryProfile: () => undefined,
      onReset: () => undefined,
      onCopy: () => undefined,
    }),
  );
}

function plainText(markup) {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quotaNotice(markup) {
  const paragraphs = [...markup.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(([, contents]) =>
    plainText(contents),
  );
  return paragraphs.find((text) => text.startsWith(quotaMessagePrefix)) || null;
}

function makeQuota({
  serverNow,
  dailyUsed = 20,
  monthlyUsed = 200,
  dailyResetAt = serverNow + 8 * 60 * 60 * 1000,
  monthlyResetAt = serverNow + 21 * 24 * 60 * 60 * 1000,
  blockedUntil = Math.max(dailyResetAt, monthlyResetAt),
} = {}) {
  return {
    daily: {
      used: dailyUsed,
      limit: 20,
      resetAt: dailyResetAt,
      period: "2026-10-21",
    },
    monthly: {
      used: monthlyUsed,
      limit: 200,
      resetAt: monthlyResetAt,
      period: "2026-10",
    },
    serverNow,
    blockedUntil,
    policyRevision: "quota-policy-1",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the v2 direct Runtime chat client", () => {
  it("returns a quota rejection and its server view from the SSE failure", async () => {
    const streamChat = await loadStreamChat();
    const serverNow = Date.UTC(2026, 9, 21, 12);
    const quota = makeQuota({ serverNow });
    const request = startRequest();
    const failure = event("failed", {
      code: "quota_exceeded",
      message: "Llegaste al límite de uso.",
      recordStatus: "not_admitted",
      queryId: request.queryId,
      quota,
    });
    const fetch = vi.fn(async () => sseResponse([failure]));
    vi.stubGlobal("fetch", fetch);
    const onEvent = vi.fn();

    const result = await streamChat(config, makeSession(), request, {
      isActive: () => true,
      onEvent,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "failed", code: "quota_exceeded" });
    expect(result.quota).toEqual(quota);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "failed", quota }));
  });

  it("returns a completed duplicate snapshot without creating another request or SSE terminal", async () => {
    const streamChat = await loadStreamChat();
    const request = startRequest({ queryId: secondQueryId });
    const snapshot = {
      version: 2,
      conversationId,
      queryId: secondQueryId,
      ordinal: 1,
      status: "completed",
      question: request.text,
      answer: "Respuesta ya persistida.",
      canContinue: true,
    };
    const fetch = vi.fn(async () => jsonResponse(snapshot));
    vi.stubGlobal("fetch", fetch);
    const onEvent = vi.fn();

    const result = await streamChat(config, makeSession(), request, {
      isActive: () => true,
      onEvent,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
    expect(result).toMatchObject({
      status: snapshot.status,
      conversationId: snapshot.conversationId,
      queryId: snapshot.queryId,
      ordinal: snapshot.ordinal,
      question: snapshot.question,
      answer: snapshot.answer,
      canContinue: snapshot.canContinue,
    });
    expect(onEvent.mock.calls.some(([item]) => item.type === "completed")).toBe(false);
  });

  it.each([
    ["in_progress", "Respuesta parcial durable."],
    ["failed", "Respuesta parcial conservada."],
  ])("preserves a %s JSON snapshot without inventing an SSE terminal", async (status, answer) => {
    const streamChat = await loadStreamChat();
    const request = startRequest({ queryId: secondQueryId });
    const snapshot = {
      version: 2,
      conversationId,
      queryId: secondQueryId,
      ordinal: 1,
      status,
      question: request.text,
      answer,
      canContinue: false,
    };
    const fetch = vi.fn(async () => jsonResponse(snapshot));
    vi.stubGlobal("fetch", fetch);
    const onEvent = vi.fn();

    const result = await streamChat(config, makeSession(), request, {
      isActive: () => true,
      onEvent,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: snapshot.status,
      conversationId: snapshot.conversationId,
      queryId: snapshot.queryId,
      ordinal: snapshot.ordinal,
      question: snapshot.question,
      answer: snapshot.answer,
      canContinue: snapshot.canContinue,
    });
    expect(onEvent.mock.calls.some(([item]) => item.type === "completed")).toBe(false);
    expect(onEvent.mock.calls.some(([item]) => item.type === "failed")).toBe(false);
  });

  it.each([
    ["queryId", { queryId: secondQueryId }],
    ["conversationId", { conversationId: "650e8400-e29b-41d4-a716-446655440000" }],
  ])("rejects a JSON recovery snapshot for a different %s", async (_identityField, identity) => {
    const streamChat = await loadStreamChat();
    const request = startRequest();
    const snapshot = {
      version: 2,
      conversationId,
      queryId: firstQueryId,
      ordinal: 1,
      status: "completed",
      question: request.text,
      answer: "Respuesta de otro envío.",
      canContinue: true,
      ...identity,
    };
    const fetch = vi.fn(async () => jsonResponse(snapshot));
    vi.stubGlobal("fetch", fetch);
    const onEvent = vi.fn();

    await expect(
      streamChat(config, makeSession(), request, { isActive: () => true, onEvent }),
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("the quota state on the chat screen", () => {
  it("uses server availability and clock for daily, monthly, and combined blocks", async () => {
    const serverNow = Date.UTC(2026, 9, 21, 12);
    const dailyResetAt = serverNow + 8 * 60 * 60 * 1000;
    const monthlyResetAt = serverNow + 21 * 24 * 60 * 60 * 1000;
    const commonState = {
      profileStatus: "complete",
      queryStatus: "idle",
      question: "Consulta conservada durante el bloqueo.",
    };
    const cases = [
      [
        "both",
        makeQuota({ serverNow, dailyResetAt, monthlyResetAt, blockedUntil: monthlyResetAt }),
      ],
      [
        "daily",
        makeQuota({
          serverNow,
          dailyUsed: 20,
          monthlyUsed: 199,
          dailyResetAt,
          monthlyResetAt,
          blockedUntil: dailyResetAt,
        }),
      ],
      [
        "monthly",
        makeQuota({
          serverNow,
          dailyUsed: 19,
          monthlyUsed: 200,
          dailyResetAt,
          monthlyResetAt,
          blockedUntil: monthlyResetAt,
        }),
      ],
    ];
    const notices = new Map();

    for (const [label, quota] of cases) {
      const dateNow = vi.spyOn(Date, "now");
      dateNow.mockReturnValue(0);
      const earlyHtml = await renderChatScreen({ ...commonState, quota });
      dateNow.mockReturnValue(monthlyResetAt + 365 * 24 * 60 * 60 * 1000);
      const lateHtml = await renderChatScreen({ ...commonState, quota });
      const earlyNotice = quotaNotice(earlyHtml);
      const lateNotice = quotaNotice(lateHtml);

      expect(earlyNotice).not.toBeNull();
      expect(earlyNotice).toMatch(
        /^Llegaste al límite de uso, vas a poder seguir usando la aplicación en .+/,
      );
      expect(lateNotice).toBe(earlyNotice);
      expect(plainText(earlyHtml)).toContain(commonState.question);
      notices.set(label, earlyNotice);
      dateNow.mockRestore();
    }

    expect(notices.get("both")).toBe(notices.get("monthly"));
    expect(notices.get("daily")).toMatch(/8\s+horas?/i);
    expect(notices.get("monthly")).toMatch(/21\s+d[ií]as?/i);
    expect(notices.get("both")).toMatch(/21\s+d[ií]as?/i);
  });
});
