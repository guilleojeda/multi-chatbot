import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApp } from "../../web/AdminApp.tsx";
import {
  bodyText,
  button,
  createAdminWebHarness,
  deferred,
  input,
  jsonResponse,
} from "../support/phase9-admin-web-harness.mjs";

// Real AdminApp and DOM with controlled HTTP responses. This does not establish backend
// filtering, authorization, AWS behavior, native browser layout, or the live download.
const adminTokens = [{ accessToken: "admin-token", idToken: "admin-id" }];
const bots = [
  { botId: "docentes", projectName: "Docentes" },
  { botId: "robotica", projectName: "Robótica" },
];
// Near midnight in Cordoba, but already the next UTC day. This distinguishes the
// approved calendar from a browser or server that uses UTC dates.
const fixedNow = new Date("2026-11-16T02:00:00.000Z");
const defaultFilters = {
  from: "2026-10-17",
  to: "2026-11-15",
  excludeTests: true,
};
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
  const label = [...element.ownerDocument.querySelectorAll("label")].find(
    (candidate) => candidate.control === element || candidate.htmlFor === element.id,
  );
  return normalize(label?.textContent ?? element.textContent);
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

function getControl(harness, name, tagName = "input") {
  const match = input(harness.document, name, tagName);
  expect(match, `se esperaba un control accesible llamado "${name}"`).toBeTruthy();
  return match;
}

function getLevelControl(harness) {
  return (
    input(harness.document, "Nivel educativo", "select") ?? getControl(harness, "Nivel educativo")
  );
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

function recordRequests(harness, method, suffix) {
  return harness.apiRequests.filter(
    (request) =>
      request.method === method &&
      /^\/api\/admin\/bots\/[^/]+\/records\//.test(request.path) &&
      request.path.endsWith(suffix),
  );
}

function searchRequests(harness) {
  return recordRequests(harness, "POST", "/search");
}

function exportStarts(harness) {
  return harness.apiRequests.filter(
    (request) => request.method === "POST" && /\/records\/exports$/.test(request.path),
  );
}

function exportStatusRequests(harness) {
  return harness.apiRequests.filter(
    (request) => request.method === "GET" && /\/records\/exports\/[^/]+$/.test(request.path),
  );
}

function exportDownloadRequests(harness) {
  return harness.apiRequests.filter(
    (request) =>
      request.method === "POST" && /\/records\/exports\/[^/]+\/download$/.test(request.path),
  );
}

function resultRow({
  conversationId = "conversation-1",
  queryId = "query-2",
  ordinal = 2,
  personId = "person-1",
  admittedAt = "2026-11-14T16:00:00.000Z",
  status = "failed",
  questionPreview = "¿Y para primaria?",
  profileFields = {
    educationLevels: [{ id: "primario", label: "Primaria" }],
    subjects: ["Ciencias"],
  },
  isTest = false,
} = {}) {
  return {
    conversationId,
    queryId,
    ordinal,
    personId,
    admittedAt,
    status,
    questionPreview,
    profileFields,
    isTest,
  };
}

function searchPage(botId, results = [], nextCursor = null) {
  return jsonResponse({ botId, results, nextCursor });
}

async function startRecordsAdmin({ behavior = {}, fakeTimers = true } = {}) {
  const harness = await createAdminWebHarness(AdminApp, {
    restoreResults: [...adminTokens],
  });
  harnesses.push(harness);
  if (fakeTimers) {
    harness.useFakeTimers();
    vi.setSystemTime(fixedNow);
  }
  harness.route("GET", "/api/admin/me", async () => jsonResponse({ sub: "admin-sub" }));
  harness.route("GET", "/api/admin/bots", async () => jsonResponse({ bots }));
  harness.route("GET", /^\/api\/admin\/bots\/[^/]+\/quota$/, async ({ path }) =>
    jsonResponse({
      botId: botFromPath(path),
      policy: { dailyLimit: 20, monthlyLimit: 200, revision: "q1" },
    }),
  );
  harness.route(
    "POST",
    /^\/api\/admin\/bots\/[^/]+\/records\/search$/,
    behavior.search ?? (async ({ path }) => searchPage(botFromPath(path))),
  );
  harness.route(
    "GET",
    /^\/api\/admin\/bots\/[^/]+\/records\/conversations\/[^/]+$/,
    behavior.conversation ??
      (async ({ path }) => {
        const conversationId = path.split("/").at(-1);
        return jsonResponse({
          botId: botFromPath(path),
          conversationId,
          personId: "person-1",
          hidden: false,
          isTest: false,
          throughOrdinal: 0,
          turns: [],
          nextCursor: null,
          newerCursor: null,
        });
      }),
  );
  harness.route(
    "GET",
    /^\/api\/admin\/bots\/[^/]+\/records\/conversations\/[^/]+\/turns\/\d+\/text$/,
    behavior.text ??
      (async ({ path, url }) =>
        jsonResponse({
          botId: botFromPath(path),
          conversationId: path.split("/")[7],
          ordinal: Number(path.split("/")[9]),
          role: url.searchParams.get("role"),
          text: "",
          nextCursor: null,
          ...(url.searchParams.get("role") === "answer"
            ? { status: "completed", answerComplete: true }
            : {}),
        })),
  );
  harness.route(
    "POST",
    /^\/api\/admin\/bots\/[^/]+\/records\/exports$/,
    behavior.startExport ??
      (async ({ body, path }) =>
        jsonResponse(
          {
            botId: botFromPath(path),
            exportId: body.exportId,
            status: "processing",
          },
          202,
        )),
  );
  harness.route(
    "GET",
    /^\/api\/admin\/bots\/[^/]+\/records\/exports\/[^/]+$/,
    behavior.readExport ??
      (async ({ path }) => {
        const exportId = path.split("/").at(-1);
        return jsonResponse({ botId: botFromPath(path), exportId, status: "processing" });
      }),
  );
  harness.route(
    "POST",
    /^\/api\/admin\/bots\/[^/]+\/records\/exports\/[^/]+\/download$/,
    behavior.download ??
      (async ({ path }) =>
        jsonResponse({
          botId: botFromPath(path),
          exportId: path.split("/")[7],
          url: "https://downloads.example.test/signed.csv?token=private",
          expiresAt: "2026-11-16T02:02:00.000Z",
        })),
  );
  await harness.mount();
  await harness.click(getSectionControl(harness, "Consultas"));
  return harness;
}

async function applyFilters(harness) {
  await harness.click(getButton(harness, "Aplicar filtros"));
}

async function waitForText(harness, pattern) {
  await vi.waitFor(() => expect(bodyText(harness.document)).toMatch(pattern));
}

async function advanceUntil(harness, condition, attempts = 8) {
  for (let attempt = 0; attempt < attempts && !condition(); attempt += 1) {
    await harness.advanceTimers(60_000);
    await harness.settle();
  }
  expect(condition()).toBe(true);
}

async function waitForTextAdvancing(harness, pattern, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await harness.settle();
    if (pattern.test(bodyText(harness.document))) return;
    await harness.advanceTimers(60_000);
  }
  expect(bodyText(harness.document)).toMatch(pattern);
}

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("administrative conversation records", () => {
  it("uses the agreed local-date defaults and keeps unapplied edits out of paging until Apply", async () => {
    let page = 0;
    const harness = await startRecordsAdmin({
      behavior: {
        search: async ({ path }) => {
          page += 1;
          if (page === 1) {
            return searchPage(botFromPath(path), [resultRow()], "cursor-1");
          }
          if (page === 2) return searchPage(botFromPath(path), [], "cursor-2");
          return searchPage(botFromPath(path), [
            resultRow({ questionPreview: "Coincidencia aplicada" }),
          ]);
        },
      },
    });

    expect(getControl(harness, "Desde").value).toBe(defaultFilters.from);
    expect(getControl(harness, "Hasta").value).toBe(defaultFilters.to);
    expect(getControl(harness, "Excluir pruebas del equipo").checked).toBe(true);
    expect(getControl(harness, "Estado", "select")).toBeTruthy();
    expect(getControl(harness, "ID de persona")).toBeTruthy();
    expect(getLevelControl(harness)).toBeTruthy();
    expect(getControl(harness, "Materia")).toBeTruthy();

    if (searchRequests(harness).length === 0) await applyFilters(harness);
    expect(searchRequests(harness).length).toBeGreaterThan(0);
    const initialRequestCount = searchRequests(harness).length;
    expect(searchRequests(harness).at(-1).body.filters).toMatchObject(defaultFilters);

    await harness.setValue(getControl(harness, "Materia"), "Artes visuales");
    await harness.setValue(getControl(harness, "ID de persona"), "person-7");
    expect(searchRequests(harness)).toHaveLength(initialRequestCount);

    const continueButton = [...harness.document.querySelectorAll("button")].find((candidate) =>
      /más|siguiente|continuar|cargar/i.test(controlName(candidate)),
    );
    expect(continueButton, "una página vacía con cursor debe permitir continuar").toBeTruthy();
    await harness.click(continueButton);
    expect(searchRequests(harness)).toHaveLength(initialRequestCount + 1);
    expect(searchRequests(harness).at(-1).body).toMatchObject({
      filters: defaultFilters,
      cursor: "cursor-1",
    });

    const afterEmptyPage = [...harness.document.querySelectorAll("button")].find((candidate) =>
      /más|siguiente|continuar|cargar/i.test(controlName(candidate)),
    );
    expect(afterEmptyPage, "la continuación vacía no debe finalizar la búsqueda").toBeTruthy();
    await harness.click(afterEmptyPage);
    expect(searchRequests(harness).at(-1).body).toMatchObject({
      filters: defaultFilters,
      cursor: "cursor-2",
    });
    expect(bodyText(harness.document)).toContain("Coincidencia aplicada");

    await harness.setValue(getControl(harness, "Desde"), "2026-11-01");
    await harness.setValue(getControl(harness, "Hasta"), "2026-11-14");
    await harness.setValue(getControl(harness, "Estado", "select"), "failed");
    await harness.setValue(getLevelControl(harness), "primario");
    await harness.click(getControl(harness, "Excluir pruebas del equipo"));
    await harness.click(getButton(harness, "Aplicar filtros"));
    expect(searchRequests(harness).at(-1).body.filters).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-14",
      status: "failed",
      personId: "person-7",
      levelId: "primario",
      subject: "Artes visuales",
      excludeTests: false,
    });
    expect(searchRequests(harness).at(-1).body.cursor).toBeUndefined();
  });

  it("opens a hidden conversation with its original text and historical profile context", async () => {
    const profileAtFirstTurn = {
      educationLevels: [{ id: "secundario", label: "Secundaria" }],
      subjects: ["Ciencias naturales"],
    };
    const turns = [
      {
        ordinal: 1,
        queryId: "query-1",
        admittedAt: "2026-11-01T14:00:00.000Z",
        status: "completed",
        answerComplete: true,
        profileFields: profileAtFirstTurn,
      },
      {
        ordinal: 2,
        queryId: "query-2",
        admittedAt: "2026-11-14T16:00:00.000Z",
        status: "completed",
        answerComplete: true,
        profileFields: {
          educationLevels: [{ id: "primario", label: "Primaria" }],
          subjects: ["Ciencias"],
        },
      },
    ];
    const harness = await startRecordsAdmin({
      behavior: {
        search: async ({ path }) => searchPage(botFromPath(path), [resultRow()]),
        conversation: async ({ path }) =>
          jsonResponse({
            botId: botFromPath(path),
            conversationId: "conversation-1",
            personId: "person-1",
            hidden: true,
            isTest: false,
            throughOrdinal: 2,
            turns,
            nextCursor: null,
            newerCursor: null,
          }),
        text: async ({ path, url }) => {
          const ordinal = Number(path.split("/")[9]);
          const role = url.searchParams.get("role");
          const cursor = url.searchParams.get("cursor");
          return jsonResponse({
            botId: botFromPath(path),
            conversationId: "conversation-1",
            ordinal,
            role,
            text:
              ordinal === 1
                ? role === "question"
                  ? "Pregunta original, con acentos: ¿cómo se enseña?"
                  : "Respuesta original de noviembre."
                : role === "question"
                  ? "¿Y para primaria?"
                  : cursor === null
                    ? "Prefijo de respuesta guardado."
                    : " Resto exacto del corte.",
            nextCursor:
              ordinal === 2 && role === "answer" && cursor === null ? "answer-tail" : null,
            ...(role === "answer"
              ? {
                  status: ordinal === 1 ? "completed" : "failed",
                  answerComplete: ordinal === 1,
                  ...(ordinal === 2 ? { failureCode: "generation_failed" } : {}),
                }
              : {}),
          });
        },
      },
    });
    if (searchRequests(harness).length === 0) await applyFilters(harness);

    const resultControl = [...harness.document.querySelectorAll("button")].find((candidate) =>
      controlName(candidate).includes("¿Y para primaria?"),
    );
    expect(resultControl, "cada resultado debe poder abrir su conversación").toBeTruthy();
    await harness.click(resultControl);

    await waitForText(harness, /Pregunta original, con acentos/);
    expect(bodyText(harness.document)).toContain("Respuesta original de noviembre.");
    expect(bodyText(harness.document)).toContain("Prefijo de respuesta guardado.");
    expect(bodyText(harness.document)).toContain("Resto exacto del corte.");
    expect(bodyText(harness.document)).toContain("Respuesta original · parcial");
    expect(bodyText(harness.document)).toContain("Turno 2 · Coincidencia");
    expect(bodyText(harness.document)).toContain("Secundaria");
    expect(bodyText(harness.document)).toContain("Ciencias naturales");
    expect(bodyText(harness.document)).toMatch(/retirad[ao]|ocult[ao]|quitad[ao]/i);
    expect(recordRequests(harness, "GET", "/conversations/conversation-1")).toHaveLength(1);
    expect(
      recordRequests(harness, "GET", "/conversations/conversation-1")[0].url.searchParams.get(
        "ordinal",
      ),
    ).toBe("2");
    const textReads = harness.apiRequests.filter(
      ({ method, path }) =>
        method === "GET" && /\/records\/conversations\/[^/]+\/turns\/\d+\/text$/.test(path),
    );
    expect(textReads.length).toBeGreaterThan(0);
    expect(textReads.some(({ url }) => url.searchParams.get("role") === "question")).toBe(true);
    expect(textReads.some(({ url }) => url.searchParams.get("role") === "answer")).toBe(true);
    expect(
      harness.apiRequests.some(
        ({ method, path }) => method !== "GET" && /records\/conversations/.test(path),
      ),
    ).toBe(false);
    expect(harness.apiRequests.every(({ hostname }) => hostname === "localhost")).toBe(true);
  });

  it("opens the clicked ordinal and pages both older and newer turns under one cut", async () => {
    const conversationRequests = [];
    const harness = await startRecordsAdmin({
      behavior: {
        search: async ({ path }) =>
          searchPage(botFromPath(path), [resultRow({ ordinal: 2, queryId: "query-2" })]),
        conversation: async ({ path, url }) => {
          const cursor = url.searchParams.get("cursor");
          conversationRequests.push({ ordinal: url.searchParams.get("ordinal"), cursor });
          const turn = (ordinal) => ({
            ordinal,
            queryId: `query-${ordinal}`,
            admittedAt: `2026-11-0${ordinal}T14:00:00.000Z`,
            status: "completed",
            answerComplete: true,
            profileFields: {},
          });
          if (cursor === "older-2") {
            return jsonResponse({
              botId: botFromPath(path),
              conversationId: "conversation-1",
              personId: "person-1",
              hidden: false,
              isTest: false,
              throughOrdinal: 3,
              turns: [turn(1)],
              nextCursor: null,
              newerCursor: "newer-from-older",
            });
          }
          if (cursor === "newer-2" || cursor === "newer-from-older") {
            return jsonResponse({
              botId: botFromPath(path),
              conversationId: "conversation-1",
              personId: "person-1",
              hidden: false,
              isTest: false,
              throughOrdinal: 3,
              turns: [turn(3)],
              nextCursor: null,
              newerCursor: null,
            });
          }
          return jsonResponse({
            botId: botFromPath(path),
            conversationId: "conversation-1",
            personId: "person-1",
            hidden: false,
            isTest: false,
            throughOrdinal: 3,
            turns: [turn(2)],
            nextCursor: "older-2",
            newerCursor: "newer-2",
          });
        },
        text: async ({ path, url }) => {
          const ordinal = Number(path.split("/")[9]);
          const role = url.searchParams.get("role");
          return jsonResponse({
            botId: botFromPath(path),
            conversationId: "conversation-1",
            ordinal,
            role,
            text: role === "question" ? `Pregunta ${ordinal}` : `Respuesta ${ordinal}`,
            nextCursor: null,
            ...(role === "answer" ? { status: "completed", answerComplete: true } : {}),
          });
        },
      },
    });
    if (searchRequests(harness).length === 0) await applyFilters(harness);
    await harness.click(
      [...harness.document.querySelectorAll("button")].find((candidate) =>
        controlName(candidate).includes("¿Y para primaria?"),
      ),
    );
    await waitForText(harness, /Pregunta 2/);
    expect(conversationRequests[0]).toEqual({ ordinal: "2", cursor: null });
    expect(bodyText(harness.document)).toContain("Turno 2 · Coincidencia");

    await harness.click(getButton(harness, "Cargar turnos anteriores"));
    await waitForText(harness, /Pregunta 1/);
    expect(conversationRequests.at(-1)).toEqual({ ordinal: null, cursor: "older-2" });

    await harness.click(getButton(harness, "Cargar turnos siguientes"));
    await waitForText(harness, /Pregunta 3/);
    expect(conversationRequests.at(-1)).toEqual({ ordinal: null, cursor: "newer-2" });
    expect(bodyText(harness.document)).toContain("Turno 3");
  });

  it("does not let a conversation response reopen after applying new filters", async () => {
    const pendingConversation = deferred();
    const harness = await startRecordsAdmin({
      behavior: {
        search: async ({ path }) =>
          searchPage(botFromPath(path), [resultRow({ questionPreview: "Nuevo filtro" })]),
        conversation: async () => pendingConversation.promise,
      },
    });
    if (searchRequests(harness).length === 0) await applyFilters(harness);
    await harness.click(
      [...harness.document.querySelectorAll("button")].find((candidate) =>
        controlName(candidate).includes("Nuevo filtro"),
      ),
    );
    expect(bodyText(harness.document)).toMatch(/cargando originales/i);

    await harness.setValue(getControl(harness, "Materia"), "Aplicada después");
    await harness.click(getButton(harness, "Aplicar filtros"));
    expect(bodyText(harness.document)).not.toMatch(/cargando originales|Conversación/);
    pendingConversation.resolve(
      jsonResponse({
        botId: "docentes",
        conversationId: "conversation-1",
        personId: "person-1",
        hidden: false,
        isTest: false,
        throughOrdinal: 1,
        turns: [],
        nextCursor: null,
        newerCursor: null,
      }),
    );
    await harness.settle();
    expect(bodyText(harness.document)).not.toContain("Identificador: conversation-1");
    expect(bodyText(harness.document)).toContain("Nuevo filtro");
  });

  it("drops a late search response from a different chatbot selection", async () => {
    const oldResult = deferred();
    const harness = await startRecordsAdmin({
      behavior: {
        search: async ({ path }) => {
          if (botFromPath(path) === "docentes") return oldResult.promise;
          return searchPage("robotica", [
            resultRow({
              conversationId: "robotica-conversation",
              questionPreview: "Solo del chatbot Robótica",
            }),
          ]);
        },
      },
    });
    if (searchRequests(harness).filter(({ path }) => path.includes("/docentes/")).length === 0) {
      await applyFilters(harness);
    }
    expect(searchRequests(harness).some(({ path }) => path.includes("/docentes/"))).toBe(true);
    const botSelector = getControl(harness, "Chatbot", "select");
    await harness.setValue(botSelector, "robotica");
    if (searchRequests(harness).filter(({ path }) => path.includes("/robotica/")).length === 0) {
      await applyFilters(harness);
    }
    expect(bodyText(harness.document)).toContain("Solo del chatbot Robótica");

    oldResult.resolve(
      searchPage("docentes", [
        resultRow({
          conversationId: "stale-conversation",
          questionPreview: "Resultado atrasado de Docentes",
        }),
      ]),
    );
    await harness.settle();

    expect(bodyText(harness.document)).toContain("Solo del chatbot Robótica");
    expect(bodyText(harness.document)).not.toContain("Resultado atrasado de Docentes");
  });

  it("keeps an export start response attached to its bot while switching chatbots", async () => {
    const pendingStart = deferred();
    let statusReads = 0;
    const harness = await startRecordsAdmin({
      behavior: {
        search: async ({ path }) =>
          searchPage(botFromPath(path), [
            resultRow({ conversationId: `${botFromPath(path)}-conversation` }),
          ]),
        startExport: async () => pendingStart.promise,
        readExport: async ({ path }) => {
          statusReads += 1;
          const exportId = path.split("/").at(-1);
          return jsonResponse({
            botId: "docentes",
            exportId,
            status: "ready",
            conversationCount: 1,
            rowCount: 1,
            bytes: 72,
            expiresAt: "2026-11-17T02:00:00.000Z",
          });
        },
      },
    });
    await harness.click(getButton(harness, "Descargar conversaciones en CSV"));
    expect(exportStarts(harness)).toHaveLength(1);
    const start = exportStarts(harness)[0];
    await harness.setValue(getControl(harness, "Chatbot", "select"), "robotica");
    pendingStart.resolve(
      jsonResponse({ botId: "docentes", exportId: start.body.exportId, status: "processing" }, 202),
    );
    await harness.settle();
    await harness.setValue(getControl(harness, "Chatbot", "select"), "docentes");
    await advanceUntil(harness, () => /1\s+conversaciones/.test(bodyText(harness.document)));
    expect(statusReads).toBeGreaterThan(0);
    expect(exportStarts(harness)).toHaveLength(1);
    expect(bodyText(harness.document)).toMatch(/1\s+conversaciones/);
  });

  it.each([400, 409])(
    "shows a confirmed %s start rejection and allows a new request with corrected applied filters",
    async (status) => {
      let starts = 0;
      const harness = await startRecordsAdmin({
        behavior: {
          search: async ({ path }) => searchPage(botFromPath(path), [resultRow()]),
          startExport: async ({ body, path }) => {
            starts += 1;
            if (starts === 1) return jsonResponse({ code: "start_rejected" }, status);
            return jsonResponse(
              { botId: botFromPath(path), exportId: body.exportId, status: "processing" },
              202,
            );
          },
        },
      });
      if (searchRequests(harness).length === 0) await applyFilters(harness);
      await harness.click(getButton(harness, "Descargar conversaciones en CSV"));
      await waitForText(harness, /rechazó/i);
      expect(getButton(harness, "Preparar otra exportación")).toBeTruthy();
      const first = exportStarts(harness)[0];

      await harness.setValue(getControl(harness, "Materia"), "Materia corregida");
      await harness.click(getButton(harness, "Aplicar filtros"));
      await harness.click(getButton(harness, "Preparar otra exportación"));
      expect(exportStarts(harness)).toHaveLength(2);
      expect(exportStarts(harness)[1].body.exportId).not.toBe(first.body.exportId);
      expect(exportStarts(harness)[1].body.filters).toMatchObject({
        ...defaultFilters,
        subject: "Materia corregida",
      });
    },
  );

  it("retries an unconfirmed export with the same ID, resumes processing, and starts a native download only on click", async () => {
    let startCount = 0;
    let statusCount = 0;
    const harness = await startRecordsAdmin({
      behavior: {
        search: async ({ path }) => {
          const botId = botFromPath(path);
          return searchPage(botId, [resultRow({ conversationId: `${botId}-conversation` })]);
        },
        startExport: async ({ body, path }) => {
          startCount += 1;
          if (startCount === 1) throw new TypeError("connection lost after request");
          return jsonResponse(
            {
              botId: botFromPath(path),
              exportId: body.exportId,
              status: "processing",
            },
            202,
          );
        },
        readExport: async ({ path }) => {
          statusCount += 1;
          const exportId = path.split("/").at(-1);
          if (statusCount === 1) {
            return jsonResponse({ botId: "docentes", exportId, status: "processing" });
          }
          return jsonResponse({
            botId: "docentes",
            exportId,
            status: "ready",
            conversationCount: 2,
            rowCount: 3,
            bytes: 163,
            expiresAt: "2026-11-17T02:00:00.000Z",
          });
        },
      },
    });
    if (searchRequests(harness).length === 0) await applyFilters(harness);
    const appliedSearchCount = searchRequests(harness).length;
    await harness.setValue(getControl(harness, "Materia"), "Borrador sin aplicar");
    expect(searchRequests(harness)).toHaveLength(appliedSearchCount);
    await harness.click(getButton(harness, "Descargar conversaciones en CSV"));
    expect(exportStarts(harness)).toHaveLength(1);
    const firstExportRequest = exportStarts(harness)[0];
    expect(firstExportRequest.body.exportId).toMatch(
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
    );
    expect(firstExportRequest.body.filters).toMatchObject(defaultFilters);
    await waitForText(harness, /error|falló|no se pudo|confirmar|conexión/i);
    expect(exportStarts(harness)).toHaveLength(1);

    await harness.click(getButtonMatching(harness, /reintentar|intentar de nuevo/i));
    expect(exportStarts(harness)).toHaveLength(2);
    expect(exportStarts(harness)[1].body).toEqual(firstExportRequest.body);
    const statusCountWhileVisible = statusCount;
    await waitForTextAdvancing(harness, /preparando|procesando/i);
    await harness.click(getSectionControl(harness, "Acceso"));
    await harness.advanceTimers(60_000);
    expect(statusCount).toBe(statusCountWhileVisible);
    expect(exportStarts(harness)).toHaveLength(2);
    await harness.click(getSectionControl(harness, "Consultas"));
    await advanceUntil(harness, () => /Descargar CSV/.test(bodyText(harness.document)));
    expect(bodyText(harness.document)).toMatch(/2\s+conversaciones/);
    expect(bodyText(harness.document)).toMatch(/3\s+(filas|consultas)/);
    expect(exportStarts(harness)).toHaveLength(2);
    expect(exportStatusRequests(harness).at(-1).path).toContain(
      `/exports/${firstExportRequest.body.exportId}`,
    );

    const nativeClicks = [];
    const clickSpy = vi
      .spyOn(harness.dom.window.HTMLAnchorElement.prototype, "click")
      .mockImplementation(function () {
        nativeClicks.push({ href: this.href, download: this.download });
      });
    expect(exportDownloadRequests(harness)).toHaveLength(0);
    expect(harness.apiRequests.some(({ url }) => url.hostname === "downloads.example.test")).toBe(
      false,
    );
    expect(
      [...harness.document.querySelectorAll("a")].some((link) =>
        link.href.startsWith("https://downloads.example.test/"),
      ),
    ).toBe(false);
    await harness.click(getButton(harness, "Descargar CSV"));
    expect(exportDownloadRequests(harness)).toHaveLength(1);
    expect(nativeClicks).toHaveLength(1);
    expect(nativeClicks[0].href).toBe("https://downloads.example.test/signed.csv?token=private");
    expect(harness.apiRequests.some(({ url }) => url.hostname === "downloads.example.test")).toBe(
      false,
    );
    clickSpy.mockRestore();

    const botSelector = getControl(harness, "Chatbot", "select");
    await harness.setValue(botSelector, "robotica");
    await harness.settle();
    expect(
      [...harness.document.querySelectorAll("button")].some((candidate) =>
        /descargar csv/i.test(controlName(candidate)),
      ),
    ).toBe(false);
    expect(exportDownloadRequests(harness)).toHaveLength(1);
  });

  it("does not start a late native download after the admin session ends", async () => {
    const pendingDownload = deferred();
    const harness = await startRecordsAdmin({
      behavior: {
        search: async ({ path }) => {
          const botId = botFromPath(path);
          return searchPage(botId, [resultRow({ conversationId: `${botId}-conversation` })]);
        },
        readExport: async ({ path }) =>
          jsonResponse({
            botId: "docentes",
            exportId: path.split("/").at(-1),
            status: "ready",
            conversationCount: 1,
            rowCount: 1,
            bytes: 72,
            expiresAt: "2026-11-17T02:00:00.000Z",
          }),
        download: async () => pendingDownload.promise,
      },
    });

    await harness.click(getButton(harness, "Descargar conversaciones en CSV"));
    await waitForTextAdvancing(harness, /Descargar CSV/);
    const nativeClicks = [];
    const clickSpy = vi
      .spyOn(harness.dom.window.HTMLAnchorElement.prototype, "click")
      .mockImplementation(function () {
        nativeClicks.push(this.href);
      });
    await harness.click(getButton(harness, "Descargar CSV"));
    expect(exportDownloadRequests(harness)).toHaveLength(1);

    await harness.click(getButton(harness, "Cerrar sesión"));
    pendingDownload.resolve(
      jsonResponse({
        botId: "docentes",
        exportId: exportStarts(harness)[0].body.exportId,
        url: "https://downloads.example.test/late.csv?token=private",
        expiresAt: "2026-11-16T02:02:00.000Z",
      }),
    );
    await harness.settle();

    expect(nativeClicks).toEqual([]);
    expect(
      [...harness.document.querySelectorAll("a")].some((link) =>
        link.href.startsWith("https://downloads.example.test/"),
      ),
    ).toBe(false);
    clickSpy.mockRestore();
  });

  it.each([
    { status: "failed", expected: /error|falló|no se pudo preparar/i },
    { status: "empty", expected: /Sin consultas para exportar/i },
  ])(
    "handles terminal $status exports without starting another job automatically",
    async ({ status: terminalStatus, expected }) => {
      let statusReadCount = 0;
      const harness = await startRecordsAdmin({
        behavior: {
          search: async ({ path }) => {
            const botId = botFromPath(path);
            return searchPage(botId, [resultRow({ conversationId: `${botId}-conversation` })]);
          },
          readExport: async ({ path }) => {
            statusReadCount += 1;
            return jsonResponse({
              botId: "docentes",
              exportId: path.split("/").at(-1),
              status: terminalStatus,
            });
          },
        },
      });
      if (searchRequests(harness).length === 0) await applyFilters(harness);
      await harness.click(getButton(harness, "Descargar conversaciones en CSV"));
      await waitForTextAdvancing(harness, expected);
      expect(exportStarts(harness)).toHaveLength(1);
      expect(exportDownloadRequests(harness)).toHaveLength(0);
      if (terminalStatus === "failed") {
        expect(getButtonMatching(harness, /reintentar|intentar de nuevo/i)).toBeTruthy();
      } else {
        expect(
          [...harness.document.querySelectorAll("button")].some((candidate) =>
            /descargar csv/i.test(controlName(candidate)),
          ),
        ).toBe(false);
        expect(
          [...harness.document.querySelectorAll("button")].some((candidate) =>
            /reintentar|intentar de nuevo/i.test(controlName(candidate)),
          ),
        ).toBe(false);
      }
      expect(statusReadCount).toBeGreaterThan(0);

      if (terminalStatus === "failed") {
        const previousId = exportStarts(harness)[0].body.exportId;
        await harness.click(getButtonMatching(harness, /reintentar|intentar de nuevo/i));
        expect(exportStarts(harness)).toHaveLength(2);
        expect(exportStarts(harness)[1].body.exportId).not.toBe(previousId);
        expect(exportStarts(harness)[1].body.filters).toEqual(
          exportStarts(harness)[0].body.filters,
        );
      }
    },
  );
});
