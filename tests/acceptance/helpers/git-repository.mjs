import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureIdentity(cwd) {
  git(cwd, "config", "user.name", "Acceptance Test");
  git(cwd, "config", "user.email", "acceptance@example.invalid");
}

function commitFile(cwd, filename, contents, message) {
  writeFileSync(path.join(cwd, filename), contents);
  git(cwd, "add", filename);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

export function createGitRepositoryScenario() {
  const root = mkdtempSync(path.join(tmpdir(), "multi-chatbot-acceptance-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const checkout = path.join(root, "checkout");
  const unrelated = path.join(root, "unrelated");

  git(root, "init", "--bare", "--initial-branch=main", bare);
  mkdirSync(seed);
  git(seed, "init", "--initial-branch=main");
  configureIdentity(seed);
  git(seed, "remote", "add", "origin", bare);

  const mainFirst = commitFile(seed, "main.txt", "first\n", "main first");
  git(seed, "push", "--set-upstream", "origin", "main");
  const mainHead = commitFile(seed, "main.txt", "second\n", "main second");
  git(seed, "push", "origin", "main");
  git(root, "clone", bare, checkout);

  mkdirSync(unrelated);
  git(unrelated, "init", "--initial-branch=main");
  configureIdentity(unrelated);
  const outsideCommit = commitFile(
    unrelated,
    "outside.txt",
    "unrelated history\n",
    "unrelated commit",
  );
  git(unrelated, "remote", "add", "origin", bare);
  git(unrelated, "push", "origin", "HEAD:refs/heads/outside");
  git(checkout, "fetch", "origin", "refs/heads/outside:refs/remotes/origin/outside");

  function publishTag(name, commit, annotated = false) {
    if (annotated) {
      git(seed, "tag", "--force", "--annotate", "--message", `tag ${name}`, name, commit);
    } else {
      git(seed, "tag", "--force", name, commit);
    }
    git(seed, "push", "origin", `+refs/tags/${name}:refs/tags/${name}`);
    return git(seed, "rev-parse", `refs/tags/${name}`);
  }

  function deleteRemoteTag(name) {
    git(seed, "push", "origin", `:refs/tags/${name}`);
    git(seed, "tag", "--delete", name);
  }

  return {
    root,
    bare,
    seed,
    checkout,
    mainFirst,
    mainHead,
    outsideCommit,
    publishTag,
    deleteRemoteTag,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function readGitHubOutput(pathname) {
  let contents = "";
  try {
    contents = readFileSync(pathname, "utf8");
  } catch {
    return {};
  }
  const lines = contents.split(/\r?\n/).filter(Boolean);
  return Object.fromEntries(
    lines.map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
}
