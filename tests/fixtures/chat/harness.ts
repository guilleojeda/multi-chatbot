import {
  validateProfileInput,
  type ProfileDocument,
  type ProfileDraft,
} from "../../../config/profile";
import { siteConfig } from "../../../config/site";
import type { QuotaView } from "../../../runtime/contracts";
import { createSession, type Session, type SessionTokens } from "../../../web/session";
import { clearChatJournal } from "../../../web/chat-journal";

export const fixtureScenarios = [
  { id: "ready", label: "Perfil completo; Runtime controlado" },
  { id: "incomplete", label: "Perfil docente incompleto" },
  { id: "history-pending", label: "Historial: retener la primera lista" },
  { id: "history-snapshot-pending", label: "Historial: retener una lista ya capturada" },
  { id: "history-error", label: "Historial: error temporal al listar" },
  { id: "history-unavailable", label: "Historial: lista y apertura temporalmente indisponibles" },
  { id: "history-earlier-pending", label: "Historial: retener una página anterior" },
  { id: "history-reload-error", label: "Historial: META correcto y recarga 503" },
  { id: "profile-error", label: "GET del perfil: error recuperable" },
  { id: "profile-pending", label: "GET del perfil: mantener pendiente" },
  { id: "profile-save-error", label: "PUT del perfil: 503 sin aplicar el cambio" },
  { id: "membership-denied", label: "Membresía: acceso denegado" },
  { id: "membership-unauthorized", label: "Membresía: sesión vencida (401)" },
  { id: "membership-temporary", label: "Membresía: fallo temporal 503" },
  { id: "membership-network", label: "Membresía: fallo de red" },
  { id: "config-temporary", label: "Configuración pública: fallo temporal 503" },
  { id: "runtime-admission-pending", label: "Runtime: admisión retenida" },
  { id: "runtime-unconfirmed", label: "Runtime: lookup sin confirmar (sin admisión)" },
  {
    id: "runtime-context-unavailable",
    label: "Runtime: preparación de contexto no disponible (sin admisión)",
  },
  { id: "runtime-temporary", label: "Runtime: fallo temporal 503" },
  { id: "runtime-recover-network", label: "Runtime: fallo de red solo en recover" },
  { id: "runtime-quota-daily", label: "Runtime: cupo diario agotado" },
  { id: "runtime-quota-monthly", label: "Runtime: cupo mensual agotado" },
  { id: "runtime-quota-both", label: "Runtime: cupos diario y mensual agotados" },
  { id: "runtime-capacity-exceeded", label: "Runtime: contexto supera la ventana del modelo" },
  {
    id: "journal-admission-write-failure",
    label: "Storage: falla al guardar la referencia admitida",
  },
  { id: "runtime-documents-unavailable", label: "Runtime: preparación documental retenida" },
  {
    id: "runtime-storage-capacity-exceeded",
    label: "Runtime: preflight de almacenamiento excedido",
  },
  { id: "runtime-conversation-busy", label: "Runtime: hilo ocupado (sin admisión)" },
  { id: "runtime-stale-base", label: "Runtime: ordinal base desactualizado (sin admisión)" },
  { id: "runtime-401", label: "Runtime: 401 y refresh correcto" },
  { id: "runtime-401-pending", label: "Runtime: 401 y refresh retenidos" },
  { id: "cognito-refresh-network", label: "Cognito: refresh token falla con TypeError de red" },
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
type PendingHistory = { request: FixtureRequest; release: () => void };
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
  rejectDocuments: () => void;
  close: () => void;
  cancel: () => void;
  queryId: string;
  nextIndex: number;
  admitted: boolean;
  producerClosed: boolean;
  transportClosed: boolean;
  turn: FixtureTurn;
  disconnect: () => void;
};

type FixtureTurn = {
  ordinal: number;
  queryId: string;
  question: string;
  answer: string;
  status: string;
  canContinue: boolean;
};
type FixtureConversation = {
  conversationId: string;
  ownerSub: string;
  botId: string;
  createdAt?: string;
  updatedAt?: string;
  closed?: boolean;
  nextOrdinal: number;
  turns: FixtureTurn[];
};

type StoredFixtureState = {
  version: 1;
  conversations: FixtureConversation[];
};

const fixtureTabStateKey = "multi-chatbot:fixture-chat-tab-state:v1";
const productJournalPrefix = "chat-journal:v3";

class FixtureProductStorage {
  private rejectAdmittedJournalWrites = false;

  constructor(private readonly storage: Storage) {}

  get length() {
    return this.storage.length;
  }

  key(index: number) {
    return this.storage.key(index);
  }

  getItem(key: string) {
    return this.storage.getItem(key);
  }

  setItem(key: string, value: string) {
    if (this.rejectAdmittedJournalWrites && key.startsWith(`${productJournalPrefix}:entry:`)) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (isRecord(parsed) && parsed.admitted === true) {
          throw new DOMException(
            "The fixture rejected an admitted journal write",
            "QuotaExceededError",
          );
        }
      } catch (error) {
        if (error instanceof DOMException) throw error;
      }
    }
    this.storage.setItem(key, value);
  }

  removeItem(key: string) {
    this.storage.removeItem(key);
  }

  clear() {
    this.storage.clear();
  }

  setAdmissionWriteFailure(enabled: boolean) {
    this.rejectAdmittedJournalWrites = enabled;
  }
}

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

function isFixtureTurn(value: unknown): value is FixtureTurn {
  return (
    isRecord(value) &&
    typeof value.ordinal === "number" &&
    Number.isSafeInteger(value.ordinal) &&
    value.ordinal > 0 &&
    typeof value.queryId === "string" &&
    value.queryId.length > 0 &&
    typeof value.question === "string" &&
    typeof value.answer === "string" &&
    typeof value.status === "string" &&
    typeof value.canContinue === "boolean"
  );
}

function isFixtureConversation(value: unknown): value is FixtureConversation {
  return (
    isRecord(value) &&
    typeof value.conversationId === "string" &&
    value.conversationId.length > 0 &&
    typeof value.ownerSub === "string" &&
    typeof value.botId === "string" &&
    (value.createdAt === undefined || typeof value.createdAt === "string") &&
    (value.updatedAt === undefined || typeof value.updatedAt === "string") &&
    (value.closed === undefined || typeof value.closed === "boolean") &&
    typeof value.nextOrdinal === "number" &&
    Number.isSafeInteger(value.nextOrdinal) &&
    value.nextOrdinal > 0 &&
    Array.isArray(value.turns) &&
    value.turns.every(isFixtureTurn)
  );
}

function readFixtureTabState(): Map<string, FixtureConversation> {
  try {
    const raw = window.sessionStorage.getItem(fixtureTabStateKey);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.conversations)) {
      return new Map();
    }
    const conversations = parsed.conversations.filter(isFixtureConversation);
    return new Map(
      conversations.map((conversation) => [
        conversation.conversationId,
        cloneConversation(conversation),
      ]),
    );
  } catch {
    return new Map();
  }
}

function cloneConversation(conversation: FixtureConversation): FixtureConversation {
  return {
    conversationId: conversation.conversationId,
    ownerSub: conversation.ownerSub,
    botId: conversation.botId,
    ...(conversation.createdAt ? { createdAt: conversation.createdAt } : {}),
    ...(conversation.updatedAt ? { updatedAt: conversation.updatedAt } : {}),
    ...(conversation.closed === undefined ? {} : { closed: conversation.closed }),
    nextOrdinal: conversation.nextOrdinal,
    turns: conversation.turns.map((turn) => ({ ...turn })),
  };
}

const fixtureUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const historyPageSize = 20;
const historyTextPageSize = 2;

function fixtureUuid(prefix: string, number: number) {
  return `${prefix}-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function splitHistoryText(text: string) {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += 72) {
    chunks.push(characters.slice(offset, offset + 72).join(""));
  }
  return chunks;
}

function historyLabel(question: string) {
  const normalized = question.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= 120 ? normalized : `${characters.slice(0, 119).join("")}…`;
}

function publicTurnStatus(turn: FixtureTurn): "in_progress" | "completed" | "failed" {
  if (turn.status === "completed") return "completed";
  if (turn.status === "failed") return "failed";
  return "in_progress";
}

function productJournalScope(config: ChatBrowserFixture["publicConfig"]) {
  return [
    config.region,
    config.clientId,
    config.apiBaseUrl,
    config.runtimeArn,
    config.runtimeQualifier,
    config.botId,
  ];
}

function sanitizedJournalRequest(value: unknown) {
  if (!isRecord(value)) return null;
  const { version, operation, conversationId, queryId, baseOrdinal, text } = value;
  if (
    version !== 2 ||
    (operation !== "start" && operation !== "message") ||
    typeof conversationId !== "string" ||
    typeof queryId !== "string" ||
    typeof baseOrdinal !== "number" ||
    !Number.isSafeInteger(baseOrdinal)
  ) {
    return null;
  }
  return {
    version,
    operation,
    conversationId,
    queryId,
    baseOrdinal,
    ...(typeof text === "string" ? { text } : {}),
  };
}

function readProductJournal(config: ChatBrowserFixture["publicConfig"]) {
  const entries: Array<{
    sub: string;
    botId: string;
    admitted: boolean;
    ordinal?: number;
    request: ReturnType<typeof sanitizedJournalRequest>;
  }> = [];
  const ownerPointers: string[] = [];
  const scope = productJournalScope(config);
  try {
    const store = window.sessionStorage;
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (!key || !key.startsWith(productJournalPrefix)) continue;
      const raw = store.getItem(key);
      if (!raw) continue;
      if (key.startsWith(`${productJournalPrefix}:owner:`)) {
        try {
          const owner: unknown = JSON.parse(raw);
          if (
            isRecord(owner) &&
            owner.botId === config.botId &&
            typeof owner.sub === "string" &&
            identities.some(({ sub }) => sub === owner.sub)
          ) {
            ownerPointers.push(owner.sub);
          }
        } catch {
          // A malformed owner pointer is not a valid fixture identity.
        }
        continue;
      }
      if (!key.startsWith(`${productJournalPrefix}:entry:`)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        continue;
      }
      if (
        !isRecord(parsed) ||
        parsed.version !== 3 ||
        JSON.stringify(parsed.scope) !== JSON.stringify(scope) ||
        typeof parsed.sub !== "string" ||
        typeof parsed.botId !== "string" ||
        parsed.botId !== config.botId ||
        !identities.some(({ sub }) => sub === parsed.sub) ||
        typeof parsed.admitted !== "boolean"
      ) {
        continue;
      }
      const request = sanitizedJournalRequest(parsed.request);
      if (!request) continue;
      const ordinal =
        typeof parsed.ordinal === "number" && Number.isSafeInteger(parsed.ordinal)
          ? parsed.ordinal
          : undefined;
      entries.push({
        sub: parsed.sub,
        botId: parsed.botId,
        admitted: parsed.admitted,
        ...(ordinal === undefined ? {} : { ordinal }),
        request,
      });
    }
  } catch {
    return { entries: [], ownerPointers: [] };
  }
  return { entries, ownerPointers };
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
  private readonly pendingHistoryReads: PendingHistory[] = [];
  private readonly pendingSignOuts: PendingSignOut[] = [];
  private readonly pendingRefreshes: PendingRefresh[] = [];
  private readonly pendingRuntime401s: PendingRuntime401[] = [];
  private readonly pendingPasswordResets: PendingPasswordReset[] = [];
  private readonly pendingSignIns: PendingSignIn[] = [];
  private readonly clipboardOperations: ClipboardOperation[] = [];
  private readonly streams: ControlledStream[] = [];
  private readonly productStorage: FixtureProductStorage;
  private readonly conversations: Map<string, FixtureConversation>;
  private readonly sessionStorage = new FixtureSessionStorage();
  private readonly storedProfiles = new Map(
    fixtureProfiles.map((profile) => [profile.sub, cloneProfile(profile)]),
  );
  private selectedScenario = initialScenario();
  private historyReloadReads = 0;
  private nextToken = 0;
  private nextRemoteQueryNumber = 0;
  private restoreCount = 0;
  private restorable = true;
  private refreshSub: string = identities[0].sub;
  private nextClipboardOperation = 0;
  private runtime401Used = false;
  private holdNextRefresh = false;
  private profileRefresh401Used = false;
  private clipboardFailure = false;

  constructor() {
    this.productStorage = new FixtureProductStorage(window.sessionStorage);
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: this.productStorage,
    });
    this.productStorage.setAdmissionWriteFailure(
      this.selectedScenario === "journal-admission-write-failure",
    );
    this.conversations = readFixtureTabState();
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

  private persistConversations() {
    const state: StoredFixtureState = {
      version: 1,
      conversations: [...this.conversations.values()].map(cloneConversation),
    };
    try {
      window.sessionStorage.setItem(fixtureTabStateKey, JSON.stringify(state));
    } catch {
      // The fixture remains usable when a browser blocks sessionStorage. Its state is then volatile.
    }
  }

  private touchConversation(turn: FixtureTurn) {
    for (const conversation of this.conversations.values()) {
      if (conversation.turns.includes(turn)) {
        conversation.updatedAt = new Date().toISOString();
        return conversation;
      }
    }
    return undefined;
  }

  private activeSessionSub() {
    const accessToken = this.session.accessToken();
    return accessToken ? (this.tokens.get(accessToken) ?? null) : null;
  }

  private restoredActiveTurns() {
    const sub = this.activeSessionSub();
    if (!sub) return [];
    const liveQueryIds = new Set(
      this.streams
        .filter(({ producerClosed, admitted }) => !producerClosed && admitted)
        .map(({ queryId }) => queryId),
    );
    return [...this.conversations.values()]
      .filter(({ ownerSub, botId }) => ownerSub === sub && botId === this.publicConfig.botId)
      .flatMap(({ turns }) => turns)
      .filter(
        ({ queryId, status }) =>
          !liveQueryIds.has(queryId) && status !== "completed" && status !== "failed",
      );
  }

  selectScenario(scenario: FixtureScenario) {
    this.selectedScenario = scenario;
    this.historyReloadReads = 0;
    this.clipboardFailure = scenario === "clipboard-fail";
    this.productStorage.setAdmissionWriteFailure(scenario === "journal-admission-write-failure");
    this.runtime401Used = false;
    this.profileRefresh401Used = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => this.writeClipboard(text) },
    });
    this.changed();
  }

  seedHistoryDemo() {
    const ownerSub = this.activeSessionSub() || identities[0].sub;
    const now = Date.now();
    for (let conversationNumber = 1; conversationNumber <= 22; conversationNumber += 1) {
      const conversationId = fixtureUuid("70000000", conversationNumber);
      const turnCount = conversationNumber === 1 ? 22 : 1;
      const closed = conversationNumber === 2;
      const turns: FixtureTurn[] = [];
      for (let ordinal = 1; ordinal <= turnCount; ordinal += 1) {
        const isActive = conversationNumber === 1 && ordinal === turnCount;
        const isFailed = closed || (conversationNumber === 1 && ordinal === 18);
        const question =
          conversationNumber === 1 && ordinal === 1
            ? "Quiero planificar una clase de matemática sobre estrategias para resolver problemas."
            : conversationNumber === 2
              ? "Conversación cerrada de prueba: preparar una actividad breve."
              : `Consulta de prueba ${ordinal} para la conversación ${conversationNumber}.`;
        const answer = isActive
          ? "Prefijo de respuesta todavía en curso. ".repeat(18)
          : isFailed
            ? "Texto parcial de una respuesta fallida. ".repeat(5)
            : `Respuesta completa de prueba para la consulta ${ordinal}. `.repeat(4);
        const queryNumber = conversationNumber * 100 + ordinal;
        turns.push({
          ordinal,
          queryId: fixtureUuid("80000000", queryNumber),
          question,
          answer,
          status: isActive ? "streaming" : isFailed ? "failed" : "completed",
          canContinue: !isActive && !closed,
        });
      }
      const updatedAt = new Date(now - (conversationNumber - 1) * 60_000).toISOString();
      this.conversations.set(conversationId, {
        conversationId,
        ownerSub,
        botId: this.publicConfig.botId,
        createdAt: new Date(now - conversationNumber * 60_000).toISOString(),
        updatedAt,
        closed,
        nextOrdinal: turnCount + 1,
        turns,
      });
    }
    this.persistConversations();
    this.changed();
  }

  seedHistorySelectionDemo() {
    const ownerSub = this.activeSessionSub() || identities[0].sub;
    const now = Date.now();
    this.conversations.clear();
    try {
      clearChatJournal(this.publicConfig, { sub: ownerSub, botId: this.publicConfig.botId });
    } catch {
      // The seeded server history remains useful if fixture storage is unavailable.
    }
    for (const [conversationNumber, offset, active] of [
      [1, 120_000, true],
      [2, 60_000, false],
    ] as const) {
      const conversationId = fixtureUuid("71000000", conversationNumber);
      const turns: FixtureTurn[] = Array.from({ length: 22 }, (_, index) => {
        const ordinal = index + 1;
        const isActive = active && ordinal === 22;
        return {
          ordinal,
          queryId: fixtureUuid("81000000", conversationNumber * 100 + ordinal),
          question:
            ordinal === 1
              ? `Hilo ${active ? "A antiguo y activo" : "B reciente"}: primera consulta.`
              : `Consulta ${ordinal} del hilo ${active ? "A" : "B"}.`,
          answer: isActive
            ? "Prefijo durable de la respuesta activa del hilo A."
            : `Respuesta completa ${ordinal} del hilo ${active ? "A" : "B"}.`,
          status: isActive ? "streaming" : "completed",
          canContinue: !isActive,
        };
      });
      this.conversations.set(conversationId, {
        conversationId,
        ownerSub,
        botId: this.publicConfig.botId,
        createdAt: new Date(now - offset - 60_000).toISOString(),
        updatedAt: new Date(now - offset).toISOString(),
        closed: false,
        nextOrdinal: turns.length + 1,
        turns,
      });
    }
    this.persistConversations();
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
    if (this.selectedScenario === "cognito-refresh-network") {
      this.changed();
      throw new TypeError("Failed to fetch");
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

  private historyJson(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private async historyResponse(
    request: FixtureRequest,
    url: URL,
    sub: string | undefined,
  ): Promise<Response> {
    if (!sub) {
      this.finish(request, 401, "historial requiere una sesión de fixture");
      return this.historyJson({ code: "UNAUTHORIZED" }, 401);
    }
    if (this.selectedScenario === "membership-denied") {
      this.finish(request, 403, "membresía denegada antes de leer el historial");
      return this.historyJson({ code: "FORBIDDEN" }, 403);
    }
    if (this.selectedScenario === "membership-unauthorized") {
      this.finish(request, 401, "sesión vencida antes de leer el historial");
      return this.historyJson({ code: "UNAUTHORIZED" }, 401);
    }
    if (this.selectedScenario === "membership-temporary") {
      this.finish(request, 503, "membresía temporalmente no disponible para historial");
      return this.historyJson({ code: "HISTORY_UNAVAILABLE" }, 503);
    }
    if (this.selectedScenario === "membership-network") {
      this.finish(request, "network-error", "fallo de red al comprobar membresía de historial");
      throw new TypeError("Failed to fetch");
    }

    const listPath = "/api/chat/conversations";
    if (this.selectedScenario === "history-unavailable") {
      this.finish(request, 503, "fallo temporal de las lecturas del historial");
      return this.historyJson({ code: "HISTORY_UNAVAILABLE" }, 503);
    }
    if (url.pathname === listPath && request.method === "GET") {
      if (this.selectedScenario === "history-error") {
        this.finish(request, 503, "fallo temporal al listar el historial");
        return this.historyJson(
          { code: "HISTORY_UNAVAILABLE", message: "No pudimos cargar el historial." },
          503,
        );
      }
      if (this.selectedScenario === "history-pending") {
        request.status = "pending";
        request.outcome = "la primera lista espera el control Liberar historial";
        this.changed();
        await new Promise<void>((resolve) =>
          this.pendingHistoryReads.push({ request, release: resolve }),
        );
        if (this.selectedScenario === "history-pending") this.selectedScenario = "ready";
      }

      const limitValue = url.searchParams.get("limit");
      const limit =
        limitValue === null || limitValue === ""
          ? historyPageSize
          : /^\d+$/.test(limitValue)
            ? Number(limitValue)
            : Number.NaN;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        this.finish(request, 400, "límite de lista inválido");
        return this.historyJson({ code: "INVALID_REQUEST" }, 400);
      }
      const scoped = [...this.conversations.values()].filter(
        (conversation) =>
          conversation.ownerSub === sub &&
          conversation.botId === this.publicConfig.botId &&
          conversation.turns.length > 0,
      );
      const conversations = scoped.sort((left, right) => {
        const time = (right.updatedAt || "0000").localeCompare(left.updatedAt || "0000");
        return time || right.conversationId.localeCompare(left.conversationId);
      });
      const cursor = url.searchParams.get("cursor");
      let offset = 0;
      if (cursor !== null && cursor !== "") {
        const match = /^list:v1:([^:]+):([^:]+):(\d+)$/.exec(cursor);
        if (
          !match ||
          match[1] !== sub ||
          match[2] !== this.publicConfig.botId ||
          !Number.isSafeInteger(Number(match[3]))
        ) {
          this.finish(request, 400, "cursor de lista inválido para este sujeto o bot");
          return this.historyJson({ code: "INVALID_CURSOR" }, 400);
        }
        offset = Number(match[3]);
      }
      const page = conversations.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const nextCursor =
        nextOffset < conversations.length
          ? `list:v1:${sub}:${this.publicConfig.botId}:${nextOffset}`
          : undefined;
      const payload = {
        version: 1,
        conversations: page.map((conversation) => {
          const firstTurn = [...conversation.turns].sort((a, b) => a.ordinal - b.ordinal)[0];
          const latestTurn = [...conversation.turns].sort((a, b) => b.ordinal - a.ordinal)[0];
          return {
            conversationId: conversation.conversationId,
            label: historyLabel(firstTurn.question),
            ...(conversation.createdAt ? { createdAt: conversation.createdAt } : {}),
            ...(conversation.updatedAt ? { updatedAt: conversation.updatedAt } : {}),
            lastOrdinal: latestTurn.ordinal,
            closed: conversation.closed === true,
            ...(publicTurnStatus(latestTurn) === "in_progress"
              ? { activeQueryId: latestTurn.queryId }
              : {}),
          };
        }),
        ...(nextCursor ? { nextCursor } : {}),
      };
      if (this.selectedScenario === "history-snapshot-pending") {
        request.status = "pending";
        request.outcome = "lista capturada; esperar Liberar historial aunque el productor avance";
        this.changed();
        await new Promise<void>((resolve) =>
          this.pendingHistoryReads.push({ request, release: resolve }),
        );
        if (this.selectedScenario === "history-snapshot-pending") this.selectedScenario = "ready";
      }
      this.finish(request, 200, `lista de ${page.length} originales del productor para ${sub}`);
      return this.historyJson(payload);
    }

    const textMatch = /^\/api\/chat\/conversations\/([^/]+)\/turns\/(\d+)\/text$/.exec(
      url.pathname,
    );
    const turnsMatch = /^\/api\/chat\/conversations\/([^/]+)\/turns$/.exec(url.pathname);
    if (request.method !== "GET" || (!textMatch && !turnsMatch)) {
      this.finish(request, 404, "ruta de historial no simulada");
      return this.historyJson({ code: "NOT_FOUND" }, 404);
    }

    let conversationId = "";
    try {
      conversationId = decodeURIComponent((textMatch || turnsMatch)![1]);
    } catch {
      this.finish(request, 400, "ID de conversación mal codificado");
      return this.historyJson({ code: "INVALID_REQUEST" }, 400);
    }
    if (!fixtureUuidPattern.test(conversationId)) {
      this.finish(request, 400, "ID de conversación inválido");
      return this.historyJson({ code: "INVALID_REQUEST" }, 400);
    }
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      this.finish(request, 404, "conversación no disponible en el productor de fixture");
      return this.historyJson({ code: "NOT_FOUND" }, 404);
    }
    if (conversation.ownerSub !== sub || conversation.botId !== this.publicConfig.botId) {
      this.finish(request, 403, "el historial pertenece a otro sujeto o bot");
      return this.historyJson({ code: "FORBIDDEN" }, 403);
    }

    if (
      turnsMatch &&
      url.searchParams.has("cursor") &&
      this.selectedScenario === "history-earlier-pending"
    ) {
      this.selectedScenario = "ready";
      request.status = "pending";
      request.outcome = "la primera página anterior espera el control Liberar historial";
      this.changed();
      await new Promise<void>((resolve) =>
        this.pendingHistoryReads.push({ request, release: resolve }),
      );
    }

    if (turnsMatch && this.selectedScenario === "history-reload-error") {
      this.historyReloadReads += 1;
      if (this.historyReloadReads > 1) {
        this.finish(request, 503, "META respondió; la recarga posterior del hilo falla");
        return this.historyJson({ code: "HISTORY_UNAVAILABLE" }, 503);
      }
    }

    const limitValue = url.searchParams.get("limit");
    const limit =
      limitValue === null || limitValue === ""
        ? historyPageSize
        : /^\d+$/.test(limitValue)
          ? Number(limitValue)
          : Number.NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      this.finish(request, 400, "límite de historial inválido");
      return this.historyJson({ code: "INVALID_REQUEST" }, 400);
    }

    if (textMatch) {
      const ordinal = Number(textMatch[2]);
      const role = url.searchParams.get("role");
      const queryId = url.searchParams.get("queryId");
      const throughCursorValue = url.searchParams.get("throughCursor");
      const throughCursor =
        throughCursorValue !== null && /^\d+$/.test(throughCursorValue)
          ? Number(throughCursorValue)
          : Number.NaN;
      if (
        !Number.isSafeInteger(ordinal) ||
        ordinal < 1 ||
        (role !== "user" && role !== "assistant") ||
        !queryId ||
        !fixtureUuidPattern.test(queryId) ||
        !Number.isSafeInteger(throughCursor) ||
        throughCursor < 0
      ) {
        this.finish(request, 400, "parámetros de texto inválidos");
        return this.historyJson({ code: "INVALID_REQUEST" }, 400);
      }
      const turn = conversation.turns.find(
        (candidate) => candidate.ordinal === ordinal && candidate.queryId === queryId,
      );
      if (!turn) {
        this.finish(request, 404, "turno no disponible para ese ID de consulta");
        return this.historyJson({ code: "NOT_FOUND" }, 404);
      }
      const chunks = splitHistoryText(role === "user" ? turn.question : turn.answer);
      if (throughCursor > chunks.length || (role === "user" && throughCursor !== chunks.length)) {
        this.finish(request, 400, "throughCursor no coincide con el manifiesto del texto original");
        return this.historyJson({ code: "INVALID_REQUEST" }, 400);
      }
      const through = throughCursor;
      const cursor = url.searchParams.get("cursor");
      let offset = 0;
      if (cursor !== null && cursor !== "") {
        const match =
          /^text:v1:([^:]+):([^:]+):([^:]+):(\d+):([^:]+):(user|assistant):(\d+):(\d+)$/.exec(
            cursor,
          );
        if (
          !match ||
          match[1] !== sub ||
          match[2] !== this.publicConfig.botId ||
          match[3] !== conversationId ||
          Number(match[4]) !== ordinal ||
          match[5] !== queryId ||
          match[6] !== role ||
          Number(match[7]) !== throughCursor
        ) {
          this.finish(request, 400, "cursor de texto inválido para este prefijo");
          return this.historyJson({ code: "INVALID_CURSOR" }, 400);
        }
        offset = Number(match[8]);
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > through) {
        this.finish(request, 400, "cursor de texto fuera del prefijo observado");
        return this.historyJson({ code: "INVALID_CURSOR" }, 400);
      }
      const end = Math.min(offset + historyTextPageSize, through);
      const nextCursor =
        end < through
          ? `text:v1:${sub}:${this.publicConfig.botId}:${conversationId}:${ordinal}:${queryId}:${role}:${throughCursor}:${end}`
          : undefined;
      const pageChunks = chunks
        .slice(offset, end)
        .map((text, index) => ({ index: offset + index, text }));
      this.finish(request, 200, `${pageChunks.length} fragmento(s) original(es) de ${role}`);
      return this.historyJson({
        version: 1,
        conversationId,
        queryId,
        ordinal,
        role,
        chunks: pageChunks,
        complete: end >= through,
        ...(nextCursor ? { nextCursor } : {}),
      });
    }

    const latestOrdinal = conversation.turns.reduce((max, turn) => Math.max(max, turn.ordinal), 0);
    let throughOrdinal = latestOrdinal;
    let beforeOrdinal = latestOrdinal + 1;
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && cursor !== "") {
      const match = /^turns:v1:([^:]+):([^:]+):([^:]+):(\d+):(\d+)$/.exec(cursor);
      if (
        !match ||
        match[1] !== sub ||
        match[2] !== this.publicConfig.botId ||
        match[3] !== conversationId
      ) {
        this.finish(request, 400, "cursor de turnos inválido para este sujeto, bot o conversación");
        return this.historyJson({ code: "INVALID_CURSOR" }, 400);
      }
      throughOrdinal = Number(match[4]);
      beforeOrdinal = Number(match[5]);
      if (
        !Number.isSafeInteger(throughOrdinal) ||
        !Number.isSafeInteger(beforeOrdinal) ||
        throughOrdinal < 0 ||
        throughOrdinal > latestOrdinal ||
        beforeOrdinal < 1 ||
        beforeOrdinal > throughOrdinal + 1
      ) {
        this.finish(request, 400, "cursor de turnos inválido para el prefijo observado");
        return this.historyJson({ code: "INVALID_CURSOR" }, 400);
      }
    }
    const eligible = conversation.turns
      .filter((turn) => turn.ordinal <= throughOrdinal && turn.ordinal < beforeOrdinal)
      .sort((left, right) => right.ordinal - left.ordinal);
    const page = eligible.slice(0, limit).sort((left, right) => left.ordinal - right.ordinal);
    const nextCursor =
      eligible.length > page.length && page.length > 0
        ? `turns:v1:${sub}:${this.publicConfig.botId}:${conversationId}:${throughOrdinal}:${page[0].ordinal}`
        : undefined;
    const latestTurn = conversation.turns.reduce<FixtureTurn | undefined>(
      (latest, turn) => (!latest || turn.ordinal > latest.ordinal ? turn : latest),
      undefined,
    );
    this.finish(request, 200, `${page.length} turnos originales para ${sub}`);
    return this.historyJson({
      version: 1,
      conversationId,
      throughOrdinal,
      closed: conversation.closed === true,
      canContinue:
        conversation.closed !== true &&
        (!latestTurn || (publicTurnStatus(latestTurn) !== "in_progress" && latestTurn.canContinue)),
      turns: page.map((turn) => {
        const questionChunks = splitHistoryText(turn.question);
        const answerChunks = splitHistoryText(turn.answer);
        const status = publicTurnStatus(turn);
        return {
          ordinal: turn.ordinal,
          queryId: turn.queryId,
          status,
          questionManifest: { count: questionChunks.length, complete: true },
          answerManifest: { count: answerChunks.length, complete: status !== "in_progress" },
          cursor: answerChunks.length,
          ...(status === "failed"
            ? { failure: { code: turn.canContinue ? "generation_failed" : "profile_required" } }
            : {}),
        };
      }),
      ...(nextCursor ? { nextCursor } : {}),
    });
  }

  private recoverResponse(
    request: FixtureRequest,
    conversationId: string,
    queryId: string,
    sub: string,
  ): Response {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      this.finish(request, 200, "no hay una conversación recuperable para ese ID");
      return json({
        type: "failed",
        code: "conversation_unavailable",
        message: "No pudimos completar la consulta. Podés volver a intentarlo desde un hilo nuevo.",
        recordStatus: "not_admitted",
        queryId,
      });
    }
    if (conversation.ownerSub !== sub || conversation.botId !== this.publicConfig.botId) {
      this.finish(request, 403, "el envío no pertenece a la identidad de fixture");
      return json({ code: "FORBIDDEN" }, 403);
    }
    const turn = conversation.turns.find((candidate) => candidate.queryId === queryId);
    if (!turn) {
      this.finish(request, 200, "no hay un envío recuperable para ese ID");
      return json({
        type: "failed",
        code: "conversation_unavailable",
        message: "No pudimos completar la consulta. Podés volver a intentarlo desde un hilo nuevo.",
        recordStatus: "not_admitted",
        queryId,
      });
    }

    const status =
      turn.status === "completed"
        ? "completed"
        : turn.status === "failed"
          ? "failed"
          : "in_progress";
    const latestTurn = conversation.turns.reduce<FixtureTurn | undefined>(
      (latest, candidate) => (!latest || candidate.ordinal > latest.ordinal ? candidate : latest),
      undefined,
    );
    const canContinue =
      status !== "in_progress" &&
      turn.canContinue &&
      conversation.closed !== true &&
      latestTurn?.ordinal === turn.ordinal &&
      latestTurn.queryId === turn.queryId &&
      publicTurnStatus(latestTurn) !== "in_progress";
    this.finish(request, 200, `snapshot ${status} recuperado sin nueva admisión`);
    return json({
      version: 2,
      conversationId,
      queryId,
      ordinal: turn.ordinal,
      status,
      question: turn.question,
      answer: turn.answer,
      canContinue,
    });
  }

  private async runtimeResponse(
    request: FixtureRequest,
    requestBody: unknown,
    sub: string,
    signal?: AbortSignal | null,
  ): Promise<Response> {
    const body = isRecord(requestBody) ? requestBody : {};
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const queryId = typeof body.queryId === "string" ? body.queryId : "";
    const operation = body.operation;

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      body.version !== 2 ||
      !uuidPattern.test(conversationId) ||
      !uuidPattern.test(queryId) ||
      (operation !== "recover" &&
        (typeof body.baseOrdinal !== "number" ||
          !Number.isSafeInteger(body.baseOrdinal) ||
          body.baseOrdinal < 0 ||
          typeof body.text !== "string" ||
          !body.text.trim())) ||
      (operation !== "recover" && operation !== "start" && operation !== "message")
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

    if (this.selectedScenario === "runtime-temporary") {
      this.finish(request, 503, "fallo temporal de Runtime simulado");
      return json(
        {
          code: "TRY_AGAIN",
          message: "No pudimos actualizar el estado del envío. Intentá de nuevo.",
        },
        503,
      );
    }

    if (operation === "recover" && this.selectedScenario === "runtime-recover-network") {
      this.finish(request, "network-error", "fallo de red simulado solo durante recover");
      throw new TypeError("Failed to fetch");
    }

    if (operation === "recover") return this.recoverResponse(request, conversationId, queryId, sub);

    const knownTurn = this.conversations
      .get(conversationId)
      ?.turns.find((turn) => turn.queryId === queryId);
    if (
      knownTurn &&
      knownTurn.question === body.text &&
      knownTurn.ordinal === Number(body.baseOrdinal) + 1 &&
      operation === (knownTurn.ordinal === 1 ? "start" : "message")
    ) {
      return this.recoverResponse(request, conversationId, queryId, sub);
    }

    if (this.selectedScenario === "runtime-unconfirmed") {
      this.finish(request, 200, "lookup temporal sin admisión; conserva el mismo query ID");
      return sseResponse({
        type: "failed",
        code: "temporarily_unavailable",
        message: "No pudimos confirmar el estado del envío. Podés reintentar el mismo pedido.",
        recordStatus: "unconfirmed",
        queryId,
      });
    }

    if (this.selectedScenario === "runtime-context-unavailable") {
      this.finish(request, 200, "preparación de contexto rechazada antes de admitir; sin consumo");
      return sseResponse({
        type: "failed",
        code: "context_unavailable",
        message:
          "INTERNAL_CONTEXT_DETAILS_DO_NOT_DISPLAY requestId=context-secret-42 prompt=private",
        recordStatus: "not_admitted",
        queryId,
        canContinue: operation === "message",
      });
    }

    if (this.selectedScenario === "runtime-capacity-exceeded" && operation === "message") {
      this.finish(request, 200, "contexto excedido simulado antes de admitir; sin consumo");
      return sseResponse({
        type: "failed",
        code: "capacity_exceeded",
        message:
          "La conversación y este pedido no caben en la ventana del modelo. Empezá una conversación nueva para conservar el pedido.",
        recordStatus: "not_admitted",
        queryId,
        canContinue: true,
      });
    }

    if (this.selectedScenario === "runtime-storage-capacity-exceeded") {
      this.finish(request, 200, "preflight de almacenamiento excedido simulado; sin consumo");
      return sseResponse({
        type: "failed",
        code: "storage_capacity_exceeded",
        message:
          "El pedido no cabe en una admisión de almacenamiento. La consulta no fue admitida; podés editarla y volver a intentar.",
        recordStatus: "not_admitted",
        queryId,
      });
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
      conversation = {
        conversationId,
        ownerSub: sub,
        botId: this.publicConfig.botId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        closed: false,
        nextOrdinal: 1,
        turns: [],
      };
      this.conversations.set(conversationId, conversation);
    } else if (
      operation !== "message" ||
      !conversation ||
      conversation.ownerSub !== sub ||
      conversation.botId !== this.publicConfig.botId ||
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
          queryId,
          question: typeof body.text === "string" ? body.text : "",
          answer: "",
          status: "pending",
          canContinue: true,
        };
        const admit = () => {
          if (stream.producerClosed || stream.admitted) return;
          stream.admitted = true;
          turn.ordinal += 1;
          conversation!.nextOrdinal = turn.ordinal + 1;
          turn.status = "streaming";
          conversation!.turns.push(turn);
          conversation!.updatedAt = new Date().toISOString();
          const firstText =
            "Propuesta: abrí la clase con una situación cotidiana y pedí que expliquen sus ideas. ";
          const firstTextIndex = stream.nextIndex++;
          turn.answer += firstText;
          this.persistConversations();
          stream.push({ type: "accepted", conversationId, queryId, ordinal: turn.ordinal });
          stream.push({
            type: "text",
            queryId,
            index: firstTextIndex,
            text: firstText,
          });
          if (stream.transportClosed) {
            request.status = "cancelled";
            request.outcome = "admisión persistida después de cerrar SSE; no se entregó accepted";
          } else {
            request.status = "pending";
            request.outcome = "respuesta progresiva abierta; esperar un cierre manual";
          }
          this.changed();
        };
        stream = {
          request,
          queryId,
          nextIndex: 0,
          admitted: false,
          producerClosed: false,
          transportClosed: false,
          turn,
          admit,
          rejectDocuments: () => {
            if (stream.producerClosed || stream.admitted) return;
            stream.push({
              type: "failed",
              code: "documents_unavailable",
              message:
                "No pudimos consultar los documentos. Conservamos tu pedido para que puedas reintentar.",
              recordStatus: "not_admitted",
              queryId,
            });
            stream.producerClosed = true;
            if (!stream.transportClosed) {
              stream.transportClosed = true;
              controller.close();
            }
            if (operation === "start" && conversation?.turns.length === 0) {
              this.conversations.delete(conversationId);
              this.persistConversations();
            }
            this.finish(request, 200, "falla documental simulada antes de admitir; sin consumo");
            this.changed();
          },
          disconnect: () => {
            if (stream.transportClosed) return;
            stream.cancel();
            try {
              controllerRef?.error(new DOMException("Fixture SSE disconnected", "AbortError"));
            } catch {
              // The reader may already have canceled or errored.
            }
          },
          push: (value) => {
            if (stream.producerClosed || stream.transportClosed) return;
            controller.enqueue(encoder.encode(sse(value)));
          },
          close: () => {
            if (stream.producerClosed) return;
            stream.producerClosed = true;
            if (!stream.transportClosed) {
              stream.transportClosed = true;
              controller.close();
            }
            this.finish(request, 200, "stream completado manualmente");
            this.changed();
          },
          cancel: () => {
            if (stream.transportClosed) return;
            stream.transportClosed = true;
            request.outcome = "SSE desconectado; productor simulado continúa en la pestaña";
            this.changed();
          },
        };
        this.streams.push(stream);
        if (
          this.selectedScenario === "runtime-admission-pending" ||
          this.selectedScenario === "runtime-documents-unavailable"
        ) {
          request.status = "pending";
          request.outcome =
            this.selectedScenario === "runtime-documents-unavailable"
              ? "preparación documental retenida antes de admitir"
              : "admisión retenida; esperar el control manual";
          this.changed();
        } else {
          admit();
        }
      },
      cancel: () => stream?.cancel(),
    });
    const abortStream = () => {
      if (stream!.producerClosed) return;
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

  releaseHistory() {
    this.pendingHistoryReads.shift()?.release();
    if (
      this.selectedScenario === "history-pending" ||
      this.selectedScenario === "history-snapshot-pending"
    )
      this.selectedScenario = "ready";
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
    this.streams.find((item) => !item.producerClosed && !item.admitted)?.admit();
  }

  rejectDocuments() {
    this.streams.find((item) => !item.producerClosed && !item.admitted)?.rejectDocuments();
  }

  disconnectPendingStream() {
    this.streams.find((item) => !item.producerClosed && !item.admitted)?.disconnect();
  }

  emitFragment() {
    const stream = this.streams.find((item) => !item.producerClosed && item.admitted);
    const text =
      "Después, resolvé una consigna breve.\n\nLuego comparen estrategias en parejas: ¿cuál es más clara para el grupo? ¡Buen trabajo!";
    if (!stream) {
      const turn = this.restoredActiveTurns()[0];
      if (!turn) return;
      turn.answer += text;
      this.touchConversation(turn);
      this.persistConversations();
      this.changed();
      return;
    }
    const index = stream.nextIndex++;
    stream.turn.answer += text;
    this.touchConversation(stream.turn);
    this.persistConversations();
    stream.push({
      type: "text",
      queryId: stream.queryId,
      index,
      text,
    });
    this.changed();
  }

  finishStream(mode: "complete" | "failed" | "profile-required" | "unconfirmed") {
    const stream = this.streams.find((item) => !item.producerClosed && item.admitted);
    if (!stream) {
      const turn = this.restoredActiveTurns()[0];
      if (!turn) return;
      if (mode === "complete") {
        turn.status = "completed";
        turn.canContinue = true;
      } else if (mode === "failed") {
        turn.status = "failed";
        turn.canContinue = true;
      } else if (mode === "profile-required") {
        turn.status = "failed";
        turn.canContinue = false;
      } else {
        turn.status = "unconfirmed";
        turn.canContinue = false;
      }
      const conversation = this.touchConversation(turn);
      if (conversation && mode === "profile-required") conversation.closed = true;
      this.persistConversations();
      this.changed();
      return;
    }
    if (mode === "complete") {
      stream.turn.status = "completed";
      stream.turn.canContinue = true;
    } else if (mode === "failed") {
      stream.turn.status = "failed";
      stream.turn.canContinue = true;
    } else if (mode === "profile-required") {
      stream.turn.status = "failed";
      stream.turn.canContinue = false;
    } else {
      stream.turn.status = "unconfirmed";
      stream.turn.canContinue = false;
    }
    const conversation = this.touchConversation(stream.turn);
    if (conversation && mode === "profile-required") conversation.closed = true;
    this.persistConversations();
    if (mode === "complete") {
      stream.push({ type: "completed", queryId: stream.queryId });
    } else if (mode === "failed") {
      stream.push({
        type: "failed",
        code: "generation_failed",
        message: "La generación terminó con un error simulado.",
        recordStatus: "failed",
        queryId: stream.queryId,
        canContinue: true,
      });
    } else if (mode === "profile-required") {
      stream.push({
        type: "failed",
        code: "profile_required",
        message: "Completá tu perfil para iniciar esta consulta.",
        recordStatus: "not_admitted",
        queryId: stream.queryId,
        canContinue: false,
      });
    }
    stream.close();
  }

  advanceAdmittedTurnFromAnotherSession() {
    const sub = this.activeSessionSub();
    if (!sub) return false;
    const entry = readProductJournal(this.publicConfig).entries.find((candidate) => {
      if (
        candidate.sub !== sub ||
        candidate.botId !== this.publicConfig.botId ||
        !candidate.request
      ) {
        return false;
      }
      const conversation = this.conversations.get(candidate.request.conversationId);
      return conversation?.turns.some(
        (turn) => turn.queryId === candidate.request?.queryId && turn.status === "streaming",
      );
    });
    const request = entry?.request;
    if (!request) return false;
    const conversation = this.conversations.get(request.conversationId);
    const turn = conversation?.turns.find((candidate) => candidate.queryId === request.queryId);
    if (
      !conversation ||
      conversation.ownerSub !== sub ||
      conversation.botId !== this.publicConfig.botId ||
      !turn ||
      turn.status !== "streaming"
    ) {
      return false;
    }

    turn.status = "completed";
    turn.canContinue = true;
    const followupOrdinal = conversation.nextOrdinal;
    const followupQueryId = fixtureUuid("90000000", ++this.nextRemoteQueryNumber);
    conversation.turns.push({
      ordinal: followupOrdinal,
      queryId: followupQueryId,
      question: "Seguimiento admitido desde otra sesión.",
      answer: "Prefijo de respuesta del seguimiento iniciado desde otra sesión.",
      status: "streaming",
      canContinue: false,
    });
    conversation.nextOrdinal = followupOrdinal + 1;
    conversation.closed = false;
    conversation.updatedAt = new Date().toISOString();
    this.persistConversations();

    const stream = this.streams.find((candidate) => candidate.queryId === turn.queryId);
    if (stream && !stream.producerClosed) {
      stream.push({ type: "completed", queryId: turn.queryId });
      stream.close();
    } else {
      this.changed();
    }
    return true;
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
    if (url.pathname.startsWith("/api/chat/conversations")) {
      return this.historyResponse(item, url, sub);
    }
    if (url.hostname === "bedrock-agentcore.us-east-1.amazonaws.com") {
      if (!sub) {
        this.finish(item, 401, "sin sesión");
        return json({ code: "UNAUTHORIZED" }, 401);
      }
      if (
        !isRecord(body) ||
        (body.operation !== "start" &&
          body.operation !== "message" &&
          body.operation !== "recover") ||
        typeof body.conversationId !== "string" ||
        (body.operation !== "recover" && typeof body.text !== "string")
      ) {
        this.finish(item, 400, "payload de inicio inválido");
        return json({ code: "INVALID_REQUEST" }, 400);
      }
      return this.runtimeResponse(item, body, sub, init?.signal);
    }
    this.finish(item, 404, "ruta no simulada");
    return json({ code: "NOT_FOUND" }, 404);
  }

  snapshot(route: string) {
    const accessToken = this.session.accessToken();
    const sessionSub = accessToken ? (this.tokens.get(accessToken) ?? null) : null;
    const sessionIdentity = identities.find(({ sub }) => sub === sessionSub) || null;
    const restoredActiveCount = this.restoredActiveTurns().length;
    const remoteAdvanceEntry = readProductJournal(this.publicConfig).entries.find(
      (entry) =>
        entry.sub === sessionSub &&
        entry.botId === this.publicConfig.botId &&
        entry.request !== null &&
        this.conversations
          .get(entry.request.conversationId)
          ?.turns.some(
            (turn) => turn.queryId === entry.request?.queryId && turn.status === "streaming",
          ),
    );
    return {
      fixture: "chat-browser-local",
      route,
      scenario: this.selectedScenario,
      canAdvanceRemoteConversation: Boolean(remoteAdvanceEntry),
      session: {
        active: Boolean(accessToken),
        sub: sessionSub,
        email: sessionIdentity?.email || null,
        credentialsIncluded: false,
      },
      pendingProfiles: this.pendingProfiles.length,
      pendingHistoryReads: this.pendingHistoryReads.length,
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
      pendingAdmissions: this.streams.filter(
        ({ producerClosed, admitted }) => !producerClosed && !admitted,
      ).length,
      admittedStreams:
        this.streams.filter(({ producerClosed, admitted }) => !producerClosed && admitted).length +
        restoredActiveCount,
      openStreams:
        this.streams.filter(({ producerClosed }) => !producerClosed).length + restoredActiveCount,
      conversations: [...this.conversations.entries()].map(([conversationId, conversation]) => ({
        conversationId,
        ownerSub: conversation.ownerSub,
        ...(conversation.createdAt ? { createdAt: conversation.createdAt } : {}),
        ...(conversation.updatedAt ? { updatedAt: conversation.updatedAt } : {}),
        closed: conversation.closed === true,
        turns: conversation.turns.map((turn) => ({ ...turn })),
      })),
      productJournal: readProductJournal(this.publicConfig),
      storedProfile: cloneDraft(
        this.storedProfiles.get(sessionSub || identities[0].sub) || fixtureProfiles[0],
      ),
      requestCount: this.requests.length,
      requests: this.requests.map(({ ...item }) => ({ ...item })),
    };
  }
}
