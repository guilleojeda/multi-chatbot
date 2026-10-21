import {
  validateProfileInput,
  type ProfileDocument,
  type ProfileDraft,
} from "../../../config/profile";
import { siteConfig } from "../../../config/site";
import type { QuotaView } from "../../../runtime/contracts";
import { createSession, type Session, type SessionTokens } from "../../../web/session";

export const fixtureScenarios = [
  { id: "ready", label: "Perfil completo; Runtime controlado" },
  { id: "incomplete", label: "Perfil docente incompleto" },
  { id: "profile-error", label: "GET del perfil: error recuperable" },
  { id: "profile-pending", label: "GET del perfil: mantener pendiente" },
  { id: "profile-save-error", label: "PUT del perfil: 503 sin aplicar el cambio" },
  { id: "membership-denied", label: "Membresía: acceso denegado" },
  { id: "membership-unauthorized", label: "Membresía: sesión vencida (401)" },
  { id: "membership-temporary", label: "Membresía: fallo temporal 503" },
  { id: "membership-network", label: "Membresía: fallo de red" },
  { id: "config-temporary", label: "Configuración pública: fallo temporal 503" },
  { id: "runtime-admission-pending", label: "Runtime: admisión retenida" },
  { id: "runtime-quota-daily", label: "Runtime: cupo diario agotado" },
  { id: "runtime-quota-monthly", label: "Runtime: cupo mensual agotado" },
  { id: "runtime-quota-both", label: "Runtime: cupos diario y mensual agotados" },
  { id: "runtime-conversation-busy", label: "Runtime: hilo ocupado (sin admisión)" },
  { id: "runtime-stale-base", label: "Runtime: ordinal base desactualizado (sin admisión)" },
  { id: "runtime-401", label: "Runtime: 401 y refresh correcto" },
  { id: "runtime-401-pending", label: "Runtime: 401 y refresh retenidos" },
  { id: "sign-in-pending", label: "Cognito: retener nuevo inicio de sesión" },
  { id: "runtime-expired", label: "Runtime: 401 y sesión vencida" },
  { id: "runtime-forbidden", label: "Runtime: acceso denegado" },
  { id: "password-reset-pending", label: "Cognito: retener confirmación de contraseña" },
  { id: "password-reset-failure", label: "Cognito: rechazar el cambio de contraseña" },
  { id: "signout-pending", label: "Logout: revocación retenida" },
  { id: "clipboard-fail", label: "Portapapeles: simular error al copiar" },
  { id: "clipboard-pending", label: "Portapapeles: retener copias" },
] as const;

export type FixtureScenario = (typeof fixtureScenarios)[number]["id"];

type FixtureStatus = number | "pending" | "cancelled" | "network-error";

type FixtureRequest = {
  number: number;
  method: string;
  url: string;
  authenticated: boolean;
  sessionId?: string;
  accept?: string;
  status: FixtureStatus;
  outcome: string;
  body?: unknown;
};

class FixtureSessionStorage {
  private readonly values = new Map<string, string>([["auth-refresh", "fixture-refresh"]]);

  getItem(key: string) {
    return this.values.get(String(key)) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(String(key), String(value));
  }

  removeItem(key: string) {
    this.values.delete(String(key));
  }
}

type PendingProfile = { release: () => void };
type PendingSignOut = { release: () => void };
type PendingRefresh = { release: () => void };
type PendingRuntime401 = { request: FixtureRequest; release: () => void };
type PendingPasswordReset = { release: (succeeds: boolean) => void };
type PendingSignIn = { email: string; release: () => void };
type ClipboardOperation = {
  id: number;
  text: string;
  status: "pending" | "copied" | "rejected";
  release: (succeeds: boolean) => void;
};

type ControlledStream = {
  request: FixtureRequest;
  push: (value: unknown) => void;
  admit: () => void;
  close: () => void;
  cancel: () => void;
  queryId: string;
  nextIndex: number;
  admitted: boolean;
  closed: boolean;
  turn: FixtureTurn;
};

type FixtureTurn = { ordinal: number; question: string; answer: string; status: string };
type FixtureConversation = { nextOrdinal: number; turns: FixtureTurn[] };

type FixtureIdentity = { sub: string; email: string };

const identities: FixtureIdentity[] = [
  { sub: "fixture-teacher", email: "docente@example.test" },
  { sub: "fixture-teacher-b", email: "docente-b@example.test" },
];
const fixtureInvitations = new Map<string, FixtureIdentity>([
  ["fixture-existing-invitation", identities[0]],
  ["fixture-existing-invitation-b", identities[1]],
]);
const profileDraft: ProfileDraft = {
  fields: { educationLevels: ["secundario"], subjects: ["Matemática"] },
  responsePreferenceIds: ["brief-practical", "classroom-ready"],
};
const fixtureProfiles = identities.map<ProfileDocument>((identity) => ({
  sub: identity.sub,
  botId: "docentes",
  updatedAt: "2026-10-01T12:00:00.000Z",
  ...cloneDraft(profileDraft),
}));

function identityForEmail(email: string) {
  return identities.find((identity) => identity.email === email.trim().toLowerCase()) || null;
}

function cloneDraft(draft: ProfileDraft): ProfileDraft {
  return {
    fields: Object.fromEntries(
      Object.entries(draft.fields).map(([fieldId, values]) => [fieldId, [...values]]),
    ),
    responsePreferenceIds: [...draft.responsePreferenceIds],
  };
}

function cloneProfile(profile: ProfileDocument): ProfileDocument {
  return { ...profile, ...cloneDraft(profile) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(value: unknown) {
  const type = isRecord(value) && typeof value.type === "string" ? value.type : "message";
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function sseResponse(value: unknown) {
  return new Response(sse(value), { headers: { "content-type": "text/event-stream" } });
}

function fixtureQuota(scenario: FixtureScenario): QuotaView {
  const serverNow = Date.now();
  const dailyReset = serverNow + 8 * 60 * 60 * 1000;
  const monthlyReset = serverNow + 21 * 24 * 60 * 60 * 1000;
  const dailyExhausted = scenario === "runtime-quota-daily" || scenario === "runtime-quota-both";
  const monthlyExhausted =
    scenario === "runtime-quota-monthly" || scenario === "runtime-quota-both";
  const blockedUntil = Math.max(
    ...(dailyExhausted ? [dailyReset] : []),
    ...(monthlyExhausted ? [monthlyReset] : []),
  );

  return {
    daily: {
      used: dailyExhausted ? 20 : 0,
      limit: 20,
      resetAt: dailyReset,
      period: "fixture-day",
    },
    monthly: {
      used: monthlyExhausted ? 200 : 0,
      limit: 200,
      resetAt: monthlyReset,
      period: "fixture-month",
    },
    serverNow,
    blockedUntil,
    policyRevision: "fixture-20-200-v1",
  };
}

function initialScenario(): FixtureScenario {
  const requested = new URLSearchParams(window.location.search).get("scenario");
  return fixtureScenarios.some(({ id }) => id === requested)
    ? (requested as FixtureScenario)
    : "ready";
}

export class ChatBrowserFixture {
  readonly session: Session;

  readonly publicConfig = {
    region: "us-east-1",
    userPoolId: "fixture-user-pool",
    clientId: "fixture-web-client",
    apiBaseUrl: "/api",
    botId: "docentes",
    runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/fixture-only",
    runtimeQualifier: "DEFAULT",
  };

  private readonly listeners = new Set<() => void>();
  private readonly requests: FixtureRequest[] = [];
  private readonly tokens = new Map<string, string>();
  private readonly pendingProfiles: PendingProfile[] = [];
  private readonly pendingSignOuts: PendingSignOut[] = [];
  private readonly pendingRefreshes: PendingRefresh[] = [];
  private readonly pendingRuntime401s: PendingRuntime401[] = [];
  private readonly pendingPasswordResets: PendingPasswordReset[] = [];
  private readonly pendingSignIns: PendingSignIn[] = [];
  private readonly clipboardOperations: ClipboardOperation[] = [];
  private readonly streams: ControlledStream[] = [];
  private readonly conversations = new Map<string, FixtureConversation>();
  private readonly sessionStorage = new FixtureSessionStorage();
  private readonly storedProfiles = new Map(
    fixtureProfiles.map((profile) => [profile.sub, cloneProfile(profile)]),
  );
  private selectedScenario = initialScenario();
  private nextToken = 0;
  private restoreCount = 0;
  private restorable = true;
  private refreshSub: string = identities[0].sub;
  private nextClipboardOperation = 0;
  private runtime401Used = false;
  private holdNextRefresh = false;
  private profileRefresh401Used = false;
  private clipboardFailure = false;

  constructor() {
    this.session = createSession({
      clientId: this.publicConfig.clientId,
      region: this.publicConfig.region,
      storage: this.sessionStorage,
      fetch: (input, init) => this.cognitoFetch(input, init),
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => this.writeClipboard(text) },
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  selectScenario(scenario: FixtureScenario) {
    this.selectedScenario = scenario;
    this.clipboardFailure = scenario === "clipboard-fail";
    this.runtime401Used = false;
    this.profileRefresh401Used = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => this.writeClipboard(text) },
    });
    this.changed();
  }

  get scenario() {
    return this.selectedScenario;
  }

  get copyFails() {
    return this.clipboardFailure;
  }

  private issueTokens(sub: string = identities[0].sub, updateRefreshOwner = true): SessionTokens {
    const accessToken = `fixture-access-${++this.nextToken}`;
    const idToken = `fixture-id-${this.nextToken}`;
    this.tokens.set(accessToken, sub);
    if (updateRefreshOwner) this.refreshSub = sub;
    this.changed();
    return { accessToken, idToken };
  }

  private writeClipboard(text: string): Promise<void> {
    if (this.clipboardFailure) return Promise.reject(new Error("Fixture clipboard failure"));
    if (this.selectedScenario !== "clipboard-pending") return Promise.resolve();
    const id = ++this.nextClipboardOperation;
    return new Promise<void>((resolve, reject) => {
      this.clipboardOperations.push({
        id,
        text,
        status: "pending",
        release: (succeeds) => {
          const operation = this.clipboardOperations.find((item) => item.id === id);
          if (!operation || operation.status !== "pending") return;
          operation.status = succeeds ? "copied" : "rejected";
          if (succeeds) resolve();
          else reject(new Error("Fixture clipboard failure"));
          this.changed();
        },
      });
      this.changed();
    });
  }

  private async cognitoFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const target = new Headers(init?.headers).get("x-amz-target") || "";
    let body: unknown;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    } catch {
      body = {};
    }

    if (target.endsWith("RevokeToken")) {
      this.restorable = false;
      this.holdNextRefresh = false;
      this.changed();
      if (this.selectedScenario === "signout-pending") {
        await new Promise<void>((resolve) => this.pendingSignOuts.push({ release: resolve }));
        this.changed();
      }
      return new Response("", { status: 200 });
    }
    if (target.endsWith("ConfirmForgotPassword")) {
      if (this.selectedScenario === "password-reset-pending") {
        return new Promise<Response>((resolve) => {
          this.pendingPasswordResets.push({
            release: (succeeds) => {
              if (succeeds) {
                this.restorable = false;
                this.changed();
                resolve(new Response("", { status: 200 }));
                return;
              }
              resolve(json({ __type: "CodeMismatchException" }, 400));
            },
          });
          this.changed();
        });
      }
      if (this.selectedScenario === "password-reset-failure") {
        return json({ __type: "CodeMismatchException" }, 400);
      }
    }
    if (target.endsWith("ForgotPassword") || target.endsWith("ConfirmForgotPassword")) {
      if (target.endsWith("ConfirmForgotPassword")) {
        this.restorable = false;
        this.changed();
      }
      return new Response("", { status: 200 });
    }
    if (!target.endsWith("InitiateAuth") || !isRecord(body)) {
      throw new Error(`Unexpected Cognito operation: ${target}`);
    }

    if (body.AuthFlow === "USER_PASSWORD_AUTH") {
      const username = isRecord(body.AuthParameters)
        ? String(body.AuthParameters.USERNAME || "")
            .trim()
            .toLowerCase()
        : "";
      const identity = identityForEmail(username);
      if (!identity) return json({ __type: "NotAuthorizedException" }, 400);
      const completeSignIn = () => {
        this.restorable = true;
        return this.cognitoTokens(this.issueTokens(identity.sub));
      };
      if (this.selectedScenario === "sign-in-pending") {
        return new Promise<Response>((resolve) => {
          this.pendingSignIns.push({
            email: identity.email,
            release: () => resolve(completeSignIn()),
          });
          this.changed();
        });
      }
      return completeSignIn();
    }
    if (body.AuthFlow !== "REFRESH_TOKEN_AUTH") {
      return json({ __type: "NotAuthorizedException" }, 400);
    }

    this.restoreCount += 1;
    const refreshSub = this.refreshSub;
    if (
      this.selectedScenario === "runtime-expired" &&
      this.runtime401Used &&
      this.restoreCount > 1
    ) {
      this.restorable = false;
      this.changed();
      return json({ __type: "NotAuthorizedException" }, 400);
    }
    if (!this.restorable) {
      this.changed();
      return json({ __type: "NotAuthorizedException" }, 400);
    }

    if (this.holdNextRefresh) {
      this.holdNextRefresh = false;
      await new Promise<void>((resolve) => {
        this.pendingRefreshes.push({ release: resolve });
        this.changed();
      });
      if (!this.restorable) {
        this.changed();
        return json({ __type: "NotAuthorizedException" }, 400);
      }
    }
    return this.cognitoTokens(this.issueTokens(refreshSub, false));
  }

  private cognitoTokens(tokens: SessionTokens) {
    return json({
      AuthenticationResult: {
        AccessToken: tokens.accessToken,
        IdToken: tokens.idToken,
        RefreshToken: "fixture-refresh",
      },
    });
  }

  private record(
    method: string,
    url: URL,
    authenticated: boolean,
    fields: Partial<Pick<FixtureRequest, "sessionId" | "accept" | "body">> = {},
  ) {
    const request: FixtureRequest = {
      number: this.requests.length + 1,
      method,
      url: `${url.origin}${url.pathname}${url.search}`,
      authenticated,
      status: "pending",
      outcome: "en curso",
      ...fields,
    };
    this.requests.push(request);
    this.changed();
    return request;
  }

  private finish(request: FixtureRequest, status: FixtureStatus, outcome: string) {
    request.status = status;
    request.outcome = outcome;
    this.changed();
  }

  private async profileResponse(request: FixtureRequest, sub: string): Promise<Response> {
    if (this.selectedScenario === "membership-denied") {
      this.finish(request, 403, "membresía denegada al leer el perfil");
      return json(
        {
          code: "FORBIDDEN",
          message: "Esta cuenta no tiene acceso a este proyecto.",
        },
        403,
      );
    }
    if (this.selectedScenario === "profile-pending") {
      await new Promise<void>((resolve) => this.pendingProfiles.push({ release: resolve }));
      this.selectedScenario = "ready";
      this.changed();
    }
    if (this.selectedScenario === "profile-error") {
      this.finish(request, 503, "error recuperable simulado");
      return json({ code: "TEMPORARY_FAILURE" }, 503);
    }
    const profile =
      this.selectedScenario === "incomplete"
        ? null
        : cloneProfile(this.storedProfiles.get(sub) || fixtureProfiles[0]);
    this.finish(request, 200, profile ? "perfil completo simulado" : "perfil ausente simulado");
    return json({ sub, botId: "docentes", profile });
  }

  private async runtimeResponse(
    request: FixtureRequest,
    requestBody: unknown,
    signal?: AbortSignal | null,
  ): Promise<Response> {
    const body = isRecord(requestBody) ? requestBody : {};
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const queryId = typeof body.queryId === "string" ? body.queryId : "";
    const operation = body.operation;

    if (
      body.version !== 2 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        conversationId,
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(queryId) ||
      typeof body.baseOrdinal !== "number" ||
      !Number.isSafeInteger(body.baseOrdinal) ||
      body.baseOrdinal < 0 ||
      typeof body.text !== "string" ||
      !body.text.trim()
    ) {
      this.finish(request, 400, "la solicitud no cumple el contrato v2");
      return json({ code: "INVALID_REQUEST" }, 400);
    }

    if (this.selectedScenario === "runtime-401-pending" && !this.runtime401Used) {
      this.runtime401Used = true;
      request.outcome = "Runtime 401 retenido; liberar desde los controles";
      this.changed();
      return new Promise<Response>((resolve) => {
        this.pendingRuntime401s.push({
          request,
          release: () => resolve(json({ code: "UNAUTHORIZED" }, 401)),
        });
        this.changed();
      });
    }
    if (this.selectedScenario === "runtime-401" && !this.runtime401Used) {
      this.runtime401Used = true;
      this.finish(request, 401, "refresh de acceso activado");
      return json({ code: "UNAUTHORIZED" }, 401);
    }
    if (this.selectedScenario === "runtime-expired" && !this.runtime401Used) {
      this.runtime401Used = true;
      this.finish(request, 401, "sesión vencida simulada");
      return json({ code: "UNAUTHORIZED" }, 401);
    }
    if (this.selectedScenario === "runtime-forbidden") {
      this.finish(request, 403, "acceso denegado simulado");
      return json({ code: "FORBIDDEN" }, 403);
    }

    if (
      this.selectedScenario === "runtime-quota-daily" ||
      this.selectedScenario === "runtime-quota-monthly" ||
      this.selectedScenario === "runtime-quota-both"
    ) {
      this.finish(request, 200, "rechazo de cupo simulado antes de admitir");
      return sseResponse({
        type: "failed",
        code: "quota_exceeded",
        message: "No pudimos completar la consulta. Podés volver a intentarlo desde un hilo nuevo.",
        recordStatus: "not_admitted",
        queryId,
        quota: fixtureQuota(this.selectedScenario),
      });
    }

    if (
      this.selectedScenario === "runtime-conversation-busy" ||
      this.selectedScenario === "runtime-stale-base"
    ) {
      const code =
        this.selectedScenario === "runtime-conversation-busy" ? "conversation_busy" : "stale_base";
      this.finish(request, 200, `rechazo ${code} simulado antes de admitir`);
      return sseResponse({
        type: "failed",
        code,
        message: "No pudimos completar la consulta. Podés volver a intentarlo desde un hilo nuevo.",
        recordStatus: "not_admitted",
        queryId,
      });
    }

    let conversation = this.conversations.get(conversationId);
    if (operation === "start") {
      if (conversation || body.baseOrdinal !== 0) {
        this.finish(request, 409, "el ID ya pertenece a una conversación");
        return json({ code: "CONVERSATION_EXISTS" }, 409);
      }
      conversation = { nextOrdinal: 1, turns: [] };
      this.conversations.set(conversationId, conversation);
    } else if (
      operation !== "message" ||
      !conversation ||
      conversation.turns.length === 0 ||
      body.baseOrdinal !== conversation.nextOrdinal - 1
    ) {
      this.finish(request, 400, "la operación no coincide con la conversación");
      return json({ code: "INVALID_CONVERSATION" }, 400);
    }

    const encoder = new TextEncoder();
    let stream: ControlledStream;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const responseBody = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllerRef = controller;
        const turn: FixtureTurn = {
          ordinal: body.baseOrdinal as number,
          question: typeof body.text === "string" ? body.text : "",
          answer: "",
          status: "pending",
        };
        const admit = () => {
          if (stream.closed || stream.admitted) return;
          stream.admitted = true;
          turn.ordinal += 1;
          conversation!.nextOrdinal = turn.ordinal + 1;
          turn.status = "streaming";
          conversation!.turns.push(turn);
          stream.push({ type: "accepted", conversationId, queryId, ordinal: turn.ordinal });
          const firstText =
            "Propuesta: abrí la clase con una situación cotidiana y pedí que expliquen sus ideas. ";
          stream.push({
            type: "text",
            queryId,
            index: stream.nextIndex++,
            text: firstText,
          });
          turn.answer += firstText;
          request.status = "pending";
          request.outcome = "respuesta progresiva abierta; esperar un cierre manual";
          this.changed();
        };
        stream = {
          request,
          queryId,
          nextIndex: 0,
          admitted: false,
          closed: false,
          turn,
          admit,
          push: (value) => {
            if (!stream.closed) controller.enqueue(encoder.encode(sse(value)));
          },
          close: () => {
            if (stream.closed) return;
            stream.closed = true;
            controller.close();
            this.finish(request, 200, "stream completado manualmente");
            this.changed();
          },
          cancel: () => {
            if (stream.closed) return;
            stream.closed = true;
            this.finish(request, "cancelled", "lector cancelado al invalidar la vista");
          },
        };
        this.streams.push(stream);
        if (this.selectedScenario === "runtime-admission-pending") {
          request.status = "pending";
          request.outcome = "admisión retenida; esperar el control manual";
          this.changed();
        } else {
          admit();
        }
      },
      cancel: () => stream?.cancel(),
    });
    const abortStream = () => {
      if (stream!.closed) return;
      if (this.selectedScenario === "signout-pending") {
        request.outcome = "aborto recibido; se retiene el fragmento para probar callback obsoleto";
        this.changed();
        return;
      }
      stream!.cancel();
      try {
        // The real fetch body errors its reader when AbortController aborts a request.
        // The fixture mirrors that behavior so the production consumer can settle promptly.
        controllerRef?.error(new DOMException("Fixture stream aborted", "AbortError"));
      } catch {
        // The reader may already have canceled or closed the body.
      }
    };
    if (signal?.aborted) abortStream();
    else signal?.addEventListener("abort", abortStream, { once: true });
    return new Response(responseBody, { headers: { "content-type": "text/event-stream" } });
  }

  releaseProfile() {
    this.pendingProfiles.shift()?.release();
    this.changed();
  }

  releaseSignOut() {
    this.pendingSignOuts.shift()?.release();
    this.changed();
  }

  releaseRefresh() {
    this.pendingRefreshes.shift()?.release();
    this.changed();
  }

  releaseRuntime401() {
    const pending = this.pendingRuntime401s.shift();
    if (!pending) return;
    this.holdNextRefresh = true;
    this.finish(pending.request, 401, "401 Runtime liberado; renovar sesión");
    pending.release();
  }

  releasePasswordReset(succeeds: boolean) {
    const pending = this.pendingPasswordResets.shift();
    if (!pending) return;
    pending.release(succeeds);
    this.changed();
  }

  releaseSignIn() {
    this.pendingSignIns.shift()?.release();
    this.changed();
  }

  releaseClipboardOperation(id: number, succeeds: boolean) {
    this.clipboardOperations.find((operation) => operation.id === id)?.release(succeeds);
  }

  admitStream() {
    this.streams.find((item) => !item.closed && !item.admitted)?.admit();
  }

  emitFragment() {
    const stream = this.streams.find((item) => !item.closed && item.admitted);
    if (!stream) return;
    const text =
      "Después, resolvé una consigna breve.\n\nLuego comparen estrategias en parejas: ¿cuál es más clara para el grupo? ¡Buen trabajo!";
    stream.push({
      type: "text",
      queryId: stream.queryId,
      index: stream.nextIndex++,
      text,
    });
    stream.turn.answer += text;
  }

  finishStream(mode: "complete" | "failed" | "profile-required" | "unconfirmed") {
    const stream = this.streams.find((item) => !item.closed && item.admitted);
    if (!stream) return;
    if (mode === "complete") {
      stream.push({ type: "completed", queryId: stream.queryId });
      stream.turn.status = "completed";
    } else if (mode === "failed") {
      stream.push({
        type: "failed",
        code: "generation_failed",
        message: "La generación terminó con un error simulado.",
        recordStatus: "failed",
        queryId: stream.queryId,
      });
      stream.turn.status = "failed";
    } else if (mode === "profile-required") {
      stream.push({
        type: "failed",
        code: "profile_required",
        message: "Completá tu perfil para iniciar esta consulta.",
        recordStatus: "not_admitted",
        queryId: stream.queryId,
      });
      stream.turn.status = "failed";
    } else {
      stream.turn.status = "unconfirmed";
    }
    stream.close();
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const requestInput = input instanceof Request ? input : null;
    const url = new URL(requestInput ? requestInput.url : String(input), window.location.href);
    const method = (init?.method || requestInput?.method || "GET").toUpperCase();
    const headers = new Headers(init?.headers || requestInput?.headers);
    const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const sub = this.tokens.get(bearer);
    let body: unknown;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (bodyText) {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        body = { invalidJson: true };
      }
    }
    const item = this.record(method, url, Boolean(bearer), {
      ...(headers.has("x-amzn-bedrock-agentcore-runtime-session-id")
        ? { sessionId: headers.get("x-amzn-bedrock-agentcore-runtime-session-id") || "" }
        : {}),
      ...(headers.has("accept") ? { accept: headers.get("accept") || "" } : {}),
      ...(body === undefined ? {} : { body }),
    });

    if (url.pathname === "/public-config.json") {
      if (this.selectedScenario === "config-temporary") {
        this.finish(item, 503, "fallo temporal de configuración");
        return json({ code: "TRY_AGAIN" }, 503);
      }
      this.finish(item, 200, "configuración pública simulada");
      return json(this.publicConfig);
    }
    if (url.pathname === "/api/account/invitations/inspect" && method === "POST") {
      const invitation = isRecord(body) ? fixtureInvitations.get(String(body.token || "")) : null;
      if (!invitation) {
        this.finish(item, 404, "invitación de fixture inexistente o vencida");
        return json({ code: "INVALID_INVITATION" }, 404);
      }
      this.finish(item, 200, "invitación vigente para una cuenta existente");
      return json({ kind: "existing", email: invitation.email });
    }
    if (url.pathname === "/api/account/invitations/accept" && method === "POST") {
      if (!sub) {
        this.finish(item, 401, "sin sesión");
        return json({ code: "UNAUTHORIZED" }, 401);
      }
      const invitation = isRecord(body) ? fixtureInvitations.get(String(body.token || "")) : null;
      if (!invitation) {
        this.finish(item, 404, "invitación de fixture inexistente o vencida");
        return json({ code: "INVALID_INVITATION" }, 404);
      }
      if (sub !== invitation.sub) {
        this.finish(item, 403, "la identidad no coincide con la invitación de fixture");
        return json({ code: "INVITATION_EMAIL_MISMATCH" }, 403);
      }
      this.finish(item, 200, "invitación de fixture aceptada");
      return json({ status: "accepted" });
    }
    if (url.pathname === "/api/account/me" && method === "GET") {
      if (
        !sub ||
        this.selectedScenario === "membership-denied" ||
        this.selectedScenario === "membership-unauthorized"
      ) {
        const status = sub && this.selectedScenario === "membership-denied" ? 403 : 401;
        this.finish(item, status, status === 403 ? "membresía denegada" : "sin sesión");
        return json({ code: status === 403 ? "FORBIDDEN" : "UNAUTHORIZED" }, status);
      }
      if (this.selectedScenario === "membership-temporary") {
        this.finish(item, 503, "fallo temporal de membresía");
        return json({ code: "TRY_AGAIN" }, 503);
      }
      if (this.selectedScenario === "membership-network") {
        this.finish(item, "network-error", "fallo de red de membresía");
        throw new Error("Fixture membership network failure");
      }
      this.finish(item, 200, "membresía activa simulada");
      return json({ sub, botId: this.publicConfig.botId });
    }
    if (url.pathname === "/api/profile" && method === "GET") {
      if (!sub) {
        this.finish(item, 401, "sin sesión");
        return json({ code: "UNAUTHORIZED" }, 401);
      }
      return this.profileResponse(item, sub);
    }
    if (url.pathname === "/api/profile" && method === "PUT") {
      if (!sub) {
        this.finish(item, 401, "sin sesión");
        return json({ code: "UNAUTHORIZED" }, 401);
      }
      if (this.selectedScenario === "membership-denied") {
        this.finish(item, 403, "membresía denegada al guardar el perfil");
        return json(
          {
            code: "FORBIDDEN",
            message: "Esta cuenta no tiene acceso a este proyecto.",
          },
          403,
        );
      }
      if (
        this.selectedScenario === "runtime-401-pending" &&
        this.pendingRefreshes.length > 0 &&
        !this.profileRefresh401Used
      ) {
        this.profileRefresh401Used = true;
        this.finish(item, 401, "PUT de perfil espera la renovación ya iniciada por Runtime");
        return json({ code: "UNAUTHORIZED" }, 401);
      }
      const validation = validateProfileInput(body, siteConfig.profile);
      if (!validation.ok) {
        this.finish(item, 400, "perfil inválido");
        return json(
          {
            code: "INVALID_PROFILE",
            message: "Revisá los campos del perfil.",
            fields: validation.fields,
          },
          400,
        );
      }
      if (this.selectedScenario === "profile-save-error") {
        this.finish(item, 503, "fallo temporal al guardar; perfil anterior conservado");
        return json(
          {
            code: "TRY_AGAIN",
            message: "No pudimos completar la operación. Intentá de nuevo.",
          },
          503,
        );
      }
      const profile: ProfileDocument = {
        sub,
        botId: this.publicConfig.botId,
        updatedAt: new Date().toISOString(),
        ...cloneDraft(validation.value),
      };
      this.storedProfiles.set(sub, profile);
      this.finish(item, 200, "perfil de fixture guardado");
      return json({
        sub,
        botId: this.publicConfig.botId,
        profile: cloneProfile(profile),
      });
    }
    if (url.hostname === "bedrock-agentcore.us-east-1.amazonaws.com") {
      if (!sub) {
        this.finish(item, 401, "sin sesión");
        return json({ code: "UNAUTHORIZED" }, 401);
      }
      if (
        !isRecord(body) ||
        (body.operation !== "start" && body.operation !== "message") ||
        typeof body.conversationId !== "string" ||
        typeof body.text !== "string"
      ) {
        this.finish(item, 400, "payload de inicio inválido");
        return json({ code: "INVALID_REQUEST" }, 400);
      }
      return this.runtimeResponse(item, body, init?.signal);
    }
    this.finish(item, 404, "ruta no simulada");
    return json({ code: "NOT_FOUND" }, 404);
  }

  snapshot(route: string) {
    const accessToken = this.session.accessToken();
    const sessionSub = accessToken ? (this.tokens.get(accessToken) ?? null) : null;
    const sessionIdentity = identities.find(({ sub }) => sub === sessionSub) || null;
    return {
      fixture: "chat-browser-local",
      route,
      scenario: this.selectedScenario,
      session: {
        active: Boolean(accessToken),
        sub: sessionSub,
        email: sessionIdentity?.email || null,
        credentialsIncluded: false,
      },
      pendingProfiles: this.pendingProfiles.length,
      pendingSignOuts: this.pendingSignOuts.length,
      pendingRefreshes: this.pendingRefreshes.length,
      pendingRuntime401s: this.pendingRuntime401s.length,
      pendingPasswordResets: this.pendingPasswordResets.length,
      pendingSignIns: this.pendingSignIns.map(({ email }) => ({ email })),
      clipboardOperations: this.clipboardOperations.map(({ id, text, status }) => ({
        id,
        text,
        status,
      })),
      pendingAdmissions: this.streams.filter(({ closed, admitted }) => !closed && !admitted).length,
      admittedStreams: this.streams.filter(({ closed, admitted }) => !closed && admitted).length,
      openStreams: this.streams.filter(({ closed }) => !closed).length,
      conversations: [...this.conversations.entries()].map(([conversationId, conversation]) => ({
        conversationId,
        turns: conversation.turns.map((turn) => ({ ...turn })),
      })),
      storedProfile: cloneDraft(
        this.storedProfiles.get(sessionSub || identities[0].sub) || fixtureProfiles[0],
      ),
      requestCount: this.requests.length,
      requests: this.requests.map(({ ...item }) => ({ ...item })),
    };
  }
}
