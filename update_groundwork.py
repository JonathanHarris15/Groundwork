#!/usr/bin/env python3
"""
Update Groundwork on this computer without touching vault setup.

    python update_groundwork.py
    python update.py

Pulls this repo, rebuilds the CLI and Obsidian plugin, and refreshes the plugin
inside the vault already saved in ~/.config/groundwork/config.json. It never
asks you to create or clone a knowledge repo.

First-time install is still `python setup_groundwork.py`.
"""

from __future__ import annotations

import argparse
import platform
import sys
from pathlib import Path

# Same directory as this file (the Groundwork source checkout).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import setup_groundwork as gw  # noqa: E402


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
    gw.update_repo(skip=args.no_pull)

    gw.title("Node")
    gw.ensure_node()

    gw.title("Build")
    gw.build()

    gw.title("Vault")
    vault = gw.saved_vault()
    if vault:
        gw.ok(f"Keeping your existing vault at {vault}")
        gw.groundwork("install-plugin")
        gw.ok("Refreshed the Obsidian plugin in that vault")
        if args.open:
            gw.groundwork("open")
    else:
        gw.info("No vault is configured on this computer yet (nothing in ~/.config/groundwork/config.json).")
        gw.info("Software is updated. Run python setup_groundwork.py only when you want to connect a vault.")

    gw.title("Done")
    gw.info("Day to day: `groundwork open`. To update Groundwork again: `python update_groundwork.py`.")
    if vault and not args.open:
        gw.info("Obsidian was left closed. Pass --open if you want it launched.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
        sys.exit(130)
