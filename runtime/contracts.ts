import type { MessageData } from "@strands-agents/sdk";

export type ContextReference = { ordinal: number; queryId: string };

export type ConversationContext = {
  messages: MessageData[];
  references: ContextReference[];
};
