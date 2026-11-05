#!/usr/bin/env python3
"""Build every distribution (sdist + wheel) into one ``dist/`` in dependency order: the agent, then the OpenTelemetry
package and the three datastore adapters. The release workflow publishes that directory in one trusted-publishing step.
``protocol/VERSION``, the only hand-edited protocol version, is written into ``core/protocol/_version.py`` first.

A build is then proved the way a customer meets it: a clean venv installs the agent's wheel alone and imports every
layer, then installs every wheel and must hold one ``airprompter-agent``. A layer that reaches for something its
distribution does not ship fails here and nowhere else, since the editable install hides it. Each wheel must also
carry exactly its one top-level package.

Usage::

    $ python tools/build_all.py        # from sdk-python/; dist/ holds ten files afterwards
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORDER = ["agent", "agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"]
VERSION_SOURCE = ROOT.parent / "protocol" / "VERSION"
VERSION_MODULE = ROOT / "packages" / "agent" / "src" / "airprompter_agent" / "core" / "protocol" / "_version.py"
VERSION_TEMPLATE = '''"""The protocol this SDK speaks. ``tools/build_all.py`` writes this file from ``protocol/VERSION``, the only
hand-edited protocol version: change that file, never this one.

Example::

    from airprompter_agent.core import PROTOCOL_VERSION

    heartbeat = {{"protocol": PROTOCOL_VERSION}}
"""

PROTOCOL_VERSION = "{version}"
'''


#: What each distribution's wheel holds at its top level, besides its dist-info.
WHEEL_TOP_LEVEL = {"agent": "airprompter_agent", "agent-otel": "airprompter_agent_otel", "datastore-s3": "airprompter_datastore_s3", "datastore-postgres": "airprompter_datastore_postgres", "datastore-redis": "airprompter_datastore_redis"}
ALONE_CHECK = """
import importlib, importlib.util
for module, name in (("airprompter_agent", "AirPrompterAgent"), ("airprompter_agent.core", "verify_manifest"), ("airprompter_agent.core.testing", None), ("airprompter_agent.sync", "SlotStore"), ("airprompter_agent.runtime", "ReleaseResolver"), ("airprompter_agent.telemetry", "SpoolWriter")):
    loaded = importlib.import_module(module)
    assert name is None or callable(getattr(loaded, name)), f"{module}.{name}"
assert importlib.util.find_spec("airprompter_agent_otel") is None, "the agent's wheel carries no exporter"
"""
TOGETHER_CHECK = """
import importlib, importlib.metadata
for module in ("airprompter_agent_otel.exporter", "airprompter_datastore_s3", "airprompter_datastore_postgres", "airprompter_datastore_redis"):
    importlib.import_module(module)
copies = [d.version for d in importlib.metadata.distributions() if d.name == "airprompter-agent"]
assert len(copies) == 1, f"{len(copies)} copies of airprompter-agent: {copies}"
"""


def check_wheels(out: Path) -> None:
    """Check what ``out`` holds, then install it into a clean venv; ``-I`` so nothing in this checkout can stand in for a wheel."""
    for top_level in WHEEL_TOP_LEVEL.values():
        wheel = next(out.glob(f"{top_level}-*.whl"))
        with zipfile.ZipFile(wheel) as archive:
            found = {name.split("/", 1)[0] for name in archive.namelist()} - {f"{wheel.name.rsplit('-', 3)[0]}.dist-info"}
        if found != {top_level}:
            raise SystemExit(f"build_all: {wheel.name} holds {sorted(found)} at its top level; expected {top_level}")
    with tempfile.TemporaryDirectory(prefix="ap-build-all-") as work:
        venv.create(work, with_pip=True)
        python = Path(work) / ("Scripts" if sys.platform == "win32" else "bin") / "python"
        install = [str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check"]
        subprocess.run([*install, *map(str, out.glob("airprompter_agent-*.whl"))], check=True)
        subprocess.run([str(python), "-I", "-c", ALONE_CHECK], check=True, cwd=work)
        subprocess.run([*install, *map(str, out.glob("*.whl"))], check=True)
        subprocess.run([str(python), "-I", "-c", TOGETHER_CHECK], check=True, cwd=work)
    print("build_all: the agent's wheel imports every layer alone; with every wheel, one airprompter-agent resolves")


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
    check_wheels(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
