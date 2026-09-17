#!/usr/bin/env python3
"""Install the five distributions editable, in dependency order, plus the test extras — one command for a
contributor or CI.

Usage::

    $ python tools/install_dev.py                  # the five packages, editable, with the test extras
    $ python tools/install_dev.py pyflakes build   # plus anything else pip should install
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORDER = ["core", "sync", "runtime", "telemetry", "agent"]


def main() -> int:
    extra = sys.argv[1:]
    targets = []
    for name in ORDER:
        path = ROOT / "packages" / name
        targets += ["-e", f"{path}[test]" if name == "agent" else str(path)]
    subprocess.run([sys.executable, "-m", "pip", "install", *targets, *extra], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
