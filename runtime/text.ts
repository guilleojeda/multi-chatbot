export const maxDynamoTextChunkBytes = 300 * 1024;

export function splitUtf8Text(text: string, maxBytes = maxDynamoTextChunkBytes): string[] {
  if (text.length === 0) return [];
  if (!Number.isInteger(maxBytes) || maxBytes < 4) {
    throw new RangeError("Text chunk byte limit must fit at least one Unicode code point.");
  }

  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += codePoint;
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
