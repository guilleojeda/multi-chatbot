import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const node24Engine =
  /^(?:v?24(?:\.\d+){0,2}|24\.x|\^24(?:\.x)?|>=24(?:\.0)?\s*<\s*25(?:\.0)?)$/;
const node24FullPatchEngine = /^(?:\^24\.0\.0|>=24\.0\.0\s*<\s*25\.0\.0)$/;

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

describe("fase 1 setup contract", () => {
  it("exposes local and delivery commands for both build targets", () => {
    const { scripts = {} } = readJson("package.json");
    const required = [
      "typecheck",
      "typecheck:web",
      "lint",
      "format:check",
      "test",
      "build",
      "build:web",
      "synth",
      "check",
    ];

    expect(required.filter((name) => typeof scripts[name] !== "string")).toEqual([]);
    expect(scripts.typecheck || "").toContain("typecheck:infra");
    expect(scripts.typecheck || "").toContain("typecheck:web");
    expect(scripts.build || "").toContain("build:infra");
    expect(scripts.build || "").toContain("build:web");
    expect(scripts["typecheck:web"] || "").toContain("tsconfig.web.json");
    expect(scripts["build:web"] || "").toContain("--config vite.config.ts");
  });

  it("pins the CDK, React, Vite, and test dependencies to the lockfile", () => {
    const packageJson = readJson("package.json");
    const lock = readJson("package-lock.json");
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };
    const exactPackages = [
      "aws-cdk",
      "aws-cdk-lib",
      "constructs",
      "typescript",
      "@types/node",
      "react",
      "react-dom",
      "@types/react",
      "@types/react-dom",
      "vite",
      "@vitejs/plugin-react",
      "eslint",
      "prettier",
      "vitest",
    ];
    const mismatches = [];

    for (const name of exactPackages) {
      const version = dependencies[name];
      if (typeof version !== "string" || !exactVersion.test(version)) {
        mismatches.push(`${name}: missing or not an exact version`);
      } else if (lock.packages[`node_modules/${name}`]?.version !== version) {
        mismatches.push(`${name}: package and lock versions differ`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("pins Node 24 and the npm toolchain", () => {
    const packageJson = readJson("package.json");
    const nodeVersionFiles = [".nvmrc", ".node-version"].map((name) => {
      try {
        return readFileSync(path.join(projectRoot, name), "utf8").trim();
      } catch {
        return "";
      }
    });

    expect(packageJson.packageManager || "").toMatch(/^npm@\d+\.\d+\.\d+$/);
    expect(nodeVersionFiles.some((version) => /^v?24\.\d+\.\d+$/.test(version))).toBe(true);
    const nodeEngine = packageJson.engines?.node || "";
    expect(node24Engine.test(nodeEngine) || node24FullPatchEngine.test(nodeEngine)).toBe(true);
  });

  it("separates browser and Node TypeScript settings and keeps synth infra-only", () => {
    const packageJson = readJson("package.json");
    const tsconfig = readJson("tsconfig.json");
    expect(tsconfig.compilerOptions).toMatchObject({
      module: "NodeNext",
      moduleResolution: "NodeNext",
      outDir: "dist",
    });
    expect(packageJson.type).toBe("module");

    const webTsconfig = readJson("tsconfig.web.json");
    expect(webTsconfig.compilerOptions).toMatchObject({
      jsx: "react-jsx",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
    });
    expect(webTsconfig.compilerOptions.lib).toContain("DOM");

    const cdkConfig = readJson("cdk.json");
    const appCommand = cdkConfig.app.replaceAll("\\", "/");
    expect(appCommand).toMatch(/\bnode\b.*(?:^|\s)\.?\/?dist\/.+\.js(?:\s|$)/);
    expect(appCommand).not.toMatch(/ts-node|\.ts(?:\s|$)/);
    expect(cdkConfig.context?.environment).toBe("dev");

    const synthScript = packageJson.scripts.synth || "";
    expect(synthScript.indexOf("npm run build:infra")).toBeGreaterThanOrEqual(0);
    expect(synthScript.indexOf("cdk synth")).toBeGreaterThan(
      synthScript.indexOf("npm run build:infra"),
    );
    expect(synthScript).not.toMatch(/npm run build(?:\s|$)/);
  });
});
