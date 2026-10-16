import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.join(repositoryRoot, "tests/fixtures/web"),
  build: {
    outDir: path.join(repositoryRoot, "dist/web-fixture"),
    emptyOutDir: true,
  },
  test: {
    root: repositoryRoot,
    include: ["tests/acceptance/**/*.test.mjs"],
  },
});
