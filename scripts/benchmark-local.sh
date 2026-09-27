#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run the Benchmark Regression workflow locally via `act`.
#
# Prerequisites:
#   • act    – https://github.com/nektos/act  (brew install act)
#   • Docker – running and accessible from the shell
#
# Usage:
#   pnpm benchmark:local              # compare HEAD against main
#   pnpm benchmark:local develop      # compare HEAD against develop
#   pnpm benchmark:local main -- -v   # pass extra flags to act
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Pre-flight checks ──────────────────────────────────────────────────────
if ! command -v act &>/dev/null; then
  echo "Error: 'act' is not installed. Install it with: brew install act" >&2
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "Error: Docker is not running." >&2
  exit 1
fi

# ── Parse arguments ────────────────────────────────────────────────────────
BASE_BRANCH="main"
ACT_EXTRA_ARGS=()
SEEN_SEPARATOR=false

for arg in "$@"; do
  if [[ "$SEEN_SEPARATOR" == true ]]; then
    ACT_EXTRA_ARGS+=("$arg")
  elif [[ "$arg" == "--" ]]; then
    SEEN_SEPARATOR=true
  else
    BASE_BRANCH="$arg"
  fi
done

# ── Resolve SHAs ──────────────────────────────────────────────────────────
BASE_SHA="$(git merge-base HEAD "$BASE_BRANCH")"
HEAD_SHA="$(git rev-parse HEAD)"
BRANCH="$(git branch --show-current 2>/dev/null || true)"
BRANCH="${BRANCH:-HEAD}"

echo ""
echo "╭──────────────────────────────────────────────╮"
echo "│  Local Benchmark Comparison via act          │"
echo "╰──────────────────────────────────────────────╯"
echo ""
echo "  Current : $BRANCH ($HEAD_SHA)"
echo "  Base    : $BASE_BRANCH ($BASE_SHA)"
echo ""

# ── Build event payload ───────────────────────────────────────────────────
# Set head.repo.full_name to a dummy value so it won't match
# github.repository — this skips the "Publish benchmark PR comment" step
# which needs a real GITHUB_TOKEN.
EVENT_FILE="$(mktemp)"
trap 'rm -f "$EVENT_FILE"' EXIT

BASE_SHA="$BASE_SHA" \
  BASE_BRANCH="$BASE_BRANCH" \
  HEAD_SHA="$HEAD_SHA" \
  BRANCH="$BRANCH" \
  node <<'NODE' > "$EVENT_FILE"
const payload = {
  pull_request: {
    number: 0,
    base: { sha: process.env.BASE_SHA, ref: process.env.BASE_BRANCH },
    head: {
      sha: process.env.HEAD_SHA,
      ref: process.env.BRANCH,
      repo: { full_name: "local/benchmark" },
    },
  },
};
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
NODE

# ── Kill any stale server on the benchmark ports ─────────────────────────────
# act uses --network host, so host-side processes on the suites' ports
# (4175: generator, 4176: prisma-orm) collide with the container's Playwright
# webServer.
for BENCHMARK_PORT in 4175 4176; do
  PORT_PIDS="$(lsof -ti:"$BENCHMARK_PORT" 2>/dev/null || true)"
  if [[ -n "$PORT_PIDS" ]]; then
    echo "Terminating stale process on port ${BENCHMARK_PORT}..."
    printf '%s\n' "$PORT_PIDS" | xargs kill 2>/dev/null || true
    sleep 1
    if lsof -ti:"$BENCHMARK_PORT" &>/dev/null; then
      echo "Error: port ${BENCHMARK_PORT} is still in use after SIGTERM. Free it manually and retry." >&2
      exit 1
    fi
  fi
done

# ── Persistent caches ────────────────────────────────────────────────────────
# Mount host directories into the container so Playwright browsers and the pnpm
# content-addressable store survive across runs.  This cuts ~60-90 s off repeat
# runs (Playwright re-download) and speeds up pnpm install for the base commit.
CACHE_DIR="$ROOT/.cache/benchmark-act"
PLAYWRIGHT_CACHE="$CACHE_DIR/playwright"
PNPM_STORE="$CACHE_DIR/pnpm-store"
mkdir -p "$PLAYWRIGHT_CACHE" "$PNPM_STORE"

# ── Run act ───────────────────────────────────────────────────────────────
echo "Starting act…  (first run pulls the Docker image)"
echo ""

act pull_request \
  -W .github/workflows/benchmark.yml \
  -e "$EVENT_FILE" \
  --env CI=true \
  --rm \
  --artifact-server-path "$CACHE_DIR/artifacts" \
  --container-options "-v $PLAYWRIGHT_CACHE:/root/.cache/ms-playwright -v $PNPM_STORE:/root/.local/share/pnpm/store" \
  "${ACT_EXTRA_ARGS[@]+"${ACT_EXTRA_ARGS[@]}"}"

echo ""
echo "Done. Benchmark artifacts are in $CACHE_DIR/artifacts"
