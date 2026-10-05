# Groundwork

## Public copy

Never state how many dollars of model credit a plan includes, or how many dollars of that credit are left. Not in the README, the website, the Obsidian plugin, plan summaries, error text, or any API response a client receives.

The prices that may be shown are **$9 per month** (Bring your own model) and **$20 per month** (Groundwork). The Free plan can be described as Groundwork's smaller model.

`hostedCreditUsd` stays in server code. `publicPlan` and `presentAccount` are what clients may see. The website may show the share of the month's budget already used, as a percentage, without a dollar amount.

## Deploy

When the user asks to deploy, run `scripts/deploy.sh` and wait for it to finish. That publishes this repo to the live site. Do not use a different command, and do not set or replace Cloud Run environment variables.

On Cloud Run, Firestore uses the runtime service account. The Firebase key in `FIREBASE_SERVICE_ACCOUNT_JSON` verifies sign-in and is not allowed to read the database. Do not point Firestore back at that key.

## Agent skills

Skills live in `.cursor/skills/`: the [mattpocock/skills](https://github.com/mattpocock/skills) engineering and productivity packs, plus Groundwork's own. Not sure which one fits? Start with `ask-matt`. See `.cursor/skills/README.md`.

### Issue tracker

GitHub Issues on JonathanHarris15/Groundwork, through `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
