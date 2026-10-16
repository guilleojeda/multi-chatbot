import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function output(result) {
  return [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
}

function buildFixture(outputDirectory) {
  return spawnSync(
    npmCommand,
    ["run", "build:web", "--", "tests/fixtures/web", "--outDir", outputDirectory],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 45_000,
    },
  );
}

function emittedFile(outputDirectory, reference) {
  const pathname = new URL(reference, "http://vite-acceptance.invalid").pathname;
  return path.join(outputDirectory, decodeURIComponent(pathname).replace(/^\/+/, ""));
}

describe("the isolated React and TypeScript web fixture", () => {
  it(
    "transforms JSX and renders the typed component with React DOM server",
    async () => {
      const [{ Greeting }, ReactModule, server] = await Promise.all([
        import("../fixtures/web/Greeting.tsx"),
        import("react"),
        import("react-dom/server"),
      ]);
      const React = ReactModule.default || ReactModule;
      const renderToStaticMarkup =
        server.renderToStaticMarkup || server.default?.renderToStaticMarkup;
      const html = renderToStaticMarkup(
        React.createElement(Greeting, { label: "rendered-react-fixture" }),
      );

      expect(html).toContain("rendered-react-fixture");
      expect(html).toContain("fixture-greeting");
    },
    30_000,
  );

  it(
    "builds the fixture HTML with its emitted JavaScript and CSS assets",
    () => {
      const outputDirectory = mkdtempSync(path.join(tmpdir(), "multi-chatbot-web-out-"));
      try {
        const result = buildFixture(outputDirectory);
        expect(result.status, output(result)).toBe(0);

        const htmlPath = path.join(outputDirectory, "index.html");
        expect(existsSync(htmlPath)).toBe(true);
        const html = readFileSync(htmlPath, "utf8");
        const scriptReferences = [
          ...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js(?:\?[^"]*)?)"/g),
        ].map((match) => match[1]);
        const styleReferences = [
          ...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css(?:\?[^"]*)?)"/g),
        ].map((match) => match[1]);

        expect(scriptReferences.length).toBeGreaterThan(0);
        expect(styleReferences.length).toBeGreaterThan(0);

        const scriptFiles = scriptReferences.map((reference) =>
          emittedFile(outputDirectory, reference),
        );
        const styleFiles = styleReferences.map((reference) =>
          emittedFile(outputDirectory, reference),
        );
        for (const emittedPath of [...scriptFiles, ...styleFiles]) {
          expect(existsSync(emittedPath)).toBe(true);
          expect(statSync(emittedPath).size).toBeGreaterThan(0);
        }

        expect(scriptFiles.map((file) => readFileSync(file, "utf8")).join("\n")).toContain(
          "fixture-react-acceptance",
        );
        expect(styleFiles.map((file) => readFileSync(file, "utf8")).join("\n")).toContain(
          "fixture-greeting",
        );
      } finally {
        rmSync(outputDirectory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
