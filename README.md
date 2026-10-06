# Groundwork

Groundwork is a tutor inside Obsidian. It maps the concepts you're learning, marks how well you know each one, and plans the next step toward a goal.

Install it from [Obsidian's community plugins](https://community.obsidian.md/plugins/groundwork). Sign in at [groundworklearn.com](https://groundworklearn.com). A free plan is included. Paid plans are optional.

## Install

You need [Obsidian](https://obsidian.md/download) on a desktop computer.

1. In Obsidian, open **Settings → Community plugins**. Turn community plugins on if they are off. Choose **Browse**, search for **Groundwork**, then **Install** and **Enable**. You can also install from the [community plugin page](https://community.obsidian.md/plugins/groundwork).
2. Sign in with Google at [groundworklearn.com](https://groundworklearn.com). That creates the account that holds your plan and your progress.
3. On your account page, choose **Open Obsidian**. That links the plugin on this computer. If Groundwork isn't installed yet, the site opens the community plugin page.

Groundwork does not run on a phone. You can sign up on your phone and install on your computer later.

## Plans

A free plan is included. Paid plans ($6 and $20 per month) unlock a model you already pay for, or models Groundwork runs.

- **Free** starts on Light, Groundwork's smaller model. You can switch to Heavy in the plugin. Tutor use has a monthly limit. Your account shows the share of that month you've used.
- **Bring your own model** is $6 per month. It uses the Claude subscription on your computer, or a key from OpenRouter, Anthropic, Google, xAI, or OpenAI. Model use on that subscription or key is billed by that provider. The $6 covers Groundwork.
- **Groundwork** is $20 per month. Groundwork runs the models, Light by default. Switch to Heavy in the plugin when you want the stronger tutor.

The study tools are the same on each plan. Paid plans are billed on the [Groundwork website](https://groundworklearn.com) through Stripe. You can change or cancel a paid plan from Manage billing on your account page.

## What you can do

- Set a goal with a due date. If you don't name a date, a new goal is due in 14 days. The plan starts from the foundations and works up.
- See a concept map. Each concept is marked solid, shaky, learning, rusty, or not started. The goal sits in red at the top.
- Take diagnostic quiz cards at levels 1 to 5. A careless slip isn't counted as a gap.
- Study a flashcard deck in one sitting. Again shows the card next, Hard brings it back later in that sitting, and Good or Easy sets it aside. Those ratings do not set the marks on the concept map.
- Drop in lecture slides, homework, a study guide, or a practice exam. Groundwork turns that into an exam goal.
- Chat with the tutor in Obsidian. Math renders in LaTeX. You can attach slides, PDFs, or images from folders you allow.

Progress stays on your account and syncs across computers. Your vault stays on your computer. The tutor reads only the vault folders you allow in settings.

## Payment, account, and network

A free plan is included. Paid plans ($6 and $20 per month) unlock Bring your own model, or Groundwork running the models. Paid plans are billed on the [Groundwork website](https://groundworklearn.com) through Stripe.

An account is required before the tutor will run. Sign in with Google on that website. Tutor memory — concept notes, goals, quiz evidence, chats, and the learner profile — is stored on the account.

The plugin uses the network for these services:

- **Groundwork** (`https://groundwork-6f9ca.web.app` in production builds) stores the account, tutor memory, plan routing, and grades written answers. Sign-in happens in the browser on the [Groundwork website](https://groundworklearn.com). **Open Obsidian** connects this device through Obsidian; if the plugin is not installed yet, the site opens the [community plugin page](https://community.obsidian.md/plugins/groundwork).
- **Google** (`https://securetoken.googleapis.com`) refreshes the website sign-in into an ID token the plugin sends to Groundwork.
- **Google Fonts** (`https://fonts.googleapis.com`) loads Jost for the Groundwork panel stylesheet.
- **Stripe** — billing for the $6 and $20 plans happens on the website, not inside the plugin.
- **Anthropic**, through Claude Code on this computer, runs the tutor when you use your own Claude subscription. Claude Code may reach Anthropic's API and related sign-in endpoints. On hosted Groundwork plans, model calls go through your account API instead. Bring-your-own-model keys saved on the account are used only on the Groundwork server (OpenRouter, Anthropic, Google, xAI, or OpenAI), not sent from the plugin.

The plugin does not send telemetry. It does use a few paths outside the vault on the desktop: the Claude Code executable to run the tutor (via `child_process` inside the bundled Agent SDK); `~/.config/groundwork/config.json` (vault path for the `groundwork` CLI); and the vault folder path as Claude Code's working directory. Device labels default to **Obsidian** until you set one in the panel. The separate `groundwork` CLI (not the plugin) can run `git` to sync the vault. It does not read other files outside the vault. The only notes it opens as extra context are in vault folders you pick in settings.

The plugin is desktop-only.

## Obsidian community plugin

The section above — payment, a required account, network services, and files outside the vault — is what the [Obsidian community plugin directory](https://docs.obsidian.md) asks this README to state. Groundwork is [MIT licensed](LICENSE).

The plugin is laid out so it can be submitted:

| Requirement | Where |
| --- | --- |
| `manifest.json` with `id`, `name`, `version`, `minAppVersion`, `description`, `author`, `authorUrl`, `isDesktopOnly` | repository root, identical to `packages/obsidian-plugin/manifest.json`. The community directory reads the root file. |
| `versions.json` at the repo root, mapping each version to its `minAppVersion` | `versions.json` |
| An open-source license | `LICENSE` |
| Release assets `main.js`, `manifest.json`, `styles.css` | a tag equal to the manifest `version` (`0.1.13`, no `v` prefix) runs `.github/workflows/release-plugin.yml` |

`node scripts/check-community-plugin.mjs` checks that list. The plugin id is `groundwork`, which is also the community install folder.

From the website, **Open Obsidian** opens Obsidian and connects this device. Manual install: [community plugin page](https://community.obsidian.md/plugins/groundwork).

The plugin is desktop-only because it bundles Node-based tooling (Claude Code / Agent SDK) and does not run on mobile Obsidian. Publishing the map is off until you sign in and turn it on. That request goes to the Groundwork account API (`https://groundwork-6f9ca.web.app` in production builds).

The Groundwork panel uses the website's dark look: Jost, and the red, amber, blue, and green status dots. Learn, Concept map, and Goals are three views of the same memory. A goal has a due date and a weight for each concept. The concept map is Groundwork's own map of that goal, not Obsidian's graph view. The rest of Obsidian keeps its theme.

The manifest, release checklist, and `node scripts/check-community-plugin.mjs` are described in [docs/development.md](docs/development.md).

## For developers

Clone, setup, the CLI, and how the repo is laid out: [docs/development.md](docs/development.md).
