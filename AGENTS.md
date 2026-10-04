# Groundwork

## Public copy

Never state how many dollars of model credit a plan includes, or how many dollars of that credit are left. Not in the README, the website, the Obsidian plugin, plan summaries, error text, or any API response a client receives.

The prices that may be shown are **$9 per month** (Bring your own model) and **$20 per month** (Groundwork). The Free plan can be described as Groundwork's smaller model.

`hostedCreditUsd` stays in server code. `publicPlan` and `presentAccount` are what clients may see. The website may show the share of the month's budget already used, as a percentage, without a dollar amount.

## Cursor Cloud specific instructions

Obsidian is installed for plugin smoke tests. The vault is `~/GroundworkSmoke`. A local free account (not production) is created by `.cursor/install-obsidian.sh`; email, password, and token are in `~/.config/groundwork-smoke/account.env`. The account server reads `~/.config/groundwork-smoke/accounts.json` when `.cursor/start.sh` runs.

Click through the plugin on this machine's desktop:

1. Confirm `http://127.0.0.1:8787` answers. If it does not, run `bash .cursor/start.sh`.
2. Run `bash .cursor/launch-obsidian.sh`.
3. If Obsidian asks, trust the vault and turn restricted mode off. The Groundwork pane opens on the right.
4. Click through Learn, Concept map, Goals, the composer, library, and settings. A blank pane or a missing tab is a failed smoke test.
5. Sign in on the website at `http://127.0.0.1:8787/join` with the smoke account. The hosted tutor is not this local server. In the plugin, "Try the demo" is the signed-in path that does not call production.
