// PostToolUse hook: formats a file Claude just wrote or edited with the repo's Prettier config.
// Files that Prettier ignores or can't parse are left alone.
import { spawnSync } from "node:child_process";
import { text } from "node:stream/consumers";

const input = JSON.parse(await text(process.stdin));
const filePath = input.tool_input?.file_path;
if (!filePath || /(^|\/)(vendor|node_modules)\//.test(filePath)) process.exit(0);

spawnSync("pnpm", ["exec", "prettier", "--write", "--ignore-unknown", "--log-level", "silent", filePath], {
  cwd: process.env.CLAUDE_PROJECT_DIR ?? input.cwd,
  stdio: "ignore",
});
