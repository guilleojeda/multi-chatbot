const verifiedIsoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const isoCalendarDatePrefix = /^(\d{4})-(\d{2})-(\d{2})T/;

// History writers and backfill use ISO timestamps; Date.parse alone normalizes impossible days.
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

export function parseVerifiedHistoryTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !verifiedIsoTimestampPattern.test(value)) return undefined;
  const dateParts = isoCalendarDatePrefix.exec(value);
  if (
    !dateParts ||
    !isValidCalendarDate(Number(dateParts[1]), Number(dateParts[2]), Number(dateParts[3]))
  ) {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

export function normalizeVerifiedHistoryTimestamp(value: unknown): string | undefined {
  const milliseconds = parseVerifiedHistoryTimestamp(value);
  return milliseconds === undefined ? undefined : new Date(milliseconds).toISOString();
}

export function createHistoryLabel(question: string): string {
  const normalized = question.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) throw new TypeError("History label requires a question.");
  const characters = Array.from(normalized);
  return characters.length <= 120 ? normalized : `${characters.slice(0, 119).join("")}…`;
}

export function createHistoryOrder(activityAt: unknown, conversationId: string): string {
  const normalized = normalizeVerifiedHistoryTimestamp(activityAt);
  if (normalized) {
    return `${normalized}#${conversationId}`;
  }
  return `0000#${conversationId}`;
}
