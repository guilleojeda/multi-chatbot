import { createHash } from "node:crypto";
import { accessTokenSubject } from "./auth.js";

type AccountUser = {
  sub: string;
  email: string;
  emailVerified?: boolean;
  status?: string;
};

type Caller = {
  sub: string;
  email?: string;
  token_use?: string;
};

type Invitation = {
  id: string;
  tokenHash?: string;
  botId: string;
  sub: string;
  email: string;
  kind?: "new" | "existing";
  expiresAt: number;
  usedAt?: string | null;
  reserved?: boolean;
  reservedAt?: string | number | null;
};

type Identity = {
  getUserByEmail(email: string): Promise<AccountUser | null>;
  getCaller(accessToken: string): Promise<Caller | null>;
  setPermanentPassword(input: { sub: string; password: string }): Promise<void>;
  markEmailVerified(input: { sub: string }): Promise<void>;
};

type Store = {
  getInvitation(tokenHash: string): Promise<Invitation | null>;
  reserveInvitation(input: { invitationId: string; sub: string; botId: string }): Promise<boolean>;
  releaseInvitation(input: { invitationId: string; sub: string; botId: string }): Promise<void>;
  useInvitationAndAddMember(input: {
    invitationId: string;
    sub: string;
    botId: string;
  }): Promise<boolean>;
  hasMember(input: { sub: string; botId: string }): Promise<boolean>;
};

type HttpEvent = {
  version?: string;
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: { method?: string; path?: string };
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
};

type HandlerDependencies = {
  config: { botId: string };
  identity: Identity;
  store: Store;
  now: () => number;
};

type ApiResponse = { statusCode: number; headers: Record<string, string>; body: string };

const routes = {
  inspect: "/api/account/invitations/inspect",
  accept: "/api/account/invitations/accept",
  me: "/api/account/me",
} as const;

function json(statusCode: number, body: Record<string, unknown>): ApiResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(event: HttpEvent): Record<string, unknown> | null {
  if (!event.body) return {};
  try {
    const source = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    const value: unknown = JSON.parse(source);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isReserved(invitation: Invitation): boolean {
  return (
    invitation.reserved === true ||
    (invitation.reservedAt !== undefined && invitation.reservedAt !== null)
  );
}

function isInvalidPassword(error: unknown): boolean {
  return (
    isRecord(error) &&
    ["InvalidPasswordException", "PasswordHistoryPolicyViolationException"].includes(
      String(error.name),
    )
  );
}

function safeFailure(): ApiResponse {
  return json(503, {
    code: "TRY_AGAIN",
    message: "No pudimos completar la operación. Intentá de nuevo.",
  });
}

function bearerToken(headers: Record<string, string | undefined> | undefined): string | null {
  if (!headers) return null;
  const authorization = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isInvitationShape(value: Invitation | null): value is Invitation {
  return Boolean(
    value &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.botId === "string" &&
    typeof value.sub === "string" &&
    value.sub.length > 0 &&
    typeof value.email === "string" &&
    value.email.trim().length > 0 &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt),
  );
}

function isMatchingUser(user: AccountUser | null, invitation: Invitation): user is AccountUser {
  return Boolean(
    user &&
    user.sub === invitation.sub &&
    normalizedEmail(user.email) === normalizedEmail(invitation.email),
  );
}

function suppliedIdentityConflicts(
  body: Record<string, unknown>,
  invitation: Invitation,
  botId: string,
) {
  if (Object.hasOwn(body, "sub") && body.sub !== invitation.sub) return true;
  if (
    Object.hasOwn(body, "email") &&
    (typeof body.email !== "string" ||
      normalizedEmail(body.email) !== normalizedEmail(invitation.email))
  ) {
    return true;
  }
  if (Object.hasOwn(body, "botId") && body.botId !== botId) return true;
  return false;
}

function hasValidCallerIdentity(caller: Caller | null, invitation: Invitation): caller is Caller {
  return Boolean(
    caller &&
    caller.token_use === "access" &&
    caller.sub === invitation.sub &&
    typeof caller.email === "string" &&
    normalizedEmail(caller.email) === normalizedEmail(invitation.email),
  );
}

export function createAccountHandler({ config, identity, store, now }: HandlerDependencies) {
  async function loadInvitation(
    token: unknown,
  ): Promise<
    { invitation: Invitation; error?: never } | { invitation?: never; error: ApiResponse }
  > {
    if (typeof token !== "string" || token.trim().length === 0 || token.length > 4096) {
      return {
        error: json(400, {
          code: "INVALID_INVITATION",
          message: "El enlace de invitación no es válido.",
        }),
      };
    }

    const invitation = await store.getInvitation(tokenHash(token));
    if (!isInvitationShape(invitation)) {
      return {
        error: json(400, {
          code: "INVALID_INVITATION",
          message: "El enlace de invitación no es válido.",
        }),
      };
    }
    if (invitation.botId !== config.botId) {
      return {
        error: json(403, {
          code: "FORBIDDEN",
          message: "Esta invitación no corresponde a este proyecto.",
        }),
      };
    }
    if (invitation.expiresAt <= now()) {
      return {
        error: json(410, {
          code: "INVITATION_EXPIRED",
          message: "La invitación venció. Pedí un enlace nuevo.",
        }),
      };
    }
    if (invitation.usedAt) {
      return {
        error: json(409, { code: "INVITATION_USED", message: "Esta invitación ya fue utilizada." }),
      };
    }
    return { invitation };
  }

  async function inspect(body: Record<string, unknown>): Promise<ApiResponse> {
    const loaded = await loadInvitation(body.token);
    if (loaded.error) return loaded.error;
    const { invitation } = loaded;
    const user = await identity.getUserByEmail(invitation.email);
    if (!isMatchingUser(user, invitation)) {
      return json(403, {
        code: "FORBIDDEN",
        message: "No se pudo confirmar la cuenta asociada a esta invitación.",
      });
    }
    return json(200, {
      kind: user.status === "CONFIRMED" ? "existing" : "new",
      email: invitation.email,
    });
  }

  async function accept(body: Record<string, unknown>, event: HttpEvent): Promise<ApiResponse> {
    const loaded = await loadInvitation(body.token);
    if (loaded.error) return loaded.error;
    const { invitation } = loaded;
    if (suppliedIdentityConflicts(body, invitation, config.botId)) {
      return json(403, {
        code: "FORBIDDEN",
        message: "La invitación no coincide con los datos enviados.",
      });
    }

    const user = await identity.getUserByEmail(invitation.email);
    if (!isMatchingUser(user, invitation)) {
      return json(403, {
        code: "FORBIDDEN",
        message: "No se pudo confirmar la cuenta asociada a esta invitación.",
      });
    }

    const reservedBeforeRequest = isReserved(invitation);
    const canSetPassword = user.status === "FORCE_CHANGE_PASSWORD" && !reservedBeforeRequest;
    const password = typeof body.password === "string" ? body.password : undefined;
    if (
      canSetPassword &&
      (password === undefined ||
        password.length === 0 ||
        Array.from(password).length > 256 ||
        /\s/.test(password))
    ) {
      return json(400, { code: "INVALID_PASSWORD", message: "Ingresá una contraseña válida." });
    }
    let caller: Caller | null = null;
    const accessToken = bearerToken(event.headers);

    if (accessToken) {
      caller = await identity.getCaller(accessToken);
      if (caller && !hasValidCallerIdentity(caller, invitation)) {
        return json(403, {
          code: "FORBIDDEN",
          message: "La cuenta autenticada no coincide con la invitación.",
        });
      }
    }

    if (!canSetPassword || reservedBeforeRequest) {
      if (!accessToken) {
        return json(409, {
          code: "SIGN_IN_REQUIRED",
          message: "Iniciá sesión con esta cuenta para continuar.",
        });
      }
      if (!caller) {
        return json(409, {
          code: "SIGN_IN_REQUIRED",
          message: "Iniciá sesión con esta cuenta para continuar.",
        });
      }
    }

    if (!reservedBeforeRequest) {
      const reserved = await store.reserveInvitation({
        invitationId: invitation.id,
        sub: invitation.sub,
        botId: config.botId,
      });
      if (!reserved) {
        return json(409, {
          code: "SIGN_IN_REQUIRED",
          message: "Esta invitación ya está en uso. Iniciá sesión para continuar.",
        });
      }
    }

    if (canSetPassword) {
      if (password === undefined) {
        return json(400, { code: "INVALID_PASSWORD", message: "Ingresá una contraseña válida." });
      }
      try {
        await identity.setPermanentPassword({ sub: invitation.sub, password });
      } catch (error) {
        if (isInvalidPassword(error)) {
          await store.releaseInvitation({
            invitationId: invitation.id,
            sub: invitation.sub,
            botId: config.botId,
          });
          return json(400, {
            code: "INVALID_PASSWORD",
            message: "La contraseña no cumple los requisitos.",
          });
        }
        return safeFailure();
      }
    }

    if (!user.emailVerified) {
      try {
        await identity.markEmailVerified({ sub: invitation.sub });
      } catch {
        return safeFailure();
      }
    }

    const used = await store.useInvitationAndAddMember({
      invitationId: invitation.id,
      sub: invitation.sub,
      botId: config.botId,
    });
    if (!used) {
      return json(409, { code: "INVITATION_USED", message: "Esta invitación ya fue utilizada." });
    }
    return json(200, { status: "accepted" });
  }

  async function me(event: HttpEvent): Promise<ApiResponse> {
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    const sub = accessTokenSubject(claims);
    if (!sub) {
      return json(401, { code: "UNAUTHORIZED", message: "Iniciá sesión para continuar." });
    }
    if (!(await store.hasMember({ sub, botId: config.botId }))) {
      return json(403, {
        code: "FORBIDDEN",
        message: "Esta cuenta no tiene acceso a este proyecto.",
      });
    }
    return json(200, { sub, botId: config.botId });
  }

  return async function handler(event: HttpEvent): Promise<ApiResponse> {
    const method = event.requestContext?.http?.method?.toUpperCase() || "";
    const path = event.requestContext?.http?.path || event.rawPath || "";
    try {
      if (method === "GET" && path === routes.me) return await me(event);
      if (method !== "POST" || (path !== routes.inspect && path !== routes.accept)) {
        return json(404, { code: "NOT_FOUND", message: "No encontramos esa ruta." });
      }
      const body = readBody(event);
      if (!body) {
        return json(400, {
          code: "INVALID_INVITATION",
          message: "El enlace de invitación no es válido.",
        });
      }
      return path === routes.inspect ? await inspect(body) : await accept(body, event);
    } catch {
      return safeFailure();
    }
  };
}
