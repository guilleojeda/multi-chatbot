// Existing handler cases exercise their own boundary with context already prepared.
export async function prepareUnchangedContext(input, context) {
  return {
    messages: input.messages,
    references: context.references,
    contextSnapshot: { version: 1, recentReferences: context.references },
  };
}
