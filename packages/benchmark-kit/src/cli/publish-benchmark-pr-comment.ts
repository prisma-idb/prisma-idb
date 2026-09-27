import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getStringArg, parseArgs } from "./cli-args";

const MARKER = "<!-- benchmark-regression-report -->";

interface PullRequestEventPayload {
  pull_request?: { number?: number };
}

interface IssueComment {
  id: number;
  body: string | null;
}

async function githubRequest(path: string, token: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "prisma-idb-benchmark-bot",
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}): ${await response.text()}`);
  }

  return response;
}

function getNextPagePath(linkHeader: string): string | null {
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  if (!match) return null;
  try {
    const parsed = new URL(match[1]);
    return parsed.hostname === "api.github.com" ? `${parsed.pathname}${parsed.search}` : null;
  } catch {
    return null;
  }
}

async function fetchAllComments(
  owner: string,
  repo: string,
  pullRequestNumber: number,
  token: string
): Promise<IssueComment[]> {
  const all: IssueComment[] = [];
  let path: string | null = `/repos/${owner}/${repo}/issues/${pullRequestNumber}/comments?per_page=100`;

  while (path !== null) {
    const response = await githubRequest(path, token);
    all.push(...((await response.json()) as IssueComment[]));
    path = getNextPagePath(response.headers.get("Link") ?? "");
  }

  return all;
}

async function main() {
  const args = parseArgs(process.argv);
  const bodyFile = getStringArg(args, "body-file");
  if (!bodyFile) {
    throw new Error("Usage: publish-benchmark-pr-comment.ts --body-file <path> [--marker <token>]");
  }

  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!token || !repository || !eventPath) {
    process.stdout.write("Skipping PR comment publish: missing GitHub Actions environment variables.\n");
    return;
  }

  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  }

  const event = JSON.parse(await readFile(eventPath, "utf8")) as PullRequestEventPayload;
  const pullRequestNumber = event.pull_request?.number;

  if (!pullRequestNumber) {
    process.stdout.write("Skipping PR comment publish: not a pull_request event.\n");
    return;
  }

  // Use `||` (not `??`) so an explicit empty `--marker=""` falls back to MARKER
  // instead of letting `body.includes("")` match every PR comment.
  const marker = getStringArg(args, "marker") || MARKER;
  const bodyContent = await readFile(resolve(process.cwd(), bodyFile), "utf8");
  const commentBody = `${marker}\n${bodyContent}`;

  const comments = await fetchAllComments(owner, repo, pullRequestNumber, token);
  const existing = comments.find((comment) => typeof comment.body === "string" && comment.body.includes(marker));

  const jsonHeaders = { "Content-Type": "application/json" };
  const jsonBody = JSON.stringify({ body: commentBody });

  if (existing) {
    await githubRequest(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, token, {
      method: "PATCH",
      headers: jsonHeaders,
      body: jsonBody,
    });
    process.stdout.write(`Updated benchmark PR comment ${existing.id}.\n`);
    return;
  }

  await githubRequest(`/repos/${owner}/${repo}/issues/${pullRequestNumber}/comments`, token, {
    method: "POST",
    headers: jsonHeaders,
    body: jsonBody,
  });

  process.stdout.write("Created benchmark PR comment.\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
