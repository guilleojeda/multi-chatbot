import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.join(repositoryRoot, "web/admin"),
  build: {
    outDir: path.join(repositoryRoot, "dist/admin-web"),
    emptyOutDir: true,
  },
});
