import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { adminRequest, readAdminPublicConfig, type AdminPublicConfig } from "./admin-api";
import { asApiError } from "./api";
import type { Session } from "./session";
import "./admin-style.css";

export type AdminSessionOptions = { clientId: string; region: string };
export type AdminAppProps = { getSession: (options: AdminSessionOptions) => Session };

type AdminStage =
  | "booting"
  | "boot-error"
  | "login"
  | "recover-request"
  | "recover-confirm"
  | "loading"
  | "panel-error"
  | "forbidden"
  | "ready";

type Bot = { botId: string; projectName: string };
type Person = { sub: string; email: string };
type AccessState = "none" | "active" | "revoked";
type Delivery = { status: "accepted" | "failed" | "unconfirmed"; messageId?: string };
type AdminProfile = {
  botId: string;
  person: Person | null;
  access: { state: AccessState; revision: number };
  invitation?: { expiresAt: number; delivery: Delivery; invitedEmail?: string };
};
type Message = { kind: "status" | "error"; text: string };
type InvitationIntent = "invite" | "reissue";

const recoveryNotice =
  "Si la cuenta está activa y tiene un email verificado, recibirás un código para continuar.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBots(value: unknown): Bot[] {
  if (!isRecord(value) || !Array.isArray(value.bots)) throw new Error("INVALID_RESPONSE");
  return value.bots.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.botId !== "string" ||
      !candidate.botId ||
      typeof candidate.projectName !== "string" ||
      !candidate.projectName
    ) {
      throw new Error("INVALID_RESPONSE");
    }
    return { botId: candidate.botId, projectName: candidate.projectName };
  });
}

function parseProfile(value: unknown, expectedBotId: string): AdminProfile {
  if (!isRecord(value) || value.botId !== expectedBotId || !isRecord(value.access)) {
    throw new Error("INVALID_RESPONSE");
  }
  const { state, revision } = value.access;
  if (
    (state !== "none" && state !== "active" && state !== "revoked") ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new Error("INVALID_RESPONSE");
  }

  let person: Person | null = null;
  if (value.person !== null) {
    if (
      !isRecord(value.person) ||
      typeof value.person.sub !== "string" ||
      !value.person.sub ||
      typeof value.person.email !== "string" ||
      !value.person.email
    ) {
      throw new Error("INVALID_RESPONSE");
    }
    person = { sub: value.person.sub, email: value.person.email };
  }

  let invitation: AdminProfile["invitation"];
  if (value.invitation !== undefined) {
    if (
      !isRecord(value.invitation) ||
      typeof value.invitation.expiresAt !== "number" ||
      !Number.isFinite(value.invitation.expiresAt) ||
      !isRecord(value.invitation.delivery) ||
      (value.invitation.delivery.status !== "accepted" &&
        value.invitation.delivery.status !== "failed" &&
        value.invitation.delivery.status !== "unconfirmed")
    ) {
      throw new Error("INVALID_RESPONSE");
    }
    const messageId = value.invitation.delivery.messageId;
    const invitedEmail = value.invitation.invitedEmail;
    if (invitedEmail !== undefined && (typeof invitedEmail !== "string" || !invitedEmail.trim())) {
      throw new Error("INVALID_RESPONSE");
    }
    invitation = {
      expiresAt: value.invitation.expiresAt,
      delivery: {
        status: value.invitation.delivery.status,
        ...(typeof messageId === "string" ? { messageId } : {}),
      },
      ...(typeof invitedEmail === "string" ? { invitedEmail } : {}),
    };
  }

  return {
    botId: expectedBotId,
    person,
    access: { state, revision },
    ...(invitation ? { invitation } : {}),
  };
}

function apiErrorStatus(error: unknown): number {
  return asApiError(error).status;
}

function makeOperationId(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deliveryCopy(delivery: Delivery): string {
  if (delivery.status === "accepted") {
    return "SES aceptó el mensaje para envío. Esto no confirma que la persona haya recibido el email.";
  }
  if (delivery.status === "failed") {
    return "SES rechazó el correo. La invitación quedó registrada, pero la persona no recibió un envío confirmado.";
  }
  return "No se confirmó el estado del correo. Revisá la ficha antes de iniciar otra invitación.";
}

function accessCopy(profile: AdminProfile): string {
  if (profile.access.state === "active") return "Acceso activo";
  if (profile.access.state === "revoked") return "Acceso revocado";
  return profile.invitation ? "Invitación pendiente de aceptación" : "Sin acceso";
}

function projectNameFor(availableBots: Bot[], botId: string): string {
  return availableBots.find((bot) => bot.botId === botId)?.projectName ?? "el chatbot";
}

function emailKey(value: string): string {
  return value.trim().toLowerCase();
}

function recoveryError(error: unknown, confirmation: boolean): string {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (confirmation) {
    if (code === "CodeMismatchException")
      return "El código no es correcto. Revisalo e intentá de nuevo.";
    if (code === "ExpiredCodeException")
      return "El código venció. Solicitá uno nuevo y volvé a intentar.";
    if (code === "InvalidPasswordException") {
      return "La nueva contraseña no cumple con los requisitos de la cuenta.";
    }
    return "No pudimos cambiar la contraseña. Revisá el código e intentá de nuevo.";
  }
  if (code === "LimitExceededException" || code === "TooManyRequestsException") {
    return "Esperá un momento antes de solicitar otro código.";
  }
  return "No pudimos solicitar el código. Revisá tu conexión e intentá de nuevo.";
}

function emailIsValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

type ConfirmationDialogProps = {
  email: string;
  projectName: string;
  action: InvitationIntent;
  pending: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
};

function ConfirmationDialog({
  email,
  projectName,
  action,
  pending,
  triggerRef,
  onCancel,
  onConfirm,
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const pendingStatusRef = useRef<HTMLParagraphElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const titleId = "admin-invitation-confirmation-title";

  useEffect(() => {
    const previousFocus = document.activeElement;
    if (pending) pendingStatusRef.current?.focus();
    else cancelRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        onCancelRef.current();
      }
      if (event.key !== "Tab") return;
      const controls = [cancelRef.current, confirmRef.current].filter(
        (control): control is HTMLButtonElement => Boolean(control && !control.disabled),
      );
      if (controls.length === 0) {
        event.preventDefault();
        return;
      }
      const current = document.activeElement;
      const index = controls.findIndex((control) => control === current);
      if (event.shiftKey && (index <= 0 || index === -1)) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (!event.shiftKey && (index === controls.length - 1 || index === -1)) {
        event.preventDefault();
        controls[0]?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const focusWasInsideDialog =
        previousFocus === cancelRef.current ||
        previousFocus === confirmRef.current ||
        previousFocus === pendingStatusRef.current;
      if (focusWasInsideDialog && triggerRef.current?.isConnected) {
        triggerRef.current.focus();
      } else if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      } else if (triggerRef.current?.isConnected) {
        triggerRef.current.focus();
      }
    };
  }, [pending, triggerRef]);

  const reissue = action === "reissue";
  return (
    <div className="admin-dialog-backdrop">
      <section className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <p className="admin-eyebrow">Confirmación</p>
        <h2 id={titleId}>{reissue ? "Confirmá la nueva invitación" : "Confirmá la invitación"}</h2>
        <p>
          {reissue ? "Se enviará una nueva invitación a " : "Se invitará a "}
          <strong>{email}</strong> para <strong>{projectName}</strong>. La persona deberá aceptar el
          enlace para activar el acceso.
        </p>
        {pending ? (
          <p ref={pendingStatusRef} role="status" tabIndex={-1}>
            Registrando la invitación…
          </p>
        ) : null}
        <div className="admin-dialog__actions">
          <button
            ref={cancelRef}
            className="admin-button admin-button--quiet"
            type="button"
            onClick={onCancel}
            disabled={pending}
          >
            Volver
          </button>
          <button
            ref={confirmRef}
            className="admin-button"
            type="button"
            onClick={onConfirm}
            disabled={pending}
          >
            {reissue ? "Confirmar nueva invitación" : "Confirmar invitación"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function AdminApp({ getSession }: AdminAppProps) {
  const [stage, setStage] = useState<AdminStage>("booting");
  const [config, setConfig] = useState<AdminPublicConfig | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [adminSub, setAdminSub] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [selectedBotId, setSelectedBotId] = useState("");
  const [email, setEmail] = useState("");
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [lookupPending, setLookupPending] = useState(false);
  const [invitationPending, setInvitationPending] = useState(false);
  const [confirmation, setConfirmation] = useState<InvitationIntent | null>(null);
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [bootAttempt, setBootAttempt] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const invitationTriggerRef = useRef<HTMLButtonElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const configRef = useRef<AdminPublicConfig | null>(null);
  const identityEpochRef = useRef(0);
  const recoveryEpochRef = useRef(0);
  const recoveryPendingRef = useRef(false);
  const scopeEpochRef = useRef(0);
  const mountedRef = useRef(false);
  const invitationInFlightRef = useRef<string | null>(null);
  const lookupRequestRef = useRef(0);

  const isIdentityActive = useCallback(
    (ticket: number) => mountedRef.current && identityEpochRef.current === ticket,
    [],
  );

  const clearPanel = useCallback(() => {
    setAdminSub("");
    setAdminEmail("");
    setBots([]);
    setSelectedBotId("");
    setProfile(null);
    setConfirmation(null);
    setLookupPending(false);
    setInvitationPending(false);
    setMessage(null);
  }, []);

  const leaveSession = useCallback(
    (session: Session, ticket: number, nextStage: "login" | "forbidden", text: string) => {
      if (!isIdentityActive(ticket)) return;
      identityEpochRef.current += 1;
      recoveryEpochRef.current += 1;
      recoveryPendingRef.current = false;
      setRecoveryPending(false);
      scopeEpochRef.current += 1;
      clearPanel();
      setStage(nextStage);
      setMessage({ kind: nextStage === "forbidden" ? "error" : "status", text });
      void session.signOut().catch(() => undefined);
    },
    [clearPanel, isIdentityActive],
  );

  const loadPanel = useCallback(
    async (session: Session, nextConfig: AdminPublicConfig, ticket: number) => {
      if (!isIdentityActive(ticket)) return;
      setStage("loading");
      setMessage({ kind: "status", text: "Comprobando permisos de administración…" });
      try {
        const meValue = await adminRequest(nextConfig, session, "/admin/me", {}, () =>
          isIdentityActive(ticket),
        );
        if (!isIdentityActive(ticket)) return;
        if (!isRecord(meValue) || typeof meValue.sub !== "string" || !meValue.sub) {
          throw new Error("INVALID_RESPONSE");
        }

        const botsValue = await adminRequest(nextConfig, session, "/admin/bots", {}, () =>
          isIdentityActive(ticket),
        );
        if (!isIdentityActive(ticket)) return;
        const availableBots = parseBots(botsValue);
        setAdminSub(meValue.sub);
        setBots(availableBots);
        setSelectedBotId((current) =>
          availableBots.some((bot) => bot.botId === current)
            ? current
            : (availableBots[0]?.botId ?? ""),
        );
        setProfile(null);
        setMessage(null);
        setStage("ready");
      } catch (error) {
        if (!isIdentityActive(ticket)) return;
        if (apiErrorStatus(error) === 403) {
          leaveSession(
            session,
            ticket,
            "forbidden",
            "Esta cuenta no tiene permiso de administrador. La sesión administrativa se cerró.",
          );
          return;
        }
        if (apiErrorStatus(error) === 401) {
          leaveSession(session, ticket, "login", "La sesión venció. Iniciá sesión nuevamente.");
          return;
        }
        setStage("panel-error");
        setMessage({
          kind: "error",
          text: "No pudimos cargar el panel. Revisá la conexión e intentá de nuevo.",
        });
      }
    },
    [isIdentityActive, leaveSession],
  );

  useEffect(() => {
    mountedRef.current = true;
    const ticket = ++identityEpochRef.current;
    let disposed = false;
    async function boot() {
      setStage("booting");
      setMessage({ kind: "status", text: "Preparando el panel administrativo…" });
      try {
        const loadedConfig = await readAdminPublicConfig();
        if (disposed || !isIdentityActive(ticket)) return;
        const session = getSession({
          clientId: loadedConfig.clientId,
          region: loadedConfig.region,
        });
        configRef.current = loadedConfig;
        sessionRef.current = session;
        setConfig(loadedConfig);
        const tokens = await session.restore();
        if (disposed || !isIdentityActive(ticket)) return;
        if (!tokens) {
          setStage("login");
          setMessage(null);
          return;
        }
        await loadPanel(session, loadedConfig, ticket);
      } catch {
        if (disposed || !isIdentityActive(ticket)) return;
        setStage("boot-error");
        setMessage({
          kind: "error",
          text: "No pudimos preparar el panel. Revisá la conexión e intentá de nuevo.",
        });
      }
    }
    void boot();
    return () => {
      disposed = true;
      mountedRef.current = false;
      identityEpochRef.current += 1;
      recoveryEpochRef.current += 1;
      recoveryPendingRef.current = false;
      scopeEpochRef.current += 1;
    };
  }, [bootAttempt, getSession, isIdentityActive, loadPanel]);

  useEffect(() => {
    if (
      stage === "login" ||
      stage === "recover-request" ||
      stage === "recover-confirm" ||
      stage === "ready" ||
      stage === "forbidden" ||
      stage === "panel-error"
    ) {
      headingRef.current?.focus();
    }
  }, [stage]);

  useEffect(() => {
    if (message?.kind === "error") alertRef.current?.focus();
  }, [message]);

  const onLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new window.FormData(event.currentTarget);
    const loginEmail = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    const password = String(form.get("password") ?? "");
    const session = sessionRef.current;
    const currentConfig = configRef.current;
    if (!session || !currentConfig) return;

    const ticket = ++identityEpochRef.current;
    recoveryEpochRef.current += 1;
    recoveryPendingRef.current = false;
    setRecoveryPending(false);
    scopeEpochRef.current += 1;
    clearPanel();
    setAdminEmail(loginEmail);
    setStage("loading");
    setMessage({ kind: "status", text: "Iniciando sesión…" });
    try {
      await session.signIn(loginEmail, password);
      if (!isIdentityActive(ticket)) return;
      await loadPanel(session, currentConfig, ticket);
    } catch {
      if (!isIdentityActive(ticket)) return;
      setStage("login");
      setMessage({
        kind: "error",
        text: "No pudimos iniciar sesión. Revisá el email y la contraseña e intentá de nuevo.",
      });
    }
  };

  const startRecovery = () => {
    recoveryEpochRef.current += 1;
    recoveryPendingRef.current = false;
    setRecoveryPending(false);
    setRecoveryEmail("");
    setMessage(null);
    setStage("recover-request");
  };

  const backToLogin = () => {
    recoveryEpochRef.current += 1;
    recoveryPendingRef.current = false;
    setRecoveryPending(false);
    setPasswordError("");
    setMessage(null);
    setStage("login");
  };

  const changeRecoveryEmail = () => {
    recoveryEpochRef.current += 1;
    recoveryPendingRef.current = false;
    setRecoveryPending(false);
    setRecoveryEmail("");
    setMessage(null);
    setStage("recover-request");
  };

  const requestReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new window.FormData(event.currentTarget);
    const nextEmail = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    const session = sessionRef.current;
    if (!session || recoveryPendingRef.current) return;
    const identityTicket = identityEpochRef.current;
    const recoveryTicket = ++recoveryEpochRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      identityEpochRef.current === identityTicket &&
      recoveryEpochRef.current === recoveryTicket;
    setRecoveryEmail(nextEmail);
    recoveryPendingRef.current = true;
    setRecoveryPending(true);
    setMessage({ kind: "status", text: "Solicitando el código…" });
    try {
      await session.requestPasswordReset(nextEmail);
      if (!isCurrent()) return;
      setStage("recover-confirm");
      setMessage({ kind: "status", text: recoveryNotice });
    } catch (error) {
      if (!isCurrent()) return;
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (
        [
          "InvalidParameterException",
          "NotAuthorizedException",
          "UserNotConfirmedException",
          "UserNotFoundException",
        ].includes(code)
      ) {
        setStage("recover-confirm");
        setMessage({ kind: "status", text: recoveryNotice });
      } else {
        setMessage({ kind: "error", text: recoveryError(error, false) });
      }
    } finally {
      if (isCurrent()) {
        recoveryPendingRef.current = false;
        setRecoveryPending(false);
      }
    }
  };

  const resendReset = async () => {
    const session = sessionRef.current;
    if (!session || recoveryPendingRef.current || !recoveryEmail) return;
    const identityTicket = identityEpochRef.current;
    const recoveryTicket = ++recoveryEpochRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      identityEpochRef.current === identityTicket &&
      recoveryEpochRef.current === recoveryTicket;
    recoveryPendingRef.current = true;
    setRecoveryPending(true);
    setMessage({ kind: "status", text: "Solicitando otro código…" });
    try {
      await session.requestPasswordReset(recoveryEmail);
      if (!isCurrent()) return;
      setMessage({ kind: "status", text: recoveryNotice });
    } catch (error) {
      if (!isCurrent()) return;
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (
        [
          "InvalidParameterException",
          "NotAuthorizedException",
          "UserNotConfirmedException",
          "UserNotFoundException",
        ].includes(code)
      ) {
        setMessage({ kind: "status", text: recoveryNotice });
      } else {
        setMessage({ kind: "error", text: recoveryError(error, false) });
      }
    } finally {
      if (isCurrent()) {
        recoveryPendingRef.current = false;
        setRecoveryPending(false);
      }
    }
  };

  const confirmReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (recoveryPendingRef.current) return;
    const form = new window.FormData(event.currentTarget);
    const code = String(form.get("code") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const confirmationPassword = String(form.get("confirmPassword") ?? "");
    if (password !== confirmationPassword) {
      setPasswordError("Las contraseñas no coinciden.");
      return;
    }
    const session = sessionRef.current;
    if (!session) return;
    const identityTicket = identityEpochRef.current;
    const recoveryTicket = ++recoveryEpochRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      identityEpochRef.current === identityTicket &&
      recoveryEpochRef.current === recoveryTicket;
    setPasswordError("");
    recoveryPendingRef.current = true;
    setRecoveryPending(true);
    setMessage({ kind: "status", text: "Actualizando la contraseña…" });
    try {
      await session.confirmPasswordReset(recoveryEmail, code, password);
      if (!isCurrent()) return;
      identityEpochRef.current += 1;
      recoveryEpochRef.current += 1;
      recoveryPendingRef.current = false;
      setRecoveryPending(false);
      setStage("login");
      setMessage({ kind: "status", text: "La contraseña se cambió. Iniciá sesión nuevamente." });
    } catch (error) {
      if (!isCurrent()) return;
      setMessage({ kind: "error", text: recoveryError(error, true) });
    } finally {
      if (isCurrent()) {
        recoveryPendingRef.current = false;
        setRecoveryPending(false);
      }
    }
  };

  const changeEmail = (nextEmail: string) => {
    scopeEpochRef.current += 1;
    lookupRequestRef.current += 1;
    setEmail(nextEmail);
    setProfile(null);
    setConfirmation(null);
    setLookupPending(false);
    setInvitationPending(false);
    setMessage(null);
  };

  const changeBot = (nextBotId: string) => {
    scopeEpochRef.current += 1;
    lookupRequestRef.current += 1;
    setSelectedBotId(nextBotId);
    setProfile(null);
    setConfirmation(null);
    setLookupPending(false);
    setInvitationPending(false);
    setMessage(null);
  };

  const searchPerson = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const session = sessionRef.current;
    const currentConfig = configRef.current;
    const requestedEmail = email.trim();
    const requestedBotId = selectedBotId;
    const ticket = identityEpochRef.current;
    const scopeTicket = scopeEpochRef.current;
    const lookupTicket = ++lookupRequestRef.current;
    if (!session || !currentConfig || !requestedBotId || !emailIsValid(requestedEmail)) return;
    setProfile(null);
    setMessage({ kind: "status", text: "Buscando la cuenta…" });
    setLookupPending(true);
    const isCurrent = () =>
      isIdentityActive(ticket) &&
      scopeEpochRef.current === scopeTicket &&
      lookupRequestRef.current === lookupTicket;
    try {
      const result = await adminRequest(
        currentConfig,
        session,
        `/admin/bots/${encodeURIComponent(requestedBotId)}/people/lookup`,
        { method: "POST", body: { email: requestedEmail } },
        isCurrent,
      );
      if (!isCurrent()) return;
      const nextProfile = parseProfile(result, requestedBotId);
      setProfile(nextProfile);
      setMessage(
        nextProfile.person
          ? { kind: "status", text: `Ficha actualizada para ${nextProfile.person.email}.` }
          : {
              kind: "status",
              text: `No se encontró una cuenta con ese email en ${projectNameFor(bots, requestedBotId)}. Podés invitarla.`,
            },
      );
    } catch (error) {
      if (!isCurrent()) return;
      if (apiErrorStatus(error) === 403 || apiErrorStatus(error) === 401) {
        leaveSession(
          session,
          ticket,
          apiErrorStatus(error) === 403 ? "forbidden" : "login",
          apiErrorStatus(error) === 403
            ? "Esta cuenta ya no tiene permiso de administrador. La sesión se cerró."
            : "La sesión venció. Iniciá sesión nuevamente.",
        );
      } else {
        setMessage({
          kind: "error",
          text:
            apiErrorStatus(error) === 409
              ? "La ficha cambió durante la búsqueda. Volvé a buscar para consultar el estado actual."
              : "No pudimos buscar la cuenta. Revisá la conexión e intentá de nuevo.",
        });
      }
    } finally {
      if (isCurrent()) setLookupPending(false);
    }
  };

  const beginInvitation = (intent: InvitationIntent) => {
    if (!profile || !selectedBotId || invitationPending) return;
    setConfirmation(intent);
    setMessage(null);
  };

  const sendInvitation = async () => {
    const session = sessionRef.current;
    const currentConfig = configRef.current;
    const currentProfile = profile;
    const requestedEmail = email.trim();
    const requestedBotId = selectedBotId;
    const ticket = identityEpochRef.current;
    const scopeTicket = scopeEpochRef.current;
    if (
      !session ||
      !currentConfig ||
      !currentProfile ||
      !requestedBotId ||
      !emailIsValid(requestedEmail) ||
      !confirmation
    ) {
      return;
    }

    const operationScope = JSON.stringify([
      ticket,
      requestedBotId,
      requestedEmail,
      currentProfile.access.revision,
      currentProfile.person?.sub ?? null,
    ]);
    if (invitationInFlightRef.current === operationScope) return;
    invitationInFlightRef.current = operationScope;
    const intent = confirmation;
    const isCurrent = () => isIdentityActive(ticket) && scopeEpochRef.current === scopeTicket;
    setInvitationPending(true);
    setMessage({ kind: "status", text: "Registrando la invitación…" });
    try {
      const result = await adminRequest(
        currentConfig,
        session,
        `/admin/bots/${encodeURIComponent(requestedBotId)}/invitations`,
        {
          method: "POST",
          body: {
            email: requestedEmail,
            expectedSub: currentProfile.person?.sub ?? null,
            expectedRevision: currentProfile.access.revision,
            operationId: makeOperationId(),
          },
        },
        isCurrent,
      );
      if (!isCurrent()) return;
      const nextProfile = parseProfile(result, requestedBotId);
      setProfile(nextProfile);
      setConfirmation(null);
      if (nextProfile.access.state === "active") {
        setMessage({
          kind: "status",
          text: `La invitación quedó registrada y ${nextProfile.person?.email ?? requestedEmail} ya tiene acceso activo.`,
        });
      } else if (nextProfile.invitation) {
        const delivery = nextProfile.invitation.delivery;
        const resultText =
          delivery.status === "accepted"
            ? "La invitación quedó registrada. SES aceptó el mensaje para envío. Está pendiente que la persona acepte el enlace; el acceso todavía no está activo."
            : delivery.status === "failed"
              ? "La invitación quedó registrada, pero SES rechazó el correo. El acceso todavía no está activo."
              : "La invitación quedó registrada, pero no se confirmó el estado del correo. El acceso todavía no está activo.";
        setMessage({ kind: delivery.status === "failed" ? "error" : "status", text: resultText });
      } else {
        setMessage({
          kind: "status",
          text:
            intent === "reissue"
              ? "La nueva invitación quedó registrada."
              : "La invitación quedó registrada.",
        });
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (apiErrorStatus(error) === 403 || apiErrorStatus(error) === 401) {
        setConfirmation(null);
        leaveSession(
          session,
          ticket,
          apiErrorStatus(error) === 403 ? "forbidden" : "login",
          apiErrorStatus(error) === 403
            ? "Esta cuenta ya no tiene permiso de administrador. La sesión se cerró."
            : "La sesión venció. Iniciá sesión nuevamente.",
        );
      } else if (apiErrorStatus(error) === 409) {
        setConfirmation(null);
        setProfile(null);
        setMessage({
          kind: "error",
          text: "El estado cambió antes de registrar la invitación. Volvé a buscar la ficha antes de intentar otra vez.",
        });
      } else {
        setConfirmation(null);
        setProfile(null);
        setMessage({
          kind: "error",
          text: "No pudimos confirmar el resultado. Revisá la ficha antes de volver a invitar; no se hará otro envío automáticamente.",
        });
      }
    } finally {
      if (invitationInFlightRef.current === operationScope) invitationInFlightRef.current = null;
      if (isCurrent()) setInvitationPending(false);
    }
  };

  const signOut = async () => {
    const session = sessionRef.current;
    const ticket = identityEpochRef.current;
    if (!session || !isIdentityActive(ticket)) return;
    identityEpochRef.current += 1;
    recoveryEpochRef.current += 1;
    recoveryPendingRef.current = false;
    setRecoveryPending(false);
    scopeEpochRef.current += 1;
    clearPanel();
    setStage("login");
    setMessage(null);
    await session.signOut();
  };

  const selectedBot = bots.find((bot) => bot.botId === selectedBotId);
  const canInvite = Boolean(
    profile && profile.access.state !== "active" && profile.botId === selectedBotId,
  );
  const invitationIntent: InvitationIntent = profile?.invitation ? "reissue" : "invite";

  return (
    <div className="admin-shell">
      <a className="admin-skip-link" href="#admin-main">
        Ir al contenido principal
      </a>
      <header className="admin-header">
        <a className="admin-brand" href="/" aria-label="Panel de administración, inicio">
          <span className="admin-brand__mark" aria-hidden="true">
            A
          </span>
          <span>Administración</span>
        </a>
        {config ? <span className="admin-environment">{config.environment}</span> : null}
      </header>

      <main id="admin-main" className="admin-main">
        {stage === "booting" || stage === "loading" ? (
          <section className="admin-card admin-card--compact" aria-labelledby="admin-loading-title">
            <p className="admin-eyebrow">Acceso administrativo</p>
            <h1 id="admin-loading-title" tabIndex={-1}>
              {stage === "loading" ? "Ingresando al panel" : "Preparando el panel"}
            </h1>
            {message ? (
              <p className="admin-message" role="status">
                {message.text}
              </p>
            ) : null}
          </section>
        ) : null}

        {stage === "boot-error" ? (
          <section
            className="admin-card admin-card--compact"
            aria-labelledby="admin-boot-error-title"
          >
            <p className="admin-eyebrow">Acceso administrativo</p>
            <h1 id="admin-boot-error-title" tabIndex={-1}>
              No se pudo preparar el panel
            </h1>
            {message ? (
              <p className="admin-message admin-message--error" role="alert">
                {message.text}
              </p>
            ) : null}
            <button
              className="admin-button"
              type="button"
              onClick={() => setBootAttempt((value) => value + 1)}
            >
              Reintentar
            </button>
          </section>
        ) : null}

        {stage === "login" || stage === "recover-request" || stage === "recover-confirm" ? (
          <section className="admin-card admin-card--auth" aria-labelledby="admin-auth-title">
            <p className="admin-eyebrow">Acceso administrativo</p>
            <h1 id="admin-auth-title" ref={headingRef} tabIndex={-1}>
              {stage === "login"
                ? "Iniciá sesión"
                : stage === "recover-request"
                  ? "Recuperá tu contraseña"
                  : "Elegí una nueva contraseña"}
            </h1>
            <p className="admin-description">
              {stage === "login"
                ? "Ingresá con tu cuenta habitual. El permiso de administrador se comprueba en el servidor."
                : stage === "recover-request"
                  ? "Solicitá un código para recuperar la contraseña de tu cuenta."
                  : "Ingresá el código de recuperación y elegí una contraseña nueva."}
            </p>
            {message ? (
              <p
                ref={message.kind === "error" ? alertRef : undefined}
                className={`admin-message${message.kind === "error" ? " admin-message--error" : ""}`}
                role={message.kind === "error" ? "alert" : "status"}
                tabIndex={message.kind === "error" ? -1 : undefined}
              >
                {message.text}
              </p>
            ) : null}
            {passwordError ? (
              <p className="admin-message admin-message--error" role="alert" tabIndex={-1}>
                {passwordError}
              </p>
            ) : null}

            {stage === "login" ? (
              <form className="admin-form" onSubmit={(event) => void onLogin(event)}>
                <label htmlFor="admin-login-email">Email</label>
                <input
                  id="admin-login-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                />
                <label htmlFor="admin-login-password">Contraseña</label>
                <input
                  id="admin-login-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
                <button className="admin-button" type="submit">
                  Ingresar
                </button>
                <button className="admin-link-button" type="button" onClick={startRecovery}>
                  Recuperar contraseña
                </button>
              </form>
            ) : null}

            {stage === "recover-request" ? (
              <form className="admin-form" onSubmit={(event) => void requestReset(event)}>
                <label htmlFor="admin-recovery-email">Email</label>
                <input
                  id="admin-recovery-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={recoveryEmail}
                  onChange={(event) => setRecoveryEmail(event.currentTarget.value)}
                  required
                  disabled={recoveryPending}
                />
                <button className="admin-button" type="submit" disabled={recoveryPending}>
                  {recoveryPending ? "Enviando…" : "Enviar código"}
                </button>
                <button className="admin-link-button" type="button" onClick={backToLogin}>
                  Volver a iniciar sesión
                </button>
              </form>
            ) : null}

            {stage === "recover-confirm" ? (
              <>
                <form className="admin-form" onSubmit={(event) => void confirmReset(event)}>
                  <label htmlFor="admin-recovery-confirm-email">Email</label>
                  <input
                    id="admin-recovery-confirm-email"
                    name="email"
                    type="email"
                    value={recoveryEmail}
                    readOnly
                    required
                  />
                  <label htmlFor="admin-recovery-code">Código de recuperación</label>
                  <input
                    id="admin-recovery-code"
                    name="code"
                    type="text"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    required
                    disabled={recoveryPending}
                  />
                  <label htmlFor="admin-recovery-password">Elegí una nueva contraseña</label>
                  <input
                    id="admin-recovery-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    disabled={recoveryPending}
                  />
                  <p className="admin-field-hint">
                    Usá al menos 8 caracteres, con una mayúscula, una minúscula, un número y un
                    símbolo.
                  </p>
                  <label htmlFor="admin-recovery-confirm-password">
                    Confirmá la nueva contraseña
                  </label>
                  <input
                    id="admin-recovery-confirm-password"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    required
                    disabled={recoveryPending}
                  />
                  <button className="admin-button" type="submit" disabled={recoveryPending}>
                    {recoveryPending ? "Actualizando…" : "Cambiar contraseña"}
                  </button>
                </form>
                <div className="admin-form__secondary-actions">
                  <button
                    className="admin-button admin-button--quiet"
                    type="button"
                    onClick={() => void resendReset()}
                    disabled={recoveryPending}
                  >
                    Reenviar código
                  </button>
                  <button
                    className="admin-button admin-button--quiet"
                    type="button"
                    onClick={changeRecoveryEmail}
                    disabled={recoveryPending}
                  >
                    Cambiar email
                  </button>
                </div>
              </>
            ) : null}
          </section>
        ) : null}

        {stage === "forbidden" ? (
          <section
            className="admin-card admin-card--compact"
            aria-labelledby="admin-forbidden-title"
          >
            <p className="admin-eyebrow">Acceso administrativo</p>
            <h1 id="admin-forbidden-title" ref={headingRef} tabIndex={-1}>
              No tenés permiso de administrador
            </h1>
            {message ? (
              <p className="admin-message admin-message--error" role="alert">
                {message.text}
              </p>
            ) : null}
            <button className="admin-button" type="button" onClick={backToLogin}>
              Volver a ingresar
            </button>
          </section>
        ) : null}

        {stage === "panel-error" ? (
          <section
            className="admin-card admin-card--compact"
            aria-labelledby="admin-panel-error-title"
          >
            <p className="admin-eyebrow">Administración de acceso</p>
            <h1 id="admin-panel-error-title" ref={headingRef} tabIndex={-1}>
              No se pudo cargar el panel
            </h1>
            {message ? (
              <p className="admin-message admin-message--error" role="alert">
                {message.text}
              </p>
            ) : null}
            <button
              className="admin-button"
              type="button"
              onClick={() => {
                const session = sessionRef.current;
                const currentConfig = configRef.current;
                if (session && currentConfig) {
                  void loadPanel(session, currentConfig, identityEpochRef.current);
                }
              }}
            >
              Reintentar
            </button>
            <button className="admin-link-button" type="button" onClick={() => void signOut()}>
              Cerrar sesión
            </button>
          </section>
        ) : null}

        {stage === "ready" ? (
          <section className="admin-workspace" aria-labelledby="admin-title">
            <div className="admin-workspace__heading">
              <div>
                <p className="admin-eyebrow">Administración de acceso</p>
                <h1 id="admin-title" ref={headingRef} tabIndex={-1}>
                  Invitar a un chatbot
                </h1>
                <p className="admin-description">
                  Elegí el chatbot y buscá la cuenta por su email. El acceso se activa cuando la
                  persona acepta la invitación.
                </p>
              </div>
              <div className="admin-identity">
                <span>Sesión administrativa</span>
                <span className="admin-identity__sub" title={adminEmail || adminSub}>
                  {adminEmail || adminSub}
                </span>
                <button className="admin-link-button" type="button" onClick={() => void signOut()}>
                  Cerrar sesión
                </button>
              </div>
            </div>

            {message ? (
              <p
                ref={message.kind === "error" ? alertRef : undefined}
                className={`admin-message${message.kind === "error" ? " admin-message--error" : ""}`}
                role={message.kind === "error" ? "alert" : "status"}
                tabIndex={message.kind === "error" ? -1 : undefined}
              >
                {message.text}
              </p>
            ) : null}

            <div className="admin-content-grid">
              <section
                className="admin-card admin-card--search"
                aria-labelledby="admin-search-title"
              >
                <div className="admin-card__heading">
                  <span className="admin-step">01</span>
                  <div>
                    <h2 id="admin-search-title">Elegí el destino y la persona</h2>
                    <p>El chatbot define dónde se habilitará el acceso.</p>
                  </div>
                </div>
                {bots.length > 0 ? (
                  <form className="admin-form" onSubmit={(event) => void searchPerson(event)}>
                    <label htmlFor="admin-bot">Chatbot</label>
                    <select
                      id="admin-bot"
                      value={selectedBotId}
                      onChange={(event) => changeBot(event.currentTarget.value)}
                    >
                      {bots.map((bot) => (
                        <option key={bot.botId} value={bot.botId}>
                          {bot.projectName}
                        </option>
                      ))}
                    </select>
                    <label htmlFor="admin-person-email">Email</label>
                    <input
                      id="admin-person-email"
                      name="email"
                      type="email"
                      autoComplete="off"
                      value={email}
                      onChange={(event) => changeEmail(event.currentTarget.value)}
                      required
                    />
                    <p className="admin-field-hint">
                      Buscamos la cuenta con este email. La búsqueda no crea cuentas ni envía
                      invitaciones.
                    </p>
                    <button className="admin-button" type="submit" disabled={!selectedBotId}>
                      {lookupPending ? "Buscar" : "Buscar"}
                    </button>
                  </form>
                ) : (
                  <p className="admin-empty">No hay chatbots disponibles en este ambiente.</p>
                )}
              </section>

              <section
                className="admin-card admin-card--result"
                aria-labelledby="admin-result-title"
                aria-live="polite"
              >
                <div className="admin-card__heading">
                  <span className="admin-step">02</span>
                  <div>
                    <h2 id="admin-result-title">Ficha de acceso</h2>
                    <p>Revisá la cuenta y el estado antes de invitar.</p>
                  </div>
                </div>
                {lookupPending && !profile ? (
                  <div className="admin-result-placeholder">
                    <span className="admin-spinner" aria-hidden="true" />
                    Buscando la cuenta…
                  </div>
                ) : profile ? (
                  <div className="admin-profile">
                    <div className="admin-profile__identity">
                      <span
                        className={`admin-status-dot admin-status-dot--${profile.access.state}`}
                        aria-hidden="true"
                      />
                      <div>
                        <p className="admin-profile__email">
                          {profile.person?.email ?? email.trim()}
                        </p>
                        <p className="admin-profile__state">{accessCopy(profile)}</p>
                      </div>
                    </div>
                    {selectedBot ? (
                      <p className="admin-profile__project">Chatbot: {selectedBot.projectName}</p>
                    ) : null}
                    {profile.invitation ? (
                      <div className="admin-invitation-detail">
                        <p>{deliveryCopy(profile.invitation.delivery)}</p>
                        {profile.invitation.invitedEmail &&
                        profile.person &&
                        emailKey(profile.invitation.invitedEmail) !==
                          emailKey(profile.person.email) ? (
                          <p className="admin-invitation-detail__address-note">
                            Esta invitación se envió a {profile.invitation.invitedEmail.trim()}. La
                            ficha corresponde a la cuenta encontrada con el email actual{" "}
                            {profile.person.email}; una nueva invitación se enviará a{" "}
                            {profile.person.email}.
                          </p>
                        ) : null}
                        <p className="admin-expiry">
                          Vigencia hasta {formatExpiry(profile.invitation.expiresAt)}. Aceptar la
                          invitación activa el acceso.
                        </p>
                      </div>
                    ) : null}
                    {canInvite ? (
                      <button
                        ref={invitationTriggerRef}
                        className="admin-button"
                        type="button"
                        onClick={() => beginInvitation(invitationIntent)}
                        disabled={invitationPending}
                      >
                        {profile.invitation ? "Enviar nueva invitación" : "Invitar"}
                      </button>
                    ) : profile.access.state === "active" ? (
                      <p className="admin-active-note">La cuenta tiene acceso a este chatbot.</p>
                    ) : null}
                  </div>
                ) : (
                  <div className="admin-result-placeholder">
                    <span className="admin-result-placeholder__icon" aria-hidden="true">
                      ↗
                    </span>
                    <p>La ficha aparecerá acá después de buscar un email.</p>
                  </div>
                )}
              </section>
            </div>
            <footer className="admin-footer">
              <span>Administración compartida · {config?.environment}</span>
              <span>El envío de un correo no activa el acceso.</span>
            </footer>
          </section>
        ) : null}
      </main>

      {confirmation && profile && selectedBot ? (
        <ConfirmationDialog
          email={email.trim()}
          projectName={selectedBot.projectName}
          action={confirmation}
          pending={invitationPending}
          triggerRef={invitationTriggerRef}
          onCancel={() => {
            if (!invitationPending) setConfirmation(null);
          }}
          onConfirm={() => void sendInvitation()}
        />
      ) : null}
    </div>
  );
}

function formatExpiry(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "fecha no disponible";
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
