import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("retires the old history backfill command instead of shipping a compatibility path", () => {
  const retiredCommand = fileURLToPath(
    new URL("../../scripts/backfill-chat-history.mjs", import.meta.url),
  );
  expect(existsSync(retiredCommand)).toBe(false);
});
