#!/usr/bin/env python3
"""
Set up this computer for Groundwork, then open it.

    python setup_groundwork.py                     # asks what it needs to
    python setup_groundwork.py --new my-knowledge  # first computer: create your private knowledge repo
    python setup_groundwork.py --clone https://github.com/you/my-knowledge.git   # every other computer

Every step checks first and skips what's already done, so it is safe to re-run
for a first install. To update Groundwork later without creating or reconnecting
a vault, use `python update_groundwork.py` (or `python update.py`).

Steps: install missing tools (Node.js, git, GitHub CLI, Obsidian, Claude Code), set
your git name/email, build Groundwork and put `groundwork` on your PATH, sign in to
Claude Code with your Claude subscription, create or clone your knowledge vault, and
open it in Obsidian. Uses only the Python standard library (Python 3.8+).
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn, Optional

REPO = Path(__file__).resolve().parent
CLI = REPO / "packages" / "cli" / "dist" / "groundwork.js"
CONFIG = Path.home() / ".config" / "groundwork" / "config.json"
IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"
MIN_NODE = 20

ASSUME_YES = False


# ── output ──────────────────────────────────────────────────────────────

if IS_WIN:
    os.system("")  # turns on ANSI colors in the Windows console
sys.stdout.reconfigure(line_buffering=True)  # keep our lines in order with the tools' output when piped


def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if sys.stdout.isatty() else s


def title(s: str) -> None:
    print(f"\n{_c('1;35', '==')} {_c('1', s)}")


def ok(s: str) -> None:
    print(f"  {_c('32', 'ok')}  {s}")


def info(s: str) -> None:
    print(f"      {s}")


def warn(s: str) -> None:
    print(f"  {_c('33', '!!')}  {s}")


def fail(s: str) -> NoReturn:
    print(f"\n  {_c('31', 'xx')}  {s}\n")
    sys.exit(1)


def ask(question: str, default: str = "") -> str:
    if ASSUME_YES and default:
        return default
    suffix = f" [{default}]" if default else ""
    try:
        answer = input(f"  {_c('36', '??')}  {question}{suffix}: ").strip()
    except EOFError:
        answer = ""
    return answer or default


def confirm(question: str) -> bool:
    if ASSUME_YES:
        return True
    return ask(f"{question} (y/n)", "y").lower().startswith("y")


# ── processes ───────────────────────────────────────────────────────────


def which(cmd: str) -> Optional[str]:
    return shutil.which(cmd)


def run(cmd: list[str], cwd: Optional[Path] = None, check: bool = True, capture: bool = False, quiet: bool = False) -> subprocess.CompletedProcess:
    exe = which(cmd[0]) or cmd[0]
    if not quiet:
        info(_c("2", "$ " + " ".join(cmd)))
    try:
        result = subprocess.run(
            [exe, *cmd[1:]],
            cwd=str(cwd) if cwd else None,
            text=True,
            capture_output=capture,
            encoding="utf-8" if capture else None,
            errors="replace" if capture else None,
        )
    except FileNotFoundError:
        if check:
            fail(f"`{cmd[0]}` isn't installed or isn't on your PATH.")
        return subprocess.CompletedProcess(cmd, 127, "", "")
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip() if capture else ""
        fail(f"`{' '.join(cmd)}` failed (exit {result.returncode}).{(' ' + detail[-800:]) if detail else ''}")
    return result


def output(cmd: list[str]) -> Optional[str]:
    r = run(cmd, check=False, capture=True, quiet=True)
    return r.stdout.strip() if r.returncode == 0 else None


def add_to_path(*dirs: Path) -> None:
    parts = os.environ.get("PATH", "").split(os.pathsep)
    for d in dirs:
        if d.is_dir() and str(d) not in parts:
            parts.append(str(d))
    os.environ["PATH"] = os.pathsep.join(parts)


def refresh_path() -> None:
    """Pick up PATH changes made by installers without restarting the terminal."""
    home = Path.home()
    if IS_WIN:
        try:
            import winreg

            for root, key in (
                (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
                (winreg.HKEY_CURRENT_USER, r"Environment"),
            ):
                try:
                    with winreg.OpenKey(root, key) as k:
                        value, _ = winreg.QueryValueEx(k, "Path")
                    add_to_path(*(Path(os.path.expandvars(p)) for p in value.split(";") if p))
                except OSError:
                    pass
        except ImportError:
            pass
        pf = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        appdata = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
        add_to_path(pf / "nodejs", pf / "Git" / "cmd", pf / "GitHub CLI", appdata / "npm", home / ".local" / "bin")
    else:
        add_to_path(home / ".local" / "bin", home / ".claude" / "local", Path("/opt/homebrew/bin"), Path("/usr/local/bin"))


# ── package managers ────────────────────────────────────────────────────


# Callers re-check the tool afterwards, so these only report problems, not success.


def winget(package_id: str) -> None:
    if not which("winget"):
        return warn("winget isn't available. Install “App Installer” from the Microsoft Store, or install this tool by hand.")
    run(["winget", "install", "--id", package_id, "-e", "--accept-source-agreements", "--accept-package-agreements"], check=False)
    refresh_path()


def brew(*args: str) -> None:
    if not which("brew"):
        return warn("Homebrew isn't installed. Get it from https://brew.sh, then re-run this script.")
    run(["brew", "install", *args], check=False)
    refresh_path()


def linux_pkg(name: str) -> None:
    for pm, cmd in (("apt-get", ["sudo", "apt-get", "install", "-y", name]), ("dnf", ["sudo", "dnf", "install", "-y", name]), ("pacman", ["sudo", "pacman", "-S", "--noconfirm", name])):
        if which(pm):
            run(cmd, check=False)
            return


# ── tools ───────────────────────────────────────────────────────────────


def node_major() -> Optional[int]:
    v = output(["node", "--version"])
    m = re.match(r"v(\d+)", v or "")
    return int(m.group(1)) if m else None


def ensure_node() -> None:
    major = node_major()
    if major and major >= MIN_NODE:
        return ok(f"Node.js v{major}")
    reason = f"Node.js v{major} is too old (need {MIN_NODE}+)" if major else "Node.js isn't installed"
    warn(reason)
    if confirm("Install Node.js LTS now?"):
        if IS_WIN:
            winget("OpenJS.NodeJS.LTS")
        elif IS_MAC:
            brew("node")
        else:
            info("Install Node.js 20+ with nvm (https://github.com/nvm-sh/nvm) or your distro's NodeSource packages, then re-run.")
    major = node_major()
    if not major or major < MIN_NODE:
        fail("Node.js 20+ is required. Install it from https://nodejs.org, open a new terminal, and re-run this script.")
    ok(f"Node.js v{major}")


def ensure_git() -> None:
    if which("git"):
        return ok("git")
    warn("git isn't installed")
    if confirm("Install git now?"):
        if IS_WIN:
            winget("Git.Git")
        elif IS_MAC:
            brew("git")
        else:
            linux_pkg("git")
    if not which("git"):
        fail("git is required. Install it from https://git-scm.com, open a new terminal, and re-run this script.")
    ok("git")


def update_repo(*, skip: bool = False) -> None:
    """If this is a git clone, pull first so a re-run updates an existing install."""
    if skip:
        return info("Skipped git pull (--no-pull).")
    if not which("git") or not (REPO / ".git").exists():
        return
    remotes = output(["git", "-C", str(REPO), "remote"])
    if not remotes:
        return ok("No git remote on this clone — using the local tree")
    r = run(["git", "-C", str(REPO), "pull", "--ff-only"], check=False, capture=True)
    text = ((r.stdout or "") + "\n" + (r.stderr or "")).strip()
    if r.returncode == 0:
        if "Already up to date" in text or "Already up-to-date" in text:
            ok("Groundwork source is already up to date")
        else:
            ok("Pulled the latest Groundwork, then will rebuild")
    else:
        warn("git pull --ff-only didn't apply (uncommitted changes or a diverged branch). Rebuilding what you have.")
        if text:
            info(text[-400:])


def ensure_gh() -> bool:
    if which("gh"):
        ok("GitHub CLI")
        return True
    warn("GitHub CLI (gh) isn't installed. It creates your private knowledge repo for you.")
    if confirm("Install the GitHub CLI now?"):
        if IS_WIN:
            winget("GitHub.cli")
        elif IS_MAC:
            brew("gh")
        else:
            linux_pkg("gh")
    if which("gh"):
        ok("GitHub CLI")
        return True
    warn("Continuing without the GitHub CLI.")
    return False


def find_obsidian() -> Optional[str]:
    if os.environ.get("OBSIDIAN_BIN"):
        return os.environ["OBSIDIAN_BIN"]
    candidates: list[Path] = []
    if IS_WIN:
        local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        candidates = [local / "Programs" / "Obsidian" / "Obsidian.exe", Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Obsidian" / "Obsidian.exe"]
    elif IS_MAC:
        candidates = [Path("/Applications/Obsidian.app"), Path.home() / "Applications" / "Obsidian.app"]
    else:
        found = which("obsidian")
        if found:
            return found
        candidates = [Path("/opt/Obsidian/obsidian"), Path("/var/lib/flatpak/exports/bin/md.obsidian.Obsidian"), Path.home() / ".local/share/flatpak/exports/bin/md.obsidian.Obsidian", Path("/snap/bin/obsidian")]
    return next((str(p) for p in candidates if p.exists()), None)


def ensure_obsidian() -> None:
    if find_obsidian():
        return ok("Obsidian")
    warn("Obsidian isn't installed")
    if confirm("Install Obsidian now?"):
        if IS_WIN:
            winget("Obsidian.Obsidian")
        elif IS_MAC:
            brew("--cask", "obsidian")
        elif which("flatpak"):
            run(["flatpak", "install", "-y", "flathub", "md.obsidian.Obsidian"], check=False)
    if find_obsidian():
        return ok("Obsidian")
    warn("Couldn't install Obsidian automatically. Get it from https://obsidian.md; the rest of setup continues.")


def claude_exe() -> Optional[str]:
    return which("claude")


def ensure_claude() -> None:
    if claude_exe():
        return ok("Claude Code")
    warn("Claude Code isn't installed. Groundwork runs the tutor through it, using your Claude subscription.")
    if confirm("Install Claude Code now?"):
        if IS_WIN:
            run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"], check=False)
        else:
            run(["bash", "-c", "curl -fsSL https://claude.ai/install.sh | bash"], check=False)
        refresh_path()
    if not claude_exe():
        fail("Claude Code is required. Install it from https://claude.com/claude-code, open a new terminal, and re-run this script.")
    ok("Claude Code")


# ── accounts ────────────────────────────────────────────────────────────


def claude_status() -> dict:
    r = run(["claude", "auth", "status", "--json"], check=False, capture=True, quiet=True)
    try:
        return json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return {}


def ensure_claude_login() -> None:
    status = claude_status()
    if status.get("loggedIn"):
        who = status.get("email")
        return ok(f"Claude Code is signed in{f' as {who}' if who else ''}")
    info("Sign in with the Claude account that has your Pro or Max plan. A browser window will open.")
    run(["claude", "auth", "login", "--claudeai"], check=False)
    if not claude_status().get("loggedIn"):
        fail("Claude Code still isn't signed in. Run `claude auth login` and re-run this script.")
    ok("Claude Code is signed in")


def gh_logged_in() -> bool:
    return run(["gh", "auth", "status"], check=False, capture=True, quiet=True).returncode == 0


def ensure_gh_login() -> bool:
    if gh_logged_in():
        ok("GitHub CLI is signed in")
        return True
    info("Sign in to GitHub so Groundwork can create and sync your private knowledge repo.")
    run(["gh", "auth", "login", "--web", "--git-protocol", "https"], check=False)
    if gh_logged_in():
        run(["gh", "auth", "setup-git"], check=False, quiet=True)
        ok("GitHub CLI is signed in")
        return True
    warn("GitHub sign-in didn't finish.")
    return False


def ensure_git_identity(have_gh: bool) -> None:
    name = output(["git", "config", "--global", "user.name"])
    email = output(["git", "config", "--global", "user.email"])
    if name and email:
        return ok(f"git identity: {name} <{email}>")
    default_name, default_email = "", ""
    if have_gh and gh_logged_in():
        user = output(["gh", "api", "user"])
        if user:
            u = json.loads(user)
            default_name = u.get("name") or u.get("login") or ""
            if u.get("id") and u.get("login"):
                default_email = f"{u['id']}+{u['login']}@users.noreply.github.com"
    info("Git needs a name and email for the commits that sync your knowledge.")
    if not name:
        name = ask("Your name", default_name)
        if name:
            run(["git", "config", "--global", "user.name", name], quiet=True)
    if not email:
        email = ask("Your email (a GitHub no-reply address is fine)", default_email)
        if email:
            run(["git", "config", "--global", "user.email", email], quiet=True)
    if not (name and email):
        fail("A git name and email are required. Set them with `git config --global user.name/user.email`.")
    ok(f"git identity: {name} <{email}>")


# ── Groundwork ──────────────────────────────────────────────────────────


def build() -> None:
    run(["npm", "install", "--no-fund", "--no-audit"], cwd=REPO)
    run(["npm", "run", "build"], cwd=REPO)
    ok("Built the Obsidian plugin and the groundwork command")
    if which("groundwork"):
        return ok("`groundwork` is on your PATH")
    r = run(["npm", "link", "-w", "packages/cli"], cwd=REPO, check=False)
    refresh_path()
    if r.returncode == 0 and which("groundwork"):
        ok("`groundwork` is on your PATH (open a new terminal to use it)")
    else:
        warn(f"Couldn't put `groundwork` on your PATH. You can always run: node \"{CLI}\" <command>")


def groundwork(*args: str) -> None:
    run(["node", str(CLI), *args])


def saved_vault() -> Optional[Path]:
    try:
        vault = json.loads(CONFIG.read_text(encoding="utf-8")).get("vault")
    except (OSError, json.JSONDecodeError):
        return None
    return Path(vault) if vault and Path(vault).exists() else None


def default_vault_dir() -> Path:
    d = Path.home() / "Groundwork"
    return Path.home() / "Knowledge" if d.resolve() == REPO else d


def github_login() -> Optional[str]:
    return output(["gh", "api", "user", "--jq", ".login"]) if which("gh") and gh_logged_in() else None


def setup_vault(args: argparse.Namespace, have_gh: bool) -> None:
    existing = saved_vault()
    if existing and not (args.new or args.clone):
        return ok(f"Using your knowledge vault at {existing}")

    vault_dir = Path(os.path.expanduser(args.vault)) if args.vault else default_vault_dir()
    clone, new = args.clone, args.new
    if not (clone or new):
        info("Your knowledge vault is a private GitHub repo that every computer shares.")
        info("  1. This is my first computer: create a new knowledge vault")
        info("  2. I already have one: connect this computer to it")
        choice = ask("Choose 1 or 2", "1")
        if choice.startswith("2"):
            login = github_login()
            hint = f" (e.g. https://github.com/{login}/my-knowledge.git or just my-knowledge)" if login else ""
            clone = ask(f"Your knowledge repo's URL{hint}")
            if not clone:
                fail("No repo given.")
        else:
            new = ask("Name for the new private GitHub repo", "my-knowledge")

    if clone:
        if "/" not in clone and ":" not in clone:
            login = github_login()
            if not login:
                fail("Give the full repo URL, e.g. https://github.com/you/my-knowledge.git")
            clone = f"https://github.com/{login}/{clone}.git"
        groundwork("clone", clone, str(vault_dir), "--no-open")
        return ok(f"Connected to {clone} at {vault_dir}")

    if have_gh and ensure_gh_login():
        groundwork("init", str(vault_dir), "--github", new, "--no-open")
    else:
        info("Without the GitHub CLI, create an EMPTY private repo at https://github.com/new (no README), then paste its URL.")
        remote = ask("Repo URL (leave empty to stay local-only for now)")
        groundwork("init", str(vault_dir), *(["--remote", remote] if remote else []), "--no-open")
    ok(f"Created your knowledge vault at {vault_dir}")


def main() -> None:
    global ASSUME_YES
    parser = argparse.ArgumentParser(description="Set up this computer for Groundwork, then open it.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--new", metavar="NAME", help="create a new private GitHub repo for your knowledge (first computer)")
    group.add_argument("--clone", metavar="URL", help="connect to your existing knowledge repo (other computers)")
    parser.add_argument("--vault", metavar="DIR", help="where the vault lives on this computer (default ~/Groundwork)")
    parser.add_argument("--no-open", action="store_true", help="don't open Obsidian at the end")
    parser.add_argument("--no-pull", action="store_true", help="don't git pull this repo before rebuilding")
    parser.add_argument("-y", "--yes", action="store_true", help="install missing tools and accept defaults without asking")
    args = parser.parse_args()
    ASSUME_YES = args.yes

    if sys.version_info < (3, 8):
        fail("Python 3.8 or newer is required.")
    print(_c("1", "Groundwork setup") + f"  ·  {platform.system()} · repo at {REPO}")
    refresh_path()

    title("Tools")
    ensure_git()
    update_repo(skip=args.no_pull)
    ensure_node()
    have_gh = ensure_gh()
    ensure_obsidian()
    ensure_claude()

    title("Accounts")
    ensure_claude_login()
    if have_gh and (args.new or args.clone or not saved_vault()):
        ensure_gh_login()
    ensure_git_identity(have_gh)

    title("Build")
    build()

    title("Knowledge vault")
    setup_vault(args, have_gh)

    if not args.no_open:
        title("Opening Obsidian")
        groundwork("open")

    title("Done")
    info("In Obsidian: click “Trust author and enable plugins” (and “Allow” for Mermaid) the first time.")
    info("Then Settings → Groundwork → Check connection should say you're signed in.")
    info("Next time, just run `groundwork open`. To update Groundwork itself: `python update_groundwork.py`.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
        sys.exit(130)
