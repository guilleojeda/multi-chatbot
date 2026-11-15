export function parseRecordsTestPersonIds(raw = "{}"): ReadonlyMap<string, readonly string[]> {
  const invalid = () => new TypeError("Invalid records test account configuration.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const byBot = new Map<string, readonly string[]>();
  for (const [botId, people] of Object.entries(value)) {
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(botId) ||
      !Array.isArray(people) ||
      !people.every(
        (personId): personId is string =>
          typeof personId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(personId),
      )
    ) {
      throw invalid();
    }
    byBot.set(botId, [...new Set(people)]);
  }
  return byBot;
}
