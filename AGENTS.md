# Groundwork

## Public copy

Never state how many dollars of model credit a plan includes, or how many dollars of that credit are left. Not in the README, the website, the Obsidian plugin, plan summaries, error text, or any API response a client receives.

The prices that may be shown are **$9 per month** (Bring your own model) and **$20 per month** (Groundwork). The Free plan can be described as Groundwork's smaller model.

`hostedCreditUsd` stays in server code. `publicPlan` and `presentAccount` are what clients may see. The website may show the share of the month's budget already used, as a percentage, without a dollar amount.
