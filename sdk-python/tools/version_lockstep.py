#!/usr/bin/env python3
"""One version across the distributions. A satellite pins ``airprompter-agent`` exactly while the version is a release
candidate, and to the major from a final version on (``>=1.0.0,<2``), so a 1.1.0 SDK installs beside a 1.0.0
datastore. The Development Status classifier follows: ``4 - Beta`` for a candidate, ``5 - Production/Stable`` after.
A version may be given in the npm form (``1.0.0-rc.0``); it equals the PEP 440 form the distributions carry
(``1.0.0rc0``).

``--set`` also moves the version in the READMEs that name it (the SDK's and each distribution's PyPI page) and, from a
final version on, drops what sits between ``<!-- release-candidate -->`` and ``<!-- /release-candidate -->``: advice
that only holds for a candidate. So a release is ``--set`` alone.

Usage::

    $ python tools/version_lockstep.py             # check
    $ python tools/version_lockstep.py --expect V  # check, and V must be the version
    $ python tools/version_lockstep.py --set V     # rewrite every pyproject.toml and README to V
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "packages"
PACKAGES = ["agent", "agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"]
DOCS = [ROOT.parent / "README.md", *(ROOT / name / "README.md" for name in PACKAGES)]
VERSION_LINE = re.compile(r'^version = "([^"]+)"$', re.M)
#: A dependency on one of ours: ``"airprompter-agent==1.0.0rc5"`` or ``"airprompter-agent>=1.0.0,<2"``, extras allowed.
PIN = re.compile(r'"(airprompter-agent(?:-[a-z]+)?)(\[[a-z,]+\])?(==[^"]+|>=[^",]+,<[^"]+)"')
STATUS = re.compile(r'"Development Status :: [^"]+"')
RC_BLOCK = re.compile(r"<!-- release-candidate -->.*?<!-- /release-candidate -->\n?", re.S)
NPM_PRERELEASE = re.compile(r"^(\d+\.\d+\.\d+)-(alpha|beta|rc)\.(\d+)$")
PEP440_LABEL = {"alpha": "a", "beta": "b", "rc": "rc"}


def pep440(version: str) -> str:
    """``1.0.0-rc.0`` as PEP 440 writes it, ``1.0.0rc0``; anything else unchanged."""
    match = NPM_PRERELEASE.match(version)
    return f"{match.group(1)}{PEP440_LABEL[match.group(2)]}{match.group(3)}" if match else version


def version_token(version: str) -> re.Pattern[str]:
    """``version`` as a whole token: never inside ``1.0.10``, ``11.0.0`` or ``1.0.0rc5``. A tag form (``cli/v1.0.0``)
    is not a token either; the READMEs name versions as install pins and the status line, never as tags."""
    return re.compile(rf"(?<![\w.-]){re.escape(version)}(?![\w-]|\.\d)")


def is_prerelease(version: str) -> bool:
    return re.search(r"(a|b|rc|\.dev)\d+$", version) is not None


def pin_for(version: str) -> str:
    """What a satellite's dependency on the agent says for ``version``."""
    return f"=={version}" if is_prerelease(version) else f">={version},<{int(version.split('.')[0]) + 1}"


def status_for(version: str) -> str:
    return '"Development Status :: 4 - Beta"' if is_prerelease(version) else '"Development Status :: 5 - Production/Stable"'


def main() -> int:
    args = sys.argv[1:]
    set_to = pep440(args[args.index("--set") + 1]) if "--set" in args else None
    expect = pep440(args[args.index("--expect") + 1]) if "--expect" in args else None
    if set_to:
        previous = VERSION_LINE.search((ROOT / "agent" / "pyproject.toml").read_text()).group(1)  # type: ignore[union-attr]
        for name in PACKAGES:
            path = ROOT / name / "pyproject.toml"
            text = VERSION_LINE.sub(f'version = "{set_to}"', path.read_text(), count=1)
            text = PIN.sub(lambda m: f'"{m.group(1)}{m.group(2) or ""}{pin_for(set_to)}"', text)
            text = STATUS.sub(status_for(set_to), text)
            path.write_text(text)
        for path in DOCS:
            text = version_token(previous).sub(set_to, path.read_text())
            if not is_prerelease(set_to):
                text = RC_BLOCK.sub("", text)
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
            if pin.group(3) != pin_for(m.group(1)):
                problems.append(f"{name} pins {pin.group(1)}{pin.group(3)}; for {m.group(1)} it is {pin_for(m.group(1))}")
        if STATUS.findall(text) != [status_for(m.group(1))]:
            problems.append(f"{name}: the classifier for {m.group(1)} is {status_for(m.group(1))}")
    distinct = set(versions.values())
    if len(distinct) != 1:
        problems.append("versions differ: " + ", ".join(f"{k}={v}" for k, v in versions.items()))
    version = next(iter(distinct)) if distinct else None
    if expect and version != expect:
        problems.append(f"the tag says {expect}; the distributions say {version}")
    for path in DOCS:
        text = path.read_text()
        if version and not is_prerelease(version) and RC_BLOCK.search(text):
            problems.append(f"{path}: a release-candidate block on {version}; --set drops it")
        # Named where it counts: an install pin (``==V``), never prose.
        if version and not re.search("==" + version_token(version).pattern, text):
            problems.append(f"{path} does not name {version}")
    if problems:
        for line in problems:
            print(f"version_lockstep: {line}", file=sys.stderr)
        return 1
    print(f"version_lockstep: ok ({version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
