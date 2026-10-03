#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for Groundwork (npm workspaces).
# Converge from package-lock.json; safe to re-run on a warm disk.
set -euo pipefail

cd "$(dirname "$0")/.."

npm ci --no-audit --no-fund
npm run build:all

# Optional: fastbrowse for jev-smoke-test skill (non-fatal; see .cursor/skills/jev-smoke-test/)
export PATH="${HOME}/.local/bin:${PATH:-}"
if command -v uv >/dev/null 2>&1 || pip install --user -q uv 2>/dev/null; then
  uv tool install -q fastbrowse 2>/dev/null || echo "fastbrowse install skipped"
fi
