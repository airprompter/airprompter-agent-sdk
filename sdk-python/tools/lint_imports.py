#!/usr/bin/env python3
"""The package direction (S10): core → clients → agent.

  layer 0  airprompter_agent_core        imports nothing of ours
  layer 1  airprompter_agent_sync,       import core only — never each other
           airprompter_agent_runtime,
           airprompter_agent_telemetry
  layer 2  airprompter_agent (facade)    imports core and the clients

A package reaches a sibling only by its absolute name (``from airprompter_agent_core... import``); a relative import
may only point inside the package it is written in (Python cannot do otherwise, but a ``from ...x`` that climbs past
the package root is caught here rather than at import time). Exit 1 with every offending line; ``--json`` prints the
edges instead.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "packages"
DIST = {"core": "airprompter_agent_core", "sync": "airprompter_agent_sync", "runtime": "airprompter_agent_runtime", "telemetry": "airprompter_agent_telemetry", "agent": "airprompter_agent"}
LAYER = {"core": 0, "sync": 1, "runtime": 1, "telemetry": 1, "agent": 2}
BY_MODULE = {v: k for k, v in DIST.items()}


def package_of(module: str) -> str | None:
    head = module.split(".")[0]
    return BY_MODULE.get(head)


def main() -> int:
    offenders: list[str] = []
    edges: set[str] = set()
    for name, dist in DIST.items():
        src = ROOT / name / "src" / dist
        for path in sorted(src.rglob("*.py")):
            tree = ast.parse(path.read_text(), filename=str(path))
            shown = path.relative_to(ROOT.parent)
            depth = len(path.relative_to(src).parts) - 1  # packages above the module, inside the dist
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    if node.level:
                        if node.level > depth + 1:
                            offenders.append(f"{shown}:{node.lineno}: a relative import climbs out of {dist}")
                        continue
                    target = package_of(node.module or "")
                elif isinstance(node, ast.Import):
                    target = None
                    for alias in node.names:
                        t = package_of(alias.name)
                        if t:
                            target = t
                else:
                    continue
                if target is None or target == name:
                    continue
                edges.add(f"{name}→{target}")
                if LAYER[target] >= LAYER[name]:
                    offenders.append(f"{shown}:{node.lineno}: {name} (layer {LAYER[name]}) may not import {target} (layer {LAYER[target]}) — the direction is core → clients → agent")
    if "--json" in sys.argv:
        print(json.dumps({"layers": LAYER, "edges": sorted(edges)}, indent=2))
    if offenders:
        print("lint_imports: the package direction is core → clients → agent; these lines break it:", file=sys.stderr)
        for line in offenders:
            print("  " + line, file=sys.stderr)
        return 1
    print(f"lint_imports: ok ({len(edges)} package edges, all downward)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
