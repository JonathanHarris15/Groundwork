#!/usr/bin/env bash
# Publish the current repo to live Groundwork.
# Cloud Run service "groundwork" (the API) and Firebase Hosting (the website).
# Run from any working directory. Do not pass environment variables to Cloud Run:
# the Stripe keys and the other server secrets are already on the service.

set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT=groundwork-6f9ca
REGION=us-central1
SERVICE=groundwork
DEPLOY_AS=926716096050-compute@developer.gserviceaccount.com

if [[ -z "${GCP_SERVICE_ACCOUNT_JSON:-}" ]]; then
	echo "GCP_SERVICE_ACCOUNT_JSON is not set, so deploy cannot sign in." >&2
	exit 1
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
sa="$tmpdir/source.json"
imp="$tmpdir/impersonated.json"

python3 - "$sa" "$imp" "$DEPLOY_AS" << 'PY'
import json, os, sys
sa_path, imp_path, target = sys.argv[1:]
src = json.loads(os.environ["GCP_SERVICE_ACCOUNT_JSON"])
with open(sa_path, "w") as f:
    json.dump(src, f)
os.chmod(sa_path, 0o600)
impersonated = {
    "type": "impersonated_service_account",
    "service_account_impersonation_url": f"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{target}:generateAccessToken",
    "delegates": [],
    "source_credentials": src,
}
with open(imp_path, "w") as f:
    json.dump(impersonated, f)
os.chmod(imp_path, 0o600)
PY

if ! command -v gcloud >/dev/null 2>&1; then
	if [[ ! -x "$HOME/google-cloud-sdk/bin/gcloud" ]]; then
		curl -fsSL -o "$tmpdir/gcloud.tar.gz" https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz
		tar -xzf "$tmpdir/gcloud.tar.gz" -C "$HOME"
		"$HOME/google-cloud-sdk/install.sh" --quiet --path-update false --usage-reporting false
	fi
	export PATH="$HOME/google-cloud-sdk/bin:$PATH"
fi

gcloud auth activate-service-account --key-file="$sa" --quiet
gcloud config set auth/impersonate_service_account "$DEPLOY_AS" --quiet
gcloud config set project "$PROJECT" --quiet

gcloud run deploy "$SERVICE" --source . --region "$REGION" --project "$PROJECT" --quiet

GOOGLE_APPLICATION_CREDENTIALS="$imp" npx -y firebase-tools@14 deploy --only hosting --project "$PROJECT" --non-interactive

health=$(curl -fsS https://groundworklearn.com/health)
printf '%s\n' "$health"
python3 -c 'import json,sys; body=json.loads(sys.argv[1]); assert body.get("ok") is True and body.get("billing") is True, body' "$health"
echo "Deployed. https://groundworklearn.com is live and billing is on."
