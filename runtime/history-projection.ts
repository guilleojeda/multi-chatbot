const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function createHistoryLabel(question: string): string {
  const normalized = question.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) throw new TypeError("History label requires a question.");
  const characters = Array.from(normalized);
  return characters.length <= 120 ? normalized : `${characters.slice(0, 119).join("")}…`;
}

export function createHistoryOrder(activityAt: unknown, conversationId: string): string {
  if (typeof activityAt === "string" && isoTimestampPattern.test(activityAt)) {
    const milliseconds = Date.parse(activityAt);
    if (Number.isFinite(milliseconds)) {
      return `${new Date(milliseconds).toISOString()}#${conversationId}`;
    }
  }
  return `0000#${conversationId}`;
}
