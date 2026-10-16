import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.join(repositoryRoot, "web"),
  build: {
    outDir: path.join(repositoryRoot, "dist/web"),
    emptyOutDir: true,
  },
  test: {
    root: repositoryRoot,
    include: ["tests/acceptance/**/*.test.mjs"],
    // Synthesis tests compile into shared dist/infra output, so test files must not overlap.
    fileParallelism: false,
  },
});
