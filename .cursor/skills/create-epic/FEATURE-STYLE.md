# How to write a Feature

The register for every **Feature** description `create-epic` publishes. `to-prd` carries the
same register forward into the fuller PRD, so getting it right here saves work later.

Write so someone **not** steeped in the project or its jargon can understand what the Feature
is and why it matters — then make the "done" conditions concrete enough to test.

```md
## What & why

Plain-language prose, a short paragraph or two. Say what the Feature does AND **why it
exists** — the problem it solves for the user. **Define any domain term the moment you use
it, in-line** — e.g. "Recommendations (suggested products) are ranked items shown to a
customer at checkout." Assume the reader hasn't read the epic, the glossary, or the
codebase. No implementation detail, no file paths.

## Acceptance criteria

A checklist of **specific, measurable, externally-observable** conditions — each one
something you could demo or test as pass/fail. Prefer "given X, the app returns Y" or
"changing A recomputes B" over a vague "supports A." Where a correct result already exists
(a spreadsheet, a legacy output), make **matching it** a criterion.

## Dependencies / demo

What must exist first (reference the blocking tickets), and whether the Feature is in scope
for the nearest demo milestone.
```

**High-level is not the same as vague.** "High-level" here means *not yet decomposed into
sub-tasks*. It does not license jargon-dense or hand-wavy prose. Aim for the clarity of a
good README: plain enough for a newcomer, specific enough to check. The deep implementation
detail lands later in `to-prd`; the accessibility and the measurable criteria start **here**.

## An investigation ticket is written differently

It states **the question, not the answer**, plus what "resolved" would mean. No acceptance
criteria, because there is no deliverable — the output is a decision. No due date, because
deciding is not a dated commitment.

```md
## Question

{The decision this ticket resolves.}

## Resolved when

{What we'd need to know or have seen to call it decided.}
```
