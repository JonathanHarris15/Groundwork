---
name: design-push
description: Move a page, card or component out of the codebase and into Claude Design exactly as it is today, so the user can play with it there and pull the better version back. Extracts the real markup, flattens the framework and live data into something that renders standalone with real content, and saves a snapshot to docs/design/ that design-pull later diffs against. Use when the user says "/design-push", "push this to Claude Design", "I don't like this card but can't say why", or wants to rework something that already exists.
---

# Design push

Something in the product is wrong and the user cannot put it into words. They
don't need a brief; they need the thing itself, in a place where they can move
it around. This skill takes it there **exactly as it is** and changes nothing.

The temptation is to improve it on the way out. Don't. A fix made in transit is
invisible: the user goes to Claude Design, finds the thing already better, and
never learns which change did it. Worse, `design-pull` will read your improvement
as their decision. Push is a photograph, not a restoration.

**Read `.claude/design.json` first.** **Run `design-sync` Pass 1 before you
start**, so what goes over is drawn on current tokens. Pass 1 only.

## Step 1 — Agree the boundary, then wait

Find the thing and show them where it stops:

> That's `public/service-card.html` lines 112–180 — the card, its header row,
> the three note lines and the footer actions. Not the surrounding list. Right?

**Wait for the answer.** Getting this wrong is expensive both ways. Too narrow
and they cannot see the problem, because the problem is usually how the thing
sits next to its neighbours. Too wide and Claude Design redesigns half the page
and the pull turns into an argument. When in doubt take **one ring wider** —
enough context to judge against, clearly marked as context, not as the subject.

## Step 2 — Collect everything it needs

- **The markup**, verbatim.
- **The classes it uses** — which are shared `m-*` components and which are
  loose utilities. Note both; the loose ones are often the reason it feels off.
- **Every state it has.** Empty, one, many, loading, error, selected, disabled,
  overflowing. A card only looks good in the state you were staring at.
- **Fictional data only.** The repo is public — never use real congregation
  names, people, or records in snapshots. Invent plausible names, hymn titles,
  and dates in the same formats the app uses. **Never Lorem, never `Item 1`.**
  Vary length deliberately: include one value that wraps to three lines so
  wrapping problems show up.
- **The longest realistic fictional value.** The one that wraps to three lines is
  the one worth designing for.

## Step 3 — Flatten it

**Claude Design can read the repo, and it still cannot run it.** Linking the
source lets it read the file this came out of; it does not give it a browser
with a signed-in session and live data. So the snapshot is still the deliverable
— what a linked repo buys you is the surrounding context, not the rendering.

The desktop runs Alpine and Tailwind against live Firestore. None of that
survives the trip. Turn dynamic markup into rendered output:

- A loop becomes **three real rows**, not one and a comment.
- A conditional becomes **both branches, side by side, labelled**.
- A binding becomes the value it would hold.
- An interaction that cannot survive becomes a **note in the prompt**, not a
  silent omission.

Then build `docs/design/<slug>-snapshot.html`: a single file that opens in a
browser and looks like the real thing. Link the generated token and component
stylesheets so it renders on the same CSS the app does — never hand-copy their
rules into the file, or the snapshot starts drifting the moment somebody
rebuilds. Show each state as its own labelled copy rather than making the
snapshot interactive.

**Open it and compare it against the real page.** A snapshot that is subtly
wrong is worse than no snapshot: the user redesigns a problem they don't have.
List anything you could not reproduce — animation, hover, a virtualised list,
anything the framework was doing for it.

## Step 4 — Record it, so the pull is cheap

Head the snapshot with a comment block, or write a companion
`<slug>-snapshot.md`, holding:

- source file and line range, and the commit it was taken from
- which `m-*` components it uses
- what was faked to make it stand alone
- what could not be reproduced
- the ticket key, if any

This is what makes push→pull much safer than prototype→pull: **everything in
the snapshot is Real by definition**, so `design-pull` classifies only the
differences. Skip this step and you have thrown that away.

## Step 5 — Hand it over

Give one paste block containing the flattened markup, the real data, the states,
which shared components it is built from, and:

- **Where it came from** — the repo (`owner/name` and branch, or *Link local
  code*) and the file and line range. Tell them to attach it. The snapshot is
  the subject, but the file around it is the argument for why the thing is
  shaped the way it is, and a design that can read it stops guessing at
  constraints that are written down three lines up.
- **What it is for** — who opens this, what they came to do. Not what is wrong
  with it; that is the thing the user cannot say yet, and guessing at it puts
  words in their mouth that Claude Design will then design against.
- **What must keep working** — the information it has to carry and the actions
  it has to offer. Everything else is fair game.
- **Tokens only, the project's icon set, both widths.**
- **"This is the current state, not a target. Change it."**

Then stop. The user goes and plays. `design-pull` brings it back.

## Rules

- **Change nothing.** Not the spacing, not a stale label, not a class you think
  is wrong. Note it separately and leave it in.
- **Fictional data or don't push.** No real congregation records in public docs.
- **Confirm the boundary before extracting**, every time.
- **Say what did not survive.** An unreproducible behaviour that goes unmentioned
  gets designed away by accident.
