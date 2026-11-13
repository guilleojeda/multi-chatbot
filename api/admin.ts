import { randomUUID } from "node:crypto";
import { provisionInvitation } from "./invitations.js";
import {
  isValidOperationId,
  type AccountAccessStore,
  type AccessRecord,
  type InvitationRecord,
} from "./access.js";
import type { InvitationUser } from "./invitations.js";
import {
  isValidQuotaLimit,
  isValidQuotaRevision,
  type QuotaPolicy,
} from "../config/quota-policy.js";
import type { QuotaPolicyReader, QuotaPolicyWriter } from "./quota-policy-store.js";
import { DOCUMENT_MAX_BYTES, isDocumentAction, validateDocumentFile } from "../config/documents.js";
import type { DocumentAdministration } from "./document-administration.js";

type AdminStore = AccountAccessStore;

type AdminBot = {
  botId: string;
  projectName: string;
  siteUrl: string;
};

type AdminIdentity = {
  getUserByEmail(email: string): Promise<InvitationUser | null>;
  createUser(input: { email: string; messageAction: "SUPPRESS" }): Promise<InvitationUser>;
};

type AdminMail = {
  sendInvitation(input: {
    from: string;
    to: string;
    projectName: string;
    url: string;
    expiresAt: number;
  }): Promise<{ messageId?: string }>;
};

type AdminConfig = {
  clientId: string;
  adminGroup: string;
  sender: string | null;
  invitationTtlMs: number;
  bots: AdminBot[];
};

type HttpEvent = {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: {
    http?: { method?: string; path?: string };
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
};

type HttpResponse = {
  statusCode: number;
  headers: { "content-type": string; "cache-control": "no-store" };
  body: string;
};

function response(statusCode: number, body: Record<string, unknown>): HttpResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(event: HttpEvent): Record<string, unknown> | null {
  if (typeof event.body !== "string") return null;
  try {
    const source = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    const value: unknown = JSON.parse(source);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && hasOnlyKeys(value, expected);
}

function pathFrom(event: HttpEvent): string {
  return event.requestContext?.http?.path || event.rawPath || "";
}

function documentRoute(
  path: string,
):
  | { botId: string; kind: "list" }
  | { botId: string; kind: "create" }
  | { botId: string; kind: "start" | "get"; operationId: string }
  | null {
  const match = path.match(
    /^\/api\/admin\/bots\/([^/]+)\/(documents|document-operations(?:\/([^/]+)(?:\/(start))?)?)$/,
  );
  if (!match) return null;
  let botId: string;
  try {
    botId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (match[2] === "documents") return { botId, kind: "list" };
  if (match[2] === "document-operations") return { botId, kind: "create" };
  let operationId: string;
  try {
    operationId = decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  return match[4] ? { botId, kind: "start", operationId } : { botId, kind: "get", operationId };
}

function documentErrorResponse(error: unknown): HttpResponse {
  const value = isObject(error) ? error : {};
  const code = typeof value.code === "string" ? value.code : "DOCUMENTS_UNAVAILABLE";
  const statusCode =
    code === "INVALID_INPUT"
      ? 400
      : code === "FILE_TOO_LARGE"
        ? 413
        : code === "NOT_FOUND"
          ? 404
          : ["STATE_CHANGED", "DOCUMENT_OPERATION_ACTIVE", "UPLOAD_NOT_READY"].includes(code)
            ? 409
            : code === "UNAUTHORIZED"
              ? 401
              : 503;
  return response(statusCode, {
    code,
    ...(Array.isArray(value.fields) ? { fields: value.fields } : {}),
  });
}

function tokenExpiresAt(event: HttpEvent, now: () => number): number | null {
  const claim = event.requestContext?.authorizer?.jwt?.claims?.exp;
  const exp =
    typeof claim === "number"
      ? claim
      : typeof claim === "string" && /^\d+$/.test(claim)
        ? Number(claim)
        : Number.NaN;
  if (!Number.isSafeInteger(exp) || exp <= 0) return null;
  const expiresAt = exp * 1000;
  return Number.isSafeInteger(expiresAt) && expiresAt > now() ? expiresAt : null;
}

function documentIntentBody(body: Record<string, unknown> | null):
  | {
      operationId: string;
      action: "upload" | "replace" | "withdraw" | "reprocess";
      file?: { name: string; sizeBytes: number; sha256: string };
      documentId?: string;
      expectedRevision?: string;
    }
  | HttpResponse {
  if (!body || !isDocumentAction(body.action)) return response(400, { code: "INVALID_INPUT" });
  const action = body.action;
  const upload = action === "upload" || action === "replace";
  const expectedKeys =
    action === "upload"
      ? ["operationId", "action", "file"]
      : upload
        ? ["operationId", "action", "documentId", "expectedRevision", "file"]
        : ["operationId", "action", "documentId", "expectedRevision"];
  if (!exactKeys(body, expectedKeys) || !isValidOperationId(body.operationId)) {
    return response(400, { code: "INVALID_INPUT" });
  }
  let documentId: string | undefined;
  let expectedRevision: string | undefined;
  if (action !== "upload") {
    if (
      typeof body.documentId !== "string" ||
      body.documentId.length < 1 ||
      body.documentId.length > 128 ||
      body.documentId.trim() !== body.documentId ||
      typeof body.expectedRevision !== "string" ||
      body.expectedRevision.length < 1 ||
      body.expectedRevision.length > 128 ||
      body.expectedRevision.trim() !== body.expectedRevision
    ) {
      return response(400, { code: "INVALID_INPUT" });
    }
    documentId = body.documentId;
    expectedRevision = body.expectedRevision;
  }
  if (!upload) {
    return { operationId: body.operationId, action, documentId, expectedRevision };
  }
  if (!isObject(body.file) || !exactKeys(body.file, ["name", "sizeBytes", "sha256"])) {
    return response(400, { code: "INVALID_INPUT", fields: ["file"] });
  }
  const fields = validateDocumentFile(body.file);
  if (
    typeof body.file.sizeBytes === "number" &&
    Number.isSafeInteger(body.file.sizeBytes) &&
    body.file.sizeBytes > DOCUMENT_MAX_BYTES
  ) {
    return response(413, { code: "FILE_TOO_LARGE", fields: ["file"] });
  }
  if (fields.length > 0) return response(400, { code: "INVALID_INPUT", fields });
  const file = body.file as { name: string; sizeBytes: number; sha256: string };
  return {
    operationId: body.operationId,
    action,
    ...(documentId ? { documentId } : {}),
    ...(expectedRevision ? { expectedRevision } : {}),
    file,
  };
}

function botIdFromPath(
  path: string,
  suffix: "people/lookup" | "invitations" | "access/revoke" | "quota",
): string | null {
  const match = path.match(new RegExp(`^/api/admin/bots/([^/]+)/${suffix.replace("/", "\\/")}$`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function bearerToken(event: HttpEvent): string | null {
  const authorization = Object.entries(event.headers || {}).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];
  if (typeof authorization !== "string") return null;
  return /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] ?? null;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1].length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function adminSub(event: HttpEvent, config: AdminConfig): { sub: string } | HttpResponse {
  const token = bearerToken(event);
  const bearer = token !== null;
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (
    !bearer ||
    !claims ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.trim() !== claims.sub
  ) {
    return response(401, { code: "UNAUTHORIZED" });
  }
  let groups = claims["cognito:groups"];
  if (!Array.isArray(groups)) {
    const payload = jwtPayload(token);
    if (
      !payload ||
      payload.sub !== claims.sub ||
      payload.client_id !== claims.client_id ||
      payload.token_use !== claims.token_use
    ) {
      return response(403, { code: "FORBIDDEN" });
    }
    groups = payload["cognito:groups"];
  }
  if (
    claims.token_use !== "access" ||
    claims.client_id !== config.clientId ||
    !Array.isArray(groups) ||
    groups.some((group) => typeof group !== "string") ||
    !groups.includes(config.adminGroup)
  ) {
    return response(403, { code: "FORBIDDEN" });
  }
  return { sub: claims.sub };
}

function publicAccess(access: AccessRecord | null, botId: string, sub: string) {
  if (!access) return { state: "none" as const, revision: 0 };
  if (
    access.sub !== sub ||
    access.botId !== botId ||
    !["none", "active", "revoked"].includes(access.access) ||
    !Number.isSafeInteger(access.revision) ||
    access.revision < 0
  ) {
    throw new Error("Invalid access record");
  }
  return { state: access.access, revision: access.revision };
}

function publicInvitation(invitation: InvitationRecord, currentEmail: string) {
  if (
    !Number.isFinite(invitation.expiresAt) ||
    !isEmail(normalizeEmail(invitation.email)) ||
    !["accepted", "failed", "unconfirmed"].includes(invitation.delivery.status)
  ) {
    throw new Error("Invalid invitation record");
  }
  return {
    expiresAt: invitation.expiresAt,
    delivery: {
      status: invitation.delivery.status,
      ...(invitation.delivery.messageId ? { messageId: invitation.delivery.messageId } : {}),
    },
    ...(normalizeEmail(invitation.email) !== normalizeEmail(currentEmail)
      ? { invitedEmail: invitation.email }
      : {}),
  };
}

function isStateChanged(error: unknown): boolean {
  return isObject(error) && (error.code === "STATE_CHANGED" || error.name === "STATE_CHANGED");
}

function quotaPutFields(body: Record<string, unknown> | null): string[] {
  if (!body) return ["body"];

  const fields: string[] = [];
  for (const key of Object.keys(body)) {
    if (!["dailyLimit", "monthlyLimit", "expectedRevision"].includes(key)) fields.push(key);
  }
  if (!Object.hasOwn(body, "dailyLimit") || !isValidQuotaLimit(body.dailyLimit)) {
    fields.push("dailyLimit");
  }
  if (!Object.hasOwn(body, "monthlyLimit") || !isValidQuotaLimit(body.monthlyLimit)) {
    fields.push("monthlyLimit");
  }
  if (!Object.hasOwn(body, "expectedRevision") || !isValidQuotaRevision(body.expectedRevision)) {
    fields.push("expectedRevision");
  }
  return [...new Set(fields)];
}

export function createAdminHandler(deps: {
  config: AdminConfig;
  stores: Record<string, AdminStore>;
  documentAdministrations?: Record<string, DocumentAdministration>;
  quotaReaders?: Record<string, QuotaPolicyReader>;
  quotaWriters?: Record<string, QuotaPolicyWriter>;
  identity: AdminIdentity;
  mail: AdminMail;
  now: () => number;
  randomBytes: (size: number) => Buffer | Uint8Array;
}) {
  const { config, stores } = deps;
  const quotaReaders = deps.quotaReaders || {};
  const quotaWriters = deps.quotaWriters || {};
  const documentAdministrations = deps.documentAdministrations || {};
  const bots = new Map(config.bots.map((bot) => [bot.botId, bot]));

  async function lookup(botId: string, email: string): Promise<HttpResponse> {
    const bot = bots.get(botId);
    const store = Object.hasOwn(stores, botId) ? stores[botId] : undefined;
    if (!bot || !store) return response(404, { code: "NOT_FOUND" });
    const normalized = normalizeEmail(email);
    if (!isEmail(normalized)) return response(400, { code: "INVALID_INPUT" });

    const user = await deps.identity.getUserByEmail(normalized);
    if (!user) {
      return response(200, {
        botId,
        person: null,
        access: { state: "none", revision: 0 },
      });
    }
    if (
      typeof user.sub !== "string" ||
      user.sub.length === 0 ||
      typeof user.email !== "string" ||
      normalizeEmail(user.email) !== normalized
    ) {
      return response(409, { code: "STATE_CHANGED" });
    }

    const access = await store.getAccess({ sub: user.sub, botId });
    const accessView = publicAccess(access, botId, user.sub);
    let invitation: ReturnType<typeof publicInvitation> | undefined;
    const current = access?.currentInvitation;
    if (current) {
      if (
        typeof current.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(current.hash) ||
        !Number.isFinite(current.expiresAt)
      ) {
        throw new Error("Invalid current invitation pointer");
      }
      const record = await store.getInvitation(current.hash);
      if (
        !record ||
        record.tokenHash !== current.hash ||
        record.sub !== user.sub ||
        record.botId !== botId ||
        record.expiresAt !== current.expiresAt
      ) {
        throw new Error("Current invitation is unavailable");
      }
      invitation = publicInvitation(record, user.email);
    }

    return response(200, {
      botId,
      person: { sub: user.sub, email: user.email },
      access: accessView,
      ...(invitation ? { invitation } : {}),
    });
  }

  return async (event: HttpEvent): Promise<HttpResponse> => {
    const principal = adminSub(event, config);
    if ("statusCode" in principal) return principal;

    const method = event.requestContext?.http?.method?.toUpperCase() || "";
    const path = pathFrom(event);
    if (method === "GET" && path === "/api/admin/me") {
      return response(200, { sub: principal.sub });
    }
    if (method === "GET" && path === "/api/admin/bots") {
      return response(200, {
        bots: config.bots.map(({ botId, projectName }) => ({ botId, projectName })),
      });
    }

    const documentsRoute = documentRoute(path);
    if (documentsRoute) {
      if (!bots.has(documentsRoute.botId)) return response(404, { code: "NOT_FOUND" });
      const administration = Object.hasOwn(documentAdministrations, documentsRoute.botId)
        ? documentAdministrations[documentsRoute.botId]
        : undefined;
      if (!administration) return response(503, { code: "DOCUMENTS_UNAVAILABLE" });
      try {
        if (documentsRoute.kind === "list") {
          if (method !== "GET") return response(404, { code: "NOT_FOUND" });
          const cursor = event.queryStringParameters?.cursor ?? null;
          const listing = await administration.list({ cursor, actorSub: principal.sub });
          return response(200, {
            botId: documentsRoute.botId,
            ...(listing as unknown as Record<string, unknown>),
          });
        }
        if (documentsRoute.kind === "create") {
          if (method !== "POST") return response(404, { code: "NOT_FOUND" });
          const parsed = documentIntentBody(parseBody(event));
          if ("statusCode" in parsed) return parsed;
          const expiresAt = tokenExpiresAt(event, deps.now);
          if (!expiresAt) return response(401, { code: "UNAUTHORIZED" });
          const result = await administration.createIntent({
            ...parsed,
            actorSub: principal.sub,
            tokenExpiresAt: expiresAt,
          });
          return response(201, {
            botId: documentsRoute.botId,
            ...(result as unknown as Record<string, unknown>),
          });
        }
        if (documentsRoute.kind === "start") {
          if (method !== "POST") return response(404, { code: "NOT_FOUND" });
          if (typeof event.body === "string" && event.body.trim() !== "") {
            const body = parseBody(event);
            if (!body || !exactKeys(body, [])) return response(400, { code: "INVALID_INPUT" });
          }
          const result = await administration.start({
            operationId: documentsRoute.operationId,
            actorSub: principal.sub,
          });
          if (!result.startConfirmed) {
            return response(503, {
              botId: documentsRoute.botId,
              operation: result.operation,
              code: "DOCUMENT_OPERATION_UNCONFIRMED",
            });
          }
          const terminal =
            result.operation.status === "completed" || result.operation.status === "failed";
          return response(terminal ? 200 : 202, {
            botId: documentsRoute.botId,
            operation: result.operation,
          });
        }
        if (method !== "GET") return response(404, { code: "NOT_FOUND" });
        const result = await administration.get({
          operationId: documentsRoute.operationId,
          actorSub: principal.sub,
        });
        return response(200, { botId: documentsRoute.botId, ...result });
      } catch (error) {
        return documentErrorResponse(error);
      }
    }

    const quotaBotId = method === "GET" || method === "PUT" ? botIdFromPath(path, "quota") : null;
    if (quotaBotId !== null) {
      if (!bots.has(quotaBotId)) return response(404, { code: "NOT_FOUND" });
      const readPolicy = Object.hasOwn(quotaReaders, quotaBotId)
        ? quotaReaders[quotaBotId]
        : undefined;
      if (!readPolicy) return response(503, { code: "QUOTA_UNAVAILABLE" });

      if (method === "PUT") {
        const writePolicy = Object.hasOwn(quotaWriters, quotaBotId)
          ? quotaWriters[quotaBotId]
          : undefined;
        if (!writePolicy) return response(503, { code: "QUOTA_UNAVAILABLE" });
        const body = parseBody(event);
        const fields = quotaPutFields(body);
        if (
          !body ||
          !exactKeys(body, ["dailyLimit", "monthlyLimit", "expectedRevision"]) ||
          fields.length > 0
        ) {
          return response(400, { code: "INVALID_INPUT", fields });
        }

        let previous: QuotaPolicy;
        try {
          previous = await readPolicy();
        } catch {
          return response(503, { code: "QUOTA_UNAVAILABLE" });
        }

        const dailyLimit = body.dailyLimit as number;
        const monthlyLimit = body.monthlyLimit as number;
        const expectedRevision = body.expectedRevision as string;
        if (expectedRevision !== previous.revision) {
          return response(409, { code: "STATE_CHANGED" });
        }
        if (dailyLimit === previous.dailyLimit && monthlyLimit === previous.monthlyLimit) {
          return response(200, { botId: quotaBotId, policy: previous, changed: false });
        }

        const next: QuotaPolicy = {
          dailyLimit,
          monthlyLimit,
          revision: randomUUID(),
        };
        try {
          const policy = await writePolicy({ previous, next });
          return response(200, { botId: quotaBotId, policy, changed: true });
        } catch {
          let observed: QuotaPolicy;
          try {
            observed = await readPolicy();
          } catch {
            return response(503, { code: "SAVE_UNCONFIRMED" });
          }
          if (
            observed.revision === next.revision &&
            observed.dailyLimit === next.dailyLimit &&
            observed.monthlyLimit === next.monthlyLimit
          ) {
            return response(200, { botId: quotaBotId, policy: next, changed: true });
          }
          if (
            observed.revision === previous.revision &&
            observed.dailyLimit === previous.dailyLimit &&
            observed.monthlyLimit === previous.monthlyLimit
          ) {
            return response(503, { code: "SAVE_UNCONFIRMED" });
          }
          return response(409, { code: "STATE_CHANGED" });
        }
      }

      try {
        const policy: QuotaPolicy = await readPolicy();
        return response(200, { botId: quotaBotId, policy });
      } catch {
        return response(503, { code: "QUOTA_UNAVAILABLE" });
      }
    }

    const lookupBotId = method === "POST" ? botIdFromPath(path, "people/lookup") : null;
    if (lookupBotId !== null) {
      if (!bots.has(lookupBotId) || !Object.hasOwn(stores, lookupBotId))
        return response(404, { code: "NOT_FOUND" });
      const body = parseBody(event);
      if (!body || !hasOnlyKeys(body, ["email"]) || typeof body.email !== "string") {
        return response(400, { code: "INVALID_INPUT" });
      }
      try {
        return await lookup(lookupBotId, body.email);
      } catch {
        return response(503, { code: "TRY_AGAIN" });
      }
    }

    const revokeBotId = method === "POST" ? botIdFromPath(path, "access/revoke") : null;
    if (revokeBotId !== null) {
      const store = Object.hasOwn(stores, revokeBotId) ? stores[revokeBotId] : undefined;
      if (!bots.has(revokeBotId) || !store) return response(404, { code: "NOT_FOUND" });
      const body = parseBody(event);
      if (
        !body ||
        !hasOnlyKeys(body, ["email", "expectedSub", "expectedRevision", "operationId"]) ||
        typeof body.email !== "string" ||
        typeof body.expectedSub !== "string" ||
        body.expectedSub.length === 0 ||
        !Number.isSafeInteger(body.expectedRevision) ||
        (body.expectedRevision as number) < 0 ||
        !isValidOperationId(body.operationId) ||
        !isEmail(normalizeEmail(body.email))
      ) {
        return response(400, { code: "INVALID_INPUT" });
      }

      try {
        const email = normalizeEmail(body.email);
        const user = await deps.identity.getUserByEmail(email);
        if (
          !user ||
          typeof user.sub !== "string" ||
          user.sub.length === 0 ||
          user.sub !== body.expectedSub ||
          typeof user.email !== "string" ||
          normalizeEmail(user.email) !== email
        ) {
          return response(409, { code: "STATE_CHANGED" });
        }

        const result = await store.revokeAccess({
          sub: user.sub,
          botId: revokeBotId,
          expectedRevision: body.expectedRevision as number,
          operationId: body.operationId,
        });
        if (result.access.sub !== user.sub || result.access.botId !== revokeBotId) {
          throw new Error("Access record does not match the revocation request");
        }
        return response(200, {
          botId: revokeBotId,
          person: { sub: user.sub, email: user.email },
          access: publicAccess(result.access, revokeBotId, user.sub),
          operation: {
            id: body.operationId,
            status: result.created ? "recorded" : "already_recorded",
          },
        });
      } catch (error) {
        if (isStateChanged(error)) return response(409, { code: "STATE_CHANGED" });
        return response(503, { code: "TRY_AGAIN" });
      }
    }

    const invitationBotId = method === "POST" ? botIdFromPath(path, "invitations") : null;
    if (invitationBotId !== null) {
      const bot = bots.get(invitationBotId);
      const store = Object.hasOwn(stores, invitationBotId) ? stores[invitationBotId] : undefined;
      if (!bot || !store) return response(404, { code: "NOT_FOUND" });
      const body = parseBody(event);
      if (
        !body ||
        !hasOnlyKeys(body, ["email", "expectedSub", "expectedRevision", "operationId"]) ||
        typeof body.email !== "string" ||
        (body.expectedSub !== null &&
          (typeof body.expectedSub !== "string" || body.expectedSub.length === 0)) ||
        !Number.isSafeInteger(body.expectedRevision) ||
        (body.expectedRevision as number) < 0 ||
        !isValidOperationId(body.operationId) ||
        !isEmail(normalizeEmail(body.email))
      ) {
        return response(400, { code: "INVALID_INPUT" });
      }
      if (typeof config.sender !== "string" || config.sender.trim() === "") {
        return response(503, { code: "TRY_AGAIN" });
      }

      try {
        const result = await provisionInvitation(
          {
            config: {
              botId: bot.botId,
              projectName: bot.projectName,
              siteUrl: bot.siteUrl,
              sender: config.sender,
              invitationTtlMs: config.invitationTtlMs,
            },
            identity: deps.identity,
            store,
            mail: deps.mail,
            now: deps.now,
            randomBytes: deps.randomBytes,
          },
          {
            email: body.email,
            expectedSub: body.expectedSub,
            expectedRevision: body.expectedRevision as number,
            operationId: body.operationId,
          },
        );
        if (result.botId !== invitationBotId) throw new Error("Invitation bot mismatch");
        const invitation = result.invitation;
        if (
          invitation.botId !== invitationBotId ||
          invitation.sub !== result.sub ||
          (result.created && normalizeEmail(invitation.email) !== normalizeEmail(body.email))
        ) {
          throw new Error("Invitation record mismatch");
        }
        return response(200, {
          botId: invitationBotId,
          person: { sub: result.sub, email: normalizeEmail(body.email) },
          access: publicAccess(result.access, invitationBotId, result.sub),
          invitation: publicInvitation(invitation, normalizeEmail(body.email)),
          operation: {
            id: body.operationId,
            status: result.created ? "recorded" : "already_recorded",
          },
        });
      } catch (error) {
        if (isStateChanged(error)) return response(409, { code: "STATE_CHANGED" });
        return response(503, { code: "TRY_AGAIN" });
      }
    }

    return response(404, { code: "NOT_FOUND" });
  };
}
