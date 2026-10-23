const openingTag = "<pedido_original_json>";
const closingTag = "</pedido_original_json>";

export function extractOriginalRequestText(modelText) {
  const openingIndex = modelText.indexOf(openingTag);
  if (openingIndex < 0 || modelText.indexOf(openingTag, openingIndex + openingTag.length) >= 0) {
    throw new Error("Expected exactly one quoted original request block.");
  }
  const contentStart = openingIndex + openingTag.length;
  const closingIndex = modelText.indexOf(closingTag, contentStart);
  if (
    closingIndex < contentStart ||
    modelText.indexOf(closingTag, closingIndex + closingTag.length) >= 0
  ) {
    throw new Error("Expected exactly one closing request tag.");
  }
  const serialized = modelText.slice(contentStart, closingIndex).trim();
  if (/[<>]/.test(serialized)) throw new Error("Quoted request must escape angle brackets.");
  const original = JSON.parse(serialized);
  if (typeof original !== "string") throw new Error("Quoted request must be a JSON string.");
  return original;
}
