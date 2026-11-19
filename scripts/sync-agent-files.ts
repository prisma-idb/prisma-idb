/**
 * Keeps the agent instruction files for other tools in sync with their canonical
 * Claude Code sources, and validates the sources.
 *
 * Canonical sources:
 *   CLAUDE.md                        project instructions
 *   .claude/rules/<name>.md          path-scoped rules
 *   .claude/skills/<name>/SKILL.md   skills
 *
 * Generated symlinks:
 *   AGENTS.md                                    -> CLAUDE.md
 *   .github/copilot-instructions.md              -> ../CLAUDE.md
 *   .cursor/rules/<name>.mdc                     -> ../../.claude/rules/<name>.md
 *   .github/instructions/<name>.instructions.md  -> ../../.claude/rules/<name>.md
 *   .agents/skills                               -> ../.claude/skills
 *
 * Usage: `tsx scripts/sync-agent-files.ts` writes the links; `--check` only reports.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const problems: string[] = [];

const rulesDir = join(root, ".claude/rules");
const skillsDir = join(root, ".claude/skills");
const managedRuleDirs = [
  { dir: ".cursor/rules", name: (rule: string) => `${rule}.mdc` },
  { dir: ".github/instructions", name: (rule: string) => `${rule}.instructions.md` },
];

const rules = readdirSync(rulesDir)
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.slice(0, -".md".length));

// Each entry maps a link path to its target, both relative to the repository root.
const links = new Map<string, string>([
  ["AGENTS.md", "CLAUDE.md"],
  [".github/copilot-instructions.md", "CLAUDE.md"],
  [".agents/skills", ".claude/skills"],
]);
for (const rule of rules) {
  for (const { dir, name } of managedRuleDirs) {
    links.set(join(dir, name(rule)), join(".claude/rules", `${rule}.md`));
  }
}

/**
 * With `core.symlinks=false` (the default on Windows without Developer Mode), Git checks each link out as a plain
 * file holding its target path. The links can't be checked or created there, so only the sources are validated.
 */
function checkoutSupportsSymlinks(): boolean {
  try {
    return (
      execFileSync("git", ["config", "--get", "core.symlinks"], { cwd: root, encoding: "utf8" }).trim() !== "false"
    );
  } catch {
    // Unset means Git's default, which is true everywhere except where Git detects no symlink support.
    return true;
  }
}
const syncLinks = checkoutSupportsSymlinks();
if (!syncLinks) {
  console.warn(
    "Skipping agent file links: this checkout has core.symlinks=false. Enable symlinks to use AGENTS.md, Cursor and Copilot rules."
  );
}

function symlinkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

for (const [link, target] of syncLinks ? links : []) {
  const linkPath = join(root, link);
  const expected = relative(dirname(linkPath), join(root, target));
  const actual = symlinkTarget(linkPath);
  if (actual === expected) continue;

  // A real file or folder here may hold someone's work, so never replace it; only wrong links are repaired.
  if (actual === undefined && existsSync(linkPath)) {
    problems.push(`${link} is a regular file or folder, not a link to ${expected}. Move its contents, then rerun.`);
    continue;
  }
  if (check) {
    problems.push(`${link} should be a symlink to ${expected}${actual ? ` (points to ${actual})` : ""}`);
    continue;
  }
  if (actual !== undefined) rmSync(linkPath);
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(expected, linkPath);
  console.log(`linked ${link} -> ${expected}`);
}

// Remove links left behind by deleted or renamed rules.
for (const { dir } of syncLinks ? managedRuleDirs : []) {
  const dirPath = join(root, dir);
  if (!existsSync(dirPath)) continue;
  for (const entry of readdirSync(dirPath)) {
    const path = join(dir, entry);
    const target = symlinkTarget(join(root, path));
    if (target === undefined || links.has(path) || !target.includes(".claude/rules/")) continue;
    if (check) {
      problems.push(`${path} links to a rule that no longer exists`);
    } else {
      rmSync(join(root, path));
      console.log(`removed stale ${path}`);
    }
  }
}

function frontmatter(file: string): Map<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(readFileSync(file, "utf8"));
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2].replace(/^"(.*)"$/, "$1"));
  }
  return fields;
}

function globs(value: string | undefined): string {
  return (value ?? "")
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean)
    .join(",");
}

// Each rule carries the scope fields for every tool, and they must agree.
for (const rule of rules) {
  const file = `.claude/rules/${rule}.md`;
  const fields = frontmatter(join(root, file));
  if (!fields) {
    problems.push(`${file} has no frontmatter`);
    continue;
  }
  for (const key of ["description", "paths", "globs", "applyTo", "alwaysApply"]) {
    if (!fields.has(key)) problems.push(`${file} is missing \`${key}\``);
  }
  // Claude Code expands braces in `paths`; Cursor and Copilot need the patterns spelled out.
  if (globs(fields.get("globs")) !== globs(fields.get("applyTo"))) {
    problems.push(`${file}: \`globs\` and \`applyTo\` must list the same patterns`);
  }
}

for (const skill of readdirSync(skillsDir)) {
  const file = `.claude/skills/${skill}/SKILL.md`;
  if (!existsSync(join(root, file))) {
    problems.push(`${file} is missing`);
    continue;
  }
  const fields = frontmatter(join(root, file));
  if (fields?.get("name") !== skill) problems.push(`${file}: \`name\` must be "${skill}"`);
  if (!fields?.get("description")) problems.push(`${file} needs a \`description\``);
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  console.error(check ? "\nRun `pnpm agents:sync` to fix the links." : "");
  process.exit(1);
}
if (check) console.log("Agent files are in sync.");
