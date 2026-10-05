# Provenance

## Upstream: mattpocock/skills

Pinned at [`4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d`](https://github.com/mattpocock/skills/tree/4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d) (`main`, 2026-10-05). MIT: [LICENSE-mattpocock-skills](LICENSE-mattpocock-skills).

Each folder is a copy of `skills/engineering/<name>/` or `skills/productivity/<name>/`, including `agents/openai.yaml`:

- engineering: `ask-matt`, `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-with-docs`, `implement`, `implement-spec`, `improve-codebase-architecture`, `pr`, `prototype`, `research`, `retro`, `setup-matt-pocock-skills`, `tdd`, `to-spec`, `to-tickets`, `triage`, `wayfinder`, `wizard`
- productivity: `grill-me`, `grilling`, `handoff`, `teach`, `to-questionnaire`, `wait-what`, `writing-for-agents`

Not taken: upstream `in-progress/` and `misc/` (Claude Code git guardrails, shoehorn migration, exercise scaffolding, pre-commit setup).

### Groundwork notes on upstream files

Each is one blockquote starting `> **Groundwork:**`, so a refresh can re-apply it by hand:

- `prototype/SKILL.md`, under "Pick a branch", and the top of `prototype/UI.md`: look or layout questions follow `../rules/ui-prototype-first.mdc`; `?variant=` only when Jonathan asks.
- `pr/SKILL.md`, under "Sections": add a `## Smoke test` section after Evidence per `../rules/smoke-test.mdc`.

### Refreshing

```sh
git clone --depth 1 https://github.com/mattpocock/skills /tmp/mp-skills
# for each upstream skill listed above (engineering or productivity):
rm -rf .cursor/skills/<name> && cp -a /tmp/mp-skills/skills/<pack>/<name> .cursor/skills/<name>
```

Then re-apply the Groundwork notes, update the pin, and check `diff -rq` against upstream shows only those files. A skill upstream deletes gets deleted here; upstream's changeset names its replacement.

### Setup output

`setup-matt-pocock-skills` was run for Groundwork: GitHub Issues, default triage labels, single-context domain docs. Output: the `## Agent skills` block in `AGENTS.md` and `docs/agents/{issue-tracker,triage-labels,domain}.md`.

### Retired

Replaced by their upstream counterparts when Groundwork moved its tracker from Jira to GitHub Issues:

| Retired | Replaced by |
| --- | --- |
| `plan-ticket` | `triage`, `to-spec`, `to-tickets` (`ask-matt` routes) |
| `create-epic` | `wayfinder`, then `to-spec` and `to-tickets` |
| `to-prd` | `to-spec` |
| `to-issues` | `to-tickets` |
| `diagnose` | `diagnosing-bugs` |
| `review` | `code-review` |

## Groundwork keepers

| Skill | Upstream | License | Pin |
| --- | --- | --- | --- |
| [frontend-design](frontend-design/SOURCE.md) | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Apache-2.0 | `33375500bcea98d610eb30ce10ac4e59b89c390d` |
| [web-interface-guidelines](web-interface-guidelines/SOURCE.md) | [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) | MIT | `e3d624baaf29dc1fc645aff3e38f03e564d2d6b1` |
| `design-prototype`, `design-push`, `design-pull`, `design-sync`, `sync-config` | [JonathanHarris15/claude-config](https://github.com/JonathanHarris15/claude-config) `skills/` | — | — |
| `jev-smoke-test` | Groundwork (ported from mosaic-website, adapted to `npm run server` on `:8787`) | — | — |

`design-prototype` and `design-pull` read the domain glossary as `GLOSSARY.md`, upstream's name for what claude-config called `CONTEXT.md`.
