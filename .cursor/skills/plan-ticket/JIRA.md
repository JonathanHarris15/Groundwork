# Working with JIRA

The shared mechanics. `create-epic`, `plan-ticket`, `to-prd`, `to-issues` and `implement` all
use this file; each one names only the extra tools and the moves that are its own.

[BOARD.md](./BOARD.md) says what the columns and levels *mean*. This says how to touch them.

## Loading the tools

The Atlassian tools are MCP tools on **Cursor Cloud Agents** (the Atlassian MCP
connector). Discover and call them in the **Atlassian** namespace
(`GetDynamicTools` / `CallDynamicTool` with `namespace: "Atlassian"`).
Do **not** use Claude `ToolSearch` or `~/.claude` to find Jira tools.

The skill that sent you here names its own list; these are the ones nearly everything needs:

`getAccessibleAtlassianResources`, `getJiraIssue`, `editJiraIssue`, `addCommentToJiraIssue`,
`searchJiraIssuesUsingJql`.

## Knowing where you are

1. **`cloudId`** — from `getAccessibleAtlassianResources`. You can also pass the site hostname
   (`yoursite.atlassian.net`) directly as `cloudId`.
2. **Project key** — read it off the issue you're working on with `getJiraIssue`, or, when
   creating from nothing, confirm it with me via `getVisibleJiraProjects` (action `create`).
   **Never guess a project key.**
3. **Real type and status names** — `getJiraProjectIssueTypesMetadata`. Every project names
   things differently. Don't assume names verbatim; use what the metadata says.

A project that has been set up already carries a `<!-- jira-config -->` block in its
`CLAUDE.md` with the cloudId, project key, and real type names. Read that first and skip the
discovery. If there isn't one, discover once and offer to write it.

## The three levels

JIRA nests exactly three: **Epic (1) → level-0 ticket (0) → sub-task (−1)**.

`Feature`, `Task` and `Bug` are all level 0 and **cannot nest inside each other**. So anything
that lives "under" a Feature must be created at the sub-task level with `parent` set to the
Feature's key. There is no fourth level — a sub-task's own micro-steps go in a checklist in its
description.

Watch for renames: a project's sub-task-level type is JIRA's `Subtask`, which projects often
rename to "Task". A project may have no `Feature` type at all, only `Story`. The metadata is
the truth.

## Creating an issue

`createJiraIssue` requires `cloudId`, `projectKey`, `issueTypeName`, `summary`.

- **Parenting** — set `parent` to the parent's key. If the project rejects `parent` for that
  type, fall back: `getJiraIssueTypeMetaWithFields`, find the **Epic Link** custom field, and
  set it via `additional_fields` (e.g. `{"customfield_10014": "PROJ-123"}`) or a follow-up
  `editJiraIssue`.
- **Description** — pass `contentFormat: "markdown"`.
- **Labels, priority, dates** — ride in `additional_fields`, e.g.
  `{"labels": ["afk", "epic-checkout"], "duedate": "2026-09-01", "priority": {"name": "High"}}`.
  Dates are `YYYY-MM-DD`.
- **Story points**, if the project has the field, also go in `additional_fields` — discover the
  `customfield_*` id from the type metadata.

## Editing without destroying

**Read before you write.** `editJiraIssue` replaces what you give it.

- **Descriptions** — fetch the current one with `getJiraIssue` first, then set the new text.
  Preserve anything on the ticket worth keeping that you didn't author.
- **Labels** — JIRA replaces the whole array. Read the current labels, then re-set the full
  list with your change folded in.
- **Comments** — `addCommentToJiraIssue` with `contentFormat: "markdown"`.

If a description is genuinely too large for the field, keep the narrative on the ticket and
move the long detail into a pinned comment on the same ticket.

## Dependency links

`createIssueLink`, after confirming the `Blocks` type exists with `getIssueLinkTypes`.

For "**A** is blocked by **B**": `type: "Blocks"`, `inwardIssue: B` (the blocker),
`outwardIssue: A` (the blocked).

Link at the level the dependency actually lives — ticket-to-ticket for work that must ship in
order, sub-task-to-sub-task within one ticket. Don't link across levels.

## Transitions

`getTransitionsForJiraIssue` returns the transitions valid **from the current status**, each
with an `id` and a target status name. Pick the one matching where you're going, then
`transitionJiraIssue` with that `id`.

- Some transitions require fields (a resolution on Done); pass them in the transition `fields`.
- Re-fetch the transition list after every move — the valid set changes with the status.
- **Never invent a status name.** If no transition matches the phase you're in (the project has
  no "In Review", say), skip it rather than forcing one.

## Finding work

JQL through `searchJiraIssuesUsingJql`. The ready queue:

```
project = PROJ AND status IN ("To Do", "On Deck") ORDER BY created ASC
```

Filter out anything with an open blocker in its `issuelinks` — JQL won't do that for you.

## GitHub linkage

The JIRA↔GitHub app links code automatically once the issue key appears in the right places.
There's no per-issue setup beyond the org's app.

- **Branch names** — `PROJ-124-add-oauth`
- **Commit messages** — `PROJ-124 add token refresh`
- **PR titles and descriptions** — the linked PR then shows in the issue's Development panel

Smart Commits can also transition and comment: `PROJ-124 #comment ready for review #time 2h`.

Tell me to name branches and PRs with the key so this stays automatic.
