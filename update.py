#!/usr/bin/env python3
"""Update Groundwork without reconnecting your vault. Same as update_groundwork.py."""

from pathlib import Path
import runpy
import sys

_script = Path(__file__).resolve().parent / "update_groundwork.py"
sys.argv[0] = str(_script)
runpy.run_path(str(_script), run_name="__main__")
