import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const allowedTags = new Set(["dev", "prod"]);
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function runGit(args, { cwd = process.cwd(), allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(`Could not run git ${args[0]}: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args[0]} failed${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ""}`,
    );
  }

  return result;
}

function requireOutputPath() {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT must point to the GitHub Actions output file");
  }
  return outputPath;
}

function writeOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  appendFileSync(requireOutputPath(), `${lines.join("\n")}\n`, "utf8");
}

function readPushEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required for resolve");
  }

  try {
    return JSON.parse(readFileSync(eventPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read the GitHub event payload: ${error.message}`, { cause: error });
  }
}

function tagForRef(ref) {
  const match = /^refs\/tags\/(dev|prod)$/.exec(ref ?? "");
  if (!match) {
    throw new Error(`Unsupported deployment ref: ${ref ?? "<missing>"}`);
  }
  return match[1];
}

function requireSha(value, name) {
  if (!shaPattern.test(value ?? "")) {
    throw new Error(`${name} must be a full Git object SHA`);
  }
  return value;
}

function resolveCommit(sha) {
  const result = runGit(["rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`]);
  const commit = result.stdout.trim();
  if (!shaPattern.test(commit)) {
    throw new Error("Git did not resolve the event SHA to a full commit SHA");
  }
  return commit;
}

function ensureOnMain(commit) {
  runGit(["fetch", "--no-tags", "origin", "refs/heads/main"]);
  const ancestry = runGit(["merge-base", "--is-ancestor", commit, "FETCH_HEAD"], {
    allowFailure: true,
  });

  if (ancestry.status === 1) {
    throw new Error(`Commit ${commit} is not reachable from origin/main`);
  }
  if (ancestry.status !== 0) {
    throw new Error("Could not verify that the deployment commit belongs to origin/main");
  }
}

async function resolveDeployment() {
  const event = readPushEvent();
  if (event.deleted === true) {
    writeOutputs({ deploy: "false" });
    return;
  }

  const ref = process.env.GITHUB_REF;
  if (event.ref && ref && event.ref !== ref) {
    throw new Error("GITHUB_REF does not match the ref in the event payload");
  }
  const tag = tagForRef(ref || event.ref);
  const environment = tag;
  const eventSha = requireSha(process.env.GITHUB_SHA, "GITHUB_SHA");
  const commit = resolveCommit(eventSha);

  ensureOnMain(commit);

  const { projectConfig, resolveEnvironment } = await import("../dist/config/project.js");
  const resolved = resolveEnvironment(environment);
  if (
    !resolved ||
    resolved.environment !== environment ||
    resolved.account !== projectConfig.account ||
    resolved.region !== projectConfig.region
  ) {
    throw new Error("The deployment environment does not match the shared project configuration");
  }

  writeOutputs({
    commit,
    environment: resolved.environment,
    account: resolved.account,
    region: resolved.region,
    deploy: "true",
  });
}

function parseCurrentArgs(args) {
  if (args.length !== 4 || args[0] !== "--tag" || args[2] !== "--commit") {
    throw new Error("Usage: deployment-context.mjs current --tag <dev|prod> --commit <sha>");
  }

  const [, tag, , commit] = args;
  if (!allowedTags.has(tag)) {
    throw new Error(`Unsupported deployment tag: ${tag}`);
  }

  return { tag, commit: resolveCommit(requireSha(commit, "--commit")) };
}

function isCurrentTag(tag, commit) {
  const tagRef = `refs/tags/${tag}`;
  const result = runGit(["ls-remote", "origin", tagRef, `${tagRef}^{}`], { allowFailure: true });
  if (result.status !== 0) {
    throw new Error("Could not check the deployment tag on origin");
  }

  const refs = new Map(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/);
        return [ref, sha];
      }),
  );
  const remoteCommit = refs.get(`${tagRef}^{}`) ?? refs.get(tagRef);
  if (!remoteCommit) {
    return false;
  }

  return remoteCommit === commit;
}

function checkCurrentTag(args) {
  const { tag, commit } = parseCurrentArgs(args);
  writeOutputs({ current: String(isCurrentTag(tag, commit)) });
}

async function main(args) {
  const [operation, ...rest] = args;
  if (operation === "resolve" && rest.length === 0) {
    await resolveDeployment();
    return;
  }
  if (operation === "current") {
    checkCurrentTag(rest);
    return;
  }
  throw new Error("Usage: deployment-context.mjs <resolve|current>");
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
