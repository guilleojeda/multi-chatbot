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
    revoke:
      behavior.revoke ??
      (async ({ body, path }) =>
        jsonResponse({
          botId: path.split("/")[4],
          person: { sub: body.expectedSub, email: body.email },
          access: { state: "revoked", revision: body.expectedRevision + 1 },
          operation: { id: body.operationId, status: "recorded" },
        })),
  };
  harness.route("GET", "/api/admin/me", handlers.me);
  harness.route("GET", "/api/admin/bots", handlers.bots);
  harness.route("POST", /^\/api\/admin\/bots\/[^/]+\/people\/lookup$/, handlers.lookup);
  harness.route("POST", /^\/api\/admin\/bots\/[^/]+\/invitations$/, handlers.invitation);
  harness.route("POST", /^\/api\/admin\/bots\/[^/]+\/access\/revoke$/, handlers.revoke);
  return handlers;
}

async function startAdmin({
  restoreResults = adminTokens,
  signInResult,
  behavior,
  useRealSession = false,
} = {}) {
  const harness = await createAdminWebHarness(AdminApp, {
    restoreResults: [...restoreResults],
    signInResult,
    useRealSession,
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

describe("AdminApp: acceso desde la web", () => {
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

  it("conserva la sesión si el refresh falla temporalmente y permite reintentar", async () => {
    const harness = await createAdminWebHarness(AdminApp);
    harnesses.push(harness);
    let restoreCalls = 0;
    let accessToken = null;
    harness.session.accessToken.mockImplementation(() => accessToken);
    harness.session.restore.mockImplementation(async () => {
      restoreCalls += 1;
      if (restoreCalls === 1) {
        accessToken = "expired-admin-token";
        return { accessToken, idToken: "old-id" };
      }
      if (restoreCalls === 2) {
        throw Object.assign(new Error("temporary refresh failure"), {
          code: "NETWORK_ERROR",
          status: 503,
        });
      }
      accessToken = "refreshed-admin-token";
      return { accessToken, idToken: "new-id" };
    });
    harness.session.signOut.mockImplementation(async () => {
      accessToken = null;
    });
    let meCalls = 0;
    installAdminRoutes(harness, {
      me: async () => {
        meCalls += 1;
        return meCalls <= 2
          ? jsonResponse({ code: "UNAUTHORIZED" }, 401)
          : jsonResponse({ sub: "admin-sub" });
      },
    });

    await harness.mount();
    expect(apiCalls(harness, "GET", /^\/api\/admin\/me$/)).toHaveLength(1);
    expect(status(harness.document).join(" ")).toMatch(/cargar el panel|conexión/i);
    expect(harness.session.restore).toHaveBeenCalledTimes(2);
    expect(harness.session.signOut).not.toHaveBeenCalled();
    expect(harness.session.accessToken()).toBe("expired-admin-token");

    await harness.click(getButton(harness, "Reintentar"));

    const meRequests = apiCalls(harness, "GET", /^\/api\/admin\/me$/);
    expect(meRequests).toHaveLength(3);
    expect(meRequests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer expired-admin-token",
      "Bearer expired-admin-token",
      "Bearer refreshed-admin-token",
    ]);
    expect(harness.session.restore).toHaveBeenCalledTimes(3);
    expect(harness.session.signOut).not.toHaveBeenCalled();
    expect(getInput(harness, "Chatbot", "select")).toBeTruthy();
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

  it("explica que la invitación anterior fue a otro email y confirma el email actual para una nueva", async () => {
    const previousEmail = "docente-anterior@example.test";
    const currentEmail = "docente-actual@example.test";
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ path }) =>
          jsonResponse({
            botId: path.split("/")[4],
            person: { sub: "same-person-sub", email: currentEmail },
            access: { state: "none", revision: 5 },
            invitation: {
              expiresAt: expiry,
              invitedEmail: previousEmail,
              delivery: { status: "accepted", messageId: "ses-previous" },
            },
          }),
      },
    });

    await search(harness, currentEmail);
    const currentFicha = bodyText(harness.document).toLowerCase();
    expect(currentFicha).toContain(`esta invitación se envió a ${previousEmail}`);
    expect(currentFicha).toContain(
      `la ficha corresponde a la cuenta encontrada con el email actual ${currentEmail}`,
    );
    expect(currentFicha).toContain(`una nueva invitación se enviará a ${currentEmail}`);

    await harness.click(getButton(harness, "Enviar nueva invitación"));
    const confirmation = bodyText(harness.document).toLowerCase();
    expect(confirmation).toContain(previousEmail);
    expect(confirmation).toContain(currentEmail);
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(0);
    await harness.click(getButton(harness, "Confirmar nueva invitación"));
    const invitationRequests = apiCalls(harness, "POST", /\/invitations$/);
    expect(invitationRequests).toHaveLength(1);
    expect(invitationRequests[0].body).toMatchObject({
      email: currentEmail,
      expectedSub: "same-person-sub",
      expectedRevision: 5,
    });
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

  it("ignora una solicitud de recuperación tardía después de volver e ingresar con otra identidad", async () => {
    const pendingReset = deferred();
    const { harness } = await startAdmin({
      restoreResults: [null],
      signInResult: { accessToken: "new-admin-token", idToken: "new-admin-id" },
    });
    harness.session.requestPasswordReset.mockImplementationOnce(() => pendingReset.promise);

    await harness.click(getButton(harness, "Recuperar contraseña"));
    await harness.setValue(getInput(harness, "Email"), "old-admin@example.test");
    await harness.click(getButton(harness, "Enviar código"));
    expect(harness.session.requestPasswordReset).toHaveBeenCalledWith("old-admin@example.test");

    await harness.click(getButton(harness, "Volver a iniciar sesión"));
    await harness.setValue(getInput(harness, "Email"), "new-admin@example.test");
    await harness.setValue(getInput(harness, "Contraseña"), "new-admin-password");
    await harness.click(getButton(harness, "Ingresar"));
    expect(getInput(harness, "Chatbot", "select")).toBeTruthy();

    pendingReset.resolve();
    await harness.settle();

    expect(bodyText(harness.document)).toContain("new-admin@example.test");
    expect(bodyText(harness.document)).not.toContain("old-admin@example.test");
    expect(bodyText(harness.document)).not.toContain("Código de recuperación");
    expect(getInput(harness, "Chatbot", "select")).toBeTruthy();
    expect(harness.session.signIn).toHaveBeenCalledOnce();
  });

  it("recupera con Cognito, rechaza sin perder el formulario y luego permite ingresar sin tocar accesos", async () => {
    const email = "admin.recovery@example.test";
    const newPassword = "Correct-Horse8!";
    const { harness } = await startAdmin({ restoreResults: [null], useRealSession: true });
    harness.cognito("ForgotPassword", async () => jsonResponse({}));
    harness.cognito("ConfirmForgotPassword", async ({ body }) =>
      body.ConfirmationCode === "valid-code"
        ? jsonResponse({})
        : jsonResponse({ __type: "com.amazonaws.cognito#CodeMismatchException" }, 400),
    );
    harness.cognito("InitiateAuth", async ({ body }) => {
      if (
        body.AuthFlow !== "USER_PASSWORD_AUTH" ||
        body.AuthParameters?.USERNAME !== email ||
        body.AuthParameters?.PASSWORD !== newPassword
      ) {
        return jsonResponse({ __type: "com.amazonaws.cognito#NotAuthorizedException" }, 400);
      }
      return jsonResponse({
        AuthenticationResult: {
          AccessToken: "access-after-recovery",
          IdToken: "id-after-recovery",
          RefreshToken: "refresh-after-recovery",
        },
      });
    });

    expect(getButton(harness, "Ingresar")).toBeTruthy();
    expect(harness.cognitoRequests).toHaveLength(0);
    expect(harness.apiRequests).toHaveLength(0);

    await harness.click(getButton(harness, "Recuperar contraseña"));
    await harness.setValue(getInput(harness, "Email"), email);
    await harness.click(getButton(harness, "Enviar código"));

    const forgotRequests = harness.cognitoRequests.filter(
      ({ operation }) => operation === "ForgotPassword",
    );
    expect(forgotRequests).toHaveLength(1);
    expect(forgotRequests[0].body).toEqual({ ClientId: "admin-client", Username: email });
    expect(bodyText(harness.document)).toMatch(/recibirás un código/i);
    expect(getInput(harness, "Código de recuperación")).toBeTruthy();
    expect(harness.apiRequests).toHaveLength(0);

    await harness.setValue(getInput(harness, "Código de recuperación"), "local-code");
    await harness.setValue(getInput(harness, "Elegí una nueva contraseña"), newPassword);
    await harness.setValue(getInput(harness, "Confirmá la nueva contraseña"), "Different-Horse8!");
    await harness.click(getButton(harness, "Cambiar contraseña"));

    expect(bodyText(harness.document)).toMatch(/las contraseñas no coinciden/i);
    expect(
      harness.cognitoRequests.filter(({ operation }) => operation === "ConfirmForgotPassword"),
    ).toHaveLength(0);

    await harness.setValue(getInput(harness, "Confirmá la nueva contraseña"), newPassword);
    await harness.setValue(getInput(harness, "Código de recuperación"), "wrong-code");
    await harness.click(getButton(harness, "Cambiar contraseña"));

    const rejectedConfirm = harness.cognitoRequests.filter(
      ({ operation }) => operation === "ConfirmForgotPassword",
    );
    expect(rejectedConfirm).toHaveLength(1);
    expect(rejectedConfirm[0].body).toEqual({
      ClientId: "admin-client",
      Username: email,
      ConfirmationCode: "wrong-code",
      Password: newPassword,
    });
    expect(status(harness.document).join(" ")).toMatch(/código no es correcto/i);
    expect(getInput(harness, "Código de recuperación").value).toBe("wrong-code");
    expect(getInput(harness, "Elegí una nueva contraseña").value).toBe(newPassword);
    expect(bodyText(harness.document)).not.toMatch(/la contraseña se cambió/i);
    expect(harness.apiRequests).toHaveLength(0);

    await harness.setValue(getInput(harness, "Código de recuperación"), "valid-code");
    await harness.click(getButton(harness, "Cambiar contraseña"));

    const confirms = harness.cognitoRequests.filter(
      ({ operation }) => operation === "ConfirmForgotPassword",
    );
    expect(confirms).toHaveLength(2);
    expect(confirms[1].body).toEqual({
      ClientId: "admin-client",
      Username: email,
      ConfirmationCode: "valid-code",
      Password: newPassword,
    });
    expect(bodyText(harness.document)).toMatch(/la contraseña se cambió/i);
    expect(getButton(harness, "Ingresar")).toBeTruthy();
    expect(harness.session.accessToken()).toBeNull();
    expect(harness.session.idToken()).toBeNull();
    expect(harness.adminStorage.getItem("auth-refresh")).toBeNull();
    expect(harness.cognitoRequests.map(({ operation }) => operation)).toEqual([
      "ForgotPassword",
      "ConfirmForgotPassword",
      "ConfirmForgotPassword",
    ]);
    expect(harness.apiRequests).toHaveLength(0);

    await harness.setValue(getInput(harness, "Email"), email);
    await harness.setValue(getInput(harness, "Contraseña"), newPassword);
    await harness.click(getButton(harness, "Ingresar"));

    expect(harness.cognitoRequests.map(({ operation }) => operation)).toEqual([
      "ForgotPassword",
      "ConfirmForgotPassword",
      "ConfirmForgotPassword",
      "InitiateAuth",
    ]);
    expect(
      harness.cognitoRequests.find(({ operation }) => operation === "InitiateAuth")?.body,
    ).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "admin-client",
      AuthParameters: { USERNAME: email, PASSWORD: newPassword },
    });
    expect(harness.session.accessToken()).toBe("access-after-recovery");
    expect(harness.apiRequests.map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/api/admin/me"],
      ["GET", "/api/admin/bots"],
    ]);
    expect(getInput(harness, "Chatbot", "select")).toBeTruthy();
    expect(apiCalls(harness, "POST", /people\/lookup|invitations|accept/i)).toHaveLength(0);
  });

  it("revoca el acceso activo solo después de confirmar la persona y el chatbot, y evita el doble envío", async () => {
    const email = "revocar@example.test";
    const pendingRevoke = deferred();
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ path }) =>
          jsonResponse({
            botId: path.split("/")[4],
            person: { sub: "teacher-to-revoke", email },
            access: { state: "active", revision: 8 },
          }),
        revoke: async () => pendingRevoke.promise,
      },
    });

    await search(harness, email);
    await harness.click(getButton(harness, "Revocar"));
    const firstConfirmation = bodyText(harness.document).toLowerCase();
    expect(firstConfirmation).toContain(email);
    expect(firstConfirmation).toContain("docentes");
    expect(firstConfirmation).toContain("revoc");
    expect(apiCalls(harness, "POST", /\/access\/revoke$/)).toHaveLength(0);
    await harness.click(getButton(harness, "Cancelar"));
    expect(apiCalls(harness, "POST", /\/access\/revoke$/)).toHaveLength(0);
    expect(bodyText(harness.document)).toContain(email);
    expect(bodyText(harness.document)).toMatch(/acceso activo/i);

    await harness.click(getButton(harness, "Revocar"));
    const confirmation = getButton(harness, "Confirmar revocación");
    expect(bodyText(harness.document).toLowerCase()).toContain(email);
    expect(bodyText(harness.document).toLowerCase()).toContain("docentes");
    const cognitoCountBefore = harness.cognitoRequests.length;
    await harness.click(confirmation);

    const revocations = apiCalls(harness, "POST", /\/access\/revoke$/);
    expect(revocations).toHaveLength(1);
    expect(revocations[0]).toMatchObject({
      path: "/api/admin/bots/docentes/access/revoke",
      body: {
        email,
        expectedSub: "teacher-to-revoke",
        expectedRevision: 8,
      },
    });
    expect(revocations[0].body.operationId).toEqual(expect.any(String));
    expect(revocations[0].body.operationId.length).toBeGreaterThan(0);
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(0);
    expect(harness.cognitoRequests).toHaveLength(cognitoCountBefore);
    expect(harness.apiRequests.some(({ url }) => url.hostname !== "localhost")).toBe(false);

    const pendingConfirmation = button(harness.document, "Confirmar revocación");
    if (pendingConfirmation) {
      expect(pendingConfirmation.disabled).toBe(true);
      await harness.click(pendingConfirmation);
    } else {
      const pendingAction = button(harness.document, "Revocar");
      expect(!pendingAction || pendingAction.disabled).toBe(true);
    }
    expect(apiCalls(harness, "POST", /\/access\/revoke$/)).toHaveLength(1);

    pendingRevoke.resolve(
      jsonResponse({
        botId: "docentes",
        person: { sub: "teacher-to-revoke", email },
        access: { state: "revoked", revision: 9 },
        operation: { id: revocations[0].body.operationId, status: "recorded" },
      }),
    );
    await harness.settle();
    expect(bodyText(harness.document)).toMatch(/acceso revocado/i);
    expect(bodyText(harness.document)).not.toMatch(/acceso activo/i);
  });

  it("cancela una invitación pendiente sin convertirla en acceso revocado", async () => {
    const email = "pendiente@example.test";
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ path }) =>
          jsonResponse({
            botId: path.split("/")[4],
            person: { sub: "pending-person", email },
            access: { state: "none", revision: 3 },
            invitation: {
              expiresAt: expiry,
              delivery: { status: "accepted", messageId: "ses-pending" },
            },
          }),
        revoke: async ({ body, path }) =>
          jsonResponse({
            botId: path.split("/")[4],
            person: { sub: body.expectedSub, email: body.email },
            access: { state: "none", revision: 4 },
            operation: { id: body.operationId, status: "already_recorded" },
          }),
      },
    });

    await search(harness, email);
    await harness.click(getButton(harness, "Cancelar invitación"));
    const confirmation = bodyText(harness.document).toLowerCase();
    expect(confirmation).toContain(email);
    expect(confirmation).toContain("docentes");
    expect(confirmation).toContain("cancelar invitación");
    expect(apiCalls(harness, "POST", /\/access\/revoke$/)).toHaveLength(0);
    await harness.click(getButton(harness, "Confirmar cancelación"));

    const [request] = apiCalls(harness, "POST", /\/access\/revoke$/);
    expect(request).toMatchObject({
      path: "/api/admin/bots/docentes/access/revoke",
      body: {
        email,
        expectedSub: "pending-person",
        expectedRevision: 3,
      },
    });
    expect(request.body.operationId).toEqual(expect.any(String));
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(0);
    expect(bodyText(harness.document)).toMatch(/sin acceso/i);
    expect(bodyText(harness.document)).not.toMatch(/acceso revocado|invitación pendiente/i);
  });

  it("ante 409 descarta la ficha vieja y exige una lectura antes de volver a decidir", async () => {
    const email = "conflicto-revocacion@example.test";
    let lookupCount = 0;
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ path }) => {
          lookupCount += 1;
          return jsonResponse({
            botId: path.split("/")[4],
            person: { sub: "conflict-person", email },
            access: { state: lookupCount === 1 ? "active" : "revoked", revision: lookupCount + 5 },
          });
        },
        revoke: async () => jsonResponse({ code: "STATE_CHANGED" }, 409),
      },
    });

    await search(harness, email);
    await harness.click(getButton(harness, "Revocar"));
    await harness.click(getButton(harness, "Confirmar revocación"));
    expect(status(harness.document).join(" ")).toMatch(/cambi|revis|actualiz|conflicto/i);
    expect(apiCalls(harness, "POST", /\/access\/revoke$/)).toHaveLength(1);
    expect(button(harness.document, "Revocar")).toBeFalsy();

    await harness.click(getButton(harness, "Buscar"));
    expect(apiCalls(harness, "POST", /\/people\/lookup$/)).toHaveLength(2);
    expect(apiCalls(harness, "POST", /\/access\/revoke$/)).toHaveLength(1);
    expect(bodyText(harness.document)).toMatch(/acceso revocado/i);
    expect(button(harness.document, "Revocar")).toBeFalsy();
  });

  it.each([
    ["503", async () => jsonResponse({ code: "TRY_AGAIN" }, 503)],
    ["respuesta perdida", async () => Promise.reject(new TypeError("fetch failed"))],
  ])(
    "trata %s como resultado incierto y consulta el estado real sin repetir el POST",
    async (_name, fail) => {
      const email = "resultado-incierto@example.test";
      let lookupCount = 0;
      const { harness } = await startAdmin({
        behavior: {
          lookup: async ({ path }) => {
            lookupCount += 1;
            return jsonResponse({
              botId: path.split("/")[4],
              person: { sub: "uncertain-person", email },
              access: {
                state: lookupCount === 1 ? "active" : "revoked",
                revision: lookupCount === 1 ? 6 : 7,
              },
            });
          },
          revoke: fail,
        },
      });

      await search(harness, email);
      await harness.click(getButton(harness, "Revocar"));
      await harness.click(getButton(harness, "Confirmar revocación"));
      const resultText = bodyText(harness.document).toLowerCase();
      expect(resultText).toMatch(/confirm|inciert|revis|temporal|error/i);
      expect(resultText).not.toMatch(/revocación confirmada|acceso revocado/i);
      expect(apiCalls(harness, "POST", /\/access\/revoke$/)).toHaveLength(1);

      await harness.click(getButton(harness, "Buscar"));
      expect(apiCalls(harness, "POST", /\/people\/lookup$/)).toHaveLength(2);
      expect(apiCalls(harness, "POST", /\/access\/revoke$/)).toHaveLength(1);
      expect(bodyText(harness.document)).toMatch(/acceso revocado/i);
    },
  );

  it("ignora una revocación tardía al cambiar de chatbot y confirma la ficha del destino nuevo", async () => {
    const email = "mismo-email@example.test";
    const pendingRevoke = deferred();
    let docenteLookup = 0;
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ path }) => {
          const botId = path.split("/")[4];
          if (botId === "docentes") {
            docenteLookup += 1;
            return jsonResponse({
              botId,
              person: { sub: "docentes-sub", email },
              access: { state: "active", revision: 2 },
            });
          }
          return jsonResponse({
            botId,
            person: { sub: "robotica-sub", email },
            access: { state: "active", revision: 11 },
          });
        },
        revoke: async ({ body, path }) =>
          body.expectedSub === "docentes-sub"
            ? pendingRevoke.promise
            : jsonResponse({
                botId: path.split("/")[4],
                person: { sub: body.expectedSub, email: body.email },
                access: { state: "revoked", revision: body.expectedRevision + 1 },
                operation: { id: body.operationId, status: "recorded" },
              }),
      },
    });

    await search(harness, email);
    await harness.click(getButton(harness, "Revocar"));
    await harness.click(getButton(harness, "Confirmar revocación"));
    expect(apiCalls(harness, "POST", /\/access\/revoke$/)).toHaveLength(1);

    await selectBot(harness, "robotica");
    pendingRevoke.resolve(
      jsonResponse({
        botId: "docentes",
        person: { sub: "docentes-sub", email },
        access: { state: "revoked", revision: 3 },
        operation: { id: "old-operation", status: "recorded" },
      }),
    );
    await harness.settle();
    expect(bodyText(harness.document)).not.toContain("Acceso revocado");

    await search(harness, email);
    expect(bodyText(harness.document)).toContain("Robótica");
    await harness.click(getButton(harness, "Revocar"));
    expect(bodyText(harness.document).toLowerCase()).toContain(email);
    expect(bodyText(harness.document).toLowerCase()).toContain("robótica");
    await harness.click(getButton(harness, "Confirmar revocación"));

    const revocations = apiCalls(harness, "POST", /\/access\/revoke$/);
    expect(revocations).toHaveLength(2);
    expect(revocations[1]).toMatchObject({
      path: "/api/admin/bots/robotica/access/revoke",
      body: { email, expectedSub: "robotica-sub", expectedRevision: 11 },
    });
    expect(docenteLookup).toBe(1);
  });

  it("ignora una revocación tardía al cambiar el email y confirma a la persona nueva", async () => {
    const oldEmail = "persona-anterior@example.test";
    const newEmail = "persona-nueva@example.test";
    const pendingRevoke = deferred();
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ body, path }) =>
          jsonResponse({
            botId: path.split("/")[4],
            person: {
              sub: body.email === oldEmail ? "old-person-sub" : "new-person-sub",
              email: body.email,
            },
            access: { state: "active", revision: body.email === oldEmail ? 1 : 7 },
          }),
        revoke: async ({ body, path }) =>
          body.expectedSub === "old-person-sub"
            ? pendingRevoke.promise
            : jsonResponse({
                botId: path.split("/")[4],
                person: { sub: body.expectedSub, email: body.email },
                access: { state: "revoked", revision: body.expectedRevision + 1 },
                operation: { id: body.operationId, status: "recorded" },
              }),
      },
    });

    await search(harness, oldEmail);
    await harness.click(getButton(harness, "Revocar"));
    await harness.click(getButton(harness, "Confirmar revocación"));
    await harness.setValue(getInput(harness, "Email"), newEmail);
    pendingRevoke.resolve(
      jsonResponse({
        botId: "docentes",
        person: { sub: "old-person-sub", email: oldEmail },
        access: { state: "revoked", revision: 2 },
        operation: { id: "old-operation", status: "recorded" },
      }),
    );
    await harness.settle();
    expect(bodyText(harness.document)).not.toContain(oldEmail);
    expect(bodyText(harness.document)).not.toContain("Acceso revocado");

    await search(harness, newEmail);
    await harness.click(getButton(harness, "Revocar"));
    const confirmation = bodyText(harness.document).toLowerCase();
    expect(confirmation).toContain(newEmail);
    expect(confirmation).not.toContain(oldEmail);
    await harness.click(getButton(harness, "Confirmar revocación"));
    const revocations = apiCalls(harness, "POST", /\/access\/revoke$/);
    expect(revocations).toHaveLength(2);
    expect(revocations[1]).toMatchObject({
      path: "/api/admin/bots/docentes/access/revoke",
      body: { email: newEmail, expectedSub: "new-person-sub", expectedRevision: 7 },
    });
  });

  it("descarta una revocación tardía después del logout y exige login y confirmación nuevos", async () => {
    const oldEmail = "admin-anterior-persona@example.test";
    const newEmail = "admin-nuevo-persona@example.test";
    const pendingRevoke = deferred();
    const { harness } = await startAdmin({
      signInResult: { accessToken: "new-admin-token", idToken: "new-admin-id" },
      behavior: {
        lookup: async ({ body, path }) =>
          jsonResponse({
            botId: path.split("/")[4],
            person: {
              sub: body.email === oldEmail ? "old-person-sub" : "new-person-sub",
              email: body.email,
            },
            access: { state: "active", revision: body.email === oldEmail ? 2 : 12 },
          }),
        revoke: async ({ body, path }) =>
          body.expectedSub === "old-person-sub"
            ? pendingRevoke.promise
            : jsonResponse({
                botId: path.split("/")[4],
                person: { sub: body.expectedSub, email: body.email },
                access: { state: "revoked", revision: body.expectedRevision + 1 },
                operation: { id: body.operationId, status: "recorded" },
              }),
      },
    });

    await search(harness, oldEmail);
    await harness.click(getButton(harness, "Revocar"));
    await harness.click(getButton(harness, "Confirmar revocación"));
    await harness.click(getButton(harness, "Cerrar sesión"));
    expect(button(harness.document, "Ingresar")).toBeTruthy();
    pendingRevoke.resolve(
      jsonResponse({
        botId: "docentes",
        person: { sub: "old-person-sub", email: oldEmail },
        access: { state: "revoked", revision: 3 },
        operation: { id: "old-operation", status: "recorded" },
      }),
    );
    await harness.settle();
    expect(button(harness.document, "Ingresar")).toBeTruthy();
    expect(bodyText(harness.document)).not.toContain(oldEmail);
    expect(bodyText(harness.document)).not.toContain("Acceso revocado");

    await harness.setValue(getInput(harness, "Email"), "new-admin@example.test");
    await harness.setValue(getInput(harness, "Contraseña"), "new-admin-password");
    await harness.click(getButton(harness, "Ingresar"));
    await search(harness, newEmail);
    await harness.click(getButton(harness, "Revocar"));
    expect(bodyText(harness.document).toLowerCase()).toContain(newEmail);
    await harness.click(getButton(harness, "Confirmar revocación"));

    const revocations = apiCalls(harness, "POST", /\/access\/revoke$/);
    expect(revocations).toHaveLength(2);
    expect(revocations[1]).toMatchObject({
      path: "/api/admin/bots/docentes/access/revoke",
      body: { email: newEmail, expectedSub: "new-person-sub", expectedRevision: 12 },
    });
  });

  it("al invitar de nuevo desde revoked conserva el estado revocado hasta que la persona acepte", async () => {
    const email = "restituir@example.test";
    const { harness } = await startAdmin({
      behavior: {
        lookup: async ({ path }) =>
          jsonResponse({
            botId: path.split("/")[4],
            person: { sub: "revoked-person", email },
            access: { state: "revoked", revision: 14 },
          }),
        invitation: async ({ body, path }) =>
          jsonResponse({
            botId: path.split("/")[4],
            person: { sub: "revoked-person", email: body.email },
            access: { state: "revoked", revision: 15 },
            invitation: {
              expiresAt: expiry,
              delivery: { status: "accepted", messageId: "ses-reinvite" },
            },
            operation: { id: body.operationId, status: "recorded" },
          }),
      },
    });

    await search(harness, email);
    expect(bodyText(harness.document)).toMatch(/acceso revocado/i);
    await confirmInvitation(harness, {
      action: "Invitar",
      confirmation: "Confirmar invitación",
      email,
      projectName: "Docentes",
    });

    const body = bodyText(harness.document);
    expect(body).toMatch(/acceso revocado/i);
    expect(body).not.toMatch(/acceso activo/i);
    expect(body).toMatch(/pendiente.*acept|acept.*persona|todav[ií]a no.*acceso/i);
    expect(apiCalls(harness, "POST", /\/invitations$/)).toHaveLength(1);
    expect(apiCalls(harness, "POST", /\/access\/revoke$/)).toHaveLength(0);
  });
});
