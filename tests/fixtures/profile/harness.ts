import type { ProfileDocument, ProfileDraft } from "../../../config/profile";
import type { Session, SessionTokens } from "../../../web/session";

export type FixtureIdentity = "A" | "B";
export type FixtureGate = "GET" | "PUT" | "refresh" | "revoke";

export const fixtureScenarios = [
  { id: "empty", label: "Perfil vacío, respuestas normales" },
  { id: "existing", label: "Perfil previo guardado, respuestas normales" },
  { id: "membership-forbidden", label: "Membresía: /account/me devuelve 403" },
  { id: "get-pending", label: "GET perfil: mantener pendiente" },
  { id: "get-503", label: "GET perfil: 503 recuperable" },
  { id: "get-corrupt", label: "GET perfil: JSON inválido recuperable" },
  { id: "get-403", label: "GET perfil: 403" },
  { id: "get-401-refresh-success", label: "GET perfil: 401, refresh correcto" },
  { id: "get-401-refresh-pending", label: "GET perfil: 401, refresh pendiente" },
  { id: "get-401-refresh-fail", label: "GET perfil: 401, refresh fallido" },
  { id: "get-401-second-401", label: "GET perfil: 401, refresh correcto, segundo 401" },
  { id: "put-pending", label: "PUT perfil: mantener pendiente" },
  { id: "put-503", label: "PUT perfil: 503 recuperable" },
  { id: "put-corrupt", label: "PUT perfil: aplica, JSON inválido" },
  { id: "put-lost", label: "PUT perfil: aplica, respuesta perdida" },
  { id: "put-400", label: "PUT perfil: 400 con campo subjects" },
  { id: "put-413", label: "PUT perfil: 413" },
  { id: "put-403", label: "PUT perfil: 403" },
  { id: "put-401-refresh-success", label: "PUT perfil: 401, refresh correcto" },
  { id: "put-401-refresh-pending", label: "PUT perfil: 401, refresh pendiente" },
  { id: "put-401-refresh-fail", label: "PUT perfil: 401, refresh fallido" },
  { id: "put-401-second-401", label: "PUT perfil: 401, refresh correcto, segundo 401" },
  { id: "revoke-pending", label: "Cerrar sesión: revocación pendiente" },
] as const;

export type FixtureScenario = (typeof fixtureScenarios)[number]["id"];

type ScenarioGate = "GET" | "PUT" | "MEMBERSHIP" | "SIGNOUT";
type RequestStatus = number | "pending" | "network-error";

export type FixtureRequest = {
  number: number;
  method: string;
  path: string;
  identity: FixtureIdentity | "unknown" | null;
  authenticated: boolean;
  status: RequestStatus;
  outcome: string;
  body?: ProfileDraft;
};

type PendingGate = {
  label: string;
  release: () => void;
};

type AuthFault = {
  operation: "GET" | "PUT";
  identity: FixtureIdentity;
  refresh: "success" | "pending" | "fail";
  retryReturns401: boolean;
  phase: "refresh" | "retry";
};

type PublicConfig = {
  region: string;
  userPoolId: string;
  clientId: string;
  apiBaseUrl: string;
  botId: string;
};

const identityDetails: Record<FixtureIdentity, { sub: string; label: string }> = {
  A: { sub: "fixture-user-a", label: "Docente de prueba A" },
  B: { sub: "fixture-user-b", label: "Docente de prueba B" },
};

const initialDraft: ProfileDraft = {
  fields: {
    educationLevels: ["primario", "secundario"],
    subjects: ["Matemática, con coma", "Historia argentina"],
  },
  responsePreferenceIds: ["brief-practical", "step-by-step"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDraft(draft: ProfileDraft): ProfileDraft {
  return {
    fields: Object.fromEntries(
      Object.entries(draft.fields).map(([fieldId, values]) => [fieldId, [...values]]),
    ),
    responsePreferenceIds: [...draft.responsePreferenceIds],
  };
}

function safeDraft(value: unknown): ProfileDraft {
  if (!isRecord(value) || !isRecord(value.fields)) {
    return { fields: {}, responsePreferenceIds: [] };
  }

  const fields: Record<string, string[]> = {};
  for (const [fieldId, values] of Object.entries(value.fields)) {
    if (Array.isArray(values) && values.every((item) => typeof item === "string")) {
      fields[fieldId] = [...values];
    }
  }
  const preferences = value.responsePreferenceIds;
  return {
    fields,
    responsePreferenceIds:
      Array.isArray(preferences) && preferences.every((item) => typeof item === "string")
        ? [...preferences]
        : [],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function scenarioTarget(scenario: FixtureScenario): ScenarioGate | null {
  if (scenario === "membership-forbidden") return "MEMBERSHIP";
  if (scenario === "revoke-pending") return "SIGNOUT";
  if (scenario.startsWith("get-")) return "GET";
  if (scenario.startsWith("put-")) return "PUT";
  return null;
}

export class ProfileBrowserFixture {
  readonly session: Session;

  private readonly publicConfig: PublicConfig;
  private readonly profiles: Record<FixtureIdentity, ProfileDocument | null> = { A: null, B: null };
  private readonly tokenIdentity = new Map<string, FixtureIdentity>();
  private readonly requests: FixtureRequest[] = [];
  private readonly waiters: Record<FixtureGate, PendingGate[]> = {
    GET: [],
    PUT: [],
    refresh: [],
    revoke: [],
  };
  private readonly listeners = new Set<() => void>();
  private activeIdentity: FixtureIdentity | null = null;
  private restoreIdentity: FixtureIdentity | null = null;
  private selectedIdentity: FixtureIdentity = "A";
  private selectedScenario: FixtureScenario = "empty";
  private scenarioArmed = false;
  private authFault: AuthFault | null = null;
  private tokenSequence = 0;

  constructor(botId: string) {
    this.publicConfig = {
      region: "us-east-1",
      userPoolId: "fixture-user-pool",
      clientId: "fixture-client",
      apiBaseUrl: "/api",
      botId,
    };
    this.session = {
      signIn: async (email, password) => this.signIn(email, password),
      requestPasswordReset: async () => undefined,
      confirmPasswordReset: async () => undefined,
      restore: async () => this.restore(),
      accessToken: () => this.accessToken,
      idToken: () => this.idToken,
      signOut: async () => this.signOut(),
    };
  }

  private accessToken: string | null = null;
  private idToken: string | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  get selected(): FixtureIdentity {
    return this.selectedIdentity;
  }

  get scenario(): FixtureScenario {
    return this.selectedScenario;
  }

  get hasArmedScenario(): boolean {
    return this.scenarioArmed;
  }

  selectIdentity(identity: FixtureIdentity) {
    this.selectedIdentity = identity;
    this.changed();
  }

  selectScenario(scenario: FixtureScenario) {
    this.selectedScenario = scenario;
    this.scenarioArmed = false;
    this.authFault = null;

    if (scenario === "empty") {
      this.profiles[this.selectedIdentity] = null;
    } else if (scenario === "existing") {
      this.profiles[this.selectedIdentity] = this.makeProfile(this.selectedIdentity, initialDraft);
    } else {
      this.scenarioArmed = true;
    }
    this.changed();
  }

  prepareRestorableIdentity(): boolean {
    if (this.activeIdentity && this.activeIdentity !== this.selectedIdentity) return false;
    this.restoreIdentity = this.selectedIdentity;
    this.changed();
    return true;
  }

  private makeProfile(identity: FixtureIdentity, draft: ProfileDraft): ProfileDocument {
    return {
      sub: identityDetails[identity].sub,
      botId: this.publicConfig.botId,
      updatedAt: new Date().toISOString(),
      ...cloneDraft(draft),
    };
  }

  private issueTokens(identity: FixtureIdentity): SessionTokens {
    this.activeIdentity = identity;
    this.restoreIdentity = identity;
    const accessToken = "fixture-access-" + identity + "-" + ++this.tokenSequence;
    const idToken = "fixture-id-" + identity + "-" + this.tokenSequence;
    this.tokenIdentity.set(accessToken, identity);
    this.changed();
    this.accessToken = accessToken;
    this.idToken = idToken;
    return { accessToken, idToken };
  }

  private clearSession() {
    this.activeIdentity = null;
    this.restoreIdentity = null;
    this.accessToken = null;
    this.idToken = null;
  }

  private async signIn(email: string, password: string): Promise<SessionTokens> {
    if (!email.trim() || !password) {
      throw Object.assign(new Error("Completá el email y la contraseña."), {
        code: "NotAuthorizedException",
      });
    }
    return this.issueTokens(this.selectedIdentity);
  }

  private async restore(): Promise<SessionTokens | null> {
    const fault = this.authFault;
    if (fault && fault.phase === "refresh") {
      if (fault.refresh === "fail") {
        this.authFault = null;
        this.changed();
        return null;
      }
      if (fault.refresh === "pending") {
        await this.hold("refresh", "Session.restore después del 401", () => {
          if (this.authFault === fault) fault.refresh = "success";
        });
      }
      if (this.authFault !== fault) return null;
      fault.phase = "retry";
      this.changed();
      return this.issueTokens(fault.identity);
    }

    if (!this.restoreIdentity) {
      this.clearSession();
      this.changed();
      return null;
    }
    return this.issueTokens(this.restoreIdentity);
  }

  private async signOut(): Promise<void> {
    this.clearSession();
    this.changed();

    if (this.selectedScenario === "revoke-pending" && this.scenarioArmed) {
      this.scenarioArmed = false;
      this.changed();
      await this.hold("revoke", "Revocación remota de la sesión", () => undefined);
    }
  }

  private hold<T>(gate: FixtureGate, label: string, onRelease: () => T | Promise<T>): Promise<T> {
    let resume!: () => void;
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const waiter: PendingGate = { label, release: resume };
    this.waiters[gate].push(waiter);
    this.changed();

    return released.then(onRelease).finally(() => {
      const queue = this.waiters[gate];
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      this.changed();
    });
  }

  release(gate: FixtureGate): boolean {
    const waiter = this.waiters[gate].shift();
    if (!waiter) return false;
    waiter.release();
    this.changed();
    return true;
  }

  private completeRequest(item: FixtureRequest, status: RequestStatus, outcome: string) {
    item.status = status;
    item.outcome = outcome;
    this.changed();
  }

  private nextScenario(target: ScenarioGate): FixtureScenario | null {
    if (!this.scenarioArmed || scenarioTarget(this.selectedScenario) !== target) return null;
    this.scenarioArmed = false;
    this.changed();
    return this.selectedScenario;
  }

  private profileEnvelope(identity: FixtureIdentity) {
    const profile = this.profiles[identity];
    return {
      sub: identityDetails[identity].sub,
      botId: this.publicConfig.botId,
      profile: profile ? { ...profile, fields: cloneDraft(profile).fields } : null,
    };
  }

  private membershipResponse(identity: FixtureIdentity) {
    return { sub: identityDetails[identity].sub, botId: this.publicConfig.botId };
  }

  private async handleMembership(
    item: FixtureRequest,
    identity: FixtureIdentity | null,
  ): Promise<Response> {
    if (!identity) {
      this.completeRequest(item, 401, "sin sesión válida");
      return jsonResponse({ code: "UNAUTHORIZED" }, 401);
    }
    if (this.nextScenario("MEMBERSHIP")) {
      this.completeRequest(item, 403, "membresía denegada");
      return jsonResponse({ code: "FORBIDDEN" }, 403);
    }
    this.completeRequest(item, 200, "membresía activa");
    return jsonResponse(this.membershipResponse(identity));
  }

  private async handleProfile(
    item: FixtureRequest,
    identity: FixtureIdentity | null,
    method: "GET" | "PUT",
    body: ProfileDraft,
  ): Promise<Response> {
    if (!identity) {
      this.completeRequest(item, 401, "sin sesión válida");
      return jsonResponse({ code: "UNAUTHORIZED" }, 401);
    }

    const activeFault = this.authFault;
    if (activeFault && activeFault.operation === method && activeFault.phase === "retry") {
      this.authFault = null;
      if (activeFault.retryReturns401) {
        this.completeRequest(item, 401, "segundo 401 después del refresh");
        return jsonResponse({ code: "UNAUTHORIZED" }, 401);
      }
      this.completeRequest(item, 200, "repetición después del refresh");
      return method === "GET"
        ? jsonResponse(this.profileEnvelope(identity))
        : this.applyProfile(identity, body);
    }

    const scenario = this.nextScenario(method);
    if (scenario && scenario.indexOf("-401-") >= 0) {
      const authFault = this.makeAuthFault(scenario, method, identity);
      this.authFault = authFault;
      this.completeRequest(item, 401, "primer 401; esperando refresh");
      return jsonResponse({ code: "UNAUTHORIZED" }, 401);
    }

    if (scenario === "get-pending" || scenario === "put-pending") {
      const gate: FixtureGate = method;
      const response = await this.hold(gate, method + " /api/profile", () => {
        this.completeRequest(item, 200, "liberada manualmente");
        return method === "GET"
          ? jsonResponse(this.profileEnvelope(identity))
          : this.applyProfile(identity, body);
      });
      return response;
    }

    if (scenario === "get-503" || scenario === "put-503") {
      this.completeRequest(item, 503, "fallo temporal simulado");
      return jsonResponse({ code: "TEMPORARY_FAILURE" }, 503);
    }

    if (scenario === "get-corrupt") {
      this.completeRequest(item, 200, "cuerpo JSON inválido");
      return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
    }

    if (scenario === "get-403" || scenario === "put-403") {
      this.completeRequest(item, 403, "acceso denegado simulado");
      return jsonResponse({ code: "FORBIDDEN" }, 403);
    }

    if (scenario === "put-corrupt") {
      this.applyProfile(identity, body);
      this.completeRequest(item, 200, "perfil aplicado; cuerpo JSON inválido");
      return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
    }

    if (scenario === "put-lost") {
      this.applyProfile(identity, body);
      this.completeRequest(item, "network-error", "perfil aplicado; respuesta perdida");
      throw new Error("Respuesta simulada perdida");
    }

    if (scenario === "put-400") {
      this.completeRequest(item, 400, "validación simulada");
      return jsonResponse({ code: "INVALID_PROFILE", fields: ["subjects"] }, 400);
    }

    if (scenario === "put-413") {
      this.completeRequest(item, 413, "tamaño excedido simulado");
      return jsonResponse({ code: "PAYLOAD_TOO_LARGE" }, 413);
    }

    this.completeRequest(item, 200, "respuesta correcta");
    return method === "GET"
      ? jsonResponse(this.profileEnvelope(identity))
      : this.applyProfile(identity, body);
  }

  private makeAuthFault(
    scenario: FixtureScenario,
    operation: "GET" | "PUT",
    identity: FixtureIdentity,
  ): AuthFault {
    let refresh: AuthFault["refresh"] = "success";
    if (scenario.indexOf("refresh-pending") >= 0) refresh = "pending";
    if (scenario.indexOf("refresh-fail") >= 0) refresh = "fail";
    return {
      operation,
      identity,
      refresh,
      retryReturns401: scenario.indexOf("second-401") >= 0,
      phase: "refresh",
    };
  }

  private applyProfile(identity: FixtureIdentity, draft: ProfileDraft): Response {
    const normalized: ProfileDraft = {
      fields: Object.fromEntries(
        Object.entries(draft.fields).map(([fieldId, values]) => [
          fieldId,
          [...new Set(values.map((value) => value.trim()).filter(Boolean))],
        ]),
      ),
      responsePreferenceIds: [...new Set(draft.responsePreferenceIds)],
    };
    const profile: ProfileDocument = {
      sub: identityDetails[identity].sub,
      botId: this.publicConfig.botId,
      updatedAt: new Date().toISOString(),
      ...normalized,
    };
    this.profiles[identity] = profile;
    this.changed();
    return jsonResponse({
      sub: identityDetails[identity].sub,
      botId: this.publicConfig.botId,
      profile,
    });
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), window.location.href);
    const path = url.pathname;
    const method = (init?.method || request?.method || "GET").toUpperCase();
    const headers = new Headers(init?.headers || request?.headers);
    const authorization = headers.get("authorization");
    const token = authorization?.replace(/^Bearer\s+/i, "") || "";
    const identity = token ? (this.tokenIdentity.get(token) ?? null) : null;
    const bodyText =
      typeof init?.body === "string" ? init.body : request ? await request.clone().text() : "";
    let parsedBody: unknown = undefined;
    if (bodyText) {
      try {
        parsedBody = JSON.parse(bodyText) as unknown;
      } catch {
        parsedBody = undefined;
      }
    }

    const safeBody =
      method === "PUT" && path === "/api/profile" ? safeDraft(parsedBody) : undefined;
    const item = this.recordRequest(
      method,
      path,
      identity || (token ? "unknown" : null),
      Boolean(token),
      safeBody,
    );

    if (path === "/public-config.json") {
      this.completeRequest(item, 200, "configuración local");
      return jsonResponse(this.publicConfig);
    }

    if (path === "/api/account/invitations/inspect" && method === "POST") {
      const invitationToken = isRecord(parsedBody) ? parsedBody.token : undefined;
      const kind = invitationToken === "fixture-existing" ? "existing" : "new";
      this.completeRequest(item, 200, `invitación local ${kind}`);
      return jsonResponse({
        kind,
        email: kind === "existing" ? "existing@example.test" : "new@example.test",
      });
    }

    if (path === "/api/account/me" && method === "GET") {
      return this.handleMembership(item, identity);
    }

    if (path === "/api/profile" && (method === "GET" || method === "PUT")) {
      return this.handleProfile(
        item,
        identity,
        method,
        safeBody || { fields: {}, responsePreferenceIds: [] },
      );
    }

    this.completeRequest(item, 404, "ruta no simulada");
    return jsonResponse({ code: "NOT_FOUND" }, 404);
  }

  private recordRequest(
    method: string,
    path: string,
    identity: FixtureRequest["identity"],
    authenticated: boolean,
    body?: ProfileDraft,
  ): FixtureRequest {
    const item: FixtureRequest = {
      number: this.requests.length + 1,
      method,
      path,
      identity,
      authenticated,
      status: "pending",
      outcome: "en curso",
      ...(body ? { body: cloneDraft(body) } : {}),
    };
    this.requests.push(item);
    this.changed();
    return item;
  }

  snapshot(route: string) {
    const profiles = Object.fromEntries(
      (["A", "B"] as const).map((identity) => [
        identity,
        {
          label: identityDetails[identity].label,
          sub: identityDetails[identity].sub,
          profile: this.profiles[identity]
            ? {
                fields: cloneDraft(this.profiles[identity]!).fields,
                responsePreferenceIds: [...this.profiles[identity]!.responsePreferenceIds],
                updatedAt: this.profiles[identity]!.updatedAt,
              }
            : null,
        },
      ]),
    );
    const requests = this.requests.map((item) => ({
      number: item.number,
      method: item.method,
      path: item.path,
      identity: item.identity,
      authenticated: item.authenticated,
      status: item.status,
      outcome: item.outcome,
      ...(item.body ? { body: cloneDraft(item.body) } : {}),
    }));
    const pending = Object.fromEntries(
      (["GET", "PUT", "refresh", "revoke"] as const).map((gate) => [
        gate,
        this.waiters[gate].map(({ label }) => label),
      ]),
    );

    return {
      fixture: "profile-browser-local",
      route,
      botId: this.publicConfig.botId,
      selectedIdentity: this.selectedIdentity,
      selectedScenario: this.selectedScenario,
      scenarioArmed: this.scenarioArmed,
      authFault: this.authFault
        ? {
            operation: this.authFault.operation,
            identity: this.authFault.identity,
            refresh: this.authFault.refresh,
            phase: this.authFault.phase,
            retryReturns401: this.authFault.retryReturns401,
          }
        : null,
      session: {
        activeIdentity: this.activeIdentity,
        restorableIdentity: this.restoreIdentity,
      },
      backend: profiles,
      pending,
      requestCount: this.requests.length,
      requests,
      credentialsIncluded: false,
      storageUsed: false,
    };
  }
}
