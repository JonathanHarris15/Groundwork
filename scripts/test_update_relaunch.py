"""The Windows updater must keep a repo path with spaces as one argument."""

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import update_groundwork as updater  # noqa: E402


def main() -> None:
    script = r"C:\Users\jonol\Personal Projects\Groundwork\update_groundwork.py"
    exe = r"C:\Users\jonol\AppData\Local\Python\pythoncore-3.12-64\python.exe"
    line = subprocess.list2cmdline([exe, script])
    quoted = f'"{script}"'
    if quoted not in line:
        raise SystemExit(f"path with spaces was not quoted: {line}")
    if line.split()[1] == r"C:\Users\jonol\Personal":
        raise SystemExit(f"path was split at the space: {line}")
    # relaunch() is what update.py calls; on Windows it must go through subprocess.
    source = Path(updater.__file__).read_text(encoding="utf-8")
    win = source.split('if sys.platform == "win32":', 1)[1].split("os.execv", 1)[0]
    if "subprocess.run" not in win:
        raise SystemExit("Windows relaunch does not use subprocess.run")
    print("windows relaunch keeps the path together")


if __name__ == "__main__":
    main()
