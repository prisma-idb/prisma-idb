// PreToolUse hook: blocks `gh pr create` until the branch has been through the change-reviewer subagent.
// Exit code 2 rejects the tool call and shows stderr to Claude.
//
// `node .claude/hooks/require-review.mjs --mark` records that HEAD was reviewed. Commits made after the review
// (fixing its findings) still pass if they only touch files the review saw, plus tests, docs and changesets.
// A new source file needs a new review.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { text } from "node:stream/consumers";

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|svelte)$/;
const GENERATED = /(^|\/)(src\/lib\/prisma-idb\/|contract\.d\.ts$|migrations[^/]*\/snapshots\/)/;
// One changed file in these places still needs a review: write paths, migrations and sync.
const RISKY = /^packages\/prisma-orm\/((client-idb|driver-idb|target-idb|sync-[^/]+)\/src|[^/]+\/migrations[^/]*)\//;
// Files that may change after a review without a new one.
const FOLLOW_UP_OK = /(\.(md|mdx)$|(^|\/)(test|tests)\/|\.(test|spec)\.[cm]?[jt]sx?$|^\.changeset\/)/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function changedFiles(cwd, from, to) {
  const out = git(cwd, "diff", "--name-only", `${from}...${to}`);
  return out ? out.split("\n") : [];
}

function mergeBase(cwd, base) {
  for (const ref of [`origin/${base}`, base]) {
    try {
      return git(cwd, "merge-base", ref, "HEAD");
    } catch {
      // Try the next spelling of the base branch.
    }
  }
  return undefined;
}

function isAncestor(cwd, commit, of) {
  try {
    git(cwd, "merge-base", "--is-ancestor", commit, of);
    return true;
  } catch {
    return false;
  }
}

const markerDir = (root) => join(root, ".cache/agent-logs");

if (process.argv.includes("--mark")) {
  const root = git(process.cwd(), "rev-parse", "--show-toplevel");
  const head = git(root, "rev-parse", "HEAD");
  mkdirSync(markerDir(root), { recursive: true });
  writeFileSync(join(markerDir(root), `reviewed-${head}`), `${new Date().toISOString()}\n`);
  console.log(`Recorded a review of ${head.slice(0, 12)}.`);
  process.exit(0);
}

const input = JSON.parse(await text(process.stdin));
const command = input.tool_input?.command ?? "";
if (!/(^|[;&|(]\s*|\s)gh\s+pr\s+create\b/.test(command)) process.exit(0);

// The checks below read HEAD before the command runs, so a commit made earlier in the same command would
// reach the PR unchecked.
if (/\bgit\b[^;&|\n]*\s(commit|merge|rebase|reset|checkout|switch|cherry-pick|revert|am|pull|stash)\b/.test(command)) {
  console.error(
    "Run `gh pr create` as its own command, after any command that changes HEAD, so the review check sees every commit."
  );
  process.exit(2);
}

const cwd = input.cwd ?? process.cwd();
let root, base, head;
try {
  root = git(cwd, "rev-parse", "--show-toplevel");
  head = git(root, "rev-parse", "HEAD");
  const baseName = /(?:--base|-B)[=\s]+["']?([\w./-]+)/.exec(command)?.[1] ?? "main";
  base = mergeBase(root, baseName);
} catch {
  // Not a Git checkout or Git is unavailable; nothing to check against.
  process.exit(0);
}
if (!base) process.exit(0);

const changed = changedFiles(root, base, head);
const source = changed.filter((file) => SOURCE.test(file) && !GENERATED.test(file));
if (source.length < 2 && !source.some((file) => RISKY.test(file))) process.exit(0);

// Accept the newest review of this branch whose later commits only touch files it already covered.
const dir = markerDir(root);
const reviewed = existsSync(dir)
  ? readdirSync(dir)
      .filter((name) => /^reviewed-[0-9a-f]{40}$/.test(name))
      .map((name) => name.slice("reviewed-".length))
      .filter((sha) => sha === head || (isAncestor(root, sha, head) && !isAncestor(root, sha, base)))
  : [];
for (const sha of reviewed) {
  if (sha === head) process.exit(0);
  const covered = new Set(changedFiles(root, base, sha));
  const later = changedFiles(root, sha, head).filter((file) => !covered.has(file) && !FOLLOW_UP_OK.test(file));
  if (later.length === 0) process.exit(0);
}

const why = reviewed.length
  ? "Commits since the last review touch source files that review didn't see."
  : `This branch changes ${source.length} source file(s) and has no recorded review.`;
console.error(
  [
    `Review the change before opening the PR. ${why}`,
    "1. Run the change-reviewer subagent on this branch.",
    "2. Fix the findings it confirms, and verify with the verify-change skill.",
    "3. Run `node .claude/hooks/require-review.mjs --mark`, then retry `gh pr create`.",
    "If the user says to skip the review, ask them to open the PR themselves with `! gh pr create ...`.",
  ].join("\n")
);
process.exit(2);
