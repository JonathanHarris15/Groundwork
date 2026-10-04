#!/usr/bin/env bash
# Open the Groundwork smoke vault in Obsidian on this machine's desktop.
set -euo pipefail

VAULT="${GROUNDWORK_SMOKE_VAULT:-$HOME/GroundworkSmoke}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACCOUNT_ENV="${HOME}/.config/groundwork-smoke/account.env"

if ! command -v obsidian >/dev/null 2>&1; then
	echo "Obsidian is not installed. Run bash .cursor/install-obsidian.sh" >&2
	exit 1
fi

if [[ -f "$ROOT/packages/cli/dist/groundwork.js" && -f "$ROOT/packages/obsidian-plugin/dist/main.js" ]]; then
	node "$ROOT/packages/cli/dist/groundwork.js" install-plugin --vault "$VAULT"
fi

# Refresh the plugin bundle inside the already-running app by launching again.
# Electron needs --no-sandbox in this container.
export ELECTRON_DISABLE_SANDBOX=1
export GROUNDWORK_API_URL="${GROUNDWORK_API_URL:-http://127.0.0.1:8787}"

if [[ -f "$ACCOUNT_ENV" ]]; then
	# shellcheck disable=SC1090
	set -a
	source "$ACCOUNT_ENV"
	set +a
fi

exec obsidian --no-sandbox --disable-gpu "$VAULT"
