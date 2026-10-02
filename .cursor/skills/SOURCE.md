# Provenance

Upstream: `https://github.com/JonathanHarris15/claude-config` `skills/` tree.

**Initial Groundwork overlay** copied from `https://github.com/JonathanHarris15/mosaic-website` `main` (`.cursor/skills/`, rules, install pattern), then adapted for Groundwork paths, account server smoke on port **8787**, and generic Jira examples (no Mosaic board defaults).

Cursor Cloud adaptations (from claude-config + mosaic):

- [plan-ticket/JIRA.md](plan-ticket/JIRA.md) and [plan-ticket/SKILL.md](plan-ticket/SKILL.md) load Jira via **Atlassian MCP** on Cursor Cloud Agents, not Claude `ToolSearch` or `~/.claude`.
- [plan-ticket/SKILL.md](plan-ticket/SKILL.md) and [create-epic/SKILL.md](create-epic/SKILL.md) carry the operator note: Cursor Agents run them; Grok Bot answers routine questions for Jonathan and escalates only crucial decisions when that workflow applies.
- `implement`, `to-prd`, and `to-issues` point at that same JIRA.md / Atlassian MCP connector.

Groundwork-specific:

- [jev-smoke-test/SKILL.md](jev-smoke-test/SKILL.md) — `npm run account`, `http://127.0.0.1:8787`, not Firebase Hosting emulators.
- [../rules/smoke-test.mdc](../rules/smoke-test.mdc), [../rules/ui-prototype-first.mdc](../rules/ui-prototype-first.mdc) — `packages/site/public/`, `docs/design/prototypes/`.

## Vendored skills (not from claude-config)

| Skill | Upstream | License | Pin |
| --- | --- | --- | --- |
| [frontend-design](frontend-design/SOURCE.md) | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Apache-2.0 | `33375500bcea98d610eb30ce10ac4e59b89c390d` |
| [web-interface-guidelines](web-interface-guidelines/SOURCE.md) | [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) | MIT | `e3d624baaf29dc1fc645aff3e38f03e564d2d6b1` |
