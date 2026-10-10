# Groundwork design language

Conventions the Obsidian plugin (`packages/obsidian-plugin/styles.css`) and the website (`packages/server/public/`) share. When a page needs one of these choices, follow the rule here rather than inventing a new one.

## Mastery tones

A concept's state is drawn in one of five tones, the same everywhere: map nodes, path-panel steps, legends, goal tables, list dots, and status pills.

| Tone | Label | Mark |
| --- | --- | --- |
| `solid` | Solid | filled, green |
| `shaky` | Shaky | filled, orange |
| `learning` | Learning | filled, blue |
| `rusty` | Rusty | filled, purple |
| `unstarted` | Not started | dashed ring, grey |

A sixth tone, `goal`, marks the goal itself.

- Labels come from `MASTERY_LABEL` in `packages/core/src/mastery-tone.ts`. Use "Not started", not "Not quizzed".
- Colors come from tokens: `--gw-tone-<tone>` is the fill and `--gw-tone-<tone>-ink` is the text. Put `data-tone="<tone>"` on an element to set `--gw-tone` and `--gw-tone-ink` for it. Pills mix the fill into the surface at `--gw-tone-pill-mix`.
- The graph canvas reads the same tokens when it paints, so a node and its list row always match.
- Never color a concept by its subject. Subject colors collide with the mastery greens, blues, and oranges.
- Contrast: pill text is at least 4.5:1 on its pill over every surface it sits on, and fills are at least 3:1. The checks are `packages/obsidian-plugin/test/tone-contrast.test.ts` (four themes) and `packages/server/test/site-mastery.test.ts`. The site uses the plugin's dark palette, and that test keeps the two equal.
- Warning text inside the plugin panel uses `--gw-tone-shaky-ink`, not Obsidian's `--text-warning`, which is under 3:1 on light surfaces. Only the status bar, which sits outside `.gw-root`, keeps `--text-warning`.

## What a click on a concept does

`studyMove` decides, and it is the same on map nodes, path rows, and goal tables:

| State | Action |
| --- | --- |
| Next or not started | Start |
| Solid | Review (the button reads "Known" and is never disabled) |
| Shaky or rusty | Quiz me |
| Learning | Learn |

Only the Next row's action is filled. Every other row's action is outlined, so a list never shows several equal primary buttons.

## Screens, not overlays

Library, Settings, and Flashcards are screens in the same chrome as Learn, Map, and Goals. They have no Close or X button; you leave through the center tabs or the utility buttons.

A Close belongs only to a temporary view of something already on the page, such as the website's fullscreen graph (Expand and Close).

## Buttons inside Obsidian

Obsidian styles `button:not(.clickable-icon)` with its own height, background, and shadow, and that selector beats a single class. Plugin overrides use `body .gw-root button.<class>`.

Secondary text actions (New goal, Delete goal, Manage cards) use `.gw-text-btn`: muted, underlined text, not a boxed button.

## Narrow panes

The plugin often lives in a side pane, so its layout reacts to the width of `.gw-root` (a container query), not the window:

- Under 640px, the four tabs take their own row below the brand and tools.
- Under 860px, side rails stack under the main column, and the map key sits below the graph instead of over it.
- A table reflows each row onto two lines when the table itself is under 600px wide, so the row's action stays on screen. Actions never sit behind a horizontal scroll.

## Website header on a phone

The site header is one row from 360px through 840px: the Groundwork logo, a compact initials avatar when someone is signed in, and a Menu. The Menu holds Pricing, Get started, the feature links, Admin only when `/v1/account` says `isAdmin`, and Sign in or Sign out. At 841px and wider the bar keeps Pricing, Get started, and Sign in (or the name and Sign out) inline, and the Menu is not shown.

## Admin account counts

The top of `/admin/usage` is two count cards, Users and Paid users, above the free-plan usage report. Paid users are accounts with an active or trialing subscription on Bring your own model or Groundwork. The card lists how many of those cost more than $0 after discounts, and how many are on the 100% off GROUNDWORKTESTER coupon. It does not multiply a plan price by the subscription count.

## Copy

- Action labels are titles only, with no time estimates ("Practice exam", not "Practice exam · 30m").
- Name a state once. A tooltip that already shows "Learning" says "click to keep learning", not "Learning — click to keep learning".
