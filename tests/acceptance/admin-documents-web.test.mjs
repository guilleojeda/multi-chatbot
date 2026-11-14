import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApp } from "../../web/AdminApp.tsx";
import {
  bodyText,
  button,
  createAdminWebHarness,
  deferred,
  input,
  jsonResponse,
  status,
} from "../support/phase9-admin-web-harness.mjs";

// Real AdminApp, DOM, File, FormData, and WebCrypto with controlled HTTP services.
// This does not establish S3/Bedrock interoperability, persistence, chat retrieval, or browser layout.
const adminTokens = [{ accessToken: "admin-token", idToken: "admin-id" }];
const bots = [
  { botId: "docentes", projectName: "Docentes" },
  { botId: "robotica", projectName: "Robótica" },
];
const uploadHost = "uploads.example.test";
const uploadFields = {
  key: "incoming/operation-1/archivo.txt",
  "Content-Type": "text/plain",
  "x-amz-checksum-sha256": "opaque-signed-checksum",
  policy: "opaque-policy",
  "x-amz-signature": "opaque-signature",
};
const operationPollIntervalMs = 5_000;
const harnesses = [];

function normalized(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function controlName(element) {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return normalized(ariaLabel);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return normalized(
      labelledBy
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
  }
  return normalized(element.textContent);
}

function getButton(harness, name) {
  const match = button(harness.document, name);
  expect(match, `se esperaba un botón accesible llamado "${name}"`).toBeTruthy();
  return match;
}

function getButtonMatching(harness, pattern) {
  const match = [...harness.document.querySelectorAll("button")].find((candidate) =>
    pattern.test(controlName(candidate)),
  );
  expect(match, `se esperaba un botón que coincida con ${pattern}`).toBeTruthy();
  return match;
}

function findDocumentAction(harness, action, documentName) {
  const actionPattern = new RegExp(action, "i");
  const documentNameKey = normalized(documentName).toLocaleLowerCase();
  return [...harness.document.querySelectorAll("button")].find((candidate) => {
    const accessibleName = controlName(candidate);
    if (!actionPattern.test(accessibleName)) return false;
    if (accessibleName.toLocaleLowerCase().includes(documentNameKey)) return true;
    const row = candidate.closest('[role="listitem"], li, article, tr, section');
    return Boolean(
      row && normalized(row.textContent).toLocaleLowerCase().includes(documentNameKey),
    );
  });
}

function getDocumentAction(harness, action, documentName) {
  const match = findDocumentAction(harness, action, documentName);
  expect(match, `se esperaba la acción "${action}" asociada a "${documentName}"`).toBeTruthy();
  return match;
}

function expectUnavailable(control) {
  expect(!control || control.disabled || control.getAttribute("aria-disabled") === "true").toBe(
    true,
  );
}

function getInput(harness, name, tagName = "input") {
  const match = input(harness.document, name, tagName);
  expect(match, `se esperaba un control accesible llamado "${name}"`).toBeTruthy();
  return match;
}

function getSectionControl(harness, name) {
  const match = [
    ...harness.document.querySelectorAll('[aria-label="Secciones administrativas"] button'),
  ].find((candidate) => controlName(candidate) === name);
  expect(match, `se esperaba la sección "${name}"`).toBeTruthy();
  return match;
}

function botFromPath(path) {
  return path.split("/")[4];
}

function listPath(botId) {
  return `/api/admin/bots/${botId}/documents`;
}

function listView(botId, { documents = [], activeOperation = null, lastOperation = null } = {}) {
  return jsonResponse({
    botId,
    documents,
    nextCursor: null,
    activeOperation,
    lastOperation,
  });
}

function operationView(operationId, action = "upload", overrides = {}) {
  return {
    operationId,
    documentId: "document-1",
    action,
    status: "processing",
    stage: "ingestion",
    revision: "revision-1",
    updatedAt: "2026-11-13T12:00:00.000Z",
    canRetry: false,
    ...overrides,
  };
}

function documentView(overrides = {}) {
  return {
    documentId: "document-1",
    name: "Guía preparada.txt",
    sizeBytes: 18,
    revision: "revision-1",
    updatedAt: "2026-11-13T12:00:00.000Z",
    canReplace: true,
    processing: { status: "completed", operationId: "operation-1" },
    ...overrides,
  };
}

function uploadTicket(operationId, fileName, sha256) {
  return {
    url: `https://${uploadHost}/bucket?signature=opaque`,
    fields: {
      ...uploadFields,
      key: `incoming/${operationId}/${fileName}`,
      "x-amz-meta-file-sha256": sha256,
    },
    expiresAt: Date.now() + 60_000,
  };
}

function installDocumentRoutes(harness, behavior = {}) {
  const operationActions = new Map();
  harness.route("GET", "/api/admin/me", async () => jsonResponse({ sub: "admin-sub" }));
  harness.route("GET", "/api/admin/bots", async () => jsonResponse({ bots }));
  harness.route("GET", /^\/api\/admin\/bots\/[^/]+\/quota$/, async ({ path }) =>
    jsonResponse({
      botId: botFromPath(path),
      policy: { dailyLimit: 20, monthlyLimit: 200, revision: "q1" },
    }),
  );
  harness.route(
    "GET",
    /^\/api\/admin\/bots\/[^/]+\/documents$/,
    behavior.list ?? (async ({ path }) => listView(botFromPath(path))),
  );
  harness.route("POST", /^\/api\/admin\/bots\/[^/]+\/document-operations$/, async (request) => {
    const { body, path } = request;
    const botId = botFromPath(path);
    operationActions.set(body.operationId, body.action);
    if (behavior.create) return behavior.create(request);
    const includesUpload = body.action === "upload" || body.action === "replace";
    const operation = operationView(body.operationId, body.action, {
      status: includesUpload ? "awaiting_upload" : "pending_start",
      stage: includesUpload ? "upload" : "source",
      documentId: body.documentId ?? "document-1",
      canRetry: false,
    });
    return jsonResponse(
      {
        botId,
        operation,
        ...(includesUpload
          ? { upload: uploadTicket(body.operationId, body.file.name, body.file.sha256) }
          : {}),
      },
      201,
    );
  });
  harness.route(
    "POST",
    /^\/api\/admin\/bots\/[^/]+\/document-operations\/[^/]+\/start$/,
    async (request) => {
      if (behavior.start) return behavior.start(request);
      const { path } = request;
      const operationId = path.split("/")[6];
      const botId = botFromPath(path);
      return jsonResponse(
        {
          botId,
          operation: operationView(operationId, operationActions.get(operationId) ?? "upload"),
        },
        202,
      );
    },
  );
  harness.route(
    "GET",
    /^\/api\/admin\/bots\/[^/]+\/document-operations\/[^/]+$/,
    behavior.readOperation ??
      (async ({ path }) => {
        const operationId = path.split("/").at(-1);
        const botId = botFromPath(path);
        const action = operationActions.get(operationId) ?? "upload";
        return jsonResponse({
          botId,
          operation: operationView(operationId, action, {
            status: "completed",
            stage: "result",
          }),
        });
      }),
  );
  harness.route(
    "POST",
    "/bucket",
    behavior.upload ?? (async () => new Response(null, { status: 204 })),
    { hostname: uploadHost },
  );
}

async function startAdmin({ behavior, restoreResults = adminTokens, fakeTimers = false } = {}) {
  const harness = await createAdminWebHarness(AdminApp, { restoreResults: [...restoreResults] });
  harnesses.push(harness);
  if (fakeTimers) harness.useFakeTimers();
  installDocumentRoutes(harness, behavior);
  await harness.mount();
  return harness;
}

async function openSection(harness, name) {
  await harness.click(getSectionControl(harness, name));
}

async function openDocuments(harness) {
  await openSection(harness, "Documentos");
}

function documentCalls(harness, method, suffixPattern) {
  return harness.apiRequests.filter(
    (request) =>
      request.hostname === "localhost" &&
      request.method === method &&
      request.path.startsWith("/api/admin/bots/") &&
      suffixPattern.test(request.path),
  );
}

function uploadRequests(harness) {
  return harness.apiRequests.filter((request) => request.hostname === uploadHost);
}

function makeFile(harness, name, contents = "contenido preparado", type = "text/plain") {
  return new harness.dom.window.File([contents], name, { type });
}

async function chooseFile(harness, file) {
  await harness.setFiles(getInput(harness, "Documento preparado"), [file]);
}

async function submitFile(harness, file, { expectIntent = true } = {}) {
  await chooseFile(harness, file);
  await harness.click(getButton(harness, "Cargar y procesar"));
  if (expectIntent) await waitForRequest(harness, "POST", /\/document-operations$/);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function waitFor(assertion) {
  await vi.waitFor(assertion, { interval: 10, timeout: 10_000 });
}

async function waitForRequest(harness, method, suffixPattern, count = 1) {
  await waitFor(() => {
    expect(documentCalls(harness, method, suffixPattern).length).toBeGreaterThanOrEqual(count);
  });
}

async function waitForText(harness, pattern) {
  await waitFor(() => expect(bodyText(harness.document)).toMatch(pattern));
}

async function waitForPollRequest(harness, suffixPattern, count = 1) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (documentCalls(harness, "GET", suffixPattern).length >= count) return;
    await harness.advanceTimers(operationPollIntervalMs);
  }
  expect(documentCalls(harness, "GET", suffixPattern).length).toBeGreaterThanOrEqual(count);
}

async function waitForPollText(harness, pattern) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (pattern.test(bodyText(harness.document))) return;
    await harness.advanceTimers(operationPollIntervalMs);
  }
  expect(bodyText(harness.document)).toMatch(pattern);
}

async function expectExactUpload(harness, file, contents, fields = uploadFields) {
  const [request] = uploadRequests(harness);
  expect(uploadRequests(harness)).toHaveLength(1);
  expect(request.method).toBe("POST");
  expect(request.url.href).toBe(`https://${uploadHost}/bucket?signature=opaque`);
  expect(request.headers.has("authorization")).toBe(false);
  expect(request.rawBody).toBeInstanceOf(harness.dom.window.FormData);
  const entries = [...request.rawBody.entries()];
  const fieldEntries = entries.slice(0, -1);
  expect(new Set(fieldEntries.map(([name]) => name))).toEqual(new Set(Object.keys(fields)));
  expect(fieldEntries).toHaveLength(Object.keys(fields).length);
  expect(Object.fromEntries(fieldEntries)).toEqual(fields);
  const [fileField, receivedFile] = entries.at(-1);
  expect(fileField).toBe("file");
  expect(receivedFile).toBeInstanceOf(harness.dom.window.File);
  expect(receivedFile.name).toBe(file.name);
  expect(receivedFile.type).toBe(file.type);
  expect(Buffer.from(await receivedFile.arrayBuffer())).toEqual(Buffer.from(contents));
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AdminApp: administración documental desde la web (11.1)", () => {
  it("consulta la lista del chatbot sin buscar personas ni pedir email, y muestra el estado vacío", async () => {
    const harness = await startAdmin();

    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    await waitForText(harness, /no hay documentos|todavía no hay documentos/i);

    expect(documentCalls(harness, "GET", /\/documents$/)).toHaveLength(1);
    expect(documentCalls(harness, "GET", /\/documents$/)[0].path).toBe(listPath("docentes"));
    expect(harness.apiRequests.some(({ path }) => /\/people\/lookup$/.test(path))).toBe(false);
    expect(input(harness.document, "Email")).toBeUndefined();
    expect(bodyText(harness.document)).toMatch(/no hay documentos|todavía no hay documentos/i);
    expect(getInput(harness, "Chatbot", "select").value).toBe("docentes");
    expect(bodyText(harness.document)).toContain("Docentes");
  });

  it("anuncia carga, mueve el foco al error y permite reintentar la lista", async () => {
    const firstRead = deferred();
    let reads = 0;
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        list: async ({ path }) => {
          reads += 1;
          if (reads === 1) return firstRead.promise;
          return listView(botFromPath(path));
        },
      },
    });

    await openDocuments(harness);
    expect(status(harness.document).join(" ")).toMatch(/carg|consult/i);
    firstRead.resolve(jsonResponse({ code: "DOCUMENTS_UNAVAILABLE" }, 503));
    await waitForText(harness, /no pudimos|error|reintentar/i);

    const alert = harness.document.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(normalized(alert.textContent)).toMatch(/no pudimos|error|reintentar/i);
    expect(harness.document.activeElement).toBe(alert);
    await harness.click(getButtonMatching(harness, /reintentar|actualizar/i));

    await waitForRequest(harness, "GET", /\/documents$/, 2);
    await waitForText(harness, /no hay documentos|todavía no hay documentos/i);
    expect(reads).toBe(2);
    expect(bodyText(harness.document)).toMatch(/no hay documentos|todavía no hay documentos/i);
    expect(documentCalls(harness, "POST", /document-operations$/)).toHaveLength(0);
    expect(uploadRequests(harness)).toHaveLength(0);
  });

  it("no convierte la intención 201 ni el inicio 202 en éxito: sigue la operación hasta completed", async () => {
    const contents = "criterio de evaluación con reflexión individual";
    let reads = 0;
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        start: async ({ path }) =>
          jsonResponse(
            {
              botId: botFromPath(path),
              operation: operationView(path.split("/")[6], "upload", {
                status: "completed",
                stage: "result",
              }),
            },
            202,
          ),
        readOperation: async ({ path }) => {
          reads += 1;
          const operationId = path.split("/").at(-1);
          const botId = botFromPath(path);
          return jsonResponse({
            botId,
            operation: operationView(operationId, "upload", {
              status: reads < 2 ? "processing" : "completed",
              stage: reads < 2 ? "ingestion" : "result",
            }),
          });
        },
      },
    });
    await openDocuments(harness);
    const file = makeFile(harness, "Criterios de evaluación.txt", contents);
    await submitFile(harness, file);
    await waitFor(() => expect(uploadRequests(harness)).toHaveLength(1));
    await waitForRequest(harness, "POST", /\/start$/);
    await waitForPollRequest(harness, /\/document-operations\/[^/]+$/);
    await harness.settle();
    expect(bodyText(harness.document)).toMatch(/procesando|en curso/i);

    const [intent] = documentCalls(harness, "POST", /\/document-operations$/);
    expect(intent.body).toEqual({
      operationId: expect.any(String),
      action: "upload",
      file: { name: file.name, sizeBytes: file.size, sha256: sha256(contents) },
    });
    expect(intent.body.operationId).not.toBe("");
    expect(intent.headers.get("authorization")).toBe("Bearer admin-token");
    const [start] = documentCalls(harness, "POST", /\/start$/);
    expect(start.path).toBe(
      `/api/admin/bots/docentes/document-operations/${intent.body.operationId}/start`,
    );
    expect(start.body === undefined || Object.keys(start.body).length === 0).toBe(true);
    const signedFields = {
      ...uploadFields,
      key: `incoming/${intent.body.operationId}/${file.name}`,
      "x-amz-meta-file-sha256": sha256(contents),
    };
    await expectExactUpload(harness, file, contents, signedFields);
    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");

    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");
    await waitForPollText(harness, /Procesamiento completado/);

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(bodyText(harness.document)).toContain(
      "Procesamiento completado. Los cambios pueden tardar unos minutos en aparecer en el chat",
    );
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
    expect(documentCalls(harness, "POST", /publish|\/documents\/[^/]+\/publish/i)).toHaveLength(0);
    expect([...harness.document.querySelectorAll("button")].map(controlName)).not.toContain(
      "Publicar",
    );
  });

  it("reemplaza sobre la revisión observada, conserva la identidad y muestra B después de completed", async () => {
    let lists = 0;
    let reads = 0;
    let startConfirmed = false;
    let operationCompleted = false;
    let completedListReads = 0;
    let replacementIntent;
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        list: async ({ path }) => {
          lists += 1;
          if (!operationCompleted) {
            return listView(botFromPath(path), {
              documents: [
                documentView({
                  documentId: "document-a",
                  name: "Criterios A.pdf",
                  sizeBytes: 1_234,
                  revision: "revision-a",
                  processing: {
                    status: startConfirmed ? "processing" : "completed",
                    operationId: startConfirmed ? replacementIntent.operationId : "old-operation",
                  },
                }),
              ],
              activeOperation:
                startConfirmed && replacementIntent
                  ? operationView(replacementIntent.operationId, "replace", {
                      documentId: "document-a",
                      status: "processing",
                    })
                  : null,
            });
          }
          completedListReads += 1;
          return listView(botFromPath(path), {
            documents: [
              documentView({
                documentId: "document-a",
                name: replacementIntent.file.name,
                sizeBytes: replacementIntent.file.sizeBytes,
                revision: "revision-b",
                processing: { status: "completed", operationId: replacementIntent.operationId },
              }),
            ],
            lastOperation: operationView(replacementIntent.operationId, "replace", {
              documentId: "document-a",
              status: "completed",
              stage: "result",
              revision: "revision-b",
            }),
          });
        },
        create: async ({ body, path }) => {
          replacementIntent = body;
          return jsonResponse(
            {
              botId: botFromPath(path),
              operation: operationView(body.operationId, "replace", {
                documentId: body.documentId,
                status: "awaiting_upload",
                stage: "upload",
              }),
              upload: uploadTicket(body.operationId, body.file.name, body.file.sha256),
            },
            201,
          );
        },
        start: async ({ path }) => {
          startConfirmed = true;
          return jsonResponse(
            {
              botId: botFromPath(path),
              operation: operationView(path.split("/")[6], "replace", {
                documentId: "document-a",
              }),
            },
            202,
          );
        },
        readOperation: async ({ path }) => {
          reads += 1;
          operationCompleted = reads >= 2;
          const operationId = path.split("/").at(-1);
          return jsonResponse({
            botId: botFromPath(path),
            operation: operationView(operationId, "replace", {
              documentId: "document-a",
              status: reads === 1 ? "processing" : "completed",
              stage: reads === 1 ? "ingestion" : "result",
              revision: "revision-b",
            }),
          });
        },
      },
    });
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    const sourceName = "Criterios A.pdf";
    const nextContent = "el cierre se realiza con una reflexión grupal";
    const nextFile = makeFile(harness, "Criterios B.txt", nextContent, "text/plain");
    await harness.click(getDocumentAction(harness, "Reemplazar", sourceName));
    await chooseFile(harness, nextFile);
    await harness.click(getButton(harness, "Reemplazar y procesar"));
    await waitForRequest(harness, "POST", /\/document-operations$/);
    await waitFor(() => expect(uploadRequests(harness)).toHaveLength(1));
    await waitForRequest(harness, "POST", /\/start$/);
    await waitForPollRequest(harness, /\/document-operations\/[^/]+$/);
    await harness.settle();

    expect(replacementIntent).toEqual({
      operationId: expect.any(String),
      action: "replace",
      documentId: "document-a",
      expectedRevision: "revision-a",
      file: { name: nextFile.name, sizeBytes: nextFile.size, sha256: sha256(nextContent) },
    });
    expect(bodyText(harness.document)).toMatch(/procesando|en curso/i);
    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");
    const [start] = documentCalls(harness, "POST", /\/start$/);
    expect(start.path).toBe(
      `/api/admin/bots/docentes/document-operations/${replacementIntent.operationId}/start`,
    );
    expect(start.body === undefined || Object.keys(start.body).length === 0).toBe(true);
    await expectExactUpload(harness, nextFile, nextContent, {
      ...uploadFields,
      key: `incoming/${replacementIntent.operationId}/${nextFile.name}`,
      "x-amz-meta-file-sha256": sha256(nextContent),
    });
    await waitForPollText(harness, /Procesamiento completado/);
    await waitFor(() => expect(completedListReads).toBeGreaterThan(0));
    await waitForText(harness, /Criterios B\.txt/);

    expect(lists).toBeGreaterThanOrEqual(2);
    expect(bodyText(harness.document)).toContain("Criterios B.txt");
    expect(bodyText(harness.document)).not.toContain(sourceName);
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(1);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
    expect(uploadRequests(harness)).toHaveLength(1);
  });

  it("cancela un reemplazo antes de enviar sin crear intención, subir ni iniciar", async () => {
    const harness = await startAdmin({
      behavior: {
        list: async ({ path }) =>
          listView(botFromPath(path), {
            documents: [
              documentView({
                documentId: "document-a",
                name: "Criterios A.pdf",
                revision: "revision-a",
              }),
            ],
          }),
      },
    });
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    await harness.click(getDocumentAction(harness, "Reemplazar", "Criterios A.pdf"));
    await chooseFile(
      harness,
      makeFile(harness, "Criterios B.txt", "contenido nuevo", "text/plain"),
    );
    expect(getButton(harness, "Reemplazar y procesar").disabled).toBe(false);

    await harness.click(getButtonMatching(harness, /cancelar/i));

    expect(bodyText(harness.document)).toContain("Criterios A.pdf");
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(0);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(0);
    expect(uploadRequests(harness)).toHaveLength(0);
  });

  it("tras STATE_CHANGED vuelve a leer la revisión sin reenviar el reemplazo", async () => {
    let lists = 0;
    let revisionChanged = false;
    let staleRevisionRead = false;
    const harness = await startAdmin({
      behavior: {
        list: async ({ path }) => {
          lists += 1;
          const currentRevisionObserved = revisionChanged;
          if (currentRevisionObserved) staleRevisionRead = true;
          return listView(botFromPath(path), {
            documents: [
              documentView({
                documentId: "document-a",
                name: currentRevisionObserved ? "Criterios A actualizado.pdf" : "Criterios A.pdf",
                revision: currentRevisionObserved ? "revision-b" : "revision-a",
              }),
            ],
          });
        },
        start: async () => {
          revisionChanged = true;
          return jsonResponse({ code: "STATE_CHANGED" }, 409);
        },
        readOperation: async ({ path }) =>
          jsonResponse({
            botId: botFromPath(path),
            operation: operationView(path.split("/").at(-1), "replace", {
              documentId: "document-a",
              status: "failed",
              stage: "validation",
              error: { code: "STATE_CHANGED", message: "La revisión cambió antes de iniciar." },
            }),
          }),
      },
    });
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    const file = makeFile(harness, "Criterios B.txt", "cambio concurrente", "text/plain");
    await harness.click(getDocumentAction(harness, "Reemplazar", "Criterios A.pdf"));
    await chooseFile(harness, file);
    await harness.click(getButton(harness, "Reemplazar y procesar"));
    await waitForRequest(harness, "POST", /\/document-operations$/);
    await waitFor(() => expect(uploadRequests(harness)).toHaveLength(1));
    await waitForRequest(harness, "POST", /\/start$/);
    await waitForText(harness, /cambió|actualizá|revisión|versión/i);

    if (!staleRevisionRead) {
      await harness.click(getButtonMatching(harness, /actualizar|consultar|reintentar/i));
      await waitFor(() => expect(staleRevisionRead).toBe(true));
    }
    await waitForText(harness, /Criterios A actualizado\.pdf/);

    const [intent] = documentCalls(harness, "POST", /\/document-operations$/);
    expect(intent.body).toMatchObject({
      action: "replace",
      documentId: "document-a",
      expectedRevision: "revision-a",
    });
    expect(lists).toBeGreaterThanOrEqual(2);
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(1);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
    expect(uploadRequests(harness)).toHaveLength(1);
    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");
  });

  it("permite cancelar la confirmación de retirada sin mutación", async () => {
    const harness = await startAdmin({
      behavior: {
        list: async ({ path }) =>
          listView(botFromPath(path), {
            documents: [
              documentView({
                documentId: "document-a",
                name: "Criterios A.pdf",
                revision: "revision-a",
              }),
            ],
          }),
      },
    });
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    await harness.click(getDocumentAction(harness, "Retirar", "Criterios A.pdf"));

    expect(getButtonMatching(harness, /confirmar/i).disabled).toBe(false);
    expect(bodyText(harness.document)).toContain("Criterios A.pdf");
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(0);
    expect(uploadRequests(harness)).toHaveLength(0);

    await harness.click(getButtonMatching(harness, /cancelar/i));

    expect(bodyText(harness.document)).toContain("Criterios A.pdf");
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(0);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(0);
    expect(uploadRequests(harness)).toHaveLength(0);
  });

  it("confirma la retirada, espera completed, quita la fila y conserva el resultado al volver", async () => {
    let lists = 0;
    let reads = 0;
    let operationId = "";
    let startConfirmed = false;
    let operationCompleted = false;
    let completedListReads = 0;
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        list: async ({ path }) => {
          lists += 1;
          if (!operationCompleted) {
            return listView(botFromPath(path), {
              documents: [
                documentView({
                  documentId: "document-a",
                  name: "Criterios A.pdf",
                  revision: "revision-a",
                  processing: {
                    status: startConfirmed ? "processing" : "completed",
                    operationId: startConfirmed ? operationId : "old-operation",
                  },
                }),
              ],
              activeOperation: startConfirmed
                ? operationView(operationId, "withdraw", {
                    documentId: "document-a",
                    status: "processing",
                  })
                : null,
            });
          }
          completedListReads += 1;
          return listView(botFromPath(path), {
            lastOperation: operationView(operationId, "withdraw", {
              documentId: "document-a",
              status: "completed",
              stage: "result",
            }),
          });
        },
        create: async ({ body, path }) => {
          operationId = body.operationId;
          return jsonResponse(
            {
              botId: botFromPath(path),
              operation: operationView(operationId, "withdraw", {
                documentId: body.documentId,
                status: "pending_start",
                stage: "source",
              }),
            },
            201,
          );
        },
        start: async ({ path }) => {
          startConfirmed = true;
          return jsonResponse(
            {
              botId: botFromPath(path),
              operation: operationView(path.split("/")[6], "withdraw", {
                documentId: "document-a",
              }),
            },
            202,
          );
        },
        readOperation: async ({ path }) => {
          reads += 1;
          operationId = path.split("/").at(-1);
          operationCompleted = reads >= 2;
          return jsonResponse({
            botId: botFromPath(path),
            operation: operationView(operationId, "withdraw", {
              documentId: "document-a",
              status: reads === 1 ? "processing" : "completed",
              stage: reads === 1 ? "source" : "result",
            }),
          });
        },
      },
    });
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    await harness.click(getDocumentAction(harness, "Retirar", "Criterios A.pdf"));
    expect(getButtonMatching(harness, /confirmar/i).disabled).toBe(false);
    expect(bodyText(harness.document)).toMatch(
      /búsquedas futuras|respuestas anteriores se conservan/i,
    );
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(0);

    await harness.click(getButtonMatching(harness, /confirmar/i));
    await waitForRequest(harness, "POST", /\/document-operations$/);
    const [intent] = documentCalls(harness, "POST", /\/document-operations$/);
    operationId = intent.body.operationId;
    expect(intent.body).toEqual({
      operationId: expect.any(String),
      action: "withdraw",
      documentId: "document-a",
      expectedRevision: "revision-a",
    });
    expect(uploadRequests(harness)).toHaveLength(0);
    await waitForRequest(harness, "POST", /\/start$/);
    const [start] = documentCalls(harness, "POST", /\/start$/);
    expect(start.path).toBe(`/api/admin/bots/docentes/document-operations/${operationId}/start`);
    expect(start.body === undefined || Object.keys(start.body).length === 0).toBe(true);
    expect(uploadRequests(harness)).toHaveLength(0);
    await waitForPollRequest(harness, /\/document-operations\/[^/]+$/);
    await harness.settle();
    expect(bodyText(harness.document)).toMatch(/retirando|procesando/i);
    expect(bodyText(harness.document)).not.toContain("Retirada procesada");
    await waitForPollText(
      harness,
      /Retirada procesada\. El chat puede tardar unos minutos en reflejar el cambio\. Las respuestas anteriores se conservan/,
    );
    await waitFor(() => expect(completedListReads).toBeGreaterThan(0));
    await waitForText(harness, /Retirada procesada/);

    expect(lists).toBeGreaterThanOrEqual(2);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(bodyText(harness.document)).not.toContain("Criterios A.pdf");
    expect(bodyText(harness.document)).toContain(
      "Retirada procesada. El chat puede tardar unos minutos en reflejar el cambio. Las respuestas anteriores se conservan",
    );
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(1);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
    expect(uploadRequests(harness)).toHaveLength(0);

    await openSection(harness, "Acceso");
    const completedListReadsBeforeReturn = completedListReads;
    await openDocuments(harness);
    await waitFor(() => expect(completedListReads).toBeGreaterThan(completedListReadsBeforeReturn));
    await waitForText(
      harness,
      /Retirada procesada\. El chat puede tardar unos minutos en reflejar el cambio\. Las respuestas anteriores se conservan/,
    );
    expect(bodyText(harness.document)).not.toContain("Criterios A.pdf");
    expect(completedListReads).toBeGreaterThan(completedListReadsBeforeReturn);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
  });

  it.each([
    ["fallo", "failed", { code: "WITHDRAW_FAILED", message: "No se pudo completar la retirada." }],
    [
      "resultado incierto",
      "unconfirmed",
      { code: "EFFECT_UNCONFIRMED", message: "No se pudo confirmar la retirada." },
    ],
  ])(
    "no afirma éxito ni restauración tras un %s de retirada",
    async (_name, operationStatus, error) => {
      const harness = await startAdmin({
        fakeTimers: true,
        behavior: {
          list: async ({ path }) =>
            listView(botFromPath(path), {
              documents: [
                documentView({
                  documentId: "document-a",
                  name: "Criterios A.pdf",
                  revision: "revision-a",
                }),
              ],
            }),
          readOperation: async ({ path }) =>
            jsonResponse({
              botId: botFromPath(path),
              operation: operationView(path.split("/").at(-1), "withdraw", {
                documentId: "document-a",
                status: operationStatus,
                stage: "result",
                error,
              }),
            }),
        },
      });
      await openDocuments(harness);
      await waitForRequest(harness, "GET", /\/documents$/);
      await harness.click(getDocumentAction(harness, "Retirar", "Criterios A.pdf"));
      await harness.click(getButtonMatching(harness, /confirmar/i));
      await waitForRequest(harness, "POST", /\/document-operations$/);
      await waitForRequest(harness, "POST", /\/start$/);
      await waitForPollRequest(harness, /\/document-operations\/[^/]+$/);
      await harness.settle();

      expect(status(harness.document).join(" ")).toMatch(
        /no se pudo|no pudimos confirmar|inciert/i,
      );
      if (operationStatus === "unconfirmed") {
        expect(bodyText(harness.document)).toContain("Resultado sin confirmar");
        expect(bodyText(harness.document)).not.toMatch(
          /Retirando documento|Actualizando la fuente/,
        );
      }
      expect(bodyText(harness.document)).not.toContain("Retirada procesada");
      expect(bodyText(harness.document)).not.toMatch(/restaurad|revertid|rollback/i);
      expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(1);
      expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
      expect(uploadRequests(harness)).toHaveLength(0);
      await harness.advanceTimers(15_000);
      expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(1);
      expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
      expect(uploadRequests(harness)).toHaveLength(0);
    },
  );

  it("reintenta una retirada fallida de la fuente ausente con withdraw y la revisión actual, sin subir", async () => {
    let retryIntent;
    let retryStatus = "failed";
    let startConfirmed = false;
    let reads = 0;
    let completedListReads = 0;
    const failedWithdraw = operationView("failed-withdraw", "withdraw", {
      documentId: "document-a",
      revision: "revision-current",
      status: "failed",
      stage: "ingestion",
      canRetry: true,
      error: {
        code: "INGESTION_FAILED",
        message: "La fuente ya se retiró; falta completar la sincronización.",
      },
    });
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        list: async ({ path }) => {
          if (retryStatus === "completed") completedListReads += 1;
          const lastOperation =
            retryStatus === "completed" && retryIntent
              ? operationView(retryIntent.operationId, "withdraw", {
                  documentId: "document-a",
                  revision: "revision-current",
                  status: "completed",
                  stage: "result",
                })
              : failedWithdraw;
          return listView(botFromPath(path), {
            documents: [],
            activeOperation:
              startConfirmed && retryStatus !== "completed"
                ? operationView(retryIntent.operationId, "withdraw", {
                    documentId: "document-a",
                    revision: "revision-current",
                    status: "processing",
                  })
                : null,
            lastOperation,
          });
        },
        create: async ({ body, path }) => {
          retryIntent = body;
          retryStatus = "processing";
          return jsonResponse(
            {
              botId: botFromPath(path),
              operation: operationView(body.operationId, "withdraw", {
                documentId: body.documentId,
                revision: body.expectedRevision,
                status: "pending_start",
                stage: "source",
              }),
            },
            201,
          );
        },
        start: async ({ path }) => {
          startConfirmed = true;
          return jsonResponse(
            {
              botId: botFromPath(path),
              operation: operationView(path.split("/")[6], "withdraw", {
                documentId: "document-a",
                revision: "revision-current",
              }),
            },
            202,
          );
        },
        readOperation: async ({ path }) => {
          reads += 1;
          retryStatus = reads >= 2 ? "completed" : "processing";
          return jsonResponse({
            botId: botFromPath(path),
            operation: operationView(path.split("/").at(-1), "withdraw", {
              documentId: "document-a",
              revision: "revision-current",
              status: retryStatus,
              stage: retryStatus === "completed" ? "result" : "ingestion",
            }),
          });
        },
      },
    });
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    expect(bodyText(harness.document)).toMatch(/no hay documentos|retirada|no se pudo/i);
    await harness.click(getButtonMatching(harness, /reintentar procesamiento/i));
    await waitForRequest(harness, "POST", /\/document-operations$/);
    await waitForRequest(harness, "POST", /\/start$/);
    await waitForPollRequest(harness, /\/document-operations\/[^/]+$/);
    await harness.settle();
    expect(bodyText(harness.document)).toMatch(/procesando|en curso/i);
    expect(bodyText(harness.document)).not.toContain("Retirada procesada");
    await waitForPollText(
      harness,
      /Retirada procesada\. El chat puede tardar unos minutos en reflejar el cambio/,
    );
    await waitFor(() => expect(completedListReads).toBeGreaterThan(0));

    expect(retryIntent).toEqual({
      operationId: expect.any(String),
      action: "withdraw",
      documentId: "document-a",
      expectedRevision: "revision-current",
    });
    expect(retryIntent.operationId).not.toBe("failed-withdraw");
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(1);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
    expect(uploadRequests(harness)).toHaveLength(0);
    expect(bodyText(harness.document)).toContain(
      "Retirada procesada. El chat puede tardar unos minutos en reflejar el cambio. Las respuestas anteriores se conservan",
    );
  });

  it.each([
    [".txt", "Guía de cursada.txt", "text/plain"],
    [".md", "Apuntes.md", "text/markdown"],
    [".html", "Material.html", "text/html"],
    [".doc", "Material.doc", "application/msword"],
    [
      ".docx",
      "Material.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [".csv", "Listado.csv", "text/csv"],
    [".xls", "Planilla.xls", "application/vnd.ms-excel"],
    [".xlsx", "Planilla.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [".pdf", "Referencia.pdf", "application/pdf"],
  ])(
    "admite el formato preparado %s y no restringe nombres españoles",
    async (_ext, name, type) => {
      const contents = "contenido textual preparado";
      const harness = await startAdmin();
      await openDocuments(harness);
      const file = makeFile(harness, name, contents, type);
      await submitFile(harness, file);
      await waitFor(() => expect(uploadRequests(harness)).toHaveLength(1));

      const [intent] = documentCalls(harness, "POST", /\/document-operations$/);
      expect(intent.body).toMatchObject({
        action: "upload",
        file: { name, sizeBytes: Buffer.byteLength(contents), sha256: sha256(contents) },
      });
      expect(intent.body.file.name).toBe(name);
      expect(uploadRequests(harness)).toHaveLength(1);
      expect(bodyText(harness.document)).not.toMatch(
        /formato no admitido|tipo de archivo no válido/i,
      );
    },
  );

  it("acepta el límite inclusivo de 50.000.000 bytes", async () => {
    const harness = await startAdmin();
    await openDocuments(harness);
    const maxBytes = 50_000_000;
    const acceptedBytes = Buffer.alloc(maxBytes, 0x61);
    const acceptedFile = makeFile(harness, "Límite de carga.txt", acceptedBytes);
    await submitFile(harness, acceptedFile);
    expect(documentCalls(harness, "POST", /\/document-operations$/)[0].body.file.sizeBytes).toBe(
      maxBytes,
    );
    await waitFor(() => expect(uploadRequests(harness)).toHaveLength(1));
    expect([...uploadRequests(harness)[0].rawBody.entries()].at(-1)[1].size).toBe(maxBytes);
  });

  it("rechaza el byte siguiente antes de crear una intención o subir", async () => {
    const harness = await startAdmin();
    await openDocuments(harness);
    const maxBytes = 50_000_000;
    const oversizedBytes = Buffer.alloc(maxBytes + 1, 0x62);
    const oversizedFile = makeFile(harness, "Demasiado grande.txt", oversizedBytes);
    await submitFile(harness, oversizedFile, { expectIntent: false });
    await waitForText(harness, /50\.000\.000|50,000,000|50 MB/i);
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(0);
    expect(uploadRequests(harness)).toHaveLength(0);
  });

  it.each([
    [
      "una extensión no aprobada",
      "respaldo.json",
      "{}",
      "application/json",
      /formato|tipo de archivo|extensión/i,
    ],
    ["un archivo vacío", "Empty.txt", "", "text/plain", /vacío|contenido/i],
  ])(
    "rechaza %s sin crear intención ni transferencia",
    async (_caseName, name, contents, type, message) => {
      const harness = await startAdmin();
      await openDocuments(harness);
      await submitFile(harness, makeFile(harness, name, contents, type), { expectIntent: false });

      await waitForText(harness, message);
      expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(0);
      expect(uploadRequests(harness)).toHaveLength(0);
      expect(status(harness.document).join(" ")).toMatch(message);
    },
  );

  it("mantiene el mismo operationId, hash y cuerpo al reintentar una intención incierta", async () => {
    let creates = 0;
    const harness = await startAdmin({
      behavior: {
        create: async (request) => {
          creates += 1;
          if (creates === 1) return jsonResponse({ code: "DOCUMENT_OPERATION_UNCONFIRMED" }, 503);
          const body = request.body;
          const botId = botFromPath(request.path);
          return jsonResponse(
            {
              botId,
              operation: operationView(body.operationId, "upload", {
                status: "awaiting_upload",
                stage: "upload",
              }),
              upload: uploadTicket(body.operationId, body.file.name, body.file.sha256),
            },
            201,
          );
        },
      },
    });
    await openDocuments(harness);
    const contents = "mismo contenido y hash";
    const file = makeFile(harness, "Mismo archivo.md", contents, "text/markdown");
    await submitFile(harness, file);
    await waitForText(harness, /inciert|confirmar|reintentar/i);
    expect(uploadRequests(harness)).toHaveLength(0);

    await harness.click(getButtonMatching(harness, /reintentar|consultar/i));
    await waitForRequest(harness, "POST", /\/document-operations$/, 2);
    await waitFor(() => expect(uploadRequests(harness)).toHaveLength(1));
    await waitForRequest(harness, "POST", /\/start$/);

    const intents = documentCalls(harness, "POST", /\/document-operations$/);
    expect(intents).toHaveLength(2);
    expect(intents[1].body).toEqual(intents[0].body);
    expect(intents[0].body.file.sha256).toBe(sha256(contents));
    expect(intents[1].body.operationId).toBe(intents[0].body.operationId);
    expect(uploadRequests(harness)).toHaveLength(1);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
  });

  it("reintenta explícitamente un pending_start confirmado con el mismo ID, sin otra intención ni subida", async () => {
    let starts = 0;
    let reads = 0;
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        start: async ({ path }) => {
          starts += 1;
          if (starts === 1) {
            return jsonResponse({ code: "DOCUMENT_OPERATION_UNCONFIRMED" }, 503);
          }
          return jsonResponse(
            {
              botId: botFromPath(path),
              operation: operationView(path.split("/")[6], "upload", {
                status: "processing",
                stage: "source",
              }),
            },
            202,
          );
        },
        readOperation: async ({ path }) => {
          reads += 1;
          const operationId = path.split("/").at(-1);
          return jsonResponse({
            botId: botFromPath(path),
            operation: operationView(operationId, "upload", {
              status: reads === 1 ? "pending_start" : reads === 2 ? "processing" : "completed",
              stage: reads === 1 ? "source" : reads === 2 ? "ingestion" : "result",
              canRetry: reads === 1,
            }),
          });
        },
      },
    });
    await openDocuments(harness);
    await submitFile(harness, makeFile(harness, "Pendiente de inicio.txt", "contenido"));
    await waitForRequest(harness, "POST", /\/start$/);

    if (documentCalls(harness, "GET", /\/document-operations\/[^/]+$/).length === 0) {
      await waitForText(harness, /no pudimos confirmar|consultá el estado|reintentar/i);
      await harness.click(getButtonMatching(harness, /consultar estado|actualizar estado/i));
      await waitForRequest(harness, "GET", /\/document-operations\/[^/]+$/);
    }
    await waitFor(() => {
      getButtonMatching(harness, /reintentar|iniciar|continuar/i);
    });

    const [intent] = documentCalls(harness, "POST", /\/document-operations$/);
    const startsBeforeExplicitRetry = documentCalls(harness, "POST", /\/start$/);
    expect(bodyText(harness.document)).toContain("Pendiente de inicio");
    expect(bodyText(harness.document)).not.toMatch(
      /Actualizando la fuente|Procesando el contenido/,
    );
    expect(startsBeforeExplicitRetry).toHaveLength(1);
    expect(startsBeforeExplicitRetry[0].path).toContain(intent.body.operationId);
    expect(uploadRequests(harness)).toHaveLength(1);
    await harness.click(getButtonMatching(harness, /reintentar|iniciar|continuar/i));
    await waitForRequest(harness, "POST", /\/start$/, 2);
    await waitForPollRequest(harness, /\/document-operations\/[^/]+$/, 2);
    await harness.settle();
    expect(bodyText(harness.document)).toMatch(/procesando|en curso/i);
    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");
    await waitForPollText(harness, /Procesamiento completado/);

    const startRequests = documentCalls(harness, "POST", /\/start$/);
    expect(startRequests).toHaveLength(2);
    expect(startRequests[1].path).toBe(startRequests[0].path);
    expect(
      startRequests.every(
        (request) => request.body === undefined || Object.keys(request.body).length === 0,
      ),
    ).toBe(true);
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(1);
    expect(uploadRequests(harness)).toHaveLength(1);
  });

  it("consulta una recepción de inicio incierta con el mismo ID, sin volver a subir ni iniciar", async () => {
    let reads = 0;
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        start: async () => jsonResponse({ code: "DOCUMENT_OPERATION_UNCONFIRMED" }, 503),
        readOperation: async ({ path }) => {
          reads += 1;
          const operationId = path.split("/").at(-1);
          const botId = botFromPath(path);
          return jsonResponse({
            botId,
            operation: operationView(operationId, "upload", {
              status: reads === 1 ? "unconfirmed" : "completed",
              stage: "result",
              error:
                reads === 1 ? { code: "UNKNOWN", message: "Resultado no confirmado" } : undefined,
            }),
          });
        },
      },
    });
    await openDocuments(harness);
    const file = makeFile(harness, "Recepción incierta.txt", "contenido");
    await submitFile(harness, file);
    await waitForRequest(harness, "POST", /\/start$/);
    await waitForText(harness, /no pudimos confirmar|consultá el estado|resultado no confirmado/i);

    if (documentCalls(harness, "GET", /\/document-operations\/[^/]+$/).length === 0) {
      await harness.click(getButtonMatching(harness, /consultar estado|actualizar estado/i));
      await waitForRequest(harness, "GET", /\/document-operations\/[^/]+$/);
    }

    const [intent] = documentCalls(harness, "POST", /\/document-operations$/);
    const operationId = intent.body.operationId;
    expect(bodyText(harness.document)).toMatch(
      /no pudimos confirmar|consultá el estado|resultado no confirmado/i,
    );
    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");
    expect(
      documentCalls(harness, "GET", /\/document-operations\/[^/]+$/).map(({ path }) => path),
    ).toEqual([`/api/admin/bots/docentes/document-operations/${operationId}`]);

    await harness.click(getButtonMatching(harness, /consultar estado|actualizar estado/i));
    await waitForRequest(harness, "GET", /\/document-operations\/[^/]+$/, 2);
    await waitForText(harness, /Procesamiento completado/);

    expect(documentCalls(harness, "GET", /\/document-operations\/[^/]+$/)).toHaveLength(2);
    expect(documentCalls(harness, "GET", /\/document-operations\/[^/]+$/).at(-1).path).toContain(
      operationId,
    );
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(1);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
    expect(uploadRequests(harness)).toHaveLength(1);
    expect(bodyText(harness.document)).toContain(
      "Procesamiento completado. Los cambios pueden tardar unos minutos en aparecer en el chat",
    );
  });

  it("bloquea doble envío durante la misma operación y vuelve a habilitar el formulario al terminar", async () => {
    const pendingCreate = deferred();
    let creates = 0;
    let submittedIntent;
    let reads = 0;
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        create: async ({ body }) => {
          creates += 1;
          submittedIntent = body;
          return pendingCreate.promise;
        },
        readOperation: async ({ path }) => {
          reads += 1;
          return jsonResponse({
            botId: botFromPath(path),
            operation: operationView(path.split("/").at(-1), "upload", {
              status: reads === 1 ? "processing" : "completed",
              stage: reads === 1 ? "ingestion" : "result",
            }),
          });
        },
      },
    });
    await openDocuments(harness);
    const file = makeFile(harness, "Envío único.txt", "contenido de envío");
    await chooseFile(harness, file);
    const submit = getButton(harness, "Cargar y procesar");
    await harness.click(submit);
    await waitFor(() => expect(creates).toBe(1));

    expect(submit.disabled).toBe(true);
    await harness.click(submit);
    expect(creates).toBe(1);
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(1);

    pendingCreate.resolve(
      jsonResponse(
        {
          botId: "docentes",
          operation: operationView(submittedIntent.operationId, "upload", {
            status: "awaiting_upload",
            stage: "upload",
          }),
          upload: uploadTicket(
            submittedIntent.operationId,
            file.name,
            sha256("contenido de envío"),
          ),
        },
        201,
      ),
    );
    await waitForRequest(harness, "POST", /\/start$/);
    await waitForPollRequest(harness, /\/document-operations\/[^/]+$/);
    await harness.settle();
    expect(bodyText(harness.document)).toMatch(/procesando|en curso/i);
    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");
    await waitForPollText(harness, /Procesamiento completado/);

    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
    expect(uploadRequests(harness)).toHaveLength(1);
    expect(bodyText(harness.document)).toContain("Procesamiento completado");
  });

  it("deshabilita una segunda carga mientras el chatbot ya tiene una operación activa", async () => {
    const harness = await startAdmin({
      behavior: {
        list: async ({ path }) =>
          listView(botFromPath(path), {
            activeOperation: operationView("already-active", "upload", { status: "processing" }),
          }),
      },
    });
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    await waitForText(harness, /already-active|operación.*en curso|procesando/i);
    await chooseFile(harness, makeFile(harness, "Segunda operación.txt", "contenido"));
    const submit = getButton(harness, "Cargar y procesar");

    expect(submit.disabled).toBe(true);
    await harness.click(submit);

    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(0);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(0);
    expect(uploadRequests(harness)).toHaveLength(0);
    expect(bodyText(harness.document)).toMatch(/already-active|operación.*en curso|procesando/i);
  });

  it("recupera el estado visible después de una carrera que devuelve 409", async () => {
    let lists = 0;
    const harness = await startAdmin({
      behavior: {
        list: async ({ path }) => {
          lists += 1;
          return listView(botFromPath(path), {
            activeOperation:
              lists > 1
                ? operationView("racing-operation", "upload", { status: "processing" })
                : null,
          });
        },
        create: async () => jsonResponse({ code: "DOCUMENT_OPERATION_ACTIVE" }, 409),
      },
    });
    await openDocuments(harness);
    await submitFile(harness, makeFile(harness, "Cambio en carrera.txt", "contenido"));
    await waitForText(harness, /operación|cambio en curso|intento de nuevo/i);

    if (lists < 2) {
      await harness.click(getButtonMatching(harness, /actualizar|consultar|reintentar/i));
      await waitForRequest(harness, "GET", /\/documents$/, 2);
    }
    await waitForText(harness, /racing-operation|operación.*en curso|procesando/i);

    expect(lists).toBeGreaterThanOrEqual(2);
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(1);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(0);
    expect(uploadRequests(harness)).toHaveLength(0);
    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");
  });

  it("reprocesa la fuente confirmada sin transferir el archivo otra vez", async () => {
    let reads = 0;
    let reprocessOperationId = "";
    let retryStarted = false;
    let retryCompleted = false;
    let completedListReads = 0;
    const failed = operationView("previous-operation", "replace", {
      status: "failed",
      stage: "source",
      canRetry: true,
      error: { code: "INGESTION_FAILED", message: "No se pudo indexar la fuente." },
    });
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        readOperation: async ({ path }) => {
          const operationId = path.split("/").at(-1);
          if (operationId !== reprocessOperationId) {
            return jsonResponse({
              botId: botFromPath(path),
              operation: failed,
            });
          }
          reads += 1;
          retryCompleted = reads >= 2;
          return jsonResponse({
            botId: botFromPath(path),
            operation: operationView(operationId, "reprocess", {
              status: reads === 1 ? "processing" : "completed",
              stage: reads === 1 ? "ingestion" : "result",
            }),
          });
        },
        create: async ({ body, path }) => {
          reprocessOperationId = body.operationId;
          retryStarted = true;
          return jsonResponse(
            {
              botId: botFromPath(path),
              operation: operationView(body.operationId, "reprocess", {
                documentId: body.documentId,
                status: "pending_start",
                stage: "source",
              }),
            },
            201,
          );
        },
        list: async ({ path }) => {
          if (retryCompleted) completedListReads += 1;
          return listView(botFromPath(path), {
            documents: [
              documentView({
                canReplace: retryCompleted,
                processing: {
                  ...(retryCompleted
                    ? { status: "completed", operationId: reprocessOperationId }
                    : {
                        status: "failed",
                        operationId: "previous-operation",
                        error: {
                          code: "INGESTION_FAILED",
                          message: "No se pudo indexar la fuente.",
                        },
                      }),
                },
              }),
            ],
            activeOperation:
              retryStarted && !retryCompleted
                ? operationView(reprocessOperationId, "reprocess", { status: "processing" })
                : null,
            lastOperation: retryCompleted
              ? operationView(reprocessOperationId, "reprocess", {
                  status: "completed",
                  stage: "result",
                })
              : failed,
          });
        },
      },
    });
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    await waitForText(harness, /no se pudo indexar|error/i);
    expect(bodyText(harness.document)).toMatch(/no se pudo indexar|error/i);
    expectUnavailable(findDocumentAction(harness, "Reemplazar", "Guía preparada.txt"));
    expect(getDocumentAction(harness, "Retirar", "Guía preparada.txt").disabled).toBe(false);
    expect(
      getDocumentAction(harness, "Reintentar procesamiento", "Guía preparada.txt").disabled,
    ).toBe(false);
    expect(bodyText(harness.document)).not.toMatch(/pendingRemovalKeys|prepared\/|incoming\//i);
    await harness.click(
      getDocumentAction(harness, "Reintentar procesamiento", "Guía preparada.txt"),
    );
    await waitForRequest(harness, "POST", /\/document-operations$/);
    await waitForRequest(harness, "POST", /\/start$/);
    await waitForPollRequest(harness, /\/document-operations\/[^/]+$/);
    await harness.settle();
    expect(bodyText(harness.document)).toMatch(/procesando|en curso/i);
    expect(harness.document.querySelector(".admin-documents__active").textContent).toContain(
      "Guía preparada.txt",
    );
    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");
    await waitForPollText(harness, /Procesamiento completado/);
    await waitFor(() => expect(completedListReads).toBeGreaterThan(0));
    await waitFor(() => {
      const replaceAction = findDocumentAction(harness, "Reemplazar", "Guía preparada.txt");
      expect(replaceAction).toBeTruthy();
      expect(replaceAction.disabled).toBe(false);
      expect(replaceAction.getAttribute("aria-disabled")).not.toBe("true");
    });

    const [intent] = documentCalls(harness, "POST", /\/document-operations$/);
    expect(intent.body).toEqual({
      operationId: expect.any(String),
      action: "reprocess",
      documentId: "document-1",
      expectedRevision: "revision-1",
    });
    expect(uploadRequests(harness)).toHaveLength(0);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
    expect(bodyText(harness.document)).toContain("Procesamiento completado");
  });

  it("bloquea carga, reemplazo, retirada y reproceso mientras cualquier operación del bot está activa", async () => {
    const activeOperation = operationView("active-replacement", "replace", {
      documentId: "document-a",
      status: "processing",
    });
    const harness = await startAdmin({
      behavior: {
        list: async ({ path }) =>
          listView(botFromPath(path), {
            documents: [
              documentView({
                documentId: "document-a",
                name: "Documento en reemplazo.pdf",
                processing: { status: "processing", operationId: "active-replacement" },
              }),
              documentView({
                documentId: "document-b",
                name: "Fuente parcial.pdf",
                canReplace: false,
                processing: {
                  status: "failed",
                  operationId: "previous-failure",
                  error: { code: "INGESTION_FAILED", message: "Fuente parcialmente procesada." },
                },
              }),
            ],
            activeOperation,
            lastOperation: operationView("previous-failure", "replace", {
              documentId: "document-b",
              status: "failed",
              stage: "source",
              canRetry: true,
            }),
          }),
      },
    });
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    await chooseFile(harness, makeFile(harness, "Otra carga.txt", "contenido"));

    expectUnavailable(getButton(harness, "Cargar y procesar"));
    expectUnavailable(findDocumentAction(harness, "Reemplazar", "Documento en reemplazo.pdf"));
    expectUnavailable(findDocumentAction(harness, "Retirar", "Documento en reemplazo.pdf"));
    expectUnavailable(
      findDocumentAction(harness, "Reintentar procesamiento", "Fuente parcial.pdf"),
    );
    expectUnavailable(findDocumentAction(harness, "Retirar", "Fuente parcial.pdf"));
    expectUnavailable(findDocumentAction(harness, "Reemplazar", "Fuente parcial.pdf"));

    await harness.click(getButton(harness, "Cargar y procesar"));
    expect(documentCalls(harness, "POST", /\/document-operations$/)).toHaveLength(0);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(0);
    expect(uploadRequests(harness)).toHaveLength(0);
  });

  it("muestra un fallo de ingestión y un posible resultado parcial sin éxito falso", async () => {
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        readOperation: async ({ path }) => {
          const operationId = path.split("/").at(-1);
          return jsonResponse({
            botId: botFromPath(path),
            operation: operationView(operationId, "upload", {
              status: "failed",
              stage: "ingestion",
              canRetry: true,
              error: {
                code: "INGESTION_FAILED",
                message: "No se pudo indexar la fuente. Puede quedar contenido parcial en el chat.",
              },
            }),
          });
        },
      },
    });
    await openDocuments(harness);
    await submitFile(harness, makeFile(harness, "Error de ingestión.txt", "contenido"));

    await waitForPollRequest(harness, /\/document-operations\/[^/]+$/);
    await harness.settle();
    expect(bodyText(harness.document)).toMatch(/no se pudo indexar|contenido parcial/i);
    expect(status(harness.document).join(" ")).toMatch(/no se pudo indexar|contenido parcial/i);
    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");
    expect(bodyText(harness.document)).not.toMatch(/publicación exitosa|documento publicado/i);
    expect(getButton(harness, "Reintentar procesamiento")).toBeTruthy();
  });

  it("mantiene una operación aceptada al cerrar la sección y al volver consulta el servidor sin reiniciarla", async () => {
    let starts = 0;
    let reads = 0;
    let lists = 0;
    const accepted = deferred();
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        list: async ({ path }) => {
          lists += 1;
          return listView(botFromPath(path), {
            activeOperation:
              lists > 1
                ? operationView("accepted-operation", "upload", { status: "processing" })
                : null,
          });
        },
        start: async () => {
          starts += 1;
          return accepted.promise;
        },
        readOperation: async ({ path }) => {
          reads += 1;
          return jsonResponse({
            botId: botFromPath(path),
            operation: operationView(path.split("/").at(-1), "upload"),
          });
        },
      },
    });
    await openDocuments(harness);
    await submitFile(
      harness,
      makeFile(harness, "Operación aceptada.txt", "continúa fuera del panel"),
    );
    await waitForRequest(harness, "POST", /\/start$/);
    expect(starts).toBe(1);

    accepted.resolve(
      jsonResponse(
        { botId: "docentes", operation: operationView("accepted-operation", "upload") },
        202,
      ),
    );
    await waitForText(harness, /podés salir|continuará/i);
    await openSection(harness, "Acceso");
    expect(bodyText(harness.document)).not.toMatch(/operación aceptada|continuará/i);
    const readsWhileHidden = reads;
    await harness.advanceTimers(10_000);
    expect(reads).toBe(readsWhileHidden);
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/, 2);

    expect(lists).toBe(2);
    expect(starts).toBe(1);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
    expect(uploadRequests(harness)).toHaveLength(1);
    expect(bodyText(harness.document)).toMatch(/procesando|en curso/i);
  });

  it("solo sondea operaciones activas mientras Documentos está visible y deja de consultar al terminar", async () => {
    let reads = 0;
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        readOperation: async ({ path }) => {
          reads += 1;
          const operationId = path.split("/").at(-1);
          return jsonResponse({
            botId: botFromPath(path),
            operation: operationView(operationId, "upload", {
              status: reads >= 2 ? "completed" : "processing",
              stage: reads >= 2 ? "result" : "ingestion",
            }),
          });
        },
      },
    });
    await openDocuments(harness);
    await submitFile(harness, makeFile(harness, "Seguimiento.txt", "seguimiento"));
    await waitForRequest(harness, "GET", /\/document-operations\/[^/]+$/);
    const initialReads = documentCalls(harness, "GET", /\/document-operations\/[^/]+$/).length;
    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");

    harness.setVisibility("hidden");
    await harness.advanceTimers(10_000);
    expect(documentCalls(harness, "GET", /\/document-operations\/[^/]+$/)).toHaveLength(
      initialReads,
    );
    harness.setVisibility("visible");
    await harness.advanceTimers(5_000);
    expect(bodyText(harness.document)).toContain("Procesamiento completado");
    const terminalReads = documentCalls(harness, "GET", /\/document-operations\/[^/]+$/).length;
    await harness.advanceTimers(15_000);
    expect(documentCalls(harness, "GET", /\/document-operations\/[^/]+$/)).toHaveLength(
      terminalReads,
    );
  });

  it("descarta un callback tardío cuando se cambia de sección", async () => {
    const pendingStart = deferred();
    const harness = await startAdmin({ behavior: { start: async () => pendingStart.promise } });
    await openDocuments(harness);
    await submitFile(harness, makeFile(harness, "Respuesta tardía.txt", "respuesta tardía"));
    await waitForRequest(harness, "POST", /\/start$/);

    await openSection(harness, "Cuotas");
    pendingStart.resolve(
      jsonResponse({ botId: "docentes", operation: operationView("old-operation", "upload") }, 202),
    );
    await harness.settle();

    expect(bodyText(harness.document)).not.toMatch(
      /old-operation|podés salir|procesamiento completado/i,
    );
    expect(getSectionControl(harness, "Cuotas").getAttribute("aria-pressed")).toBe("true");
  });

  it("aborta una lectura documental al cerrar la sección y descarta su respuesta tardía", async () => {
    const pendingList = deferred();
    let lists = 0;
    const harness = await startAdmin({
      behavior: {
        list: async ({ path }) => {
          lists += 1;
          if (lists === 1) return pendingList.promise;
          return listView(botFromPath(path), {
            documents: [documentView({ name: "Documento vigente.pdf" })],
          });
        },
      },
    });
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    const firstRead = documentCalls(harness, "GET", /\/documents$/)[0];
    expect(firstRead.signal).toMatchObject({ aborted: false });
    expect(typeof firstRead.signal.addEventListener).toBe("function");

    await openSection(harness, "Acceso");
    expect(firstRead.signal.aborted).toBe(true);
    pendingList.resolve(
      listView("docentes", {
        documents: [documentView({ name: "Respuesta tardía.pdf" })],
      }),
    );
    await harness.settle();
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/, 2);
    await waitForText(harness, /Documento vigente\.pdf/);

    expect(bodyText(harness.document)).not.toContain("Respuesta tardía.pdf");
    expect(documentCalls(harness, "GET", /\/documents$/)).toHaveLength(2);
  });

  it("descarta el callback de otro bot sin sobrescribir los documentos seleccionados", async () => {
    const pendingStart = deferred();
    const harness = await startAdmin({
      behavior: {
        start: async () => pendingStart.promise,
        list: async ({ path }) =>
          listView(botFromPath(path), {
            documents:
              botFromPath(path) === "robotica"
                ? [documentView({ documentId: "robotica-doc", name: "Solo Robótica.pdf" })]
                : [],
          }),
      },
    });
    await openDocuments(harness);
    await submitFile(harness, makeFile(harness, "Documento docente.txt", "otro bot"));
    await waitForRequest(harness, "POST", /\/start$/);
    await harness.setValue(getInput(harness, "Chatbot", "select"), "robotica");
    pendingStart.resolve(
      jsonResponse(
        { botId: "docentes", operation: operationView("old-bot-operation", "upload") },
        202,
      ),
    );
    await harness.settle();

    expect(getInput(harness, "Chatbot", "select").value).toBe("robotica");
    expect(bodyText(harness.document)).toContain("Solo Robótica.pdf");
    expect(bodyText(harness.document)).not.toMatch(/old-bot-operation|procesamiento completado/i);
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
  });

  it("descarta callbacks de una sesión cerrada después de volver a ingresar", async () => {
    const pendingStart = deferred();
    const harness = await startAdmin({ behavior: { start: async () => pendingStart.promise } });
    await openDocuments(harness);
    await submitFile(harness, makeFile(harness, "Sesión anterior.txt", "sesión anterior"));
    await waitForRequest(harness, "POST", /\/start$/);
    await harness.click(getButton(harness, "Cerrar sesión"));
    expect(button(harness.document, "Ingresar")).toBeTruthy();

    await harness.setValue(getInput(harness, "Email"), "admin@example.test");
    await harness.setValue(getInput(harness, "Contraseña"), "correct-horse-battery");
    await harness.click(getButton(harness, "Ingresar"));
    expect(getInput(harness, "Chatbot", "select")).toBeTruthy();

    pendingStart.resolve(
      jsonResponse(
        { botId: "docentes", operation: operationView("logged-out-operation", "upload") },
        202,
      ),
    );
    await harness.settle();
    expect(bodyText(harness.document)).not.toMatch(
      /logged-out-operation|procesamiento completado/i,
    );
    expect(documentCalls(harness, "POST", /\/start$/)).toHaveLength(1);
  });

  it("no relanza una operación al recargar el panel: vuelve a leer la lista del servidor", async () => {
    let lists = 0;
    const sharedActiveOperation = operationView("reload-operation", "upload", {
      status: "processing",
      stage: "validation",
      documentName: "Guía en validación.txt",
    });
    const behavior = {
      list: async ({ path }) => {
        lists += 1;
        return listView(botFromPath(path), { activeOperation: sharedActiveOperation });
      },
    };
    const first = await startAdmin({ behavior });
    await openDocuments(first);
    await first.dispose();
    harnesses.splice(harnesses.indexOf(first), 1);

    const reloaded = await startAdmin({ behavior });
    await openDocuments(reloaded);
    await waitForRequest(reloaded, "GET", /\/documents$/);
    await waitForText(reloaded, /reload-operation|procesando|en curso/i);

    expect(lists).toBe(2);
    expect(reloaded.document.querySelector('input[type="file"]').value).toBe("");
    expect(reloaded.document.querySelector(".admin-documents__active").textContent).toContain(
      "Guía en validación.txt",
    );
    expect(bodyText(reloaded.document)).toMatch(/reload-operation|procesando|en curso/i);
    expect(documentCalls(reloaded, "POST", /document-operations$/)).toHaveLength(0);
    expect(documentCalls(reloaded, "POST", /\/start$/)).toHaveLength(0);
    expect(uploadRequests(reloaded)).toHaveLength(0);
  });

  it.each([
    [
      "payload de lista incompleto",
      async () => jsonResponse({ botId: "docentes", documents: "bad" }),
    ],
    ["lista de otro chatbot", async () => listView("robotica")],
  ])("descarta un %s", async (_caseName, response) => {
    const harness = await startAdmin({ behavior: { list: response } });
    await openDocuments(harness);
    await waitForRequest(harness, "GET", /\/documents$/);
    await waitForText(harness, /no pudimos|inválid|actualizar|reintentar/i);

    expect(documentCalls(harness, "GET", /\/documents$/)).toHaveLength(1);
    expect(status(harness.document).join(" ")).toMatch(/no pudimos|inválid|actualizar|reintentar/i);
    expect(bodyText(harness.document)).not.toMatch(/documento publicado|procesamiento completado/i);
  });

  it.each([
    [
      "bot u operationId ajenos",
      async () =>
        jsonResponse({
          botId: "robotica",
          operation: operationView("someone-elses-operation", "upload", {
            status: "completed",
            stage: "result",
          }),
        }),
    ],
    [
      "un nombre de documento inválido",
      async ({ path }) =>
        jsonResponse({
          botId: botFromPath(path),
          operation: operationView(path.split("/").at(-1), "upload", {
            status: "completed",
            stage: "result",
            documentName: "../fuera-del-documento.txt",
          }),
        }),
    ],
  ])("descarta una respuesta de operación con %s", async (_caseName, readOperation) => {
    const harness = await startAdmin({
      fakeTimers: true,
      behavior: {
        readOperation,
      },
    });
    await openDocuments(harness);
    await submitFile(harness, makeFile(harness, "Respuesta ajena.txt", "contenido"));

    await waitForPollRequest(harness, /\/document-operations\/[^/]+$/);
    await harness.settle();
    expect(bodyText(harness.document)).toMatch(/no pudimos|inválid|actualizar|reintentar/i);
    expect(status(harness.document).join(" ")).toMatch(/no pudimos|inválid|actualizar|reintentar/i);
    expect(bodyText(harness.document)).not.toContain("Procesamiento completado");
  });
});
