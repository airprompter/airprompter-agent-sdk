"""airprompter-agent: run prompts and workflows approved in AirPrompter on your own systems.

::

    from airprompter_agent import AirPrompterAgent

    # PINNED_ROOT_JWK: AirPrompter's production root key, copied into your source from the README's quick start (key id
    # 044af6e8…1793); its root.json is read from https://api.airprompter.com/roots/prod/root.json. Any other root needs
    # ``sync={"root_url": ...}``.
    ap = AirPrompterAgent.start(organization_id="org_…", agent_id="agt_…", target="prod", api_key=os.environ["AIRPROMPTER_AGENT_KEY"], root={"pinned": PINNED_ROOT_JWK})
    rendered = ap.prompt("support.triage").render(team="Billing", ticket=ticket_text)
    completion = ap.observe(rendered, lambda: client.chat.completions.create(model=rendered.model, messages=[...]))
    ap.feedback(rendered.run_ref, thumbs="up")

Same protocol, same conformance vectors and the same on-disk store as the
TypeScript SDK; see the README for the parity matrix.

The root is the agent, its options and results, and the run's types: the Python counterpart of the TypeScript root (the
names differ where the languages do: option classes, handles, ``Approved`` and ``Passthrough``); everything
else has one home on a layer (``airprompter_agent.core``, ``.sync``, ``.runtime``, ``.telemetry``) or on
``airprompter_agent.testing``. The names load on first use (PEP 562), so ``import airprompter_agent.core`` or a
datastore package never loads the agent, its HTTP client or the other layers.
"""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .agent import (
        PROTOCOL_VERSION,
        SDK_NAME,
        SDK_VERSION,
        VENDORED_BUNDLE_EXPIRY_WARNING_DAYS,
        AgentStartError,
        AgentStatus,
        AirPrompterAgent,
        ApplyOptions,
        DatastoreOptions,
        GoldenOptions,
        PromptHandle,
        ReleaseChange,
        Rendered,
        RenderRefusedError,
        StagedRelease,
        SyncOptions,
        TelemetryOptions,
        VendoredBundle,
        Workflow,
        WorkflowHandle,
        WorkflowStep,
        healthz_of,
        healthz_response,
    )
    from .runtime import AgentRuntime, Approved, ModelResolver, Passthrough, Placement, RunInput, RunSession

    __version__: str

#: Where each root name lives. The run's types are the runtime's; everything else is the agent's.
_HOME = {
    **dict.fromkeys(["AgentRuntime", "Approved", "ModelResolver", "Passthrough", "Placement", "RunInput", "RunSession"], ".runtime"),
    **dict.fromkeys(
        [
            "PROTOCOL_VERSION",
            "SDK_NAME",
            "SDK_VERSION",
            "VENDORED_BUNDLE_EXPIRY_WARNING_DAYS",
            "AgentStartError",
            "AgentStatus",
            "AirPrompterAgent",
            "ApplyOptions",
            "DatastoreOptions",
            "GoldenOptions",
            "PromptHandle",
            "ReleaseChange",
            "Rendered",
            "RenderRefusedError",
            "StagedRelease",
            "SyncOptions",
            "TelemetryOptions",
            "VendoredBundle",
            "Workflow",
            "WorkflowHandle",
            "WorkflowStep",
            "healthz_of",
            "healthz_response",
        ],
        ".agent",
    ),
}
#: The promised modules under the root, reachable as attributes whatever was imported first. ``agent`` is the
#: implementation and the adapters are reached by their full path, so neither is listed (both still work once imported).
_LAYERS = ("core", "runtime", "sync", "telemetry", "testing")


def __getattr__(name: str) -> Any:
    # Each module is named in full, so tools/lint_imports.py checks it like any other import. `import_module`, not
    # `from . import x`: that form asks this very function for `x` first, and would recurse.
    # A layer is an attribute whether or not something imported it first, as it was when the root loaded everything.
    if name == "core":
        value: Any = importlib.import_module("airprompter_agent.core")
    elif name == "runtime":
        value = importlib.import_module("airprompter_agent.runtime")
    elif name == "sync":
        value = importlib.import_module("airprompter_agent.sync")
    elif name == "telemetry":
        value = importlib.import_module("airprompter_agent.telemetry")
    elif name == "testing":
        value = importlib.import_module("airprompter_agent.testing")
    else:
        home = _HOME.get("SDK_VERSION" if name == "__version__" else name)
        if home == ".agent":
            module = importlib.import_module("airprompter_agent.agent")
        elif home == ".runtime":
            module = importlib.import_module("airprompter_agent.runtime")
        else:
            raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
        value = getattr(module, "SDK_VERSION" if name == "__version__" else name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted({*globals(), *_HOME, *_LAYERS, "__version__"})


# The names 1.0 promises (docs/stability.md), one per line: tests/test_package_shape.py pins them.
__all__ = [
    "AgentRuntime",
    "AgentStartError",
    "AgentStatus",
    "AirPrompterAgent",
    "ApplyOptions",
    "Approved",
    "DatastoreOptions",
    "GoldenOptions",
    "ModelResolver",
    "PROTOCOL_VERSION",
    "Passthrough",
    "Placement",
    "PromptHandle",
    "ReleaseChange",
    "RenderRefusedError",
    "Rendered",
    "RunInput",
    "RunSession",
    "SDK_NAME",
    "SDK_VERSION",
    "StagedRelease",
    "SyncOptions",
    "TelemetryOptions",
    "VENDORED_BUNDLE_EXPIRY_WARNING_DAYS",
    "VendoredBundle",
    "Workflow",
    "WorkflowHandle",
    "WorkflowStep",
    "healthz_of",
    "healthz_response",
]
