import type { MessageData } from "@strands-agents/sdk";

export type ContextReference = { ordinal: number; queryId: string };

export type SummaryVersion = {
  version: 1;
  summaryId: string;
  throughOrdinal: number;
  previousSummaryId?: string;
  sourceReferences: ContextReference[];
  text: string;
  modelId: string;
  revision: string;
  preparedAt: string | number;
  inputTokens: number;
  countRequestId?: string;
  requestId?: string;
  metrics?: Record<string, number>;
};

export type ContextSnapshot = {
  version: 1;
  summary?: { summaryId: string; throughOrdinal: number };
  recentReferences: ContextReference[];
};

export type PreparedContext = {
  messages: MessageData[];
  references: ContextReference[];
  contextSnapshot: ContextSnapshot;
  summaryCandidate?: SummaryVersion;
  triggerCount?: TokenCountResult;
};

export type ConversationContext = {
  messages: MessageData[];
  references: ContextReference[];
  summary?: SummaryVersion;
};

export type DocumentResult = {
  text: string;
  location?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  score?: number;
  documentId?: string;
};

export type DocumentReformulation = {
  modelId: string;
  requestId?: string;
  inputTokens: number;
  countRequestId?: string;
  metrics?: Record<string, number>;
};

export type DocumentContext = {
  knowledgeBaseId: string;
  query: string;
  revision: string;
  retrievedAt: number;
  status: "results" | "empty";
  results: DocumentResult[];
  requestId?: string;
  reformulation?: DocumentReformulation;
};

export type TokenCountOptions = { abortSignal?: AbortSignal };

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
  documentContext: DocumentContext;
  contextSnapshot: ContextSnapshot;
  summaryCandidate?: SummaryVersion;
  invocation: Invocation;
  quota: QuotaView;
  requestFingerprint: string;
};

export type StartTurnInput = TurnAdmissionInput & {
  operation: "start";
  baseOrdinal: 0;
};

export type ContinueTurnInput = TurnAdmissionInput & {
  operation: "message";
  baseOrdinal: number;
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
  contextSnapshot: ContextSnapshot;
  summary?: SummaryVersion;
  answer: string;
  answerManifest: TurnManifest;
  cursor: number;
  canContinue: boolean;
  resultDeadlineAt: number;
  profileSnapshot: ProfileSnapshot;
  documentContext: DocumentContext;
  invocation: Invocation;
  failure?: { code: string };
  ownerAttemptId?: string;
};

export type ConversationMeta = {
  pk: string;
  sk: "META";
  conversationId: string;
  sub: string;
  botId: string;
  createdAt?: string;
  updatedAt?: string;
  lastOrdinal: number;
  lastQueryId?: string;
  activeQueryId?: string;
  activeOwnerAttemptId?: string;
  closed: boolean;
  hiddenAt?: unknown;
  historyOwner?: string;
  historyOrder?: string;
  historyLabel?: string;
};

export type ConversationStoreErrorCode =
  | "quota_exceeded"
  | "quota_period_changed"
  | "submission_exists"
  | "conversation_busy"
  | "conversation_hidden"
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
