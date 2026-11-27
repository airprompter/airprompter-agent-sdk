#!/usr/bin/env python3
"""The layer direction inside the one distribution, and the rule for what sits beside it.

  layer 0  airprompter_agent.core        imports nothing of ours
  layer 1  airprompter_agent.sync,       import core only, never each other
           airprompter_agent.runtime,
           airprompter_agent.telemetry
  layer 2  airprompter_agent (the agent) imports the layers below
           airprompter_agent.frameworks
  beside   airprompter_agent_otel,       import ``airprompter_agent.<layer>``
           airprompter_datastore_*

A file reaches another layer only through that layer's package (``from airprompter_agent.core import x``), never one of
its modules (``from airprompter_agent.core.protocol.trust import x``), so what a layer exports is what another layer can
depend on. Inside a layer anything goes. The one module named past a layer is ``airprompter_agent.core._util``: small
shared helpers, internal, on no layer's public list. ``airprompter_agent.core.testing`` is the tests' barrel, and the
package does not import it.

Framework adapters (AIR-2231, the rules of section 3.2; the TypeScript twin is ``scripts/lint-imports.mjs``):

1. An adapter, ``frameworks/<name>.py`` or a folder ``frameworks/<name>/``, imports only the contract
   (``airprompter_agent.frameworks.contract``), its own folder, the standard library and the packages in its
   ``ADAPTERS`` entry. ``frameworks/contract.py`` imports the ``core`` and ``runtime`` packages and the adapters'
   internal module ``airprompter_agent.runtime.adapter``, which nothing else may import. An adapter with no entry fails.
2. ``core``, ``sync``, ``runtime``, ``telemetry`` and the agent import no framework package (``FRAMEWORK_PACKAGES``).
3. ``runtime/run`` imports neither telemetry nor sync: held by the layer rule.

Exit 1 with every offending line; ``--json`` prints the edges instead.

Usage::

    $ python tools/lint_imports.py             # from sdk-python/
"""

from __future__ import annotations

import ast
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "packages"
PACKAGE = "airprompter_agent"
LAYERS = {"core": 0, "sync": 1, "runtime": 1, "telemetry": 1, "agent": 2, "frameworks": 2}
SATELLITES = {"agent-otel": "airprompter_agent_otel", "datastore-s3": "airprompter_datastore_s3", "datastore-postgres": "airprompter_datastore_postgres", "datastore-redis": "airprompter_datastore_redis"}
OURS = {PACKAGE, *SATELLITES.values()}
ALLOWED_INTERNAL = {"airprompter_agent.core._util"}
#: Rule 1: each adapter's own packages. An adapter ticket adds its entry.
ADAPTERS = {"openai": ["openai"], "anthropic": ["anthropic"], "litellm": ["litellm"]}
#: Rule 2: no layer below the adapters imports any of these (a name, or a name and its submodules).
FRAMEWORK_PACKAGES = ("openai", "anthropic", "litellm", "agents", "langchain", "langchain_core", "langgraph", "pydantic_ai")
ADAPTER_MODULE = "airprompter_agent.runtime.adapter"
CONTRACT = "airprompter_agent.frameworks.contract"
STDLIB = set(getattr(sys, "stdlib_module_names", ())) | {"__future__"}


def is_framework_package(module: str) -> bool:
    head = module.split(".")[0]
    return head in FRAMEWORK_PACKAGES or head.startswith(("langchain", "langgraph"))


def adapter_of(relative: Path) -> str | None:
    """``frameworks/<name>.py`` or ``frameworks/<name>/…`` → name; the package's own ``__init__`` is ``"__init__"``,
    which may import the standard library only."""
    if relative.parts[0] != "frameworks" or len(relative.parts) < 2:
        return None
    if relative.parts[1] == "__init__.py":
        return "__init__"
    return relative.parts[1][:-3] if len(relative.parts) == 2 else relative.parts[1]


def lint_adapter(name: str, shown: Path, found: list[tuple[int, str]], offenders: list[str]) -> None:
    if name == "__init__":
        for line, module in found:
            if module is DYNAMIC or module.split(".")[0] not in STDLIB:
                offenders.append(f"{shown}:{line}: frameworks/__init__ imports the standard library only, so importing one adapter loads no other ({module if module is not DYNAMIC else 'a computed import'})")
        return
    if name == "contract":
        for line, module in found:
            if module is DYNAMIC or module.split(".")[0] in STDLIB or module in ("airprompter_agent.core", "airprompter_agent.runtime", ADAPTER_MODULE):
                continue
            offenders.append(f"{shown}:{line}: frameworks/contract imports only the core and runtime packages and {ADAPTER_MODULE} ({module})")
        return
    allowed = ADAPTERS.get(name)
    if allowed is None:
        offenders.append(f"{shown}: frameworks/{name} has no entry in ADAPTERS (tools/lint_imports.py) or in scripts/lint-imports.mjs; see CONTRIBUTING.md › Adding a framework adapter")
        return
    own = f"airprompter_agent.frameworks.{name}"
    for line, module in found:
        if module is DYNAMIC:
            continue  # reported below, for every file
        head = module.split(".")[0]
        if module == CONTRACT or module == own or module.startswith(own + ".") or head in STDLIB or module == "airprompter_agent.frameworks":
            continue
        if head == PACKAGE:
            offenders.append(f"{shown}:{line}: an adapter imports only the contract, its own folder and its framework, not {module}")
        elif head not in allowed:
            offenders.append(f"{shown}:{line}: {module} is not in frameworks/{name}'s allowlist ({', '.join(allowed)})")


def layer_of_file(relative: Path) -> str:
    """The layer a file under ``airprompter_agent/`` belongs to; the top-level modules are the agent."""
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


SRC_ROOT = ROOT / "agent" / "src"
DYNAMIC = object()


def is_module(name: str) -> bool:
    """Whether a dotted name is a module or package of ours on disk (so ``from pkg import sub`` names ``pkg.sub``)."""
    *parents, leaf = name.split(".")
    folder = SRC_ROOT.joinpath(*parents)
    # Exact case: a case-insensitive filesystem would read ``runtime.Attribution`` as ``runtime/attribution.py``.
    names = set(os.listdir(folder)) if folder.is_dir() else set()
    return f"{leaf}.py" in names or (leaf in names and (folder / leaf / "__init__.py").is_file())


def imported_modules(tree: ast.AST, package: tuple[str, ...]) -> list[tuple[int, str]]:
    """Every module a file names: ``import x``, ``from x import y`` (and ``x.y`` when ``y`` is itself a module), and
    ``importlib.import_module("x")`` / ``__import__("x")``. A dynamic import of a computed name is reported as such."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            base = absolute_of(node, package)
            found.append((node.lineno, base))
            for alias in node.names:
                if alias.name != "*" and base.split(".")[0] == PACKAGE and is_module(f"{base}.{alias.name}"):
                    found.append((node.lineno, f"{base}.{alias.name}"))
        elif isinstance(node, ast.Import):
            found.extend((node.lineno, alias.name) for alias in node.names)
        elif isinstance(node, ast.Call):
            callee = node.func
            name = callee.attr if isinstance(callee, ast.Attribute) else callee.id if isinstance(callee, ast.Name) else None
            if name in ("import_module", "__import__"):
                argument = node.args[0] if node.args else None
                if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
                    found.append((node.lineno, argument.value))
                else:
                    found.append((node.lineno, DYNAMIC))  # type: ignore[arg-type]
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
        found = imported_modules(tree, package)
        adapter = adapter_of(relative)
        if adapter is not None:
            lint_adapter(adapter, shown, found, offenders)
        for line, module in found:
            if module is DYNAMIC:
                offenders.append(f"{shown}:{line}: a dynamic import of a computed name cannot be checked; name the module")
                continue
            if module == ADAPTER_MODULE and adapter != "contract":
                offenders.append(f"{shown}:{line}: {ADAPTER_MODULE} is the adapters' internal module; only frameworks/contract imports it")
                continue
            if layer != "frameworks" and is_framework_package(module):
                offenders.append(f"{shown}:{line}: {layer} imports the framework package {module}; only frameworks/<name> may")
                continue
            if adapter == "contract" and module == ADAPTER_MODULE:
                edges.add("frameworks→runtime")
                continue
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
