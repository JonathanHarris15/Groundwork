---
name: sync-config
description: Sync the global claude-config repo (~/.claude) with its GitHub remote from any directory — commit local changes, figure out which side is ahead, reconcile a divergence by rebasing and resolving conflicts, then push or pull so both ends match. Use when the user says "sync config", "sync my claude config", "/sync-config", or wants their ~/.claude skills/settings brought in line with the remote.
---

# Sync config

Bring `~/.claude` and its GitHub remote (`origin/main`) into the same state, no
matter what folder the user is in. **All git commands run in `~/.claude`** — pass
`-C ~/.claude` to every git call so the user's current project is never touched.

The repo's `.gitignore` is an **allowlist** (`*` then explicit un-ignores). That
means `git add -A` is safe: it can only ever stage the handful of allowlisted
paths (skills, settings.json, CLAUDE.md, agents, commands, workflows, hooks,
README, .gitignore). Credentials, transcripts and machine-local state fail closed.
Do **not** flip `.gitignore` to a denylist to "fix" anything.

## The loop

### 1. Commit local work first
Nothing should be lost to a rebase. Stage and commit any local changes before
looking at the remote:

```sh
git -C ~/.claude add -A
git -C ~/.claude diff --cached --quiet || git -C ~/.claude commit -m "<summary of what changed>"
```

Write a real one-line summary of what actually changed (glance at the staged
diff), not a generic message. If there's nothing staged, skip the commit.

`settings.local.json` is untracked by design — leave it alone.

### 2. Fetch and compare
Note where `main` is first — step 5 needs it to tell whether the sync moved the
board extension:

```sh
git -C ~/.claude rev-parse main    # keep this as <before>
```

```sh
git -C ~/.claude fetch origin
git -C ~/.claude rev-list --left-right --count main...origin/main   # -> "<ahead>	<behind>"
```

- `0  0` — already in sync. Report it and stop.
- `N  0` — local ahead. **Push** (step 3).
- `0  N` — remote ahead. **Pull, fast-forward** (step 3).
- `N  M` — diverged. **Reconcile** (step 4), then push.

### 3. Simple cases
- Ahead only: `git -C ~/.claude push origin main`
- Behind only: `git -C ~/.claude merge --ff-only origin/main`
  (equivalently `git -C ~/.claude pull --ff-only origin main`)

### 4. Diverged — rebase and resolve
Replay local commits on top of the remote so history stays linear:

```sh
git -C ~/.claude rebase origin/main
```

If it stops on a conflict:

1. `git -C ~/.claude status` to see the conflicted files, then read each one.
2. Resolve by **understanding both sides**, not by blindly taking one:
   - These are config files. For additive changes (a new skill on each side, new
     entries in a list, separate settings keys) the answer is almost always the
     **union** — keep both.
   - For the *same* setting or the *same* line changed two different ways, that's
     a genuine semantic conflict. Pick the side that's clearly newer/intended if
     it's obvious; if it isn't, **stop and ask the user** rather than guess.
3. `git -C ~/.claude add <resolved files>` then `git -C ~/.claude rebase --continue`.
4. Repeat until the rebase finishes, then `git -C ~/.claude push origin main`.

If the rebase gets into a state you can't safely untangle:
`git -C ~/.claude rebase --abort` and hand it back to the user with what you found.
Never force-push (`--force`) to escape a conflict — it destroys remote history.

### 5. The board is not here any more

The Board VS Code extension used to live in `board_extension/` and this step
rebuilt it after a sync. It is now its own repo (`board-extension`, under the
user's Profesional Projects folder) with its own `setup.js`; nothing in this
repo needs building. Skip to 6.

### 6. Confirm
End by reporting the outcome in one or two lines: what moved, which direction,
and the final `git -C ~/.claude status` (should be clean and "up to date with
origin/main"). Remind the user that running Claude Code sessions must restart to
pick up changed config — and VS Code too, if step 5 rebuilt the board.
