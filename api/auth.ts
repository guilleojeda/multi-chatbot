export function accessTokenSubject(claims: Record<string, unknown> | undefined): string | null {
  const sub = claims?.sub;
  if (claims?.token_use !== "access" || typeof sub !== "string" || sub.length === 0) {
    return null;
  }
  return sub;
}
