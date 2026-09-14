#!/usr/bin/env python3
"""Build every distribution (sdist + wheel) into one ``dist/`` in dependency order: core, sync, runtime, telemetry,
agent. The release workflow publishes that directory in one trusted-publishing step."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORDER = ["core", "sync", "runtime", "telemetry", "agent"]


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
