# Groundwork skills

Two kinds of skill live here:

- **Upstream**: the engineering and productivity packs from [mattpocock/skills](https://github.com/mattpocock/skills), copied as-is apart from three short Groundwork notes. Refresh them from upstream; don't fork them. The pin and the notes are in [SOURCE.md](SOURCE.md).
- **Groundwork keepers**: skills upstream has no counterpart for. They stay when upstream is refreshed.

Not sure which skill fits? Run `ask-matt`. Per-repo configuration (issue tracker, triage labels, domain docs) is in `AGENTS.md` under `## Agent skills` and in `docs/agents/`; re-run `setup-matt-pocock-skills` only to change it.

## Upstream: engineering

| Skill | Invoked by | Role |
| --- | --- | --- |
| `ask-matt` | user | Router: which skill or flow fits |
| `setup-matt-pocock-skills` | user | Configure tracker, labels, domain docs (done for Groundwork) |
| `grill-with-docs` | user | Grilling that updates `GLOSSARY.md` and ADRs as terms settle |
| `to-spec` | user | Turn the conversation into a spec on the issue tracker |
| `to-tickets` | user | Split a spec into tracer-bullet tickets with blocking edges |
| `triage` | user | Move incoming issues through the triage labels |
| `implement` | user | Build a spec or ticket: `tdd` at agreed seams, then `code-review` |
| `implement-spec` | user | Build a whole spec on one integration branch with parallel subagents |
| `wayfinder` | user | Map a project too big for one session as decision tickets |
| `improve-codebase-architecture` | user | Survey for deepening opportunities |
| `retro` | user | Improve the agent's environment after a session |
| `tdd` | model | Red-green loop, one vertical slice at a time |
| `diagnosing-bugs` | model | Feedback loop that goes red on this bug, then fix and regression test |
| `codebase-design` | model | Deep-module vocabulary: module, interface, seam, depth |
| `domain-modeling` | model | Sharpen `GLOSSARY.md` and record ADRs |
| `prototype` | model | Throwaway code that answers one question (Groundwork note: UI goes through `ui-prototype-first`) |
| `research` | model | Primary-source findings written to a Markdown file |
| `code-review` | model | Standards and Spec review of a diff, in parallel subagents |
| `pr` | model | PR body shape (Groundwork note: add the Smoke test section) |
| `wizard` | model | Bash wizard for steps only a human can do |

## Upstream: productivity

| Skill | Invoked by | Role |
| --- | --- | --- |
| `grill-me` | user | Grilling with no repo paper trail |
| `handoff` | user | Compact the conversation into a document another agent can pick up |
| `teach` | user | Teach a concept over several sessions |
| `to-questionnaire` | user | A questionnaire for the one person who can answer |
| `wait-what` | user | Re-pitch a message that didn't land |
| `grilling` | model | The interview primitive behind the grill skills |
| `writing-for-agents` | model | How to write skills and agent docs |

## Groundwork keepers

| Skill or rule | Why it stays |
| --- | --- |
| `jev-smoke-test` | Required pre-PR smoke of user-visible UI against the local website server on `:8787` |
| `frontend-design` | Layout, hierarchy and copy critique in the Groundwork site voice (vendored from anthropics/skills) |
| `web-interface-guidelines` | Offline Vercel interface-guidelines review pass (vendored from vercel-labs) |
| `design-prototype`, `design-push`, `design-pull`, `design-sync` | Claude Design round trip, from Jonathan's claude-config |
| `sync-config` | Syncs Jonathan's `~/.claude` config repo; not part of Groundwork's build flow |
| [`../rules/smoke-test.mdc`](../rules/smoke-test.mdc) | Always applied: when the jev smoke test is required, and the PR's Smoke test section |
| [`../rules/ui-prototype-first.mdc`](../rules/ui-prototype-first.mdc) | Always applied: restyles land on the real page; new features get an HTML prototype in `docs/design/prototypes/` |
| [`../rules/public-credit.mdc`](../rules/public-credit.mdc) | Always applied: no dollar amounts of model credit in anything a client sees |

The rules win over any upstream skill they overlap: a UI change still runs the jev smoke test before its PR, and a look-or-layout prototype follows `ui-prototype-first`, not `prototype/UI.md`.
