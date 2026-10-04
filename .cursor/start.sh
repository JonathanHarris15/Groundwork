#!/usr/bin/env bash
# Per-boot account server for local plugin and website smoke tests.
# Uses the smoke account created by install-obsidian.sh when that file exists.
set -euo pipefail

cd "$(dirname "$0")/.."

smoke_accounts="${HOME}/.config/groundwork-smoke/accounts.json"
if [[ -f "$smoke_accounts" ]]; then
	export GROUNDWORK_DATA_FILE="$smoke_accounts"
fi

if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8787/; then
	echo "Account server already listening on 8787"
	exit 0
fi

exec npm run account
