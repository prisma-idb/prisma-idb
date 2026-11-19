// PreToolUse hook: blocks hand edits to generated files and the lockfile.
// Exit code 2 rejects the tool call and shows stderr to Claude.
import { relative, resolve } from "node:path";
import { text } from "node:stream/consumers";

const input = JSON.parse(await text(process.stdin));
const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

// Resolve against the session's cwd, then express the path from the project root. Relative to a subdirectory cwd,
// a protected ancestor such as src/lib/prisma-idb would drop out of the path and the edit would slip through.
const cwd = input.cwd ?? process.cwd();
const path = relative(process.env.CLAUDE_PROJECT_DIR ?? cwd, resolve(cwd, filePath))
  .split("\\")
  .join("/");

const protectedPaths = [
  { pattern: /(^|\/)pnpm-lock\.yaml$/, fix: "Change package.json and run `pnpm install`." },
  {
    pattern: /(^|\/)src\/lib\/prisma-idb\//,
    fix: "This is a generated legacy client. Change packages/generator/src/fileCreators and run `pnpm generate`.",
  },
  {
    pattern: /(^|\/)contract\.(json|d\.ts)$/,
    fix: "This is an emitted contract. Change the schema and re-emit the contract.",
  },
  {
    pattern: /(^|\/)migrations[^/]*\/snapshots\//,
    fix: "Migration snapshots are written by the CLI. Re-plan the migration instead.",
  },
];

const hit = protectedPaths.find(({ pattern }) => pattern.test(path));
if (hit) {
  console.error(`${path} is generated; don't edit it by hand. ${hit.fix}`);
  process.exit(2);
}
