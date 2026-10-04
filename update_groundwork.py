#!/usr/bin/env python3
"""
Update Groundwork on this computer without touching vault setup.

    python update_groundwork.py
    python update.py

Pulls this repo, rebuilds the CLI and Obsidian plugin, and refreshes the plugin
inside the vault already saved in Groundwork's config.json. It never
asks you to create or clone a knowledge repo.

First-time install is still `python setup_groundwork.py`.
"""

from __future__ import annotations

import argparse
import os
import platform
import sys
from pathlib import Path

# Same directory as this file (the Groundwork source checkout).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import setup_groundwork as gw  # noqa: E402


def ensure_default_branch() -> None:
    """`git pull` only updates the checked-out branch, so a clone left on a feature branch never sees main."""
    git = ["git", "-C", str(gw.REPO)]
    branch = gw.output([*git, "branch", "--show-current"])
    default = (gw.output([*git, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) or "origin/main").split("/", 1)[-1]
    if not branch or branch == default:
        return
    gw.warn(f"This checkout is on branch '{branch}', not '{default}', so updates to {default} won't arrive.")
    if gw.output([*git, "status", "--porcelain"]):
        gw.info(f"It has uncommitted changes, so it stays put. To switch yourself: git -C \"{gw.REPO}\" switch {default}")
        return
    if gw.confirm(f"Switch to {default} now?"):
        gw.run([*git, "switch", default])


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Update Groundwork (git pull + rebuild). Does not create or reconnect a vault.",
    )
    parser.add_argument("--no-pull", action="store_true", help="don't git pull this repo before rebuilding")
    parser.add_argument("--open", action="store_true", help="open the existing vault in Obsidian after updating")
    args = parser.parse_args()

    if sys.version_info < (3, 8):
        gw.fail("Python 3.8 or newer is required.")

    print(gw._c("1", "Groundwork update") + f"  ·  {platform.system()} · repo at {gw.REPO}")
    gw.refresh_path()

    gw.title("Source")
    if not gw.which("git"):
        gw.fail("git is required. Install it, or run setup_groundwork.py once.")
    gw.ok("git")
    # This process imported the updater before `git pull`. Restart once so the
    # build and install steps are the scripts that just arrived.
    if os.environ.get("GROUNDWORK_UPDATE_REEXEC") != "1":
        if not args.no_pull:
            ensure_default_branch()
        gw.update_repo(skip=args.no_pull)
        if not args.no_pull:
            os.environ["GROUNDWORK_UPDATE_REEXEC"] = "1"
            os.execv(sys.executable, [sys.executable, *sys.argv])
    commit = gw.output(["git", "-C", str(gw.REPO), "log", "-1", "--format=%h %s"])
    if commit:
        gw.info(f"Building {commit}")

    gw.title("Node")
    gw.ensure_node()

    gw.title("Build")
    gw.build()

    gw.title("Vault")
    vault = gw.saved_vault()
    vaults = [vault] if vault else gw.obsidian_vaults_with_groundwork()
    if vault:
        gw.ok(f"Keeping your existing vault at {vault}")
    elif vaults:
        gw.ok(f"Found Groundwork in Obsidian's vaults: {', '.join(map(str, vaults))}")
        gw.save_vault(vaults[0])
        gw.info(f"Saved {vaults[0]} as your vault in {gw.CONFIG}")
    for v in vaults:
        gw.groundwork("install-plugin", "--vault", str(v))
    if vaults:
        gw.ok("Refreshed the Obsidian plugin")
        if args.open:
            gw.groundwork("open")
    else:
        gw.warn(f"No vault is configured on this computer ({gw.CONFIG}), and no Obsidian vault has Groundwork installed.")
        gw.info("Software is updated. Run python setup_groundwork.py to connect a vault.")

    gw.title("Done")
    gw.info("Day to day: `groundwork open`. To update Groundwork again: `python update_groundwork.py`.")
    if vaults and not args.open:
        gw.info("If Obsidian is open, click \"Reload Groundwork\" when it offers, or quit it fully and reopen it.")
        gw.info("Settings → Groundwork → About shows the build Obsidian is running.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
        sys.exit(130)
