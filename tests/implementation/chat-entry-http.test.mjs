import { prepareUnchangedContext } from "../support/context-preparation.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const streamConversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const streamQueryId = "a4bfbc9f-3699-4e93-b120-a03c0204bc67";
const savedConversationId = "1c6a7943-c1cb-4c88-a378-fb14655bc35a";
const savedQueryId = "ecf57adf-a0c0-4901-8f0f-cc7993da4bb2";
const quotaConversationId = "8b6e9274-1b77-47f2-b837-6d3f6a26715b";
const quotaQueryId = "a81fed69-2694-40a7-8c27-76a31f0361d8";
const jsonBodyLimitBytes = 32 * 1024 * 1024;

const workers = new Set();
const runtimeEntryBundleDirectories = new Set();
let runtimeEntryModulePromise;

const projectRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function runtimeEntryBundleUrl() {
  if (!runtimeEntryModulePromise) {
    runtimeEntryModulePromise = (async () => {
      const entryPath = path.join(projectRoot, "runtime/entry.ts");
      const outputParentDirectory = path.join(projectRoot, ".work/test-artifacts");
      mkdirSync(outputParentDirectory, { recursive: true });
      const outputDirectory = mkdtempSync(path.join(outputParentDirectory, "http-entry-config-"));
      runtimeEntryBundleDirectories.add(outputDirectory);
      const result = await build({
        entryPoints: [entryPath],
        bundle: true,
        packages: "external",
        platform: "node",
        target: "node24",
        format: "esm",
        write: false,
        plugins: [
          {
            name: "capture-agentcore-entry-config",
            setup(build) {
              build.onResolve({ filter: /^bedrock-agentcore\/runtime$/ }, () => ({
                path: "agentcore-runtime-capture",
                namespace: "entry-capture",
              }));
              build.onLoad({ filter: /.*/, namespace: "entry-capture" }, () => ({
                contents: `
                    export class BedrockAgentCoreApp {
                      constructor(params) { globalThis.__capturedAgentCoreConfig = params.config; }
                      run() {}
                      addAsyncTask() { return 1; }
                      completeAsyncTask() { return true; }
                    }
                  `,
                loader: "js",
              }));
            },
          },
        ],
      });
      const outputPath = path.join(outputDirectory, "entry.mjs");
      writeFileSync(outputPath, result.outputFiles[0].contents);
      return pathToFileURL(outputPath).href;
    })();
  }
  return runtimeEntryModulePromise;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function makeServer({ detached = false, useRuntimeEntryConfig = false } = {}) {
  const port = await freePort();
  const chatPath = fileURLToPath(new URL("../../runtime/chat.ts", import.meta.url));
  const bundle = await build({
    entryPoints: [chatPath],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    write: false,
  });
  const chatModule = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
  const agentCoreModule = import.meta.resolve("bedrock-agentcore/runtime");
  const runtimeEntryModule = useRuntimeEntryConfig ? await runtimeEntryBundleUrl() : undefined;
  const workerCode = `
    import { parentPort, workerData } from "node:worker_threads";
    import { createHash } from "node:crypto";
    import { BedrockAgentCoreApp } from ${JSON.stringify(agentCoreModule)};
    const { createChatHandler, createChatInvocationHandler } = await import(workerData.chatModule);
    const prepareContext = ${prepareUnchangedContext.toString()};
    let appConfig = { logging: { enabled: false } };
    if (workerData.runtimeEntryModule) {
      Object.assign(process.env, {
        BOT_ID: "bot-aurora",
        ACCOUNT_TABLE_NAME: "account-table",
        CONVERSATION_TABLE_NAME: "conversation-table",
        MODEL_ID: "global.anthropic.claude-sonnet-4-6",
        REVISION: "http-acceptance",
        AWS_REGION: "us-east-1",
        KNOWLEDGE_BASE_ID: "kb-http-acceptance",
        DOCUMENTS_REVISION: "http-documents-r1",
        DOCUMENT_PREPARATION_TIMEOUT_MS: "120000",
      });
      await import(workerData.runtimeEntryModule);
      appConfig = globalThis.__capturedAgentCoreConfig;
      parentPort.postMessage({
        type: "runtime-config",
        config: {
          logging: appConfig?.logging,
          contentTypeParsers: appConfig?.contentTypeParsers?.map(({ contentType, parseAs, bodyLimit }) => ({
            contentType, parseAs, bodyLimit,
          })),
        },
      });
    }
    console.info = () => {};

    const streamConversationId = ${JSON.stringify(streamConversationId)};
    const streamQueryId = ${JSON.stringify(streamQueryId)};
    const savedConversationId = ${JSON.stringify(savedConversationId)};
    const savedQueryId = ${JSON.stringify(savedQueryId)};
    const quotaConversationId = ${JSON.stringify(quotaConversationId)};
    const quotaQueryId = ${JSON.stringify(quotaQueryId)};
    const detached = ${JSON.stringify(detached)};
    const now = Date.parse("2026-10-21T15:00:00.000Z");
    const quota = {
      daily: { used: 19, limit: 20, resetAt: now + 3600000, period: "2026-10-21" },
      monthly: { used: 199, limit: 200, resetAt: now + 86400000, period: "2026-10" },
      serverNow: now,
      blockedUntil: null,
      policyRevision: "policy-1",
    };
    const profileConfig = {
      fields: [{ id: "subjects", label: "Materias", required: true, type: "text-list" }],
      responsePreferences: [],
    };
    const profile = {
      sub: "teacher-123",
      botId: "bot-aurora",
      fields: { subjects: ["Matemática"] },
      responsePreferenceIds: [],
      updatedAt: "2026-10-20T12:00:00.000Z",
    };
    const submissions = new Map();
    const metas = new Map();
    let admissionCount = 0;
    let quotaReadCount = 0;
    let providerDispatchCount = 0;
    let releaseAdmission;
    const admissionGate = new Promise((resolve) => { releaseAdmission = resolve; });
    let releaseProvider;
    const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
    parentPort.on("message", (message) => {
      if (message === "release-admission") releaseAdmission();
      if (message === "release-provider") releaseProvider();
      if (message?.type === "inspect-state") {
        parentPort.postMessage({
          type: "state",
          requestId: message.requestId,
          admissionCount,
          quotaReadCount,
          providerDispatchCount,
          taskInfo: app.getAsyncTaskInfo(),
        });
      }
    });
    const fingerprint = (request) => createHash("sha256")
      .update(JSON.stringify([request.operation, request.conversationId, request.baseOrdinal, request.text]))
      .digest("hex");
    const savedRequest = {
      operation: "start",
      conversationId: savedConversationId,
      queryId: savedQueryId,
      baseOrdinal: 0,
      text: "Pedido ya guardado",
    };
    submissions.set(savedQueryId, {
      sub: "teacher-123",
      botId: "bot-aurora",
      conversationId: savedConversationId,
      queryId: savedQueryId,
      requestFingerprint: fingerprint(savedRequest),
      operation: "start",
      baseOrdinal: 0,
      ordinal: 1,
      status: "failed",
      stage: "failed",
      question: savedRequest.text,
      questionManifest: { count: 1, complete: true },
      contextReferences: [],
      answer: "Prefijo parcial",
      answerManifest: { count: 1, complete: false },
      cursor: 1,
      canContinue: false,
      resultDeadlineAt: now + 3600000,
      profileSnapshot: {},
      invocation: { modelId: "global.anthropic.claude-sonnet-4-6" },
      failure: { code: "provider_error" },
    });
    metas.set(savedConversationId, {
      conversationId: savedConversationId,
      sub: "teacher-123",
      botId: "bot-aurora",
      lastOrdinal: 1,
    });

    const store = {
      async getSubmission({ queryId }) { return submissions.get(queryId) ?? null; },
      async getMeta({ conversationId }) { return metas.get(conversationId) ?? null; },
      async readQuota() { quotaReadCount += 1; return quota; },
      async readContext() { return { messages: [], references: [] }; },
      async reconcileTurn({ queryId }) { return submissions.get(queryId) ?? null; },
      async startTurn(input) {
        admissionCount += 1;
        if (input.text.length > 100_000) {
          parentPort.postMessage({ type: "large-text-observed", text: input.text });
        }
        if (input.conversationId === quotaConversationId) {
          const error = new Error("quota exceeded");
          error.code = "quota_exceeded";
          error.quota = quota;
          throw error;
        }
        if (input.conversationId === streamConversationId) {
          parentPort.postMessage({ type: "admission-pending" });
          await admissionGate;
        }
        const submission = {
          sub: input.sub,
          botId: input.botId,
          conversationId: input.conversationId,
          queryId: input.queryId,
          requestFingerprint: input.requestFingerprint,
          operation: "start",
          baseOrdinal: 0,
          ordinal: 1,
          status: "in_progress",
          stage: "admitted",
          question: input.text,
          questionManifest: { count: 1, complete: true },
          contextReferences: [],
          answer: "",
          answerManifest: { count: 0, complete: false },
          cursor: 0,
          canContinue: false,
          resultDeadlineAt: input.resultDeadlineAt,
          profileSnapshot: input.profileSnapshot,
          invocation: input.invocation,
        };
        submissions.set(input.queryId, submission);
        metas.set(input.conversationId, {
          conversationId: input.conversationId,
          sub: input.sub,
          botId: input.botId,
          lastOrdinal: 1,
          activeQueryId: input.queryId,
        });
        return { queryId: input.queryId, ordinal: 1 };
      },
      async continueTurn() { throw new Error("unexpected follow-up"); },
      async claimInvocation({ queryId, ownerAttemptId }) {
        const submission = submissions.get(queryId);
        if (!submission || submission.status !== "in_progress") return false;
        submission.stage = "invocation_claimed";
        submission.ownerAttemptId = ownerAttemptId;
        return true;
      },
      async appendChunk(input) {
        const submission = submissions.get(input.queryId);
        submission.answer += input.text;
        submission.cursor = input.index + 1;
        parentPort.postMessage({ type: "chunk-persisted", queryId: input.queryId, text: input.text });
      },
      async completeTurn(input) {
        const submission = submissions.get(input.queryId);
        submission.status = "completed";
        submission.stage = "complete";
        submission.answerManifest = input.answerManifest;
        submission.canContinue = true;
        const meta = metas.get(input.conversationId);
        if (meta) {
          delete meta.activeQueryId;
          meta.lastQueryId = input.queryId;
        }
        parentPort.postMessage({ type: "terminal-persisted", queryId: input.queryId });
      },
      async failTurn(input) {
        const submission = submissions.get(input.queryId);
        if (submission) {
          submission.status = "failed";
          submission.stage = "failed";
          submission.canContinue = input.providerFinished;
        }
      },
    };

    const chat = createChatHandler({
      config: {
        botId: "bot-aurora",
        profile: profileConfig,
        modelId: "global.anthropic.claude-sonnet-4-6",
        revision: "revision-123",
        systemPrompt: "Ayudá con tareas de enseñanza usando conocimiento general.",
      },
      accounts: { async hasMember() { return true; } },
      profiles: { async getProfile() { return profile; } },
      store,
      prepareContext,
      async prepareDocuments() {
        return {
          knowledgeBaseId: "kb-http-acceptance",
          query: "consulta documental HTTP de prueba",
          revision: "http-documents-r1",
          retrievedAt: now,
          status: "empty",
          results: [],
        };
      },
      async countInputTokens() { return { inputTokens: 42 }; },
      async *generate() {
        providerDispatchCount += 1;
        parentPort.postMessage({
          type: "provider-dispatch",
          taskInfo: app.getAsyncTaskInfo(),
        });
        yield { type: "text", text: "Respuesta de prueba." };
        if (detached) {
          await providerGate;
          yield { type: "text", text: " Continuación durable." };
        }
        yield { type: "result", stopReason: "end_turn" };
      },
      now: () => now,
    });

    let app;
    const tasks = {
      addAsyncTask(...args) { return app.addAsyncTask(...args); },
      completeAsyncTask(...args) { return app.completeAsyncTask(...args); },
    };
    app = new BedrockAgentCoreApp({
      invocationHandler: createChatInvocationHandler(chat, tasks),
      config: appConfig,
    });
    app.run({ port: workerData.port, host: "127.0.0.1" });
  `;
  const workerUrl = `data:text/javascript;base64,${Buffer.from(workerCode).toString("base64")}`;
  const worker = new Worker(new URL(workerUrl), {
    type: "module",
    workerData: { port, chatModule, detached, runtimeEntryModule },
  });
  workers.add(worker);

  let workerError;
  const messages = [];
  worker.on("message", (message) => messages.push(message));
  worker.on("error", (error) => {
    workerError = error;
  });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (workerError) throw workerError;
    try {
      const response = await fetch(`${origin}/ping`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!ready) throw new Error("AgentCore local server did not become ready.");
  return { worker, origin, messages };
}

async function waitForWorkerMessage(worker, messages, type, predicate = () => true) {
  const existing = messages.find((message) => message?.type === type && predicate(message));
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    const onMessage = (message) => {
      if (message?.type !== type || !predicate(message)) return;
      worker.off("message", onMessage);
      worker.off("error", onError);
      resolve(message);
    };
    worker.once("error", onError);
    worker.on("message", onMessage);
  });
}

let nextInspectionId = 0;

async function inspectState(worker, messages) {
  const requestId = ++nextInspectionId;
  worker.postMessage({ type: "inspect-state", requestId });
  return waitForWorkerMessage(
    worker,
    messages,
    "state",
    (message) => message.requestId === requestId,
  );
}

async function post(origin, payload, accept, signal) {
  return fetch(`${origin}/invocations`, {
    method: "POST",
    headers: {
      accept,
      "content-type": "application/json",
      "x-amzn-bedrock-agentcore-runtime-session-id": payload.conversationId,
      authorization: `Bearer e30.${Buffer.from(JSON.stringify({ sub: "teacher-123", token_use: "access" })).toString("base64url")}.runtime-validated`,
    },
    body: JSON.stringify(payload),
    signal,
  });
}

async function postRawJson(origin, body) {
  return fetch(`${origin}/invocations`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body,
  });
}

function postOversizedJson(origin, body) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    let receivedResponse = false;
    const request = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        path: "/invocations",
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body, "utf8"),
        },
      },
      (response) => {
        receivedResponse = true;
        response.resume();
        resolve({ status: response.statusCode });
      },
    );
    request.on("error", (error) => {
      if (receivedResponse) return;
      if (error.code === "EPIPE" || error.code === "ECONNRESET") {
        resolve({ connectionClosed: true, errorCode: error.code });
        return;
      }
      reject(error);
    });
    request.end(body);
  });
}

function expectRuntimeJsonParser(config) {
  expect.soft(config?.contentTypeParsers).toEqual(
    expect.arrayContaining([
      {
        contentType: "application/json",
        parseAs: "string",
        bodyLimit: jsonBodyLimitBytes,
      },
    ]),
  );
}

async function readSseUntil(reader, predicate) {
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE ended before the expected events arrived.");
    text += decoder.decode(value, { stream: true });
    const events = parseSse(text);
    if (predicate(events)) return events;
  }
}

function parseSse(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (!event || !data) return null;
      return { event, data: JSON.parse(data) };
    })
    .filter(Boolean);
}

afterEach(async () => {
  await Promise.all([...workers].map((worker) => worker.terminate()));
  workers.clear();
});

afterAll(() => {
  for (const directory of runtimeEntryBundleDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the real AgentCore HTTP response boundary", () => {
  it("parses escaped JSON over 1 MiB and delivers the exact decoded text to the chat handler", async () => {
    const { worker, origin, messages } = await makeServer({ useRuntimeEntryConfig: true });
    const runtimeConfig = await waitForWorkerMessage(worker, messages, "runtime-config");
    const text = `${"\u0000".repeat(180_000)}\u0001"\\ café 😀`;
    const request = {
      version: 2,
      operation: "start",
      conversationId: "d90fdf5e-2c77-4a9f-b851-5e16aa26715b",
      queryId: "e90fdf5e-2c77-4a9f-b851-5e16aa26715c",
      baseOrdinal: 0,
      text,
    };
    const json = JSON.stringify(request);

    expectRuntimeJsonParser(runtimeConfig.config);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(400 * 1024);

    const observedText = waitForWorkerMessage(worker, messages, "large-text-observed");
    const response = await post(origin, request, "text/event-stream");
    expect.soft(response.status).toBe(200);
    if (response.status === 200) {
      expect.soft(response.headers.get("content-type")).toContain("text/event-stream");
      expect.soft(await observedText).toMatchObject({ type: "large-text-observed", text });
      expect
        .soft(parseSse(await response.text()).map(({ event }) => event))
        .toEqual(["accepted", "text", "completed"]);
      expect
        .soft(messages.filter((message) => message?.type === "provider-dispatch"))
        .toHaveLength(1);
    } else {
      expect.soft(await inspectState(worker, messages)).toMatchObject({
        admissionCount: 0,
        quotaReadCount: 0,
        providerDispatchCount: 0,
      });
    }
  });

  it.each([
    ["malformed JSON", '{"version":2,"text":'],
    ["empty JSON", ""],
    ["prototype-poison JSON", '{"__proto__":{"polluted":true}}'],
    ["constructor-poison JSON", '{"constructor":{"prototype":{"polluted":true}}}'],
  ])("rejects %s before admission or model dispatch", async (_name, body) => {
    const { worker, origin, messages } = await makeServer({ useRuntimeEntryConfig: true });
    const runtimeConfig = await waitForWorkerMessage(worker, messages, "runtime-config");
    expectRuntimeJsonParser(runtimeConfig.config);

    const response = await postRawJson(origin, body);
    expect.soft(response.status).toBe(400);
    expect.soft(await inspectState(worker, messages)).toMatchObject({
      admissionCount: 0,
      quotaReadCount: 0,
      providerDispatchCount: 0,
    });
  });

  it("rejects application/json beyond the configured 32 MiB parser limit before admission", async () => {
    const { worker, origin, messages } = await makeServer({ useRuntimeEntryConfig: true });
    const runtimeConfig = await waitForWorkerMessage(worker, messages, "runtime-config");
    expectRuntimeJsonParser(runtimeConfig.config);
    const oversizedBody = `{"text":"${"x".repeat(jsonBodyLimitBytes)}"}`;
    expect(Buffer.byteLength(oversizedBody, "utf8")).toBeGreaterThan(jsonBodyLimitBytes);

    const response = await postOversizedJson(origin, oversizedBody);
    expect.soft(response.status === 413 || response.connectionClosed === true).toBe(true);
    expect.soft((await fetch(`${origin}/ping`)).status).toBe(200);
    expect.soft(await inspectState(worker, messages)).toMatchObject({
      admissionCount: 0,
      quotaReadCount: 0,
      providerDispatchCount: 0,
    });
  });

  it("waits for admission, streams a new turn, and preserves duplicate, recover, and quota fields", async () => {
    const { worker, origin, messages } = await makeServer();

    const request = {
      version: 2,
      operation: "start",
      conversationId: streamConversationId,
      queryId: streamQueryId,
      baseOrdinal: 0,
      text: "Nuevo pedido",
    };
    const pendingAdmission = waitForWorkerMessage(worker, messages, "admission-pending");
    const streamResponse = post(origin, request, "text/event-stream");
    await pendingAdmission;
    const responseStartedBeforeAdmission = await Promise.race([
      streamResponse.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    expect(responseStartedBeforeAdmission).toBe(false);
    worker.postMessage("release-admission");

    const response = await streamResponse;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const sse = await response.text();
    const streamEvents = parseSse(sse);
    expect(streamEvents.map(({ event }) => event)).toEqual(["accepted", "text", "completed"]);
    expect(streamEvents[0].data).toMatchObject({ type: "accepted", queryId: streamQueryId });
    expect(streamEvents[1].data).toMatchObject({ type: "text", text: "Respuesta de prueba." });
    expect(streamEvents[2].data).toMatchObject({ type: "completed", queryId: streamQueryId });

    const duplicateRequest = {
      version: 2,
      operation: "start",
      conversationId: savedConversationId,
      queryId: savedQueryId,
      baseOrdinal: 0,
      text: "Pedido ya guardado",
    };
    const duplicateResponse = await post(origin, duplicateRequest, "application/json");
    expect(duplicateResponse.status).toBe(200);
    expect(duplicateResponse.headers.get("content-type")).toContain("application/json");
    const duplicate = await duplicateResponse.json();
    expect(duplicate).toMatchObject({
      version: 2,
      conversationId: savedConversationId,
      queryId: savedQueryId,
      status: "failed",
      question: "Pedido ya guardado",
      answer: "Prefijo parcial",
      canContinue: false,
    });

    const recoveryResponse = await post(
      origin,
      {
        version: 2,
        operation: "recover",
        conversationId: savedConversationId,
        queryId: savedQueryId,
      },
      "application/json",
    );
    expect(recoveryResponse.status).toBe(200);
    expect(recoveryResponse.headers.get("content-type")).toContain("application/json");
    expect(await recoveryResponse.json()).toMatchObject({
      conversationId: savedConversationId,
      queryId: savedQueryId,
      canContinue: false,
      answer: "Prefijo parcial",
    });

    const quotaResponse = await post(
      origin,
      {
        version: 2,
        operation: "start",
        conversationId: quotaConversationId,
        queryId: quotaQueryId,
        baseOrdinal: 0,
        text: "Pedido sin cupo",
      },
      "text/event-stream",
    );
    expect(quotaResponse.status).toBe(200);
    expect(quotaResponse.headers.get("content-type")).toContain("text/event-stream");
    const quotaSse = await quotaResponse.text();
    const quotaEvent = parseSse(quotaSse).find(({ event }) => event === "failed");
    expect(quotaEvent?.data).toMatchObject({
      type: "failed",
      code: "quota_exceeded",
      quota: { daily: { used: 19, limit: 20 }, monthly: { used: 199, limit: 200 } },
    });
    expect(messages.filter((message) => message?.type === "provider-dispatch")).toHaveLength(1);
  });

  it("keeps the producer active after an HTTP SSE abort and recovers its durable state", async () => {
    const { worker, origin, messages } = await makeServer({ detached: true });
    const request = {
      version: 2,
      operation: "start",
      conversationId: streamConversationId,
      queryId: streamQueryId,
      baseOrdinal: 0,
      text: "Nuevo pedido que continúa después del corte",
    };
    const controller = new AbortController();
    const pendingAdmission = waitForWorkerMessage(worker, messages, "admission-pending");
    const streamResponsePromise = post(origin, request, "text/event-stream", controller.signal);
    await pendingAdmission;
    worker.postMessage("release-admission");

    const streamResponse = await streamResponsePromise;
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    expect(streamResponse.body).toBeTruthy();
    const reader = streamResponse.body.getReader();
    const eventsBeforeAbort = await readSseUntil(reader, (events) =>
      events.some(({ event }) => event === "text"),
    );
    expect(eventsBeforeAbort.map(({ event }) => event)).toEqual(["accepted", "text"]);
    expect(eventsBeforeAbort[0].data).toMatchObject({
      type: "accepted",
      queryId: streamQueryId,
    });
    expect(eventsBeforeAbort[1].data).toMatchObject({
      type: "text",
      queryId: streamQueryId,
      text: "Respuesta de prueba.",
    });
    await waitForWorkerMessage(worker, messages, "chunk-persisted");

    controller.abort();
    await reader.cancel().catch(() => {});

    const activeState = await inspectState(worker, messages);
    expect(activeState).toMatchObject({
      admissionCount: 1,
      quotaReadCount: 1,
      providerDispatchCount: 1,
      taskInfo: { activeCount: 1 },
    });
    expect(activeState.taskInfo.runningJobs).toHaveLength(1);
    expect(messages.find((message) => message?.type === "provider-dispatch")).toMatchObject({
      taskInfo: { activeCount: 1 },
    });

    const activeRecoveryResponse = await post(
      origin,
      {
        version: 2,
        operation: "recover",
        conversationId: streamConversationId,
        queryId: streamQueryId,
      },
      "application/json",
    );
    expect(activeRecoveryResponse.status).toBe(200);
    expect(activeRecoveryResponse.headers.get("content-type")).toContain("application/json");
    expect(await activeRecoveryResponse.json()).toMatchObject({
      version: 2,
      conversationId: streamConversationId,
      queryId: streamQueryId,
      status: "in_progress",
      question: request.text,
      answer: "Respuesta de prueba.",
      canContinue: false,
    });
    expect(await inspectState(worker, messages)).toMatchObject({
      admissionCount: 1,
      quotaReadCount: 1,
      providerDispatchCount: 1,
      taskInfo: { activeCount: 1 },
    });

    worker.postMessage("release-provider");
    await waitForWorkerMessage(worker, messages, "terminal-persisted");
    let terminalState;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      terminalState = await inspectState(worker, messages);
      if (terminalState.taskInfo.activeCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(terminalState).toMatchObject({
      admissionCount: 1,
      quotaReadCount: 1,
      providerDispatchCount: 1,
      taskInfo: { activeCount: 0, runningJobs: [] },
    });

    const completedRecoveryResponse = await post(
      origin,
      {
        version: 2,
        operation: "recover",
        conversationId: streamConversationId,
        queryId: streamQueryId,
      },
      "application/json",
    );
    expect(completedRecoveryResponse.status).toBe(200);
    expect(await completedRecoveryResponse.json()).toMatchObject({
      version: 2,
      conversationId: streamConversationId,
      queryId: streamQueryId,
      status: "completed",
      question: request.text,
      answer: "Respuesta de prueba. Continuación durable.",
      canContinue: true,
    });
    expect(await inspectState(worker, messages)).toMatchObject({
      admissionCount: 1,
      quotaReadCount: 1,
      providerDispatchCount: 1,
      taskInfo: { activeCount: 0 },
    });
  });
});
