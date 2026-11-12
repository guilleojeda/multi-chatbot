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

// React and controlled HTTP evidence only; this does not cover browser layout or AWS services.
const adminTokens = [{ accessToken: "admin-token", idToken: "admin-id" }];
const bots = [
  { botId: "docentes", projectName: "Docentes" },
  { botId: "robotica", projectName: "Robótica" },
];

const harnesses = [];

function normalize(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function controlName(element) {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return normalize(ariaLabel);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return normalize(
      labelledBy
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
  }
  return normalize(element.textContent);
}

function sectionControl(document, name) {
  return [...document.querySelectorAll("button, [role='tab']")].find(
    (candidate) => controlName(candidate) === name,
  );
}

function getSectionControl(harness, name) {
  const match = sectionControl(harness.document, name);
  expect(match, `expected an accessible button or tab named "${name}"`).toBeTruthy();
  return match;
}

function getButton(harness, name) {
  const match = button(harness.document, name);
  expect(match, `expected an accessible button named "${name}"`).toBeTruthy();
  return match;
}

function getInput(harness, name, tagName = "input") {
  const match = input(harness.document, name, tagName);
  expect(match, `expected an accessible ${tagName} named "${name}"`).toBeTruthy();
  return match;
}

async function openSection(harness, name) {
  await harness.click(getSectionControl(harness, name));
}

function quotaCalls(harness, method = "GET") {
  return harness.apiRequests.filter(
    (request) =>
      request.method === method && /^\/api\/admin\/bots\/[^/]+\/quota$/.test(request.path),
  );
}

function policyResponse(botId, dailyLimit, monthlyLimit, revision = `${botId}-private-revision`) {
  return jsonResponse({
    botId,
    policy: { dailyLimit, monthlyLimit, revision },
  });
}

function valueAfterLabel(document, label) {
  const text = normalize(document.body.textContent);
  const offset = text.toLocaleLowerCase().indexOf(label.toLocaleLowerCase());
  expect(offset, `expected the visible label "${label}"`).toBeGreaterThanOrEqual(0);
  const followingText = text.slice(offset + label.length);
  const match = followingText.match(/^\s*[:=–-]?\s*([0-9][0-9.,\s\u00a0\u202f]*)/u);
  expect(match, `expected a displayed value beside "${label}"`).not.toBeNull();
  return match[1].replace(/\D/g, "");
}

function expectPolicyValues(harness, dailyLimit, monthlyLimit) {
  expect(valueAfterLabel(harness.document, "Consultas por día")).toBe(String(dailyLimit));
  expect(valueAfterLabel(harness.document, "Consultas por mes")).toBe(String(monthlyLimit));
}

function expectNoCurrentPolicyValues(document) {
  const text = normalize(document.body.textContent);
  expect(text).not.toMatch(/consultas por día\s*[:=–-]?\s*\d/i);
  expect(text).not.toMatch(/consultas por mes\s*[:=–-]?\s*\d/i);
}

function alertText(document) {
  return normalize(
    [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join(" "),
  );
}

function expectReadOnlyQuotaView(harness) {
  const controls = [...harness.document.querySelectorAll("button, [role='tab']")];
  expect(controls.some((candidate) => controlName(candidate) === "Guardar límites")).toBe(false);
  expect(input(harness.document, "Consultas por día")).toBeFalsy();
  expect(input(harness.document, "Consultas por mes")).toBeFalsy();
  expect(harness.apiRequests.filter(({ method }) => method !== "GET")).toEqual([]);
}

async function startQuotaAdmin({ restoreResults = adminTokens, signInResult, quota, lookup } = {}) {
  const harness = await createAdminWebHarness(AdminApp, {
    restoreResults: [...restoreResults],
    signInResult,
  });
  harnesses.push(harness);
  harness.route("GET", "/api/admin/me", async () => jsonResponse({ sub: "admin-sub" }));
  harness.route("GET", "/api/admin/bots", async () => jsonResponse({ bots }));
  harness.route("POST", /^\/api\/admin\/bots\/[^/]+\/people\/lookup$/, async (request) =>
    lookup
      ? lookup(request)
      : jsonResponse({
          botId: request.path.split("/")[4],
          person: { sub: "teacher-sub", email: request.body.email },
          access: { state: "active", revision: 3 },
        }),
  );
  harness.route(
    "GET",
    /^\/api\/admin\/bots\/[^/]+\/quota$/,
    quota ?? (async ({ path }) => policyResponse(path.split("/")[4], 20, 200)),
  );
  await harness.mount();
  return harness;
}

async function disposeHarness(harness) {
  const index = harnesses.indexOf(harness);
  if (index >= 0) harnesses.splice(index, 1);
  await harness.dispose();
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  vi.unstubAllGlobals();
});

describe("AdminApp: consulta de cuotas desde la web", () => {
  it("lee el chatbot elegido al entrar a Cuotas y conserva el recorrido de Acceso", async () => {
    const pendingRead = deferred();
    const harness = await startQuotaAdmin({ quota: async () => pendingRead.promise });

    expect(getSectionControl(harness, "Acceso")).toBeTruthy();
    await openSection(harness, "Cuotas");
    const [request] = quotaCalls(harness);
    expect(request).toMatchObject({
      method: "GET",
      path: "/api/admin/bots/docentes/quota",
    });
    expect(status(harness.document).join(" ")).toMatch(/carg|consult/i);
    expectNoCurrentPolicyValues(harness.document);
    expect(quotaCalls(harness)).toHaveLength(1);
    expect(quotaCalls(harness).map((call) => call.path)).toEqual([
      "/api/admin/bots/docentes/quota",
    ]);
    expect(harness.apiRequests.some(({ path }) => /\/people\/lookup$/.test(path))).toBe(false);

    const revision = "docentes-revision-must-stay-private";
    pendingRead.resolve(policyResponse("docentes", 20, 200, revision));
    await harness.settle();

    expectPolicyValues(harness, 20, 200);
    expect(getInput(harness, "Chatbot", "select").value).toBe("docentes");
    expect(bodyText(harness.document)).toContain("Docentes");
    expect(bodyText(harness.document)).not.toContain(revision);
    expectReadOnlyQuotaView(harness);

    await openSection(harness, "Acceso");
    await harness.setValue(getInput(harness, "Email"), "teacher@example.test");
    await harness.click(getButton(harness, "Buscar"));
    expect(bodyText(harness.document)).toContain("teacher@example.test");
    expect(bodyText(harness.document)).toMatch(/acceso activo/i);
    expect(
      harness.apiRequests.some(
        ({ method, path }) => method === "POST" && /invitations|access\/revoke/.test(path),
      ),
    ).toBe(false);
  });

  it.each([
    ["límite cero", 0, 0],
    ["límites independientes con diario mayor que mensual", 31, 7],
    ["máximo entero seguro", Number.MAX_SAFE_INTEGER, 9],
  ])("muestra fielmente %s", async (_caseName, dailyLimit, monthlyLimit) => {
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => policyResponse(path.split("/")[4], dailyLimit, monthlyLimit),
    });

    await openSection(harness, "Cuotas");
    await harness.settle();

    expectPolicyValues(harness, dailyLimit, monthlyLimit);
    expectReadOnlyQuotaView(harness);
  });

  it("Actualiza límites vuelve a leer y muestra la política observada más reciente", async () => {
    let policy = { dailyLimit: 8, monthlyLimit: 30, revision: "first-private-revision" };
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => jsonResponse({ botId: path.split("/")[4], policy }),
    });

    await openSection(harness, "Cuotas");
    expectPolicyValues(harness, 8, 30);
    policy = { dailyLimit: 15, monthlyLimit: 42, revision: "second-private-revision" };

    await harness.click(getButton(harness, "Actualizar límites"));
    await harness.settle();

    expect(quotaCalls(harness)).toHaveLength(2);
    expect(quotaCalls(harness).every(({ method }) => method === "GET")).toBe(true);
    expectPolicyValues(harness, 15, 42);
    expect(bodyText(harness.document)).not.toContain("second-private-revision");
    expectReadOnlyQuotaView(harness);
  });

  it("al montar de nuevo hace una lectura y no reutiliza valores viejos del cliente", async () => {
    let currentPolicy = { dailyLimit: 20, monthlyLimit: 200, revision: "initial-revision" };
    const quota = async ({ path }) =>
      jsonResponse({ botId: path.split("/")[4], policy: currentPolicy });
    const firstMount = await startQuotaAdmin({ quota });
    await openSection(firstMount, "Cuotas");
    expectPolicyValues(firstMount, 20, 200);
    currentPolicy = { dailyLimit: 6, monthlyLimit: 18, revision: "updated-outside-panel" };
    await disposeHarness(firstMount);

    const freshMount = await startQuotaAdmin({ quota });
    await openSection(freshMount, "Cuotas");
    await freshMount.settle();

    expect(quotaCalls(freshMount)).toHaveLength(1);
    expectPolicyValues(freshMount, 6, 18);
    expect(bodyText(freshMount.document)).not.toContain("updated-outside-panel");
  });

  it("muestra un error operativo sin valores predeterminados y permite recuperarse con una lectura explícita", async () => {
    let reads = 0;
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => {
        reads += 1;
        return reads === 1
          ? jsonResponse({ code: "QUOTA_UNAVAILABLE" }, 503)
          : policyResponse(path.split("/")[4], 11, 45, "recovered-private-revision");
      },
    });

    await openSection(harness, "Cuotas");
    await harness.settle();
    expect(alertText(harness.document)).toMatch(/error|no pud|no se pudo|temporal|conexión|cuota/i);
    expectNoCurrentPolicyValues(harness.document);
    expect(quotaCalls(harness)).toHaveLength(1);

    await harness.click(getButton(harness, "Actualizar límites"));
    await harness.settle();

    expect(quotaCalls(harness)).toHaveLength(2);
    expectPolicyValues(harness, 11, 45);
    expect(bodyText(harness.document)).not.toContain("recovered-private-revision");
  });

  it.each([
    [
      "respuesta de otro chatbot",
      () => ({
        botId: "robotica",
        policy: { dailyLimit: 4, monthlyLimit: 10, revision: "wrong-bot" },
      }),
    ],
    [
      "política inválida",
      (path) => ({
        botId: path.split("/")[4],
        policy: { dailyLimit: -1, monthlyLimit: 10, revision: "invalid-policy" },
      }),
    ],
  ])("no presenta como vigente una %s", async (_caseName, makeResponse) => {
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => jsonResponse(makeResponse(path)),
    });

    await openSection(harness, "Cuotas");
    await harness.settle();

    expect(alertText(harness.document)).toMatch(/error|no pud|no se pudo|inválid|cuota|política/i);
    expectNoCurrentPolicyValues(harness.document);
  });

  it("renueva una sesión una sola vez después de 401 al consultar cuotas", async () => {
    let reads = 0;
    const harness = await startQuotaAdmin({
      restoreResults: [
        { accessToken: "expired-admin-token", idToken: "old-id" },
        { accessToken: "refreshed-admin-token", idToken: "new-id" },
      ],
      quota: async ({ path }) => {
        reads += 1;
        return reads === 1
          ? jsonResponse({ code: "UNAUTHORIZED" }, 401)
          : policyResponse(path.split("/")[4], 19, 70);
      },
    });

    await openSection(harness, "Cuotas");
    await harness.settle();

    const requests = quotaCalls(harness);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer expired-admin-token",
      "Bearer refreshed-admin-token",
    ]);
    expect(harness.session.restore).toHaveBeenCalledTimes(2);
    expectPolicyValues(harness, 19, 70);
  });

  it("cierra la sesión si la consulta de cuotas devuelve 403", async () => {
    const harness = await startQuotaAdmin({
      quota: async () => jsonResponse({ code: "FORBIDDEN" }, 403),
    });

    await openSection(harness, "Cuotas");
    await harness.settle();

    expect(quotaCalls(harness)).toHaveLength(1);
    expect(harness.session.signOut).toHaveBeenCalledOnce();
    expect(alertText(harness.document)).toMatch(/administrador|permiso|autorizad/i);
    expectNoCurrentPolicyValues(harness.document);
  });

  it("descarta una lectura tardía al cambiar de chatbot", async () => {
    const pendingDocentes = deferred();
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => {
        const botId = path.split("/")[4];
        return botId === "docentes"
          ? pendingDocentes.promise
          : policyResponse(botId, 48, 96, "robotica-private-revision");
      },
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getInput(harness, "Chatbot", "select"), "robotica");
    await harness.settle();
    expectPolicyValues(harness, 48, 96);

    pendingDocentes.resolve(policyResponse("docentes", 13, 27, "late-docentes-revision"));
    await harness.settle();

    expect(getInput(harness, "Chatbot", "select").value).toBe("robotica");
    expectPolicyValues(harness, 48, 96);
    expect(bodyText(harness.document)).not.toContain("late-docentes-revision");
    expect(quotaCalls(harness).map(({ path }) => path)).toEqual([
      "/api/admin/bots/docentes/quota",
      "/api/admin/bots/robotica/quota",
    ]);
  });

  it("descarta la respuesta de una sección abandonada aunque vuelva a Cuotas", async () => {
    const oldRead = deferred();
    let reads = 0;
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => {
        reads += 1;
        return reads === 1
          ? oldRead.promise
          : policyResponse(path.split("/")[4], 22, 55, "current-section-revision");
      },
    });

    await openSection(harness, "Cuotas");
    await openSection(harness, "Acceso");
    await openSection(harness, "Cuotas");
    await harness.settle();
    expectPolicyValues(harness, 22, 55);

    oldRead.resolve(policyResponse("docentes", 3, 5, "abandoned-section-revision"));
    await harness.settle();

    expectPolicyValues(harness, 22, 55);
    expect(bodyText(harness.document)).not.toContain("abandoned-section-revision");
    expect(quotaCalls(harness)).toHaveLength(2);
  });

  it("descarta una respuesta previa al cierre incluso al volver a ingresar la misma cuenta", async () => {
    const oldRead = deferred();
    let reads = 0;
    const email = "admin@example.test";
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => {
        reads += 1;
        return reads === 1
          ? oldRead.promise
          : policyResponse(path.split("/")[4], 40, 90, "same-admin-current-revision");
      },
    });

    await openSection(harness, "Cuotas");
    await harness.click(getButton(harness, "Cerrar sesión"));
    expect(getButton(harness, "Ingresar")).toBeTruthy();
    await harness.setValue(getInput(harness, "Email"), email);
    await harness.setValue(getInput(harness, "Contraseña"), "same-account-password");
    await harness.click(getButton(harness, "Ingresar"));
    expect(harness.session.signIn).toHaveBeenCalledWith(email, "same-account-password");
    await openSection(harness, "Cuotas");
    await harness.settle();
    expectPolicyValues(harness, 40, 90);

    oldRead.resolve(policyResponse("docentes", 1, 2, "old-session-revision"));
    await harness.settle();

    expectPolicyValues(harness, 40, 90);
    expect(bodyText(harness.document)).not.toContain("old-session-revision");
    expect(quotaCalls(harness)).toHaveLength(2);
  });
});
