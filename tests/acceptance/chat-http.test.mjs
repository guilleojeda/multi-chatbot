import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const clientPath = path.join(projectRoot, "web/chat-api.ts");
const publicApiPath = path.join(projectRoot, "web/api.ts");
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const queryId = "query-001";
const config = {
  region: "us-east-1",
  userPoolId: "us-east-1_example",
  clientId: "web-client",
  apiBaseUrl: "/api",
  botId: "docentes",
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
  runtimeQualifier: "DEFAULT",
};

function event(type, fields = {}) {
  return { type, ...fields };
}

function frame(payload) {
  return `event: ${payload?.type || "message"}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function streamResponse(chunks, status = 200) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function chunksOf(value, size = 1) {
  const bytes = new TextEncoder().encode(value);
  const chunks = [];
  for (let index = 0; index < bytes.length; index += size) {
    chunks.push(bytes.slice(index, index + size));
  }
  return chunks;
}

function successFrames(id = conversationId, requestId = queryId, answer = "¡Listo, maestra!") {
  return [
    ": keep-alive\n\n",
    frame(event("accepted", { conversationId: id, queryId: requestId, ordinal: 1 })),
    frame(event("text", { queryId: requestId, index: 0, text: answer })),
    frame(event("completed", { queryId: requestId })),
  ];
}

function makeSession({ token = "access-token", restore } = {}) {
  return {
    accessToken: vi.fn(() => token),
    idToken: vi.fn(() => "id-token-must-not-be-used"),
    restore: vi.fn(restore || (async () => null)),
  };
}

async function loadStreamChat() {
  const moduleExists = existsSync(clientPath);
  expect(moduleExists, "Expected the streaming client at web/chat-api.ts").toBe(true);
  if (!moduleExists) return null;

  const module = await import(pathToFileURL(clientPath).href);
  expect(typeof module.streamChat, "Expected streamChat to be the public chat client").toBe(
    "function",
  );
  return typeof module.streamChat === "function" ? module.streamChat : null;
}

async function loadPublicConfigReader() {
  const moduleExists = existsSync(publicApiPath);
  expect(moduleExists, "Expected the public configuration client at web/api.ts").toBe(true);
  if (!moduleExists) return null;

  const module = await import(pathToFileURL(publicApiPath).href);
  expect(
    typeof module.readPublicConfig,
    "Expected readPublicConfig to load the browser config",
  ).toBe("function");
  return typeof module.readPublicConfig === "function" ? module.readPublicConfig : null;
}

function assertRuntimeRequest(call, token = "access-token", operation = "start") {
  const url = new URL(String(call[0]));
  const init = call[1];
  const headers = new Headers(init?.headers);

  expect(url.protocol).toBe("https:");
  expect(url.hostname).toBe("bedrock-agentcore.us-east-1.amazonaws.com");
  expect(url.pathname).toBe(`/runtimes/${encodeURIComponent(config.runtimeArn)}/invocations`);
  expect(url.searchParams.get("qualifier")).toBe(config.runtimeQualifier);
  expect(init?.method).toBe("POST");
  expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(headers.get("accept")).toBe("text/event-stream");
  expect(headers.get("content-type")).toMatch(/application\/json/i);
  expect(headers.get("x-amzn-bedrock-agentcore-runtime-session-id")).toBe(conversationId);
  expect(typeof init?.body).toBe("string");

  const body = JSON.parse(init.body);
  expect(body).toEqual({
    version: 1,
    operation,
    conversationId,
    text: "Armá una actividad de porcentajes.",
  });
  expect(JSON.stringify(body)).not.toMatch(/profile|historial|history|model|prompt/i);
  return { url, headers, body };
}

afterEach(() => vi.unstubAllGlobals());

describe("the direct Runtime chat client", () => {
  it("retains the Runtime ARN and qualifier from the public site configuration", async () => {
    const readPublicConfig = await loadPublicConfigReader();
    if (!readPublicConfig) return;

    const fetch = vi.fn(async () => new Response(JSON.stringify(config), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(readPublicConfig()).resolves.toMatchObject({
      runtimeArn: config.runtimeArn,
      runtimeQualifier: config.runtimeQualifier,
    });
    expect(fetch).toHaveBeenCalledWith("/public-config.json", { cache: "no-store" });
  });

  it("sends a new teacher request over authenticated HTTPS with no client-supplied profile or transcript", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const fetch = vi.fn(async () => streamResponse(successFrames()));
    vi.stubGlobal("fetch", fetch);
    const onEvent = vi.fn();
    const session = makeSession();

    const result = await streamChat(
      config,
      session,
      { operation: "start", conversationId, text: "Armá una actividad de porcentajes." },
      { isActive: () => true, onEvent },
    );

    assertRuntimeRequest(fetch.mock.calls[0]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(session.idToken).not.toHaveBeenCalled();
    expect(session.restore).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "completed" });
    expect(onEvent.mock.calls.map(([item]) => item.type)).toEqual([
      "accepted",
      "text",
      "completed",
    ]);
  });

  it("decodes split UTF-8 and SSE frames while ignoring heartbeats", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const wire = successFrames(
      conversationId,
      queryId,
      "La actividad usa 25 % y conserva acentos: áéíóú.",
    ).join("");
    const fetch = vi.fn(async () => streamResponse(chunksOf(wire)));
    vi.stubGlobal("fetch", fetch);
    const received = [];

    const result = await streamChat(
      config,
      makeSession(),
      { operation: "start", conversationId, text: "Prepará un ejemplo." },
      { isActive: () => true, onEvent: (item) => received.push(item) },
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(received.map(({ type }) => type)).toEqual(["accepted", "text", "completed"]);
    expect(received[1].text).toBe("La actividad usa 25 % y conserva acentos: áéíóú.");
  });

  it("accepts the default SSE message name when JSON carries the application event type", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const fetch = vi.fn(async () =>
      streamResponse([
        frame(event("accepted", { conversationId, queryId, ordinal: 1 })).replace(
          "event: accepted",
          "event: message",
        ),
        frame(event("text", { queryId, index: 0, text: "Respuesta" })).replace(
          "event: text",
          "event: message",
        ),
        frame(event("completed", { queryId })).replace("event: completed", "event: message"),
      ]),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      streamChat(
        config,
        makeSession(),
        { operation: "start", conversationId, text: "Una consulta." },
        { isActive: () => true, onEvent: vi.fn() },
      ),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("delivers text before EOF and waits for the confirmed completed terminal", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const encoder = new TextEncoder();
    let controller;
    const body = new ReadableStream({
      start(current) {
        controller = current;
        current.enqueue(
          encoder.encode(
            frame(event("accepted", { conversationId, queryId, ordinal: 1 })) +
              frame(event("text", { queryId, index: 0, text: "Primer tramo" })),
          ),
        );
      },
    });
    const fetch = vi.fn(
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetch);
    let finished = false;
    let resolveText;
    const sawText = new Promise((resolve) => {
      resolveText = resolve;
    });
    const request = streamChat(
      config,
      makeSession(),
      { operation: "start", conversationId, text: "Escribí una consigna." },
      {
        isActive: () => true,
        onEvent: (item) => {
          if (item.type === "text") resolveText();
        },
      },
    ).finally(() => {
      finished = true;
    });
    const requestOutcome = request.then(
      (result) => ({ result }),
      (error) => ({ error }),
    );

    let timer;
    const arrivedBeforeEof = await Promise.race([
      sawText.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!arrivedBeforeEof) {
      try {
        controller.close();
      } catch {
        // The reader may already have cancelled the stream.
      }
      await requestOutcome;
    }
    expect(arrivedBeforeEof).toBe(true);
    expect(finished).toBe(false);
    controller.enqueue(encoder.encode(frame(event("completed", { queryId }))));
    controller.close();
    await expect(request).resolves.toMatchObject({ status: "completed" });
  });

  it("accepts an ordered failure terminal without treating partial text as complete", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const fetch = vi.fn(async () =>
      streamResponse([
        frame(event("accepted", { conversationId, queryId, ordinal: 1 })),
        frame(event("text", { queryId, index: 0, text: "Borrador parcial" })),
        frame(
          event("failed", {
            queryId,
            code: "model_failure/opaque",
            message: "No se completó.",
            recordStatus: "failed",
          }),
        ),
      ]),
    );
    vi.stubGlobal("fetch", fetch);
    const received = [];

    const result = await streamChat(
      config,
      makeSession(),
      { operation: "start", conversationId, text: "Prepará una actividad." },
      { isActive: () => true, onEvent: (item) => received.push(item) },
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "model_failure/opaque",
      recordStatus: "failed",
    });
    expect(received.map(({ type }) => type)).toEqual(["accepted", "text", "failed"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("continues the same conversation after a confirmed failed follow-up without an automatic retry or client transcript", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const secondQueryId = "query-002";
    const thirdQueryId = "query-003";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse(successFrames(conversationId, queryId, "Respuesta inicial.")),
      )
      .mockResolvedValueOnce(
        streamResponse([
          frame(event("accepted", { conversationId, queryId: secondQueryId, ordinal: 2 })),
          frame(event("text", { queryId: secondQueryId, index: 0, text: "Tramo parcial." })),
          frame(
            event("failed", {
              queryId: secondQueryId,
              code: "model_failure/opaque",
              message: "No se completó.",
              recordStatus: "failed",
            }),
          ),
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          frame(event("accepted", { conversationId, queryId: thirdQueryId, ordinal: 3 })),
          frame(event("text", { queryId: thirdQueryId, index: 0, text: "Seguimiento resuelto." })),
          frame(event("completed", { queryId: thirdQueryId })),
        ]),
      );
    vi.stubGlobal("fetch", fetch);

    const options = { isActive: () => true, onEvent: vi.fn() };
    await expect(
      streamChat(
        config,
        makeSession(),
        {
          operation: "start",
          conversationId,
          text: "Prepará una actividad de porcentajes.",
        },
        options,
      ),
    ).resolves.toMatchObject({ status: "completed" });
    const failed = await streamChat(
      config,
      makeSession(),
      { operation: "message", conversationId, text: "¿Podés aclarar el primer paso?" },
      options,
    );
    expect(failed).toMatchObject({ status: "failed", recordStatus: "failed" });
    expect(fetch).toHaveBeenCalledTimes(2);

    await expect(
      streamChat(
        config,
        makeSession(),
        {
          operation: "message",
          conversationId,
          text: "Continuá con una consigna breve.",
        },
        options,
      ),
    ).resolves.toMatchObject({ status: "completed" });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      {
        version: 1,
        operation: "start",
        conversationId,
        text: "Prepará una actividad de porcentajes.",
      },
      {
        version: 1,
        operation: "message",
        conversationId,
        text: "¿Podés aclarar el primer paso?",
      },
      {
        version: 1,
        operation: "message",
        conversationId,
        text: "Continuá con una consigna breve.",
      },
    ]);
  });

  it("keeps a pre-admission rejection distinct from an uncertain registered result", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const restartedConversationId = "650e8400-e29b-41d4-a716-446655440000";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse([
          frame(
            event("failed", {
              code: "PROFILE_REQUIRED",
              message: "Completá tu perfil para conversar.",
              recordStatus: "not_admitted",
            }),
          ),
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          frame(
            event("accepted", { conversationId: restartedConversationId, queryId, ordinal: 1 }),
          ),
          frame(
            event("failed", {
              queryId,
              code: "PERSISTENCE_UNCONFIRMED",
              message: "No pudimos confirmar el resultado.",
              recordStatus: "unconfirmed",
            }),
          ),
        ]),
      );
    vi.stubGlobal("fetch", fetch);

    const rejectedBeforeAdmission = await streamChat(
      config,
      makeSession(),
      { operation: "start", conversationId, text: "Una consulta." },
      { isActive: () => true, onEvent: vi.fn() },
    );
    const uncertainAfterAdmission = await streamChat(
      config,
      makeSession(),
      {
        operation: "start",
        conversationId: restartedConversationId,
        text: "Una consulta.",
      },
      { isActive: () => true, onEvent: vi.fn() },
    );

    expect(rejectedBeforeAdmission).toMatchObject({
      status: "failed",
      recordStatus: "not_admitted",
    });
    expect(uncertainAfterAdmission).toMatchObject({
      status: "failed",
      recordStatus: "unconfirmed",
    });
    const requests = fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(requests.map(({ operation }) => operation)).toEqual(["start", "start"]);
    expect(requests[0].conversationId).toBe(conversationId);
    expect(requests[1].conversationId).toBe(restartedConversationId);
    expect(requests[1].conversationId).not.toBe(requests[0].conversationId);
  });

  it.each([
    [
      "text before admission",
      [
        event("text", { queryId, index: 0, text: "unexpected" }),
        event("accepted", { conversationId, queryId, ordinal: 1 }),
        event("completed", { queryId }),
      ],
    ],
    [
      "a different query id",
      [
        event("accepted", { conversationId, queryId, ordinal: 1 }),
        event("text", { queryId: "another-query", index: 0, text: "wrong turn" }),
        event("completed", { queryId }),
      ],
    ],
    [
      "a different conversation id",
      [
        event("accepted", {
          conversationId: "650e8400-e29b-41d4-a716-446655440000",
          queryId,
          ordinal: 1,
        }),
        event("completed", { queryId }),
      ],
    ],
    [
      "a skipped text index",
      [
        event("accepted", { conversationId, queryId, ordinal: 1 }),
        event("text", { queryId, index: 1, text: "first fragment" }),
        event("completed", { queryId }),
      ],
    ],
    [
      "completion for another query",
      [
        event("accepted", { conversationId, queryId, ordinal: 1 }),
        event("completed", { queryId: "another-query" }),
      ],
    ],
  ])("rejects %s", async (_caseName, events) => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const fetch = vi.fn(async () => streamResponse(events.map(frame)));
    vi.stubGlobal("fetch", fetch);

    await expect(
      streamChat(
        config,
        makeSession(),
        { operation: "start", conversationId, text: "Una consulta." },
        { isActive: () => true, onEvent: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it.each([
    ["EOF without a terminal", [event("accepted", { conversationId, queryId, ordinal: 1 })]],
    ["malformed application data", ["not-json"]],
    [
      "a wrapper error event without an application terminal",
      ["event: error\ndata: runtime failed\n\n"],
    ],
  ])("does not report success for %s", async (_caseName, chunks) => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const fetch = vi.fn(async () =>
      streamResponse(
        chunks.map((chunk) =>
          typeof chunk === "string" && chunk.startsWith("event:") ? chunk : frame(chunk),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const session = makeSession({
      restore: vi.fn(async () => ({ accessToken: "renewed", idToken: "id" })),
    });
    await expect(
      streamChat(
        config,
        session,
        { operation: "start", conversationId, text: "Una consulta." },
        { isActive: () => true, onEvent: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(session.restore).not.toHaveBeenCalled();
  });

  it("does not report success when the response reader fails", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(frame(event("accepted", { conversationId, queryId, ordinal: 1 }))),
        );
        controller.error(new Error("stream interrupted"));
      },
    });
    const fetch = vi.fn(
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      streamChat(
        config,
        makeSession(),
        { operation: "start", conversationId, text: "Una consulta." },
        { isActive: () => true, onEvent: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects a successful HTTP response that is not an SSE stream", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const session = makeSession({
      restore: vi.fn(async () => ({ accessToken: "renewed", idToken: "id" })),
    });
    const fetch = vi.fn(
      async () =>
        new Response("not an event stream", { headers: { "content-type": "text/plain" } }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      streamChat(
        config,
        session,
        { operation: "start", conversationId, text: "Una consulta." },
        { isActive: () => true, onEvent: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(session.restore).not.toHaveBeenCalled();
  });

  it("renews and replays one 401 only while the view is active and before admission", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    let currentToken = "expired-access";
    const session = makeSession({
      token: currentToken,
      restore: vi.fn(async () => {
        currentToken = "renewed-access";
        return { accessToken: currentToken, idToken: "renewed-id" };
      }),
    });
    session.accessToken.mockImplementation(() => currentToken);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(streamResponse(successFrames()));
    vi.stubGlobal("fetch", fetch);

    const result = await streamChat(
      config,
      session,
      { operation: "message", conversationId, text: "Armá una actividad de porcentajes." },
      { isActive: () => true, onEvent: vi.fn() },
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(session.restore).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[0][1].headers).get("authorization")).toBe(
      "Bearer expired-access",
    );
    expect(new Headers(fetch.mock.calls[1][1].headers).get("authorization")).toBe(
      "Bearer renewed-access",
    );
    expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ operation: "message" });
  });

  it("does not send a request when the view is already inactive", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const session = makeSession({
      restore: vi.fn(async () => ({ accessToken: "renewed", idToken: "id" })),
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      streamChat(
        config,
        session,
        { operation: "start", conversationId, text: "Una consulta." },
        { isActive: () => false, onEvent: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(session.restore).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not refresh or replay a 401 that arrives after the view becomes inactive", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    let active = true;
    let resolveResponse;
    const responsePending = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    const session = makeSession({
      restore: vi.fn(async () => ({ accessToken: "renewed", idToken: "id" })),
    });
    const fetch = vi.fn(() => responsePending);
    vi.stubGlobal("fetch", fetch);

    const request = streamChat(
      config,
      session,
      { operation: "start", conversationId, text: "Una consulta." },
      { isActive: () => active, onEvent: vi.fn() },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    active = false;
    resolveResponse(new Response("", { status: 401 }));

    await expect(request).rejects.toBeInstanceOf(Error);
    expect(session.restore).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a second 401", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const secondSession = makeSession({
      restore: vi.fn(async () => ({ accessToken: "renewed", idToken: "id" })),
    });
    const secondFetch = vi.fn(async () => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", secondFetch);
    await expect(
      streamChat(
        config,
        secondSession,
        { operation: "start", conversationId, text: "Una consulta." },
        { isActive: () => true, onEvent: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(secondSession.restore).toHaveBeenCalledTimes(1);
    expect(secondFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["returns no session", "empty"],
    ["throws", "throws"],
  ])("does not retry a 401 when session restoration %s", async (_description, behavior) => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const session = makeSession({
      restore: vi.fn(async () => {
        if (behavior === "throws") throw new Error("refresh failed");
        return null;
      }),
    });
    const fetch = vi.fn(async () => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      streamChat(
        config,
        session,
        { operation: "start", conversationId, text: "Una consulta." },
        { isActive: () => true, onEvent: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(session.restore).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([403, 500, 503])("does not refresh or retry HTTP %i", async (status) => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const session = makeSession({
      restore: vi.fn(async () => ({ accessToken: "renewed", idToken: "id" })),
    });
    const fetch = vi.fn(async () => new Response("", { status }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      streamChat(
        config,
        session,
        { operation: "start", conversationId, text: "Una consulta." },
        { isActive: () => true, onEvent: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(session.restore).not.toHaveBeenCalled();
  });

  it("does not retry a network failure or an application rejection", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const session = makeSession({
      restore: vi.fn(async () => ({ accessToken: "renewed", idToken: "id" })),
    });
    const fetch = vi.fn(async () => {
      throw new TypeError("connection failed");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      streamChat(
        config,
        session,
        { operation: "start", conversationId, text: "Una consulta." },
        { isActive: () => true, onEvent: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(session.restore).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(
      streamResponse([
        frame(
          event("failed", {
            code: "ACCESS_DENIED",
            message: "No tenés acceso a esta conversación.",
            recordStatus: "not_admitted",
          }),
        ),
      ]),
    );
    await expect(
      streamChat(
        config,
        session,
        { operation: "start", conversationId, text: "Otra consulta." },
        { isActive: () => true, onEvent: vi.fn() },
      ),
    ).resolves.toMatchObject({ status: "failed", recordStatus: "not_admitted" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(session.restore).not.toHaveBeenCalled();
  });

  it("does not fetch without an access token and passes cancellation through to Runtime", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    const fetch = vi.fn(async () => streamResponse(successFrames()));
    vi.stubGlobal("fetch", fetch);
    const noSession = makeSession();
    noSession.accessToken.mockReturnValue(null);
    await expect(
      streamChat(
        config,
        noSession,
        { operation: "start", conversationId, text: "Una consulta." },
        { isActive: () => true, onEvent: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).not.toHaveBeenCalled();

    const abort = new AbortController();
    await streamChat(
      config,
      makeSession(),
      { operation: "start", conversationId, text: "Otra consulta." },
      { isActive: () => true, onEvent: vi.fn(), signal: abort.signal },
    );
    expect(fetch.mock.calls[0][1].signal).toBe(abort.signal);

    const cancelled = new AbortController();
    const pendingFetch = vi.fn(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Request cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", pendingFetch);
    const pending = streamChat(
      config,
      makeSession(),
      { operation: "start", conversationId, text: "Una consulta cancelada." },
      { isActive: () => true, onEvent: vi.fn(), signal: cancelled.signal },
    );
    cancelled.abort();
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(pendingFetch).toHaveBeenCalledTimes(1);
  });

  it("stops delivering queued events once the view becomes inactive", async () => {
    const streamChat = await loadStreamChat();
    if (!streamChat) return;

    let active = true;
    const fetch = vi.fn(async () =>
      streamResponse([
        frame(event("accepted", { conversationId, queryId, ordinal: 1 })) +
          frame(event("text", { queryId, index: 0, text: "No debe llegar" })) +
          frame(event("completed", { queryId })),
      ]),
    );
    vi.stubGlobal("fetch", fetch);
    const received = [];

    const outcome = await streamChat(
      config,
      makeSession(),
      { operation: "start", conversationId, text: "Una consulta." },
      {
        isActive: () => active,
        onEvent: (item) => {
          received.push(item);
          if (item.type === "accepted") active = false;
        },
      },
    ).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    expect(received.map(({ type }) => type)).toEqual(["accepted"]);
    expect(outcome.result?.status).not.toBe("completed");
  });
});
