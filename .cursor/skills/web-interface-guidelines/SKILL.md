---
name: web-interface-guidelines
description: Offline UI review pass using Vercel's Web Interface Guidelines. Use after building or changing HTML/UI to catch accessibility, focus, forms, motion, and interaction issues before merge.
---

# Web Interface Guidelines (Groundwork)

Run a **read-only review** of the files you changed (prototype HTML, `packages/site/public/` pages, or UI components) against the rules in [command.md](command.md). Do not use the unlicensed `vercel-labs/agent-skills` wrapper; this repo vendors only the MIT-licensed `command.md` and [LICENSE](LICENSE).

## When to run

- After a standalone HTML prototype under `docs/design/prototypes/` (required by `.cursor/rules/ui-prototype-first.mdc`).
- Before marking a UI PR ready, alongside the `frontend-design` critique pass when the change is user-visible.

## How to run

1. Read [command.md](command.md) (rules and output format).
2. Substitute the prototype path or file list for `$ARGUMENTS` in the command template.
3. Check each rule against the markup and styles you wrote.
4. Output findings in the concise format shown at the bottom of `command.md` (issue + location; skip preamble).

Fix blocking accessibility and focus issues before asking for review. Note intentional Groundwork exceptions (e.g. existing site patterns you are matching) in the PR if needed.
