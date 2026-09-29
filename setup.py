#!/usr/bin/env python3
"""Install or update Groundwork.

First run builds the CLI and plugin. Later runs `git pull` this repo, then
rebuild — so `python setup.py` updates an already-installed copy. Same flags
as setup_groundwork.py (`--new`, `--clone`, `--no-pull`, `-y`, …).
"""

from pathlib import Path
import runpy
import sys

_script = Path(__file__).resolve().parent / "setup_groundwork.py"
sys.argv[0] = str(_script)
runpy.run_path(str(_script), run_name="__main__")
