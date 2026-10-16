import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const excludedDirectories = new Set([".git", ".work", "node_modules", "dist", "cdk.out"]);

function createTemporaryCheckout() {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "multi-chatbot-checks-"));
  const checkout = path.join(temporaryRoot, "checkout");

  cpSync(projectRoot, checkout, {
    recursive: true,
    filter(source) {
      const relative = path.relative(projectRoot, source);
      if (!relative) return true;
      return !excludedDirectories.has(relative.split(path.sep)[0]);
    },
  });
  symlinkSync(path.join(projectRoot, "node_modules"), path.join(checkout, "node_modules"), "dir");

  return {
    root: temporaryRoot,
    checkout,
    cleanup() {
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

function runScript(checkout, script) {
  return spawnSync(npmCommand, ["run", script], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function output(result) {
  return [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
}

describe("local quality commands", () => {
  it("pass on a clean checkout and reject representative type, syntax, and format errors", () => {
    const temporary = createTemporaryCheckout();

    try {
      const infraDirectory = path.join(temporary.checkout, "infra");
      mkdirSync(infraDirectory, { recursive: true });

      for (const script of ["typecheck", "typecheck:web", "lint", "format:check"]) {
        const result = runScript(temporary.checkout, script);
        expect(result.status, `${script} failed on the clean copy:\n${output(result)}`).toBe(0);
      }

      const typeError = path.join(infraDirectory, "__acceptance_type_error__.ts");
      writeFileSync(typeError, "export const acceptanceType: string = 123;\n");
      const typecheck = runScript(temporary.checkout, "typecheck");
      expect(typecheck.status, output(typecheck)).not.toBe(0);
      expect(output(typecheck)).toContain("__acceptance_type_error__.ts");
      rmSync(typeError);

      const invalidProps = path.join(
        temporary.checkout,
        "tests/fixtures/web/__acceptance_invalid_props__.tsx",
      );
      writeFileSync(
        invalidProps,
        [
          'import { Greeting } from "./Greeting";',
          "export const invalid = <Greeting label={123} />;",
          "",
        ].join("\n"),
      );
      const webTypecheck = runScript(temporary.checkout, "typecheck:web");
      expect(webTypecheck.status, output(webTypecheck)).not.toBe(0);
      expect(output(webTypecheck)).toContain("__acceptance_invalid_props__.tsx");
      const aggregateTypecheck = runScript(temporary.checkout, "typecheck");
      expect(aggregateTypecheck.status, output(aggregateTypecheck)).not.toBe(0);
      expect(output(aggregateTypecheck)).toContain("__acceptance_invalid_props__.tsx");
      rmSync(invalidProps);

      const syntaxError = path.join(infraDirectory, "__acceptance_syntax_error__.ts");
      writeFileSync(syntaxError, "export const = ;\n");
      const jsxSyntaxError = path.join(
        temporary.checkout,
        "tests/fixtures/web/__acceptance_syntax_error__.tsx",
      );
      writeFileSync(jsxSyntaxError, "export const = ;\n");
      const lint = runScript(temporary.checkout, "lint");
      expect(lint.status, output(lint)).not.toBe(0);
      expect(output(lint)).toContain("__acceptance_syntax_error__.ts");
      expect(output(lint)).toContain("__acceptance_syntax_error__.tsx");
      rmSync(syntaxError);
      rmSync(jsxSyntaxError);

      const formattingError = path.join(infraDirectory, "__acceptance_format_error__.ts");
      writeFileSync(formattingError, "export const acceptanceFormat={answer:42}\n");
      const jsxFormattingError = path.join(
        temporary.checkout,
        "tests/fixtures/web/__acceptance_format_error__.tsx",
      );
      writeFileSync(jsxFormattingError, "export const acceptanceFormat=<main>{42}</main>\n");
      const formatting = runScript(temporary.checkout, "format:check");
      expect(formatting.status, output(formatting)).not.toBe(0);
      expect(output(formatting)).toContain("__acceptance_format_error__.ts");
      expect(output(formatting)).toContain("__acceptance_format_error__.tsx");
    } finally {
      temporary.cleanup();
    }
  }, 300_000);
});
