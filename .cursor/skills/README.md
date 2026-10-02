# Cursor Cloud skills (Groundwork)

Upstream `skills/` from [JonathanHarris15/claude-config](https://github.com/JonathanHarris15/claude-config), overlaid at `.cursor/skills/<skill-name>/`. See [SOURCE.md](SOURCE.md).

Ported from [mosaic-website](https://github.com/JonathanHarris15/mosaic-website) with Groundwork-specific smoke and design rules. Jira calls use **Atlassian MCP** on Cursor Cloud Agents when a project defines a `<!-- jira-config -->` block in `CLAUDE.md` (Groundwork may not have one yet — discover the project key via Atlassian MCP; do not assume Mosaic `MS-*` or `METH-*` keys).

## Skills ported

| Skill | Role |
| --- | --- |
| `plan-ticket` | Front door: To Plan → PRD + sub-tasks → To Do / On Deck |
| `create-epic` | Epic (never a board card) + sibling level-0 tickets |
| `to-prd` | Write the PRD onto the ticket description |
| `to-issues` | Slice a specced ticket into AFK/HITL sub-tasks |
| `implement` | Build a ticket that has a PRD; drive the board |
| `grill-with-docs` | Grill against CONTEXT.md, ADRs, and the code |
| `grilling` | Interview in rounds |
| `prototype` | Light specimen (logic / UI) |
| `research` | Factual unknowns |
| `diagnose` | Reproduce a bug first |
| `review` | Code / spec / domain review |
| `retro` | Look back |
| `tdd` | Red-green-refactor |
| `domain-modeling` | CONTEXT.md and ADRs |
| `codebase-design` | Module / seam vocabulary |
| `improve-codebase-architecture` | Architecture pass |
| `design-sync` | Design system ↔ code |
| `design-pull` | Pull design into code |
| `design-push` | Push code into design |
| `design-prototype` | Design-system specimen |
| `wait-what` | Clarify a surprise |
| `wizard` | Guided script |
| `writing-for-agents` | Writing style |
| `sync-config` | Sync the claude-config git remote |
| `jev-smoke-test` | Required pre-PR UI smoke via local fastbrowse + Jev (account server on :8787) |
| `frontend-design` | Layout, hierarchy, copy, critique (Groundwork site voice) |
| `web-interface-guidelines` | Vercel guidelines review pass (offline `command.md`) |

Always-applied rules:

- [smoke-test](../rules/smoke-test.mdc) — jev/fastbrowse before PR for user-visible UI.
- [ui-prototype-first](../rules/ui-prototype-first.mdc) — standalone HTML prototypes in `docs/design/prototypes/` before new look/layout work.

Grok Bot’s skill library is out of scope.
