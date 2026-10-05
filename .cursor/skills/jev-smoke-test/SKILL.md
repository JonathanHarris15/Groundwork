---
name: jev-smoke-test
description: Required before PR for any user-visible UI change (groundworklearn.com pages, Obsidian plugin when visible). Run fastbrowse + local Jev against the local website server (default http://127.0.0.1:8787); repeat after the final fix commit. Skip only when keys or uv are absent (exact PR line) or the change has no UI effect. See .cursor/rules/smoke-test.mdc. Not packages/core tutor grading.
---

# Jev smoke test (fastbrowse)

[fastbrowse](https://github.com/agent-labs-dev/fastbrowse) (MIT, PyPI `fastbrowse`, v0.5.3+) drives a **local** headless browser with **Jev** for quick, read-only UI checks. **Required** for user-visible UI changes: run before opening or marking a PR ready, and again after the final fix commit (see `.cursor/rules/smoke-test.mdc`).

**Never** smoke-test production with a real login. Use the **local website server** (`http://127.0.0.1:8787`, see `.cursor/environment.json`) only.

**Do not confuse** with Groundwork's **tutor answer grading** in `packages/core` (also Jev-related). This skill is only the fastbrowse browser smoke workflow.

If this file is missing in your checkout, the environment snapshot is stale — run `git fetch origin main` and read `.cursor/skills/jev-smoke-test/SKILL.md` from `origin/main` before proceeding.

## Install

Python **3.13+** is pulled by `uv` when needed.

Install `uv` in this order (stop at the first method that yields a working `uv` on `PATH`):

1. Use an existing `uv` if `command -v uv` succeeds.
2. `pip install --user uv`
3. `pipx install uv`

After (2) or (3), ensure user-local tools are on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

If none of the above works, **skip** the smoke test, do not fail the task, and note in the PR body: `jev smoke test skipped: uv unavailable`.

Then install fastbrowse:

```bash
export PATH="$HOME/.local/bin:$PATH"
uv tool install fastbrowse==0.5.3
```

One-off without installing:

```bash
export PATH="$HOME/.local/bin:$PATH"
uvx fastbrowse --help
```

Chrome or Chromium must be on `PATH`, or set:

```bash
export FASTBROWSE_CHROME=/path/to/chromium
```

Cloud Agent bootstrap may install `fastbrowse` opportunistically via `.cursor/install.sh` (non-fatal). Agents can still install manually with the commands above.

## API keys (env only — never commit)

| Role | Variable | Notes |
| --- | --- | --- |
| Jev (browser agent) | `AI_GATEWAY_API_KEY` | Vercel AI Gateway |
| Jev (alternate) | `TYPESAFE_API_KEY` | [TypeSafe console](https://console.typesafe.ai) |
| Planner / reader LLM | `OPENROUTER_API_KEY` | Required for fastbrowse’s planner |

Set these in the **Cursor Cloud Agents environment** dashboard for this repo (not in git). Jonathan configures `OPENROUTER_API_KEY` and (`AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`) on the Groundwork environment.

### Optional: cheaper OpenRouter model (smoke runs)

fastbrowse **0.5.3** defaults (via OpenRouter): `google/gemini-3.8-flash` with `low` reasoning for RECOVER, READ, VERIFY, and COMPOSE; `google/gemini-3.5-flash-lite` for PLAN, FIELD_TEXT, and SHORTCUT. Override with `FASTBROWSE_LLM_MODEL` (all purposes) or per-purpose `FASTBROWSE_LLM_MODEL_RECOVER`, `_READ`, `_VERIFY`, `_COMPOSE`, `_PLAN`, `_FIELD_TEXT`, `_SHORTCUT`.

For Groundwork smoke tasks, **`openai/gpt-6-luna`** via `FASTBROWSE_LLM_MODEL` is a good default (accurate and relatively cheap on read-only page checks).

- Read keys from the environment only. **Never** put keys in git, skills, PRs, or shell history in commits.
- **Do not** use `BROWSER_USE_API_KEY` or any cloud browser integration.
- **Always** pass `--local` on every `fastbrowse` invocation.

## Skip when keys or tooling are absent

If `OPENROUTER_API_KEY` is unset, **or** neither `AI_GATEWAY_API_KEY` nor `TYPESAFE_API_KEY` is set:

1. **Skip** the smoke test entirely.
2. Do **not** fail the task and do **not** ask the user for keys.
3. In the PR body (test evidence section), add exactly:

   `jev smoke test skipped: key(s) absent`

If `uv` cannot be installed (see Install) or `fastbrowse` is not available after install attempts, skip and add:

`jev smoke test skipped: uv unavailable`

Shell guard (use before running fastbrowse):

```bash
export PATH="$HOME/.local/bin:$PATH"

jev_keys_ready() {
  [ -n "${OPENROUTER_API_KEY:-}" ] && { [ -n "${AI_GATEWAY_API_KEY:-}" ] || [ -n "${TYPESAFE_API_KEY:-}" ]; }
}

jev_tooling_ready() {
  command -v fastbrowse >/dev/null 2>&1 || command -v uv >/dev/null 2>&1
}

if ! jev_keys_ready; then
  echo "jev smoke test skipped: key(s) absent"
elif ! jev_tooling_ready; then
  echo "jev smoke test skipped: uv unavailable"
else
  # run fastbrowse (see below)
fi
```

## When to use (mandatory)

- Any change to the **website** under `packages/server/public/` (groundworklearn.com).
- Server routes that alter what users see at `http://127.0.0.1:8787`.
- Obsidian plugin UI when the change is user-visible (prefer manual Obsidian testing when fastbrowse cannot reach the plugin; document that in the PR).
- Bug fixes: repro path before the fix and after, when feasible.
- Write **1–3 targeted natural-language tasks** per changed screen (happy path + one edge case if useful). Do not run a single vague “check the app” task.

## Local website server

From the repo root (after `npm ci` and `npm run build` — see `.cursor/install.sh`):

```bash
npm run server
```

The server prints `Groundwork on http://127.0.0.1:8787`. It serves `packages/server/public/` (the groundworklearn.com site) plus account APIs. Do not set `PORT` for this local run: that binds a public address and the process exits until Firebase auth is configured. `GROUNDWORK_PORT` changes the port and stays on loopback.

Keep checks **read-only** on public pages (home, sign-in **form visible** without submitting real credentials).

| Path | Typical smoke focus |
| --- | --- |
| `/` | Hero: “Learn it from the ground up.” |
| `/#signin` | Sign-in UI loads |

Do **not** point smoke tests at production Firebase Hosting unless Jonathan explicitly provides a **read-only** preview URL with no login — default is always local `8787`.

## Running the smoke test

1. Start `npm run server` (or ensure it is already running on port **8787**).
2. Run headless, local, with a tight budget:

```bash
export PATH="$HOME/.local/bin:$PATH"
export FASTBROWSE_LLM_MODEL=openai/gpt-6-luna

fastbrowse "Confirm the Groundwork home page loads and the heading Learn it from the ground up is visible" \
  --start "http://127.0.0.1:8787/" \
  --local \
  --max-steps 15 \
  --max-dollars 0.10 \
  --json
```

Adjust `--start` for the route you changed (e.g. `http://127.0.0.1:8787/#signin`).

### Pass / fail

- **Pass:** exit code **0** and JSON `status` is **`complete`** only.
- **Fail:** any other terminal status, including `unverified`, `needs_confirmation`, `needs_login`, `blocked`, `stuck`, `budget_exceeded`, `error`, or non-zero exit code.

On failure, fix the UI or tighten the task; do not open the PR claiming the smoke passed.

### PR body evidence

When smoke runs, add to the PR **Smoke test** section:

- Command(s) run (omit secrets).
- Final `status` from JSON.
- **Quoted** excerpts from the result that cite what was seen on the page (headings, labels, visible copy).

When skipped, use the exact skip line from the sections above (`key(s) absent` or `uv unavailable`).

## Safety rules (mandatory)

- **Never** pass: `--authorize`, `--secret`, `--bitwarden`, `--profile`, `--cloud-profile`.
- **No** sign-in flows with real passwords, **no** form submits, **no** destructive actions.
- Read-only checks of the changed UI only (load page, confirm visible content / controls).
- Keep `--max-dollars` small (e.g. `0.10`).
- **Always** `--local`.

## Ports (Groundwork)

| Service | Port |
| --- | --- |
| Website (groundworklearn.com) | 8787 (`GROUNDWORK_PORT` overrides; stay on loopback) |

Other packages (`packages/server` for Cloud Run, Firebase emulators) are out of scope for the default jev smoke path unless a task explicitly requires them.
