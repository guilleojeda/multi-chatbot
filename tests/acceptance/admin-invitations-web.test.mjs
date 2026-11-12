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

// DOM evidence covers the real React app and controlled services, not browser layout or Cognito/AWS.
const adminTokens = [{ accessToken: "admin-token", idToken: "admin-id" }];
const bots = [
  { botId: "docentes", projectName: "Docentes" },
  { botId: "robotica", projectName: "Robótica" },
];
const expiry = Date.parse("2026-11-18T12:00:00.000Z");

const harnesses = [];

function installAdminRoutes(harness, behavior = {}) {
  const handlers = {
    me: behavior.me ?? (async () => jsonResponse({ sub: "admin-sub" })),
    bots: behavior.bots ?? (async () => jsonResponse({ bots })),
    lookup:
      behavior.lookup ??
      (async ({ path }) =>
        jsonResponse({
          botId: path.split("/")[4],
          person: null,
          access: { state: "none", revision: 0 },
        })),
    invitation:
      behavior.invitation ??
      (async ({ body, path }) =>
        jsonResponse({
          botId: path.split("/")[4],
          person: { sub: "new-person-sub", email: body.email },
          access: { state: "none", revision: body.expectedRevision + 1 },
          invitation: { expiresAt: expiry, delivery: { status: "accepted", messageId: "ses-1" } },
          operation: { id: body.operationId, status: "recorded" },
        })),
  };
  harness.route("GET", "/api/admin/me", handlers.me);
  harness.route("GET", "/api/admin/bots", handlers.bots);
  harness.route("POST", /^\/api\/admin\/bots\/[^/]+\/people\/lookup$/, handlers.lookup);
  harness.route("POST", /^\/api\/admin\/bots\/[^/]+\/invitations$/, handlers.invitation);
  return handlers;
}

async function startAdmin({ restoreResults = adminTokens, signInResult, behavior } = {}) {
  const harness = await createAdminWebHarness(AdminApp, {
    restoreResults: [...restoreResults],
    signInResult,
  });
  harnesses.push(harness);
  const handlers = installAdminRoutes(harness, behavior);
  await harness.mount();
  return { harness, handlers };
}

function apiCalls(harness, method, pathPattern) {
  return harness.apiRequests.filter(
    (request) => request.method === method && pathPattern.test(request.path),
  );
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

async function search(harness, email) {
  await harness.setValue(getInput(harness, "Email"), email);
  await harness.click(getButton(harness, "Buscar"));
}

async function selectBot(harness, botId) {
  await harness.setValue(getInput(harness, "Chatbot", "select"), botId);
}

async function confirmInvitation(
  harness,
  { action, confirmation, email, projectName, expectedInvitationsBefore = 0 },
) {
  await harness.click(getButton(harness, action));
  const confirmationText = bodyText(harness.document).toLowerCase();
  expect(confirmationText).toContain(email.toLowerCase());
  expect(confirmationText).toContain(projectName.toLowerCase());
  expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(expectedInvitationsBefore);
  await harness.click(getButton(harness, confirmation));
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  vi.unstubAllGlobals();
});

describe("AdminApp: invitaciones desde la web", () => {
  it("arranca con configuración mínima, restaura la sesión y ofrece el catálogo sin perfil ni Runtime", async () => {
    const { harness } = await startAdmin();

    expect(harness.getSession).toHaveBeenCalledOnce();
    expect(harness.getSession).toHaveBeenCalledWith({
      clientId: "admin-client",
      region: "us-east-1",
    });
    expect(harness.session.restore).toHaveBeenCalledOnce();
    expect(apiCalls(harness, "GET", /^\/api\/admin\/me$/)).toHaveLength(1);
    expect(apiCalls(harness, "GET", /^\/api\/admin\/bots$/)).toHaveLength(1);
    expect(harness.apiRequests.some(({ path }) => /profile|runtime|chat/.test(path))).toBe(false);

    const botPicker = getInput(harness, "Chatbot", "select");
    expect([...botPicker.options].map((option) => option.textContent)).toEqual([
      "Docentes",
      "Robótica",
    ]);
    const controls = [...harness.document.querySelectorAll("button")].map(
      (candidate) => candidate.getAttribute("aria-label") || candidate.textContent || "",
    );
    expect(controls.some((name) => /revocar acceso|cancelar invitación/i.test(name))).toBe(false);
    expect(bodyText(harness.document)).not.toMatch(/revocar acceso|cancelar invitación/i);
  });

  it("permite ingresar desde la pantalla de login y recién entonces carga el panel", async () => {
    const { harness } = await startAdmin({
      restoreResults: [null],
      signInResult: { accessToken: "admin-after-login", idToken: "admin-after-login-id" },
    });

    expect(button(harness.document, "Ingresar")).toBeTruthy();
    expect(apiCalls(harness, "GET", /^\/api\/admin\/me$/)).toHaveLength(0);
    await harness.setValue(getInput(harness, "Email"), "admin@example.test");
    await harness.setValue(getInput(harness, "Contraseña"), "correct-horse-battery");
    await harness.click(getButton(harness, "Ingresar"));

    expect(harness.session.signIn).toHaveBeenCalledWith(
      "admin@example.test",
      "correct-horse-battery",
    );
    expect(apiCalls(harness, "GET", /^\/api\/admin\/me$/)).toHaveLength(1);
    expect(apiCalls(harness, "GET", /^\/api\/admin\/bots$/)).toHaveLength(1);
    expect(getInput(harness, "Chatbot", "select")).toBeTruthy();
  });

  it("refresca una sesión una vez tras 401 y no entra en un bucle de autorización", async () => {
    let meCalls = 0;
    const { harness } = await startAdmin({
      restoreResults: [
        { accessToken: "expired-admin-token", idToken: "old-id" },
        { accessToken: "refreshed-admin-token", idToken: "new-id" },
      ],
      behavior: {
        me: async () => {
          meCalls += 1;
          if (meCalls === 1) return jsonResponse({ code: "UNAUTHORIZED" }, 401);
          return jsonResponse({ sub: "admin-sub" });
        },
      },
    });

    const requests = apiCalls(harness, "GET", /^\/api\/admin\/me$/);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer expired-admin-token",
      "Bearer refreshed-admin-token",
    ]);
    expect(harness.session.restore).toHaveBeenCalledTimes(2);
    expect(apiCalls(harness, "GET", /^\/api\/admin\/bots$/)).toHaveLength(1);
  });

  it("muestra falta de rol en 403 y no carga funciones administrativas detrás de la denegación", async () => {
    const { harness } = await startAdmin({
      behavior: { me: async () => jsonResponse({ code: "FORBIDDEN" }, 403) },
    });

    expect(status(harness.document).join(" ")).toMatch(/administrador|permiso|autorizad/i);
    expect(apiCalls(harness, "GET", /^\/api\/admin\/me$/)).toHaveLength(1);
    expect(apiCalls(harness, "GET", /^\/api\/admin\/bots$/)).toHaveLength(0);
    expect(apiCalls(harness, "POST", /\/people\/lookup$/)).toHaveLength(0);
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(0);
  });

  it("valida email, distingue no encontrado de error y muestra la ficha existente por búsqueda", async () => {
    const existingEmail = "docente@example.test";
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ body, path }) => {
          const botId = path.split("/")[4];
          if (body.email === "error@example.test") {
            return jsonResponse({ code: "IDENTITY_UNAVAILABLE" }, 503);
          }
          if (body.email === existingEmail) {
            return jsonResponse({
              botId,
              person: { sub: "teacher-sub", email: existingEmail },
              access: { state: "active", revision: 4 },
            });
          }
          return jsonResponse({ botId, person: null, access: { state: "none", revision: 0 } });
        },
      },
    });

    await harness.setValue(getInput(harness, "Email"), "not-an-email");
    await harness.click(getButton(harness, "Buscar"));
    const emailField = getInput(harness, "Email");
    expect(apiCalls(harness, "POST", /\/people\/lookup$/)).toHaveLength(0);
    expect(
      !emailField.validity.valid ||
        emailField.getAttribute("aria-invalid") === "true" ||
        status(harness.document).length > 0,
    ).toBe(true);

    await search(harness, "missing@example.test");
    expect(bodyText(harness.document)).toMatch(/no se encontr|no existe|sin acceso/i);
    expect(getButton(harness, "Invitar")).toBeTruthy();

    await search(harness, "error@example.test");
    expect(status(harness.document).join(" ")).toMatch(/buscar|disponible|error|intentar/i);
    expect(bodyText(harness.document)).not.toMatch(/no se encontró|no existe/i);
    expect(button(harness.document, "Invitar")).toBeFalsy();

    await search(harness, existingEmail);
    expect(bodyText(harness.document)).toContain(existingEmail);
    expect(bodyText(harness.document)).toMatch(/activo|habilitado/i);
    expect(apiCalls(harness, "POST", /\/people\/lookup$/).map(({ body }) => body.email)).toEqual([
      "missing@example.test",
      "error@example.test",
      existingEmail,
    ]);
  });

  it("separa invitación registrada, aceptación de SES y acceso concedido, y confirma el estado por una nueva lectura", async () => {
    const email = "nueva@example.test";
    let lookupCount = 0;
    let recipientAccepted = false;
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ path }) => {
          lookupCount += 1;
          const botId = path.split("/")[4];
          if (lookupCount === 1) {
            return jsonResponse({ botId, person: null, access: { state: "none", revision: 0 } });
          }
          if (recipientAccepted) {
            return jsonResponse({
              botId,
              person: { sub: "created-sub", email },
              access: { state: "active", revision: 2 },
            });
          }
          return jsonResponse({
            botId,
            person: { sub: "created-sub", email },
            access: { state: "none", revision: 1 },
            invitation: {
              expiresAt: expiry,
              delivery: { status: "accepted", messageId: "ses-accepted" },
            },
          });
        },
        invitation: async ({ body, path }) =>
          jsonResponse({
            botId: path.split("/")[4],
            person: { sub: "created-sub", email },
            access: { state: "none", revision: 1 },
            invitation: {
              expiresAt: expiry,
              delivery: { status: "accepted", messageId: "ses-accepted" },
            },
            operation: { id: body.operationId, status: "recorded" },
          }),
      },
    });

    await search(harness, email);
    await confirmInvitation(harness, {
      action: "Invitar",
      confirmation: "Confirmar invitación",
      email,
      projectName: "Docentes",
    });
    const afterSend = bodyText(harness.document);
    expect(afterSend).toMatch(/invitaci[oó]n.*registr|registr.*invitaci[oó]n/i);
    expect(afterSend).toMatch(/correo|ses/i);
    expect(afterSend).toMatch(/pendiente.*acept|acept.*persona|todav[ií]a no.*acceso/i);
    expect(afterSend).not.toMatch(/acceso activo|permiso activo/i);

    await search(harness, email);
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(1);
    expect(bodyText(harness.document)).not.toMatch(/acceso activo|permiso activo/i);

    recipientAccepted = true;
    await search(harness, email);
    expect(bodyText(harness.document)).toMatch(/activo|habilitado/i);
    expect(apiCalls(harness, "POST", /\/people\/lookup$/)).toHaveLength(3);
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(1);
    expect(harness.apiRequests.some(({ path }) => /accept/i.test(path))).toBe(false);
  });

  it("usa IDs nuevos solo para una nueva invitación explícita; buscar de nuevo solo lee el estado", async () => {
    const email = "reenvio@example.test";
    let lookupCount = 0;
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ path }) => {
          lookupCount += 1;
          const botId = path.split("/")[4];
          return jsonResponse({
            botId,
            person: lookupCount === 1 ? null : { sub: "known-sub", email },
            access: { state: "none", revision: lookupCount === 1 ? 0 : 1 },
            ...(lookupCount > 1
              ? { invitation: { expiresAt: expiry, delivery: { status: "failed" } } }
              : {}),
          });
        },
        invitation: async ({ body, path }) =>
          jsonResponse({
            botId: path.split("/")[4],
            person: { sub: "known-sub", email },
            access: { state: "none", revision: body.expectedRevision + 1 },
            invitation: { expiresAt: expiry, delivery: { status: "failed" } },
            operation: { id: body.operationId, status: "recorded" },
          }),
      },
    });

    await search(harness, email);
    await confirmInvitation(harness, {
      action: "Invitar",
      confirmation: "Confirmar invitación",
      email,
      projectName: "Docentes",
    });
    const firstOperationId = apiCalls(harness, "POST", /\/invitations$/)[0].body.operationId;

    await search(harness, email);
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(1);
    expect(getButton(harness, "Enviar nueva invitación")).toBeTruthy();

    await confirmInvitation(harness, {
      action: "Enviar nueva invitación",
      confirmation: "Confirmar nueva invitación",
      email,
      projectName: "Docentes",
      expectedInvitationsBefore: 1,
    });
    const invitations = apiCalls(harness, "POST", /\/invitations$/);
    expect(invitations).toHaveLength(2);
    expect(invitations[0].body.operationId).toBeTruthy();
    expect(invitations[1].body.operationId).toBeTruthy();
    expect(invitations[1].body.operationId).not.toBe(firstOperationId);
    expect(invitations.map(({ body }) => body.expectedRevision)).toEqual([0, 1]);
    expect(invitations.map(({ body }) => body.expectedSub)).toEqual([null, "known-sub"]);
    expect(invitations.map(({ path }) => path)).toEqual([
      "/api/admin/bots/docentes/invitations",
      "/api/admin/bots/docentes/invitations",
    ]);
  });

  it("no presenta éxito ni reenvía automáticamente ante incertidumbre; permite consultar después", async () => {
    const email = "incierta@example.test";
    let lookupCount = 0;
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ path }) => {
          lookupCount += 1;
          const botId = path.split("/")[4];
          if (lookupCount === 1) {
            return jsonResponse({ botId, person: null, access: { state: "none", revision: 0 } });
          }
          return jsonResponse({
            botId,
            person: { sub: "maybe-created-sub", email },
            access: { state: "none", revision: 1 },
            invitation: { expiresAt: expiry, delivery: { status: "unconfirmed" } },
          });
        },
        invitation: async () => jsonResponse({ code: "TRY_AGAIN" }, 503),
      },
    });

    await search(harness, email);
    await confirmInvitation(harness, {
      action: "Invitar",
      confirmation: "Confirmar invitación",
      email,
      projectName: "Docentes",
    });
    expect(status(harness.document).join(" ")).toMatch(/confirm|inciert|revis|temporal|estado/i);
    expect(bodyText(harness.document)).not.toMatch(
      /invitaci[oó]n registrada|correo aceptado|correo enviado/i,
    );
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(1);

    await search(harness, email);
    expect(apiCalls(harness, "POST", /\/people\/lookup$/)).toHaveLength(2);
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(1);
    expect(bodyText(harness.document)).toMatch(
      /inciert|no confirmado|estado.*correo|correo.*estado/i,
    );
  });

  it("ante un conflicto exige revisar la ficha y no adapta ni repite la mutación con otra revisión", async () => {
    const email = "concurrente@example.test";
    let lookupCount = 0;
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ path }) => {
          lookupCount += 1;
          return jsonResponse({
            botId: path.split("/")[4],
            person: { sub: "same-sub", email },
            access: { state: "none", revision: lookupCount === 1 ? 3 : 4 },
          });
        },
        invitation: async () => jsonResponse({ code: "STATE_CHANGED" }, 409),
      },
    });

    await search(harness, email);
    await confirmInvitation(harness, {
      action: "Invitar",
      confirmation: "Confirmar invitación",
      email,
      projectName: "Docentes",
    });
    expect(status(harness.document).join(" ")).toMatch(/cambi|revis|actualiz|conflicto/i);
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(1);

    await harness.click(getButton(harness, "Buscar"));
    expect(apiCalls(harness, "POST", /\/people\/lookup$/)).toHaveLength(2);
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(1);
    expect(bodyText(harness.document)).toMatch(/acceso|invitaci|pendient|activo/i);
  });

  it("bloquea una segunda confirmación mientras la invitación sigue cargando", async () => {
    const email = "doble-clic@example.test";
    const pendingInvitation = deferred();
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ path }) =>
          jsonResponse({
            botId: path.split("/")[4],
            person: null,
            access: { state: "none", revision: 0 },
          }),
        invitation: async () => pendingInvitation.promise,
      },
    });

    await search(harness, email);
    await harness.click(getButton(harness, "Invitar"));
    expect(bodyText(harness.document)).toContain(email);
    const confirm = getButton(harness, "Confirmar invitación");
    await harness.click(confirm);
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(1);

    const stillVisibleConfirm = button(harness.document, "Confirmar invitación");
    if (stillVisibleConfirm) {
      expect(stillVisibleConfirm.disabled).toBe(true);
      await harness.click(stillVisibleConfirm);
    } else {
      const repeatedAction =
        button(harness.document, "Invitar") || button(harness.document, "Enviar nueva invitación");
      if (repeatedAction) {
        await harness.click(repeatedAction);
        const repeatedConfirmation =
          button(harness.document, "Confirmar invitación") ||
          button(harness.document, "Confirmar nueva invitación");
        if (repeatedConfirmation && !repeatedConfirmation.disabled) {
          await harness.click(repeatedConfirmation);
        }
      }
    }
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(1);

    pendingInvitation.resolve(
      jsonResponse({
        botId: "docentes",
        person: { sub: "double-click-sub", email },
        access: { state: "none", revision: 1 },
        invitation: { expiresAt: expiry, delivery: { status: "accepted", messageId: "ses-once" } },
        operation: { id: "operation-once", status: "recorded" },
      }),
    );
    await harness.settle();
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(1);
  });

  it("ignora una búsqueda tardía después de cambiar email o chatbot y usa el destino seleccionado", async () => {
    const staleByEmail = deferred();
    const staleByBot = deferred();
    let lookupNumber = 0;
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ body, path }) => {
          lookupNumber += 1;
          const botId = path.split("/")[4];
          if (lookupNumber === 1) return staleByEmail.promise;
          if (lookupNumber === 3) return staleByBot.promise;
          return jsonResponse({
            botId,
            person: { sub: "current-sub", email: body.email },
            access: { state: "active", revision: 1 },
          });
        },
      },
    });

    await harness.setValue(getInput(harness, "Email"), "old@example.test");
    await harness.click(getButton(harness, "Buscar"));
    await harness.setValue(getInput(harness, "Email"), "current@example.test");
    staleByEmail.resolve(
      jsonResponse({
        botId: "docentes",
        person: { sub: "old-sub", email: "old@example.test" },
        access: { state: "active", revision: 7 },
      }),
    );
    await harness.settle();
    expect(bodyText(harness.document)).not.toContain("old@example.test");

    await harness.click(getButton(harness, "Buscar"));
    expect(bodyText(harness.document)).toContain("current@example.test");
    expect(bodyText(harness.document)).not.toContain("old@example.test");

    await selectBot(harness, "docentes");
    await harness.setValue(getInput(harness, "Email"), "bot-old@example.test");
    expect(bodyText(harness.document)).not.toContain("current@example.test");
    await harness.click(getButton(harness, "Buscar"));
    await selectBot(harness, "robotica");
    expect(bodyText(harness.document)).not.toContain("current@example.test");
    staleByBot.resolve(
      jsonResponse({
        botId: "docentes",
        person: { sub: "old-bot-sub", email: "bot-old@example.test" },
        access: { state: "active", revision: 8 },
      }),
    );
    await harness.settle();
    expect(bodyText(harness.document)).not.toContain("bot-old@example.test");

    await harness.setValue(getInput(harness, "Email"), "robotica@example.test");
    await harness.click(getButton(harness, "Buscar"));
    expect(bodyText(harness.document)).toContain("robotica@example.test");
    const lookups = apiCalls(harness, "POST", /\/people\/lookup$/);
    expect(lookups.map(({ path }) => path)).toEqual([
      "/api/admin/bots/docentes/people/lookup",
      "/api/admin/bots/docentes/people/lookup",
      "/api/admin/bots/docentes/people/lookup",
      "/api/admin/bots/robotica/people/lookup",
    ]);
  });

  it("el logout descarta respuestas antiguas y permite iniciar una identidad nueva", async () => {
    const staleLookup = deferred();
    const { harness } = await startAdmin({
      behavior: {
        me: async (request) =>
          jsonResponse({
            sub:
              request.headers.get("authorization") === "Bearer admin-token"
                ? "old-admin"
                : "new-admin",
          }),
        lookup: async ({ body }) =>
          body.email === "old-person@example.test"
            ? staleLookup.promise
            : jsonResponse({
                botId: "docentes",
                person: { sub: "new-person-sub", email: body.email },
                access: { state: "active", revision: 1 },
              }),
      },
    });

    await harness.setValue(getInput(harness, "Email"), "old-person@example.test");
    await harness.click(getButton(harness, "Buscar"));
    await harness.click(getButton(harness, "Cerrar sesión"));

    expect(harness.session.signOut).toHaveBeenCalledOnce();
    expect(button(harness.document, "Ingresar")).toBeTruthy();

    await harness.setValue(getInput(harness, "Email"), "new-admin@example.test");
    await harness.setValue(getInput(harness, "Contraseña"), "new-admin-password");
    await harness.click(getButton(harness, "Ingresar"));
    expect(bodyText(harness.document)).not.toContain("old-person@example.test");

    staleLookup.resolve(
      jsonResponse({
        botId: "docentes",
        person: { sub: "old-person-sub", email: "old-person@example.test" },
        access: { state: "active", revision: 5 },
      }),
    );
    await harness.settle();
    expect(bodyText(harness.document)).not.toContain("old-person@example.test");
    expect(bodyText(harness.document)).toContain("new-admin@example.test");
    expect(harness.session.signIn).toHaveBeenCalledOnce();
  });
});
