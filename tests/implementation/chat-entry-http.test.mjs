import { build } from "esbuild";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

const streamConversationId = "c90fdf5e-2c77-4a9f-b851-5e16aa52d4b9";
const streamQueryId = "a4bfbc9f-3699-4e93-b120-a03c0204bc67";
const savedConversationId = "1c6a7943-c1cb-4c88-a378-fb14655bc35a";
const savedQueryId = "ecf57adf-a0c0-4901-8f0f-cc7993da4bb2";
const quotaConversationId = "8b6e9274-1b77-47f2-b837-6d3f6a26715b";
const quotaQueryId = "a81fed69-2694-40a7-8c27-76a31f0361d8";

const workers = new Set();

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

async function makeServer() {
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
  const workerCode = `
    import { parentPort, workerData } from "node:worker_threads";
    import { createHash } from "node:crypto";
    import { BedrockAgentCoreApp } from ${JSON.stringify(agentCoreModule)};
    const { createChatHandler, createChatInvocationHandler } = await import(workerData.chatModule);
    console.info = () => {};

    const streamConversationId = ${JSON.stringify(streamConversationId)};
    const streamQueryId = ${JSON.stringify(streamQueryId)};
    const savedConversationId = ${JSON.stringify(savedConversationId)};
    const savedQueryId = ${JSON.stringify(savedQueryId)};
    const quotaConversationId = ${JSON.stringify(quotaConversationId)};
    const quotaQueryId = ${JSON.stringify(quotaQueryId)};
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
    let releaseAdmission;
    const admissionGate = new Promise((resolve) => { releaseAdmission = resolve; });
    parentPort.on("message", (message) => {
      if (message === "release-admission") releaseAdmission();
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

    const store = {
      async getSubmission({ queryId }) { return submissions.get(queryId) ?? null; },
      async getMeta({ conversationId }) { return metas.get(conversationId) ?? null; },
      async readQuota() { return quota; },
      async readContext() { return { messages: [], references: [] }; },
      async reconcileTurn({ queryId }) { return submissions.get(queryId) ?? null; },
      async startTurn(input) {
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
          canContinue: true,
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
      async *generate() {
        parentPort.postMessage({ type: "provider-dispatch" });
        yield { type: "text", text: "Respuesta de prueba." };
        yield { type: "result", stopReason: "end_turn" };
      },
      now: () => now,
    });

    const app = new BedrockAgentCoreApp({
      invocationHandler: createChatInvocationHandler(chat),
      config: { logging: { enabled: false } },
    });
    app.run({ port: workerData.port, host: "127.0.0.1" });
  `;
  const workerUrl = `data:text/javascript;base64,${Buffer.from(workerCode).toString("base64")}`;
  const worker = new Worker(new URL(workerUrl), {
    type: "module",
    workerData: { port, chatModule },
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

async function waitForWorkerMessage(worker, messages, type) {
  const existing = messages.find((message) => message?.type === type);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    const onMessage = (message) => {
      if (message?.type !== type) return;
      worker.off("message", onMessage);
      worker.off("error", onError);
      resolve(message);
    };
    worker.once("error", onError);
    worker.on("message", onMessage);
  });
}

async function post(origin, payload, accept) {
  return fetch(`${origin}/invocations`, {
    method: "POST",
    headers: {
      accept,
      "content-type": "application/json",
      "x-amzn-bedrock-agentcore-runtime-session-id": payload.conversationId,
      authorization: `Bearer e30.${Buffer.from(JSON.stringify({ sub: "teacher-123", token_use: "access" })).toString("base64url")}.runtime-validated`,
    },
    body: JSON.stringify(payload),
  });
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

describe("the real AgentCore HTTP response boundary", () => {
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
});
