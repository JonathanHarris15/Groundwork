#!/usr/bin/env python3
"""First-time Groundwork install (same as setup_groundwork.py).

To update an existing install without reconnecting your vault, use
`python update.py` / `python update_groundwork.py` instead.
"""

from pathlib import Path
import runpy
import sys

_script = Path(__file__).resolve().parent / "setup_groundwork.py"
sys.argv[0] = str(_script)
runpy.run_path(str(_script), run_name="__main__")
