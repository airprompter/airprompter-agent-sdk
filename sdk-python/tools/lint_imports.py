#!/usr/bin/env python3
"""The layer direction inside the one distribution, and the rule for what sits beside it.

  layer 0  airprompter_agent.core        imports nothing of ours
  layer 1  airprompter_agent.sync,       import core only, never each other
           airprompter_agent.runtime,
           airprompter_agent.telemetry
  layer 2  airprompter_agent (the agent  imports the layers below
           and its integrations)
  beside   airprompter_agent_otel,       import ``airprompter_agent.<layer>``
           airprompter_datastore_*

A file reaches another layer only through that layer's package (``from airprompter_agent.core import x``), never one of
its modules (``from airprompter_agent.core.protocol.trust import x``), so what a layer exports is what another layer can
depend on. Inside a layer anything goes. The one module named past a layer is ``airprompter_agent.core._util``: small
shared helpers, internal, on no layer's public list. ``airprompter_agent.core.testing`` is the tests' barrel, and the
package does not import it. Exit 1 with every offending line; ``--json`` prints the edges instead.

Usage::

    $ python tools/lint_imports.py             # from sdk-python/
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "packages"
PACKAGE = "airprompter_agent"
LAYERS = {"core": 0, "sync": 1, "runtime": 1, "telemetry": 1, "agent": 2}
SATELLITES = {"agent-otel": "airprompter_agent_otel", "datastore-s3": "airprompter_datastore_s3", "datastore-postgres": "airprompter_datastore_postgres", "datastore-redis": "airprompter_datastore_redis"}
OURS = {PACKAGE, *SATELLITES.values()}
ALLOWED_INTERNAL = {"airprompter_agent.core._util"}


def layer_of_file(relative: Path) -> str:
    """The layer a file under ``airprompter_agent/`` belongs to; the top level and ``integrations`` are the agent."""
    head = relative.parts[0]
    return head if len(relative.parts) > 1 and head in LAYERS else "agent"


def target_of(module: str) -> tuple[str | None, bool]:
    """The layer a module names (``None`` when it is not ours) and whether it stops at the layer's package."""
    parts = module.split(".")
    if parts[0] != PACKAGE:
        return (parts[0] if parts[0] in OURS else None), True
    if len(parts) == 1:
        return "agent", True
    if parts[1] in LAYERS:
        return parts[1], len(parts) == 2 or module in ALLOWED_INTERNAL
    return "agent", False


def absolute_of(node: ast.ImportFrom, path_parts: tuple[str, ...]) -> str:
    """A relative import as the absolute module it names. ``path_parts`` is the importing module's package."""
    if not node.level:
        return node.module or ""
    base = path_parts[: len(path_parts) - node.level + 1]
    return ".".join([*base, *([node.module] if node.module else [])])


def imported_modules(tree: ast.AST, package: tuple[str, ...]) -> list[tuple[int, str]]:
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            found.append((node.lineno, absolute_of(node, package)))
        elif isinstance(node, ast.Import):
            found.extend((node.lineno, alias.name) for alias in node.names)
    return found


def main() -> int:
    offenders: list[str] = []
    edges: set[str] = set()
    src = ROOT / "agent" / "src" / PACKAGE
    for path in sorted(src.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        shown = path.relative_to(ROOT.parent)
        relative = path.relative_to(src)
        layer = layer_of_file(relative)
        package = (PACKAGE, *relative.parts[:-1])
        for line, module in imported_modules(tree, package):
            if module.split(".")[0] in OURS and module.split(".")[0] != PACKAGE:
                offenders.append(f"{shown}:{line}: the package imports {module}; a satellite sits beside it, never under it")
                continue
            target, whole = target_of(module)
            if target is None or target == layer:
                continue
            edges.add(f"{layer}→{target}")
            if not whole:
                offenders.append(f"{shown}:{line}: reaches into {target} by path ({module}); import airprompter_agent.{target}")
                continue
            if LAYERS[target] >= LAYERS[layer]:
                offenders.append(f"{shown}:{line}: {layer} (layer {LAYERS[layer]}) may not import {target} (layer {LAYERS[target]}); the direction is core → sync, runtime, telemetry → agent")
    for name, module_name in SATELLITES.items():
        root = ROOT / name / "src" / module_name
        for path in sorted(root.rglob("*.py")):
            tree = ast.parse(path.read_text(), filename=str(path))
            shown = path.relative_to(ROOT.parent)
            for line, module in imported_modules(tree, (module_name, *path.relative_to(root).parts[:-1])):
                target, whole = target_of(module)
                if target is None or target == module_name:
                    continue
                if target == "agent" or not whole or target not in LAYERS:
                    offenders.append(f"{shown}:{line}: {module}: a satellite imports only airprompter_agent.{{core,sync,runtime,telemetry}}")
                    continue
                edges.add(f"{name}→{target}")
    if "--json" in sys.argv:
        print(json.dumps({"layers": LAYERS, "satellites": list(SATELLITES), "edges": sorted(edges)}, indent=2))
    if offenders:
        print("lint_imports: the direction is core → sync, runtime, telemetry → agent; these lines break it:", file=sys.stderr)
        for line in offenders:
            print("  " + line, file=sys.stderr)
        return 1
    print(f"lint_imports: ok ({len(edges)} edges between layers, all downward and through barrels)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
