import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitRepositoryScenario, readGitHubOutput } from "./helpers/git-repository.mjs";

const cliPath = fileURLToPath(new URL("../../scripts/deployment-context.mjs", import.meta.url));
let scenario;

beforeEach(() => {
  scenario = createGitRepositoryScenario();
});

afterEach(() => {
  scenario?.cleanup();
});

function invokeResolve({ ref, sha, deleted = false }) {
  expect(existsSync(cliPath), "scripts/deployment-context.mjs must exist for acceptance").toBe(
    true,
  );
  const outputPath = path.join(scenario.root, "github-output");
  const eventPath = path.join(scenario.root, "event.json");
  writeFileSync(outputPath, "");
  writeFileSync(eventPath, JSON.stringify({ deleted, ref, after: sha }));

  const result = spawnSync(process.execPath, [cliPath, "resolve"], {
    cwd: scenario.checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REF: ref,
      GITHUB_SHA: sha,
      GITHUB_OUTPUT: outputPath,
      AWS_ACCESS_KEY_ID: "acceptance-test",
      AWS_SECRET_ACCESS_KEY: "acceptance-test",
      AWS_SESSION_TOKEN: "acceptance-test",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_SHARED_CREDENTIALS_FILE: path.join(scenario.root, "no-credentials"),
    },
  });
  return { ...result, output: readGitHubOutput(outputPath) };
}

function invokeCurrent({ tag, commit }) {
  expect(existsSync(cliPath), "scripts/deployment-context.mjs must exist for acceptance").toBe(
    true,
  );
  const outputPath = path.join(scenario.root, "github-output");
  writeFileSync(outputPath, "");
  const result = spawnSync(
    process.execPath,
    [cliPath, "current", "--tag", tag, "--commit", commit],
    {
      cwd: scenario.checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
      },
    },
  );
  return { ...result, output: readGitHubOutput(outputPath) };
}

describe("deployment context resolution", () => {
  it.each([
    ["dev", "dev"],
    ["prod", "prod"],
  ])("maps refs/tags/%s to its environment using the immutable event SHA", (tag, environment) => {
    scenario.publishTag(tag, scenario.mainFirst);
    scenario.publishTag(tag, scenario.mainHead);

    const result = invokeResolve({
      ref: `refs/tags/${tag}`,
      sha: scenario.mainFirst,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.output).toMatchObject({
      commit: scenario.mainFirst,
      environment,
      account: "118903272638",
      region: "us-east-1",
      deploy: "true",
    });
  });

  it("resolves an annotated event SHA to its commit", () => {
    const tagObject = scenario.publishTag("prod", scenario.mainFirst, true);
    const fetched = spawnSync("git", ["fetch", "origin", "refs/tags/prod:refs/tags/prod"], {
      cwd: scenario.checkout,
      encoding: "utf8",
    });
    expect(fetched.status, fetched.stderr).toBe(0);

    const result = invokeResolve({ ref: "refs/tags/prod", sha: tagObject });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.output).toMatchObject({ commit: scenario.mainFirst, environment: "prod" });
  });

  it("accepts a historical commit on main and rejects an unrelated commit", () => {
    scenario.publishTag("dev", scenario.mainFirst);
    const accepted = invokeResolve({ ref: "refs/tags/dev", sha: scenario.mainFirst });
    expect(accepted.status, accepted.stderr || accepted.stdout).toBe(0);
    expect(accepted.output.commit).toBe(scenario.mainFirst);

    const rejected = invokeResolve({ ref: "refs/tags/dev", sha: scenario.outsideCommit });
    expect(rejected.status).not.toBe(0);
  });

  it("returns deploy=false for a deleted tag without resolving a commit", () => {
    const result = invokeResolve({
      ref: "refs/tags/dev",
      sha: "0000000000000000000000000000000000000000",
      deleted: true,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.output.deploy).toBe("false");
    expect(result.output.commit).toBeUndefined();
  });

  it("rejects tags outside dev and prod", () => {
    const result = invokeResolve({ ref: "refs/tags/qa", sha: scenario.mainHead });
    expect(result.status).not.toBe(0);
  });
});

describe("remote deployment tag currency", () => {
  it.each([
    { tag: "dev", kind: "lightweight", annotated: false },
    { tag: "prod", kind: "annotated", annotated: true },
  ])("recognizes a $kind $tag tag through the bare origin", ({ tag, annotated }) => {
    scenario.publishTag(tag, scenario.mainFirst, annotated);

    const result = invokeCurrent({ tag, commit: scenario.mainFirst });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.output.current).toBe("true");
  });

  it("returns false after a tag moves to a different main commit", () => {
    scenario.publishTag("dev", scenario.mainHead);

    const result = invokeCurrent({ tag: "dev", commit: scenario.mainFirst });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.output.current).toBe("false");
  });

  it("returns false after the remote tag is deleted", () => {
    scenario.publishTag("prod", scenario.mainFirst);
    scenario.deleteRemoteTag("prod");

    const result = invokeCurrent({ tag: "prod", commit: scenario.mainFirst });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.output.current).toBe("false");
  });

  it("rejects deployment tags outside dev and prod", () => {
    const result = invokeCurrent({ tag: "qa", commit: scenario.mainFirst });
    expect(result.status).not.toBe(0);
  });
});
