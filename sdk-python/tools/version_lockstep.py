#!/usr/bin/env python3
"""One version across the distributions, ``airprompter-agent`` exact-pinned to it. A version may be given in the npm form
(``1.0.0-rc.0``); it equals the PEP 440 form the distributions carry (``1.0.0rc0``).

Usage::

    $ python tools/version_lockstep.py             # check
    $ python tools/version_lockstep.py --expect V  # check, and V must be the version
    $ python tools/version_lockstep.py --set V     # rewrite every pyproject.toml to V
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "packages"
PACKAGES = ["agent", "agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"]
VERSION_LINE = re.compile(r'^version = "([^"]+)"$', re.M)
PIN = re.compile(r'"(airprompter-agent(?:-[a-z]+)?)(\[[a-z,]+\])?==([^"]+)"')
NPM_PRERELEASE = re.compile(r"^(\d+\.\d+\.\d+)-(alpha|beta|rc)\.(\d+)$")
PEP440_LABEL = {"alpha": "a", "beta": "b", "rc": "rc"}


def pep440(version: str) -> str:
    """``1.0.0-rc.0`` as PEP 440 writes it, ``1.0.0rc0``; anything else unchanged."""
    match = NPM_PRERELEASE.match(version)
    return f"{match.group(1)}{PEP440_LABEL[match.group(2)]}{match.group(3)}" if match else version


def main() -> int:
    args = sys.argv[1:]
    set_to = pep440(args[args.index("--set") + 1]) if "--set" in args else None
    expect = pep440(args[args.index("--expect") + 1]) if "--expect" in args else None
    if set_to:
        for name in PACKAGES:
            path = ROOT / name / "pyproject.toml"
            text = VERSION_LINE.sub(f'version = "{set_to}"', path.read_text(), count=1)
            text = PIN.sub(lambda m: f'"{m.group(1)}{m.group(2) or ""}=={set_to}"', text)
            path.write_text(text)
        print(f"version_lockstep: every distribution is {set_to}")
    problems: list[str] = []
    versions: dict[str, str] = {}
    for name in PACKAGES:
        text = (ROOT / name / "pyproject.toml").read_text()
        m = VERSION_LINE.search(text)
        if not m:
            problems.append(f"{name}: no version")
            continue
        versions[name] = m.group(1)
        for pin in PIN.finditer(text):
            if pin.group(3) != m.group(1):
                problems.append(f"{name} pins {pin.group(1)}=={pin.group(3)}; the lockstep version is {m.group(1)}")
    distinct = set(versions.values())
    if len(distinct) != 1:
        problems.append("versions differ: " + ", ".join(f"{k}={v}" for k, v in versions.items()))
    version = next(iter(distinct)) if distinct else None
    if expect and version != expect:
        problems.append(f"the tag says {expect}; the distributions say {version}")
    if problems:
        for line in problems:
            print(f"version_lockstep: {line}", file=sys.stderr)
        return 1
    print(f"version_lockstep: ok ({version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
