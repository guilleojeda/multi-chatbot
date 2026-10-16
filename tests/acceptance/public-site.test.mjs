import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const publicSitePath = path.join(projectRoot, "web/PublicSite.tsx");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const contentFixtures = [
  {
    projectName: "Proyecto de prueba Aurora",
    purpose: "Este fixture prueba que el sitio explica el propósito del proyecto Aurora.",
    dataUse: "Este fixture explica el uso de datos del proyecto Aurora.",
  },
  {
    projectName: "Proyecto de prueba Brisa",
    purpose: "Este fixture prueba que el sitio explica el propósito del proyecto Brisa.",
    dataUse: "Este fixture explica el uso de datos del proyecto Brisa.",
  },
];

function commandOutput(result) {
  return [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
}

async function renderPublicSite(props) {
  const moduleExists = existsSync(publicSitePath);
  expect(moduleExists, "Expected the product entry component at web/PublicSite.tsx").toBe(true);
  if (!moduleExists) return null;

  const [{ PublicSite }, ReactModule, server] = await Promise.all([
    import(pathToFileURL(publicSitePath).href),
    import("react"),
    import("react-dom/server"),
  ]);
  const React = ReactModule.default || ReactModule;
  const renderToStaticMarkup = server.renderToStaticMarkup || server.default?.renderToStaticMarkup;

  return renderToStaticMarkup(React.createElement(PublicSite, props));
}

function assertPublicContent(html, props) {
  expect(html).not.toBeNull();

  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  expect(main, "Expected the public content inside a main landmark").not.toBeNull();
  if (!main) return;

  const mainContent = main[1];
  const heading = mainContent.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  expect(heading, "Expected the project name in the page's main heading").not.toBeNull();
  expect(heading?.[1].replace(/<[^>]*>/g, "")).toContain(props.projectName);

  const contentText = mainContent.replace(/<[^>]*>/g, "");
  expect(contentText).toContain(props.purpose);
  expect(contentText).toContain(props.dataUse);

  const otherFixtures = contentFixtures.filter(
    (fixture) => fixture.projectName !== props.projectName,
  );
  for (const fixture of otherFixtures) {
    expect(contentText).not.toContain(fixture.projectName);
    expect(contentText).not.toContain(fixture.purpose);
    expect(contentText).not.toContain(fixture.dataUse);
  }
}

function emittedFile(outputDirectory, reference) {
  const pathname = new URL(reference, "http://public-site-acceptance.invalid").pathname;
  return path.join(outputDirectory, decodeURIComponent(pathname).replace(/^\/+/, ""));
}

describe("the public product site", () => {
  it.each(contentFixtures)(
    "renders the configured project name, purpose, and data use ($projectName)",
    async (props) => {
      const html = await renderPublicSite(props);
      assertPublicContent(html, props);
    },
  );

  it("builds the product entry and emits its referenced assets", () => {
    const productEntry = path.join(projectRoot, "web/index.html");
    const productEntryExists = existsSync(productEntry);
    expect(productEntryExists, "Expected the product Vite entry at web/index.html").toBe(true);
    if (!productEntryExists) return;

    const outputDirectory = mkdtempSync(path.join(tmpdir(), "multi-chatbot-public-site-"));
    try {
      const result = spawnSync(
        npmCommand,
        ["run", "build:web", "--", "--outDir", outputDirectory],
        {
          cwd: projectRoot,
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      expect(result.status, commandOutput(result)).toBe(0);
      if (result.status !== 0) return;

      const htmlPath = path.join(outputDirectory, "index.html");
      const htmlExists = existsSync(htmlPath);
      expect(htmlExists, "Expected build:web to emit the product index.html").toBe(true);
      if (!htmlExists) return;

      const html = readFileSync(htmlPath, "utf8");
      expect(html).not.toContain("Multi-chatbot web fixture");

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
      const assetFiles = [...scriptFiles, ...styleFiles];
      for (const emittedPath of assetFiles) {
        expect(existsSync(emittedPath), `Expected emitted asset ${emittedPath} to exist`).toBe(
          true,
        );
        expect(statSync(emittedPath).size).toBeGreaterThan(0);
      }

      const assetContents = assetFiles.map((file) => readFileSync(file, "utf8")).join("\n");
      expect(assetContents).not.toContain("fixture-react-acceptance");
      expect(assetContents).not.toContain("fixture-greeting");
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 90_000);
});
