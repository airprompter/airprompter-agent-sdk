#!/usr/bin/env python3
"""One version across the five distributions, siblings exact-pinned to it (S10).

  python tools/version_lockstep.py             check
  python tools/version_lockstep.py --expect V  check, and V must be the version
  python tools/version_lockstep.py --set V     rewrite every pyproject.toml to V
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "packages"
PACKAGES = ["core", "sync", "runtime", "telemetry", "agent"]
NAMES = {"core": "airprompter-agent-core", "sync": "airprompter-agent-sync", "runtime": "airprompter-agent-runtime", "telemetry": "airprompter-agent-telemetry", "agent": "airprompter-agent"}
VERSION_LINE = re.compile(r'^version = "([^"]+)"$', re.M)
PIN = re.compile(r'"(airprompter-agent(?:-[a-z]+)?)(\[[a-z,]+\])?==([^"]+)"')


def main() -> int:
    args = sys.argv[1:]
    set_to = args[args.index("--set") + 1] if "--set" in args else None
    expect = args[args.index("--expect") + 1] if "--expect" in args else None
    if set_to:
        for name in PACKAGES:
            path = ROOT / name / "pyproject.toml"
            text = VERSION_LINE.sub(f'version = "{set_to}"', path.read_text(), count=1)
            text = PIN.sub(lambda m: f'"{m.group(1)}{m.group(2) or ""}=={set_to}"', text)
            path.write_text(text)
        # The constant the SDK reports on the heartbeat, pinned to core's pyproject by test_package_split.py.
        init = ROOT / "core" / "src" / "airprompter_agent_core" / "__init__.py"
        init.write_text(re.sub(r'^SDK_VERSION = "[^"]+"$', f'SDK_VERSION = "{set_to}"', init.read_text(), count=1, flags=re.M))
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
