import type { MessageData } from "@strands-agents/sdk";

export type ContextReference = { ordinal: number; queryId: string };

export type ConversationContext = {
  messages: MessageData[];
  references: ContextReference[];
};

export type ModelInput = {
  systemPrompt: string;
  profileSnapshot: Record<string, unknown>;
  text: string;
  messages: MessageData[];
  modelId: string;
  revision: string;
};

export type GenerationInput = ModelInput & {
  resultDeadlineAt: number;
  cancelSignal?: AbortSignal;
};

export type TokenCountResult = {
  inputTokens: number;
  requestId?: string;
};

export type QuotaPeriod = {
  used: number;
  limit: number;
  resetAt: number;
  period: string;
};

export type QuotaView = {
  daily: QuotaPeriod;
  monthly: QuotaPeriod;
  serverNow: number;
  blockedUntil: number | null;
  policyRevision: string;
};

export type Invocation = { modelId: string; revision?: string };
export type ProfileSnapshot = Record<string, unknown>;
export type SubmissionOperation = "start" | "message";
export type SubmissionStatus = "in_progress" | "completed" | "failed";
export type TurnPhase = "admitted" | "invocation_claimed" | "complete" | "failed";
export type TurnManifest = { count: number; complete: boolean };

type TurnAdmissionInput = {
  sub: string;
  botId: string;
  conversationId: string;
  queryId: string;
  now: number;
  ownerAttemptId: string;
  resultDeadlineAt: number;
  text: string;
  profileSnapshot: ProfileSnapshot;
  invocation: Invocation;
  quota: QuotaView;
  requestFingerprint: string;
};

export type StartTurnInput = TurnAdmissionInput & {
  operation?: "start";
  baseOrdinal?: 0;
};

type ContinueTurnOrdinal =
  | { baseOrdinal: number; expectedLastOrdinal?: number }
  | { baseOrdinal?: number; expectedLastOrdinal: number };

export type ContinueTurnInput = TurnAdmissionInput &
  ContinueTurnOrdinal & {
    operation?: "message";
    contextReferences: ContextReference[];
  };

export type SubmissionSnapshot = {
  sub: string;
  botId: string;
  conversationId: string;
  queryId: string;
  requestFingerprint: string;
  operation: SubmissionOperation;
  baseOrdinal: number;
  ordinal: number;
  status: SubmissionStatus;
  stage: TurnPhase;
  question: string;
  questionManifest: TurnManifest;
  contextReferences: ContextReference[];
  answer: string;
  answerManifest: TurnManifest;
  cursor: number;
  canContinue: boolean;
  resultDeadlineAt: number;
  profileSnapshot: ProfileSnapshot;
  invocation: Invocation;
  failure?: { code: string };
  ownerAttemptId?: string;
};

export type ConversationMeta = {
  conversationId: string;
  sub: string;
  botId: string;
  lastOrdinal: number;
  lastQueryId?: string;
  activeQueryId?: string;
  closed?: boolean;
};

export type ConversationStoreErrorCode =
  | "quota_exceeded"
  | "quota_period_changed"
  | "submission_exists"
  | "conversation_busy"
  | "stale_base"
  | "conflict"
  | "storage_capacity_exceeded";

export type ConversationStoreError = Error & {
  code: ConversationStoreErrorCode;
  quota?: QuotaView;
};

export type AppendChunkInput = {
  conversationId: string;
  ordinal: number;
  queryId: string;
  role: "assistant";
  index: number;
  text: string;
  ownerAttemptId: string;
  now: number;
};

export type CompleteTurnInput = {
  conversationId: string;
  ordinal: number;
  queryId: string;
  ownerAttemptId: string;
  now: number;
  answerManifest: { count: number; complete: true };
  invocation?: Invocation;
  stopReason?: string;
  requestId?: string;
  metrics?: Record<string, number>;
};

export type FailTurnInput = {
  conversationId: string;
  ordinal: number;
  queryId: string;
  ownerAttemptId: string;
  now: number;
  code: string;
  invocationClaimed: boolean;
  providerFinished: boolean;
  answerManifest?: { count: number; complete: false };
  stopReason?: string;
  requestId?: string;
  metrics?: Record<string, number>;
  providerError?: Record<string, unknown>;
};

export type ConversationStore = {
  getMeta(input: { conversationId: string }): Promise<ConversationMeta | null>;
  readContext(input: { conversationId: string }): Promise<ConversationContext>;
  readQuota(input: { sub: string; botId: string; now: number }): Promise<QuotaView>;
  getSubmission(input: {
    sub: string;
    botId: string;
    queryId: string;
  }): Promise<SubmissionSnapshot | null>;
  startTurn(input: StartTurnInput): Promise<{ queryId: string; ordinal: number }>;
  continueTurn(input: ContinueTurnInput): Promise<{ queryId: string; ordinal: number }>;
  claimInvocation(input: {
    conversationId: string;
    ordinal: number;
    queryId: string;
    ownerAttemptId: string;
    now: number;
  }): Promise<boolean>;
  appendChunk(input: AppendChunkInput): Promise<void>;
  completeTurn(input: CompleteTurnInput): Promise<void>;
  failTurn(input: FailTurnInput): Promise<void>;
  reconcileTurn(input: {
    sub: string;
    botId: string;
    conversationId: string;
    queryId: string;
    now: number;
  }): Promise<SubmissionSnapshot | null>;
};
