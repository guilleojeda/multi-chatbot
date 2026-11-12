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

function saveResponse(
  botId,
  dailyLimit,
  monthlyLimit,
  revision = `${botId}-saved-private-revision`,
  changed = true,
) {
  return jsonResponse({
    botId,
    policy: { dailyLimit, monthlyLimit, revision },
    changed,
  });
}

const zeroQuotaNotice =
  "Un límite en 0 bloquea nuevas consultas hasta que se amplíe. Los envíos ya admitidos continúan.";

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

function expectQuotaQueryOnly(harness) {
  expect(quotaCalls(harness, "PUT")).toEqual([]);
  expect(quotaCalls(harness).every(({ method }) => method === "GET")).toBe(true);
}

function quotaPutCalls(harness) {
  return quotaCalls(harness, "PUT");
}

function getCancelDraftButton(harness) {
  const match = [...harness.document.querySelectorAll("button")].find((candidate) =>
    /cancelar/i.test(controlName(candidate)),
  );
  expect(match, "expected a quota draft cancellation button").toBeTruthy();
  return match;
}

function getQuotaInput(harness, name) {
  return getInput(harness, name);
}

function expectQuotaDraft(harness, dailyLimit, monthlyLimit) {
  expect(getQuotaInput(harness, "Consultas por día").value).toBe(String(dailyLimit));
  expect(getQuotaInput(harness, "Consultas por mes").value).toBe(String(monthlyLimit));
}

function expectOnlyRefreshStorage(harness) {
  expect([...harness.adminStorage.values.keys()]).toEqual(["auth-refresh"]);
}

async function startQuotaAdmin({
  restoreResults = adminTokens,
  signInResult,
  quota,
  saveQuota,
  lookup,
  useRealSession = false,
  beforeMount,
} = {}) {
  const harness = await createAdminWebHarness(AdminApp, {
    restoreResults: [...restoreResults],
    signInResult,
    useRealSession,
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
  harness.route(
    "PUT",
    /^\/api\/admin\/bots\/[^/]+\/quota$/,
    saveQuota ??
      (async ({ body, path }) =>
        jsonResponse({
          botId: path.split("/")[4],
          policy: {
            dailyLimit: body.dailyLimit,
            monthlyLimit: body.monthlyLimit,
            revision: "saved-private-revision",
          },
          changed: true,
        })),
  );
  if (beforeMount) await beforeMount(harness);
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
    expectQuotaDraft(harness, 20, 200);
    expect(getButton(harness, "Guardar límites").disabled).toBe(true);
    expectQuotaQueryOnly(harness);

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
    expectQuotaDraft(harness, dailyLimit, monthlyLimit);
    expect(getButton(harness, "Guardar límites").disabled).toBe(true);
    expectQuotaQueryOnly(harness);
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
    expectQuotaDraft(harness, 15, 42);
    expect(getButton(harness, "Guardar límites").disabled).toBe(true);
    expectQuotaQueryOnly(harness);
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

  it("ignora un 403 tardío de una búsqueda de Acceso después de cambiar a Cuotas", async () => {
    const pendingLookup = deferred();
    const harness = await startQuotaAdmin({
      lookup: async () => pendingLookup.promise,
      quota: async ({ path }) => policyResponse(path.split("/")[4], 16, 52),
    });

    await harness.setValue(getInput(harness, "Email"), "teacher@example.test");
    await harness.click(getButton(harness, "Buscar"));
    expect(status(harness.document).join(" ")).toMatch(/buscando/i);

    await openSection(harness, "Cuotas");
    await harness.settle();
    expectPolicyValues(harness, 16, 52);

    pendingLookup.resolve(jsonResponse({ code: "FORBIDDEN" }, 403));
    await harness.settle();

    expect(getSectionControl(harness, "Cuotas").getAttribute("aria-pressed")).toBe("true");
    expect(getInput(harness, "Chatbot", "select").value).toBe("docentes");
    expectPolicyValues(harness, 16, 52);
    expect(alertText(harness.document)).toBe("");
    expect(harness.session.signOut).not.toHaveBeenCalled();
  });

  it("descarta una búsqueda tardía de Acceso al volver desde Cuotas", async () => {
    const pendingLookup = deferred();
    const email = "teacher@example.test";
    let lookupCount = 0;
    const harness = await startQuotaAdmin({
      lookup: async ({ path }) => {
        lookupCount += 1;
        return lookupCount === 1
          ? pendingLookup.promise
          : jsonResponse({
              botId: path.split("/")[4],
              person: { sub: "teacher-sub", email },
              access: { state: "active", revision: 4 },
            });
      },
      quota: async ({ path }) => policyResponse(path.split("/")[4], 16, 52),
    });

    await harness.setValue(getInput(harness, "Email"), email);
    await harness.click(getButton(harness, "Buscar"));
    await openSection(harness, "Cuotas");
    await harness.settle();
    await openSection(harness, "Acceso");

    pendingLookup.resolve(
      jsonResponse({
        botId: "docentes",
        person: { sub: "teacher-sub", email },
        access: { state: "active", revision: 3 },
      }),
    );
    await harness.settle();

    expect(getInput(harness, "Email").value).toBe(email);
    expect(bodyText(harness.document)).not.toContain(email);
    expect(bodyText(harness.document)).not.toMatch(/acceso activo|ficha actualizada/i);
    expect(button(harness.document, "Revocar")).toBeFalsy();

    await harness.click(getButton(harness, "Buscar"));
    await harness.settle();
    expect(bodyText(harness.document)).toContain(email);
    expect(bodyText(harness.document)).toMatch(/acceso activo/i);
    expect(lookupCount).toBe(2);
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

  it("mantiene el borrador crudo, distingue vacío de cero y envía ambos límites explícitamente", async () => {
    let saveRequest;
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => policyResponse(path.split("/")[4], 12, 30, "draft-revision"),
      saveQuota: async (request) => {
        saveRequest = request;
        return saveResponse("docentes", request.body.dailyLimit, request.body.monthlyLimit);
      },
    });

    await openSection(harness, "Cuotas");
    const daily = getQuotaInput(harness, "Consultas por día");
    const monthly = getQuotaInput(harness, "Consultas por mes");
    expect(daily.value).toBe("12");
    expect(monthly.value).toBe("30");

    await harness.setValue(daily, "");
    expect(daily.value).toBe("");
    await harness.click(getButton(harness, "Guardar límites"));
    expect(quotaPutCalls(harness)).toHaveLength(0);
    expect(alertText(harness.document)).toMatch(/día|obligatorio|válido/i);

    await harness.setValue(daily, "0");
    await harness.setValue(monthly, "7");
    expect(daily.value).toBe("0");
    expect(monthly.value).toBe("7");
    expect(bodyText(harness.document)).toContain(zeroQuotaNotice);

    await harness.click(getButton(harness, "Guardar límites"));
    expect(saveRequest.body).toEqual({
      dailyLimit: 0,
      monthlyLimit: 7,
      expectedRevision: "draft-revision",
    });
  });

  it("valida cada campo por separado sin inventar una relación diario-mensual", async () => {
    const harness = await startQuotaAdmin({
      quota: async ({ path }) =>
        policyResponse(path.split("/")[4], 20, 200, "independent-revision"),
      saveQuota: async ({ body, path }) =>
        saveResponse(path.split("/")[4], body.dailyLimit, body.monthlyLimit, "independent-saved"),
    });

    await openSection(harness, "Cuotas");
    const daily = getQuotaInput(harness, "Consultas por día");
    const monthly = getQuotaInput(harness, "Consultas por mes");
    await harness.setValue(daily, "-1");
    await harness.setValue(monthly, "7");
    await harness.click(getButton(harness, "Guardar límites"));
    expect(quotaPutCalls(harness)).toHaveLength(0);
    expect(alertText(harness.document)).toMatch(/día|mayor|entero|válido/i);

    await harness.setValue(daily, "31");
    await harness.click(getButton(harness, "Guardar límites"));
    expect(quotaPutCalls(harness)).toHaveLength(1);
    expect(quotaPutCalls(harness)[0].body).toMatchObject({
      dailyLimit: 31,
      monthlyLimit: 7,
      expectedRevision: "independent-revision",
    });
  });

  it("acepta el máximo entero seguro y deja Guardar deshabilitado cuando no hay cambios", async () => {
    const harness = await startQuotaAdmin({
      quota: async ({ path }) =>
        policyResponse(path.split("/")[4], Number.MAX_SAFE_INTEGER, 9, "safe-int-revision"),
    });

    await openSection(harness, "Cuotas");
    expectQuotaDraft(harness, Number.MAX_SAFE_INTEGER, 9);
    expect(getButton(harness, "Guardar límites").disabled).toBe(true);

    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "7");
    expect(getButton(harness, "Guardar límites").disabled).toBe(false);
    await harness.setValue(
      getQuotaInput(harness, "Consultas por día"),
      String(Number.MAX_SAFE_INTEGER),
    );
    expect(getButton(harness, "Guardar límites").disabled).toBe(true);
    expect(quotaPutCalls(harness)).toHaveLength(0);
  });

  it("cancela un borrador antes de enviar sin escribir ni consultar otra vez", async () => {
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => policyResponse(path.split("/")[4], 8, 30, "cancel-revision"),
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "17");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
    await harness.click(getCancelDraftButton(harness));

    expectQuotaDraft(harness, 8, 30);
    expect(getButton(harness, "Guardar límites").disabled).toBe(true);
    expect(quotaPutCalls(harness)).toHaveLength(0);
    expect(quotaCalls(harness)).toHaveLength(1);
  });

  it("congela cuerpo y revisión durante Guardar y bloquea el doble clic", async () => {
    const pendingSave = deferred();
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => policyResponse(path.split("/")[4], 8, 30, "frozen-revision"),
      saveQuota: async () => pendingSave.promise,
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "17");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
    const save = getButton(harness, "Guardar límites");
    await harness.click(save);
    expect(quotaPutCalls(harness)).toHaveLength(1);
    expect(quotaPutCalls(harness)[0].body).toEqual({
      dailyLimit: 17,
      monthlyLimit: 42,
      expectedRevision: "frozen-revision",
    });

    await harness.click(getButton(harness, "Guardar límites"));
    expect(quotaPutCalls(harness)).toHaveLength(1);
    expect(getButton(harness, "Guardar límites").disabled).toBe(true);

    pendingSave.resolve(saveResponse("docentes", 17, 42, "frozen-saved-revision"));
    await harness.settle();
    expect(quotaPutCalls(harness)).toHaveLength(1);
    expect(expectQuotaDraft(harness, 17, 42)).toBeUndefined();
    expect(status(harness.document).join(" ")).toMatch(/guardad|confirmad|actualizad/i);
  });

  it("consume el éxito del contrato de PUT y luego vuelve a leer el estado con un GET explícito", async () => {
    // The API acceptance owns persistence; this case proves the UI transport and response contract.
    let reads = 0;
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => {
        reads += 1;
        return reads === 1
          ? policyResponse(path.split("/")[4], 8, 30, "observed-before")
          : policyResponse(path.split("/")[4], 15, 42, "observed-after");
      },
      saveQuota: async ({ body, path }) => {
        return saveResponse(path.split("/")[4], body.dailyLimit, body.monthlyLimit, "saved-by-put");
      },
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "15");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
    await harness.click(getButton(harness, "Guardar límites"));

    expect(status(harness.document).join(" ")).toMatch(/guardad|confirmad|actualizad/i);
    expectQuotaDraft(harness, 15, 42);
    expect(quotaPutCalls(harness)).toHaveLength(1);

    await harness.click(getButton(harness, "Actualizar límites"));
    await harness.settle();
    expect(quotaCalls(harness)).toHaveLength(2);
    expectQuotaDraft(harness, 15, 42);
    expect(quotaPutCalls(harness)).toHaveLength(1);
    expect(quotaCalls(harness).every(({ method }) => method === "GET")).toBe(true);
  });

  it("consume también una respuesta changed:false válida sin mostrarla como error", async () => {
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => policyResponse(path.split("/")[4], 15, 42, "same-state-revision"),
      saveQuota: async ({ body, path }) =>
        saveResponse(
          path.split("/")[4],
          body.dailyLimit,
          body.monthlyLimit,
          "same-state-revision",
          false,
        ),
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "042");
    await harness.click(getButton(harness, "Guardar límites"));

    expect(quotaPutCalls(harness)).toHaveLength(1);
    expect(quotaPutCalls(harness)[0].body).toEqual({
      dailyLimit: 15,
      monthlyLimit: 42,
      expectedRevision: "same-state-revision",
    });
    expect(status(harness.document).join(" ")).not.toMatch(/error|no pudimos|confirmar/i);
    expectQuotaDraft(harness, 15, 42);
  });

  it("conserva el borrador ante 400 y exige una lectura nueva después de 409", async () => {
    let saveCalls = 0;
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => policyResponse(path.split("/")[4], 8, 30, "conflict-revision"),
      saveQuota: async () => {
        saveCalls += 1;
        return saveCalls === 1
          ? jsonResponse({ code: "INVALID_INPUT", fields: ["dailyLimit"] }, 400)
          : jsonResponse({ code: "STATE_CHANGED" }, 409);
      },
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "-1");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
    await harness.click(getButton(harness, "Guardar límites"));
    expect(quotaPutCalls(harness)).toHaveLength(0);

    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "17");
    await harness.click(getButton(harness, "Guardar límites"));
    expect(quotaPutCalls(harness)).toHaveLength(1);
    expectQuotaDraft(harness, 17, 42);

    await harness.click(getButton(harness, "Guardar límites"));
    expect(quotaPutCalls(harness)).toHaveLength(2);
    expect(alertText(harness.document)).toMatch(/cambi|actualiz|vigente/i);
    expect(getButton(harness, "Guardar límites").disabled).toBe(true);
    expect(quotaCalls(harness)).toHaveLength(1);

    await harness.click(getButton(harness, "Actualizar límites"));
    await harness.settle();
    expect(quotaCalls(harness)).toHaveLength(2);
    expectQuotaDraft(harness, 8, 30);
  });

  it.each([
    ["503 no confirmado", () => jsonResponse({ code: "SAVE_UNCONFIRMED" }, 503)],
    ["red", () => Promise.reject(new Error("network down"))],
    [
      "timeout",
      () => Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
    ],
    ["respuesta inválida", () => new Response("not-json", { status: 200 })],
  ])("no reenvía automáticamente un guardado con %s", async (_caseName, saveFailure) => {
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => policyResponse(path.split("/")[4], 8, 30, "failure-revision"),
      saveQuota: saveFailure,
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "17");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
    await harness.click(getButton(harness, "Guardar límites"));
    await harness.settle();

    expect(quotaPutCalls(harness)).toHaveLength(1);
    expect(alertText(harness.document)).toMatch(/confirm|pudimos|conexión|inválid|error/i);
    expect(getButton(harness, "Guardar límites").disabled).toBe(true);
    await harness.click(getButton(harness, "Guardar límites"));
    expect(quotaPutCalls(harness)).toHaveLength(1);
  });

  it.each([
    ["la base", 8, 30],
    ["los valores deseados", 17, 42],
  ])(
    "no atribuye un GET posterior al guardado incierto cuando observa %s",
    async (_caseName, observedDaily, observedMonthly) => {
      let reads = 0;
      let saves = 0;
      const harness = await startQuotaAdmin({
        quota: async ({ path }) => {
          reads += 1;
          return policyResponse(
            path.split("/")[4],
            reads === 1 ? 8 : observedDaily,
            reads === 1 ? 30 : observedMonthly,
            reads === 1 ? "inflight-base" : "observed-after-uncertain",
          );
        },
        saveQuota: async ({ body, path }) => {
          saves += 1;
          return saves === 1
            ? jsonResponse({ code: "SAVE_UNCONFIRMED" }, 503)
            : saveResponse(
                path.split("/")[4],
                body.dailyLimit,
                body.monthlyLimit,
                "second-edit-revision",
              );
        },
      });

      await openSection(harness, "Cuotas");
      await harness.setValue(getQuotaInput(harness, "Consultas por día"), "17");
      await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
      await harness.click(getButton(harness, "Guardar límites"));
      await harness.settle();
      expect(quotaPutCalls(harness)).toHaveLength(1);

      await harness.click(getButton(harness, "Actualizar límites"));
      await harness.settle();
      expect(quotaCalls(harness)).toHaveLength(2);
      expectQuotaDraft(harness, observedDaily, observedMonthly);
      expect(quotaPutCalls(harness)).toHaveLength(1);
      expect(status(harness.document).join(" ")).not.toMatch(/guardado|confirmado/i);

      expect(getButton(harness, "Guardar límites").disabled).toBe(true);
      await harness.setValue(
        getQuotaInput(harness, "Consultas por día"),
        String(observedDaily + 1),
      );
      await harness.setValue(
        getQuotaInput(harness, "Consultas por mes"),
        String(observedMonthly + 1),
      );
      await harness.click(getButton(harness, "Guardar límites"));
      expect(quotaPutCalls(harness)).toHaveLength(2);
      expect(quotaPutCalls(harness)[1].body).toMatchObject({
        dailyLimit: observedDaily + 1,
        monthlyLimit: observedMonthly + 1,
        expectedRevision: "observed-after-uncertain",
      });
    },
  );

  it("reemplaza el borrador únicamente al actualizar y no lo convierte en una escritura", async () => {
    let reads = 0;
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => {
        reads += 1;
        return reads === 1
          ? policyResponse(path.split("/")[4], 8, 30, "draft-before-refresh")
          : policyResponse(path.split("/")[4], 11, 45, "server-current-revision");
      },
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "17");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
    await harness.click(getButton(harness, "Actualizar límites"));
    await harness.settle();

    expectQuotaDraft(harness, 11, 45);
    expect(getButton(harness, "Guardar límites").disabled).toBe(true);
    expect(quotaPutCalls(harness)).toHaveLength(0);
    expect(quotaCalls(harness)).toHaveLength(2);
  });

  it("repite un PUT 401 una sola vez con la sesión y el mismo cuerpo reales", async () => {
    let putCalls = 0;
    const harness = await startQuotaAdmin({
      useRealSession: true,
      beforeMount: async (currentHarness) => {
        currentHarness.adminStorage.setItem("auth-refresh", "initial-refresh-token");
        currentHarness.cognito("InitiateAuth", async ({ body }) =>
          body.AuthFlow === "REFRESH_TOKEN_AUTH"
            ? jsonResponse({
                AuthenticationResult: {
                  AccessToken: "refreshed-admin-token",
                  IdToken: "refreshed-admin-id",
                },
              })
            : jsonResponse({
                AuthenticationResult: {
                  AccessToken: "initial-admin-token",
                  IdToken: "initial-admin-id",
                },
              }),
        );
      },
      quota: async ({ path }) => policyResponse(path.split("/")[4], 8, 30, "real-session-revision"),
      saveQuota: async ({ body, path }) => {
        putCalls += 1;
        return putCalls === 1
          ? jsonResponse({ code: "UNAUTHORIZED" }, 401)
          : saveResponse(
              path.split("/")[4],
              body.dailyLimit,
              body.monthlyLimit,
              "real-session-saved",
            );
      },
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "17");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
    await harness.click(getButton(harness, "Guardar límites"));

    const puts = quotaPutCalls(harness);
    expect(puts).toHaveLength(2);
    expect(puts[1].body).toEqual(puts[0].body);
    expect(puts.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer initial-admin-token",
      "Bearer refreshed-admin-token",
    ]);
    expect(harness.cognitoRequests.map(({ body }) => body.AuthFlow)).toEqual([
      "REFRESH_TOKEN_AUTH",
      "REFRESH_TOKEN_AUTH",
    ]);
    expect(status(harness.document).join(" ")).toMatch(/guardad|confirmad|actualizad/i);
  });

  it("descarta un PUT tardío al cambiar de chatbot y vuelve a leer el chatbot nuevo", async () => {
    const pendingSave = deferred();
    const harness = await startQuotaAdmin({
      quota: async ({ path }) =>
        path.includes("robotica")
          ? policyResponse("robotica", 48, 96, "robotica-current")
          : policyResponse("docentes", 8, 30, "docentes-current"),
      saveQuota: async ({ path }) =>
        path.includes("docentes") ? pendingSave.promise : saveResponse("robotica", 48, 96),
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "17");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
    await harness.click(getButton(harness, "Guardar límites"));
    expect(quotaPutCalls(harness)).toHaveLength(1);

    await harness.setValue(getInput(harness, "Chatbot", "select"), "robotica");
    await harness.settle();
    expectQuotaDraft(harness, 48, 96);
    pendingSave.resolve(saveResponse("docentes", 17, 42, "late-docentes-write"));
    await harness.settle();

    expect(getInput(harness, "Chatbot", "select").value).toBe("robotica");
    expectQuotaDraft(harness, 48, 96);
    expect(bodyText(harness.document)).not.toContain("late-docentes-write");
    expect(status(harness.document).join(" ")).not.toMatch(/guardado|confirmado/i);
  });

  it("descarta un PUT tardío al abandonar Cuotas y vuelve a leer al regresar", async () => {
    const pendingSave = deferred();
    const harness = await startQuotaAdmin({
      quota: async ({ path }) =>
        policyResponse(path.split("/")[4], 22, 55, "current-section-revision"),
      saveQuota: async () => pendingSave.promise,
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "17");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
    await harness.click(getButton(harness, "Guardar límites"));
    await openSection(harness, "Acceso");
    await openSection(harness, "Cuotas");
    await harness.settle();
    expectQuotaDraft(harness, 22, 55);

    pendingSave.resolve(saveResponse("docentes", 17, 42, "late-section-write"));
    await harness.settle();
    expectQuotaDraft(harness, 22, 55);
    expect(bodyText(harness.document)).not.toContain("late-section-write");
    expect(status(harness.document).join(" ")).not.toMatch(/guardado|confirmado/i);
  });

  it("descarta un PUT tardío al cerrar sesión y volver a ingresar con la misma cuenta", async () => {
    const pendingSave = deferred();
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => policyResponse(path.split("/")[4], 40, 90, "same-user-current"),
      saveQuota: async () => pendingSave.promise,
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "17");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
    await harness.click(getButton(harness, "Guardar límites"));

    await harness.click(getButton(harness, "Cerrar sesión"));
    await harness.setValue(getInput(harness, "Email"), "same-admin@example.test");
    await harness.setValue(getInput(harness, "Contraseña"), "same-account-password");
    await harness.click(getButton(harness, "Ingresar"));
    await openSection(harness, "Cuotas");
    await harness.settle();
    expectQuotaDraft(harness, 40, 90);

    pendingSave.resolve(saveResponse("docentes", 17, 42, "late-same-user-write"));
    await harness.settle();
    expectQuotaDraft(harness, 40, 90);
    expect(bodyText(harness.document)).not.toContain("late-same-user-write");
    expect(status(harness.document).join(" ")).not.toMatch(/guardado|confirmado/i);
    expect(harness.session.signIn).toHaveBeenCalledWith(
      "same-admin@example.test",
      "same-account-password",
    );
  });

  it("mantiene el email de Acceso independiente y no guarda formularios en storage", async () => {
    const harness = await startQuotaAdmin({
      quota: async ({ path }) => policyResponse(path.split("/")[4], 8, 30, "privacy-revision"),
    });

    await openSection(harness, "Cuotas");
    await harness.setValue(getQuotaInput(harness, "Consultas por día"), "17");
    await harness.setValue(getQuotaInput(harness, "Consultas por mes"), "42");
    const readsBeforeAccess = quotaCalls(harness).length;
    await openSection(harness, "Acceso");
    await harness.setValue(getInput(harness, "Email"), "teacher@example.test");

    expect(quotaCalls(harness)).toHaveLength(readsBeforeAccess);
    expect(
      harness.apiRequests.some(({ path, method }) => method !== "GET" && /quota$/.test(path)),
    ).toBe(false);
    expectOnlyRefreshStorage(harness);
    expect(getInput(harness, "Email").value).toBe("teacher@example.test");
    expect(harness.document.querySelector("input[aria-label='Consultas por día']")).toBeFalsy();
  });
});
