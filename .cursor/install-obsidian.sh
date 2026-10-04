#!/usr/bin/env bash
# Idempotent Obsidian desktop install plus a Groundwork smoke vault.
# Safe to re-run. The vault and local account live under $HOME so a
# /workspace checkout does not wipe them.
set -euo pipefail

OBSIDIAN_VERSION="1.13.7"
DEB_URL="https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/obsidian_${OBSIDIAN_VERSION}_amd64.deb"
VAULT="${GROUNDWORK_SMOKE_VAULT:-$HOME/GroundworkSmoke}"
SMOKE_DIR="${HOME}/.config/groundwork-smoke"
ACCOUNT_FILE="${SMOKE_DIR}/accounts.json"
ACCOUNT_ENV="${SMOKE_DIR}/account.env"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! dpkg-query -W -f '${Version}' obsidian 2>/dev/null | grep -qx "${OBSIDIAN_VERSION}"; then
	tmp="$(mktemp --suffix=.deb)"
	curl -fsSL -o "$tmp" "$DEB_URL"
	sudo apt-get update
	sudo apt-get install -y "$tmp"
	rm -f "$tmp"
fi

mkdir -p "$VAULT" "$SMOKE_DIR"
if [[ ! -f "$VAULT/Welcome.md" ]]; then
	printf '%s\n' "# Groundwork smoke vault" "" "Fictional notes for clicking through the plugin. Not a learner vault." > "$VAULT/Welcome.md"
fi

plugin_dist="$ROOT/packages/obsidian-plugin/dist"
if [[ -f "$plugin_dist/main.js" ]]; then
	dest="$VAULT/.obsidian/plugins/groundwork"
	mkdir -p "$dest"
	cp "$plugin_dist/main.js" "$plugin_dist/manifest.json" "$plugin_dist/styles.css" "$dest/"
	VAULT_PATH="$VAULT" python3 - << 'PY'
import json, os
from pathlib import Path
vault = Path(os.environ["VAULT_PATH"])
p = vault / ".obsidian" / "community-plugins.json"
enabled = []
if p.exists():
    enabled = json.loads(p.read_text() or "[]")
if "groundwork" not in enabled:
    enabled.append("groundwork")
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(enabled, indent=2) + "\n")
PY
fi

VAULT_PATH="$VAULT" python3 - << 'PY'
import json, os, time
from pathlib import Path
vault = str(Path(os.environ["VAULT_PATH"]).resolve())
cfg_dir = Path.home() / ".config" / "obsidian"
cfg_dir.mkdir(parents=True, exist_ok=True)
cfg_path = cfg_dir / "obsidian.json"
cfg = {}
if cfg_path.exists():
    try:
        cfg = json.loads(cfg_path.read_text() or "{}")
    except json.JSONDecodeError:
        cfg = {}
vaults = cfg.setdefault("vaults", {})
for entry in vaults.values():
    if str(Path(entry.get("path", "")).resolve()) == vault:
        entry["open"] = True
        entry["ts"] = int(time.time() * 1000)
        break
else:
    vaults["groundworksmoke"] = {"path": vault, "ts": int(time.time() * 1000), "open": True}
cfg_path.write_text(json.dumps(cfg))
PY

# Local free account for the account server. Not a production login.
if [[ ! -f "$ACCOUNT_ENV" ]]; then
	if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8787/; then
		echo "Account server is already on port 8787; stop it before creating the smoke account." >&2
		exit 1
	fi
	export GROUNDWORK_DATA_FILE="$ACCOUNT_FILE"
	export GROUNDWORK_SITE_DIR="$ROOT/packages/site/public"
	node "$ROOT/packages/account-server/dist/server.js" >/tmp/groundwork-smoke-account.log 2>&1 &
	server_pid=$!
	cleanup() { kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; }
	trap cleanup EXIT
	ready=0
	for _ in $(seq 1 50); do
		if curl -sf -o /dev/null http://127.0.0.1:8787/; then
			ready=1
			break
		fi
		sleep 0.2
	done
	if [[ "$ready" != 1 ]]; then
		echo "Account server did not start. See /tmp/groundwork-smoke-account.log" >&2
		exit 1
	fi
	email="smoke@groundwork.test"
	password="$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"
	body="$(E="$email" P="$password" python3 -c 'import json,os; print(json.dumps({"email":os.environ["E"],"password":os.environ["P"],"displayName":"Smoke"}))')"
	resp="$(curl -sf -X POST http://127.0.0.1:8787/api/register -H 'content-type: application/json' -d "$body")"
	umask 077
	ENV_PATH="$ACCOUNT_ENV" EMAIL="$email" PASSWORD="$password" RESP="$resp" python3 - << 'PY'
import json, os
user = json.loads(os.environ["RESP"])
lines = [
    f"GROUNDWORK_SMOKE_EMAIL={os.environ['EMAIL']}",
    f"GROUNDWORK_SMOKE_PASSWORD={os.environ['PASSWORD']}",
    f"GROUNDWORK_SMOKE_TOKEN={user['token']}",
    f"GROUNDWORK_SMOKE_HANDLE={user['user']['handle']}",
]
path = os.environ["ENV_PATH"]
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    f.write("\n".join(lines) + "\n")
os.chmod(path, 0o600)
PY
	trap - EXIT
	cleanup
fi

echo "Obsidian $(dpkg-query -W -f '${Version}' obsidian) ready. Vault: $VAULT"
