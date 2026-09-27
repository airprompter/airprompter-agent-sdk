#!/usr/bin/env python3
"""Build every distribution (sdist + wheel) into one ``dist/`` in dependency order: core, sync, runtime, telemetry,
agent, then the three datastore adapters. The release workflow publishes that directory in one trusted-publishing step.

Usage::

    $ python tools/build_all.py        # from sdk-python/; dist/ holds sixteen files afterwards
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORDER = ["core", "sync", "runtime", "telemetry", "agent", "datastore-s3", "datastore-postgres", "datastore-redis"]


def main() -> int:
    out = ROOT / "dist"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir()
    for name in ORDER:
        subprocess.run([sys.executable, "-m", "build", "--outdir", str(out), str(ROOT / "packages" / name)], check=True)
    print("build_all: " + ", ".join(sorted(p.name for p in out.iterdir())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
