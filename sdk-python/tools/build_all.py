#!/usr/bin/env python3
"""Build every distribution (sdist + wheel) into one ``dist/`` in dependency order: core, sync, runtime, telemetry,
agent, then the three datastore adapters. The release workflow publishes that directory in one trusted-publishing step.
``protocol/VERSION``, the only hand-edited protocol version, is written into core's ``protocol/_version.py`` first.

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
VERSION_SOURCE = ROOT.parent / "protocol" / "VERSION"
VERSION_MODULE = ROOT / "packages" / "core" / "src" / "airprompter_agent_core" / "protocol" / "_version.py"
VERSION_TEMPLATE = '''"""The protocol this SDK speaks. ``tools/build_all.py`` writes this file from ``protocol/VERSION``, the only
hand-edited protocol version: change that file, never this one.

Example::

    from airprompter_agent_core.protocol import PROTOCOL_VERSION

    heartbeat = {{"protocol": PROTOCOL_VERSION}}
"""

PROTOCOL_VERSION = "{version}"
'''


def write_protocol_version() -> None:
    VERSION_MODULE.write_text(VERSION_TEMPLATE.format(version=VERSION_SOURCE.read_text(encoding="utf-8").strip()), encoding="utf-8")


def main() -> int:
    write_protocol_version()
    out = ROOT / "dist"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir()
    for name in ORDER:
        subprocess.run([sys.executable, "-m", "build", "--outdir", str(out), str(ROOT / "packages" / name)], check=True)
    print("build_all: " + ", ".join(sorted(p.name for p in out.iterdir())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
