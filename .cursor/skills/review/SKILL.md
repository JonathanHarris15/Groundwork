---
name: review
description: "Review a change along three axes at once, in parallel sub-agents: Standards (does it follow the repo's documented standards and the code-smell baseline?), Spec (does it do what the ticket's PRD asked for?), and Domain (does it speak the language in CONTEXT.md and respect the ADRs?). Use when reviewing a branch, a PR, work in progress, or a finished ticket before it ships."
---

# Review

Review the diff between `HEAD` and a fixed point along three axes that are deliberately kept apart:

- **Standards** — does the code follow this repo's documented standards, and is it free of the smell baseline below?
- **Spec** — does the code do what the originating ticket asked for?
- **Domain** — does the code use the project's own language, and does it respect the decisions already recorded?

Each axis runs as its own sub-agent so they don't pollute each other's context, then this skill reports them side by side.

## Why the axes stay apart

A change can pass one axis and fail another:

- Follows every standard, builds the wrong thing → **Standards pass, Spec fail.**
- Does exactly what the ticket asked, ignores the repo's conventions → **Spec pass, Standards fail.**
- Correct and conventional, invents a name the domain model doesn't have → **Domain fail**, and that name is now in the codebase forever.

Reporting them separately stops one axis from masking another. Never merge or rerank the findings across axes.

## 1. Pin the fixed point

Whatever the user gave you is the fixed point: a SHA, a branch, a tag, `main`, `HEAD~5`. With nothing given, use the merge-base with the repo's main branch — that is the whole of the current piece of work.

Capture the comparison once and reuse it in every sub-agent prompt:

- `git diff <fixed-point>...HEAD` (three dots, so it compares against the merge-base)
- `git log <fixed-point>..HEAD --oneline`

Confirm `git rev-parse <fixed-point>` resolves and the diff is non-empty **before** spawning anything. A bad ref should fail here, not three times in parallel.

## 2. Find the spec

The spec is the originating ticket, in this order:

1. An issue key in the branch name or the commit messages (e.g. `PROJ-124`). Fetch the issue and take its **description** — that is the PRD, and its `## Problem Statement` and `## Acceptance Criteria` are what the Spec axis measures against. Use the `<!-- jira-config -->` block in the project's `CLAUDE.md` for the connection (discover via Atlassian MCP if missing — do not assume Mosaic `MS-*` keys).
2. A path the user passed in.
3. A spec file under `docs/` matching the branch or feature.
4. Nothing found: ask. If the user says there is no spec, skip the Spec sub-agent and say so in the report.

A ticket with no PRD is a board problem, not a review problem. Say so, and point at `/plan-ticket <KEY>`.

## 3. Find the standards

Whatever the repo documents about how code should be written: `CODING_STANDARDS.md`, `CONTRIBUTING.md`, the coding rules in `CLAUDE.md`.

On top of that, the Standards axis always carries the **smell baseline** below, which applies even when the repo documents nothing. Two rules bind it:

- **The repo wins.** A documented standard always overrides the baseline. Where the repo endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Skip anything the linter or typechecker already catches.

Each smell reads *what it is* → *how to fix it*:

- **Mysterious Name** — a function, variable, or type whose name doesn't say what it does or holds. → Rename it. If no honest name comes, the design is murky.
- **Duplicated Code** — the same logic shape in more than one hunk or file in the change. → Extract it, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → Move the method onto the data it envies.
- **Data Clumps** — the same few fields keep travelling together, a type wanting to be born. → Bundle them, pass that.
- **Primitive Obsession** — a string or number standing in for a domain concept that deserves its own type. → Give the concept its own small type.
- **Repeated Switches** — the same `switch` or `if`-cascade on the same type recurs across the change. → Replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files. → Gather what changes together into one module.
- **Divergent Change** — one file is edited for several unrelated reasons. → Split it so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → Delete it. Inline it back until a real need shows.
- **Message Chains** — long `a.b().c().d()` walks the caller shouldn't depend on. → Hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly delegates onward. → Cut it, call the real target.
- **Refused Bequest** — a subclass that ignores or overrides most of what it inherits. → Drop the inheritance, use composition.

## 4. Spawn all three in parallel

One message, three tool calls, so they run at once.

**Standards** (`subagent_type=general-purpose`). Give it: the diff and log commands, the standards files you found, and **the whole smell baseline pasted in** — it has no other way to see it. The brief:

> Report, per file or hunk: (a) every place the diff breaks a documented standard, citing the file and the rule; (b) any baseline smell you spot, naming it and quoting the hunk. Mark documented-standard breaches as hard or judgement; baseline smells are always judgement. A documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words.

**Spec** (`subagent_type=general-purpose`). Give it: the diff and log commands, and the ticket's PRD in full. The brief:

> Report: (a) acceptance criteria that are missing or only partly met; (b) behaviour in the diff nobody asked for — scope creep; (c) criteria that look implemented but where the implementation looks wrong. Quote the criterion for every finding. Under 400 words.

**Domain** (`subagent_type=domain-language`). Give it the diff and let it do its own job: names that drift from `CONTEXT.md`, concepts the code invented that the model doesn't have, model terms the code quietly renamed. Add: check the change against the ADRs in `docs/adr/` covering this area and flag anything that contradicts one.

If the spec is missing, skip that sub-agent. If the repo has no `CONTEXT.md`, skip Domain and say so — don't have it invent a model.

## 5. Report

Present the three under `## Standards`, `## Spec`, and `## Domain`, verbatim or lightly cleaned. Do not merge them and do not rerank across them.

Close with one line: how many findings per axis, and the worst one **within each axis**. No single overall winner — picking one is exactly the reranking the separation exists to stop.

## 6. What happens next

This skill reports. It doesn't fix.

If the caller is `/implement`, hand the findings back and let it decide what to address before shipping. If the user is driving, ask which findings they want fixed. A **Domain** finding is the one to resist waving through: a wrong name outlives the bug.
