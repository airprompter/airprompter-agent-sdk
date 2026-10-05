"""``AirPrompterAgent`` — the runtime a customer application holds.

``start()`` reads the store before any network and serves immediately from
the last verified release (other slot → vendored bundle → refuse to start
when nothing verifies); sync runs in the background per mode. ``prompt(tag)``
renders with trust-aware variables and hands back a content-free ``run_ref``;
``workflow(tag)`` yields steps in order; ``report()``, ``observe()`` and
``feedback()`` feed the spool. Zero network to AirPrompter on the render
path, ever; the application's own variable sources (``start(variables=)``,
``docs/variables.md``) run on ``render()`` — plain callables, on worker
threads under their timeouts — and on ``render_async()``, which also awaits
coroutine-function sources. Neither holds the agent's lock while a source runs.

Example::

    ap = AirPrompterAgent.start(organization_id="org_…", agent_id="agt_…", target="prod", api_key=os.environ["AIRPROMPTER_AGENT_KEY"],
                                root={"pinned": PINNED_ROOT_JWK},
                                variables={"customer_tier": {"resolve": lambda ctx: crm.tier_of(ctx.subject), "trust": "operator"}})
    rendered = ap.prompt("support.triage", subject=customer_id).render(ticket=ticket_text)   # customer_tier looked up only if this version uses it
    ap.status().variables                                                                    # {"sources": ["customer_tier"], "unsourced": []}

Threads: resident mode runs its sync, heartbeat and window timers on daemon
threads; every public method is safe to call from any thread. ``stop()``
cancels the timers, waits for a pass in flight, and closes the spool.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import platform
import random as _random
import re
import sys
import threading
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Optional, Sequence, TypeVar, Union

import httpx

from airprompter_agent_core._util import instant, iso_ms, now_ms, random_id
from airprompter_agent_sync.apply.window import UpdateWindow, parse_window, window_state
from airprompter_agent_core.bundle.apbundle import DistributionKey, bundle_payload_bytes, open_bundle
from airprompter_agent_core.protocol.assignment import ramp_weights_at
from airprompter_agent_core.protocol.trust import experiment_for_tag, experiments_of, key_thumbprint, trusted_root_from_pinned_key, verify_manifest, verify_root_metadata
from airprompter_agent_runtime.attribution import Attribution, RenderRegistry, attribution_scope, current_attribution, request_texts
from airprompter_agent_runtime.wrap import WrapHooks, wrap_client
from airprompter_agent_core.protocol.assignment import copy_audience_tags, valid_audience_label, AUDIENCE_CAPABILITY, AUDIENCE_PROTOCOL_VERSION
from airprompter_agent_core.render.run_ref import parse_run_ref
from airprompter_agent_core.render.template import Delimiters
from airprompter_agent_core.telemetry.feedback import normalize_feedback
from airprompter_agent_telemetry.spool.manifest import read_daemon_discovery
from airprompter_agent_telemetry.spool.writer import DirectorySink, MemorySink, Observation, SpoolSink, SpoolWriter, WriterIdentity, epoch_minute, segment_name
from airprompter_agent_sync.store.key_provider import KeyProvider, file_key
from airprompter_agent_sync.store.slot_store import LoadedSlot, SlotStore, StoreError, StoreHooks
from airprompter_agent_sync.store.release_datastore import HydrationPlan, ReleaseDatastore, ReleaseKey, resolve_hydration
from airprompter_agent_sync.sync.loop import required_models_missing
from airprompter_agent_telemetry.uploader import GrantDecision, SpoolUploader, UploadGrant, post_segment
from airprompter_agent_core.control.client import SyncClient
from airprompter_agent_sync.sync.loop import jittered_delay_ms, sync_once
from airprompter_agent_core.checks import evaluate_checks, output_text_of
from airprompter_agent_core.golden import GoldenInvoke, GoldenReport, golden_reports_meet, manifest_has_golden, parse_golden_set, run_golden_set
from airprompter_agent_core.judge import JUDGE_RUBRICS, JudgeResult, JudgeRubric, judge_prompt, judge_signals_of, parse_judge_reply, rubric_from_prompt
from airprompter_agent_runtime.observe import PendingObservation, ObserveTarget, observe_call, observe_call_async
from airprompter_agent_core.release.reader import ReleaseSlot
from airprompter_agent_runtime.release.resolver import ReleaseResolver, Rendered, Workflow, WorkflowStep, copy_inference, disabled_from
from airprompter_agent_runtime.variables import FilledRender, FillPlan, VariableSourceContext, VariableSourceInput, VariableSourceRegistry, fill_async, fill_sync, is_variable_source_error, plan_fill, unsourced

from airprompter_agent_core import SDK_VERSION  # one constant, pinned to pyproject by tests/test_package_split.py

SDK_NAME = "agent-sdk-python"
#: The protocol this SDK speaks; the heartbeat names it (the manifest carries its own). One constant, core's — a
#: second copy here drifted a whole protocol bump behind it.
from airprompter_agent_core import PROTOCOL_VERSION, protocol_at_least  # noqa: E402
# A vendored bundle this close to its notAfter logs vendored_bundle_expiring_soon at start (the platform warns at the same distance).
VENDORED_BUNDLE_EXPIRY_WARNING_DAYS = 30
_USER_AGENT = f"{SDK_NAME}/{SDK_VERSION}"
_REFUSAL_WORD = re.compile(r"^[a-z_]+$")

T = TypeVar("T")


# ----------------------------------------------------------------------------- options


@dataclass
class SyncOptions:
    #: ``"resident"`` | ``"on_invoke"`` | ``"offline"``. ``"daemon"`` was removed in 0.3.0 — the telemetry daemon never
    #: serves releases — and ``start()`` refuses it with ``invalid_options``.
    mode: str = "resident"
    poll_seconds: float = 30
    edge_pointer_url: Optional[str] = None
    root_url: Optional[str] = None


#: The environment variable that names the spool folder when ``telemetry.spool_dir`` does not (``protocol/daemon.md``).
SPOOL_DIR_ENV = "AIRPROMPTER_SPOOL_DIR"


@dataclass
class StagedRelease:
    """What the ``on_staged`` hook receives: call ``activate()`` to go live; return (or raise) without it to leave the release staged."""

    generation: int
    manifest: Mapping[str, Any]
    activate: Callable[[], None]
    unlock_request: Optional[Mapping[str, Any]]


@dataclass
class GoldenOptions:
    """T34: golden sets before activation. With ``invoke`` set, every slot of a staged release that carries a golden set is
    run against the pinned model through this call before the apply decision; a set below its pass-rate floor leaves the
    release staged (``golden_set_failed`` in the log, ``goldenPass`` counts on the arm's window) until an operator unlocks
    it deliberately. Without it, golden sets ride the release unrun (``ap.golden()`` runs them on demand)."""

    invoke: GoldenInvoke
    concurrency: Optional[int] = None


@dataclass
class ApplyOptions:
    #: A local policy this process applies on top of the host's pin (S4): ``"unlock_required"`` makes every release wait
    #: whatever the manifest or the pin says; ``"auto"`` is not a loosening. Loosening a pinned host is an operator's act.
    policy: Optional[str] = None  # "auto" | "unlock_required"
    #: T9: ``"02:00-04:00 Europe/Berlin"`` (optionally ``"… mon,tue"``), a dict, or an UpdateWindow. A local window wins over the manifest's.
    window: Optional[Union[str, Mapping[str, Any], UpdateWindow]] = None
    #: Called when a release is staged under unlock_required — the change-control integration point.
    on_staged: Optional[Callable[[StagedRelease], Any]] = None


@dataclass
class TelemetryOptions:
    sink: Optional[str] = None  # "directory" | "memory"
    instance_class: Optional[str] = None  # "resident" | "ephemeral"
    #: Serverless: the in-memory buffer (default 256 KiB); the oldest rows go past it and a ``dropped`` row says so.
    buffer_bytes: Optional[int] = None
    #: Hosts: the closed-segment budget (default 100 MiB); the oldest unsent segments go past it and a ``dropped`` row says so.
    spool_budget_bytes: Optional[int] = None
    #: S5: a resident host whose spool no live telemetry daemon ships uploads it itself — the same uploader the daemon runs,
    #: in-process, on a timer off the request path, under this runtime's own grant. When a live daemon names this process's
    #: folder the daemon uploads and this process does not (re-checked once a minute, both ways). ``False`` leaves the
    #: spool for the daemon or an operator's export.
    upload: bool = True
    #: The folder this process writes its spool to. ``None``: ``AIRPROMPTER_SPOOL_DIR``, else the folder a live telemetry
    #: daemon for this agent and target published (``<storeDir>/daemon.json``), else ``<storeDir>/spool/telemetry``. An
    #: explicit folder never moves; a discovered one is re-read once a minute (``protocol/daemon.md``).
    spool_dir: Optional[str] = None
    #: S13: where the uploader ships validated segments. ``None``: AirPrompter's sink (a grant per writer, a PUT to your prefix).
    #: ``OtlpUploadSink(...)`` from ``airprompter_agent_telemetry.otel`` sends the windows to your OpenTelemetry collector
    #: instead — no grant is ever requested — and a customer's own sink takes the same segments.
    upload_sink: Optional[Any] = None
    #: S5: serverless — ``invoke()`` flushes the invocation's rows before it returns (``"await"``, the default). ``"background"``
    #: hands the flush to a thread; a platform that freezes the process at the response loses rows in flight, silently.
    flush: str = "await"


@dataclass
class DatastoreOptions:
    """T40: the customer's own datastore as the fleet's copy of each release (a ``ReleaseDatastore`` DAO the application
    implements; ``pull_to_datastore`` fills it). At start — after the host's own store, before the vendored bundle —
    the runtime hydrates from it: the row for its ``region`` (else the global rows), verified through the same chain as
    OTA, with the datastore's rollback in force. The signed manifest inside the row carries the ramp plan and the
    directives, so dial-up percentages walk on this host's clock exactly as signed. ``ap.hydrate()`` re-reads it;
    ``poll_seconds`` re-reads it on a timer. Every sealed row is opened with ``distribution_key``."""

    store: ReleaseDatastore
    region: Optional[str] = None
    poll_seconds: Optional[float] = None


@dataclass
class VendoredBundle:
    #: A path to a ``.apbundle`` file, or the parsed document.
    bundle: Union[str, Mapping[str, Any]]
    distribution_key: Optional[DistributionKey] = None


# S10: the rendered shapes are the runtime's.


@dataclass
class AgentStatus:
    instance_id: str
    generation: int
    staged_generation: Optional[int]
    apply_state: str  # "active" | "staged" | "awaiting_unlock" | "refused" | "vendored_fallback"
    last_refusal: Optional[str]
    storage_protection: str  # a StorageProtection
    signing_key_id: Optional[str]
    lease_expires_at: Optional[str]
    lease_expired: bool
    on_lease_expiry: Optional[str]
    last_contact_at: Optional[str]
    forced_downgrade: bool
    disabled: dict[str, Any]  # {"agent": bool, "slots": [tag]}
    unlock_requests: list[dict[str, Any]]
    window: Optional[dict[str, Any]]  # {"source", "open", "opens_at", "closes_at"}
    heartbeat: dict[str, Any]  # {"last_at", "next_at", "interval_seconds", "last_refusal"}
    spool: dict[str, int]  # {"depth_segments", "depth_bytes"}
    source: str  # "store" | "vendored_bundle"
    last_sync_at: Optional[str]
    last_sync_outcome: Optional[str]
    consecutive_sync_failures: int
    next_sync_at: Optional[str]
    #: T34: the last golden-set run before activation — counts only; None until one ran.
    golden: Optional[dict[str, Any]] = None
    #: S4: the apply policy in force and where it comes from — {"effective", "source": local|pinned|operator|manifest, "manifestSaid"}.
    apply_policy: dict[str, Any] = field(default_factory=lambda: {"effective": "auto", "source": "manifest", "manifestSaid": None})
    #: S5: this process's own uploader; None when a live telemetry daemon, a memory sink or ``upload=False`` owns the spool.
    upload: Optional[dict[str, Any]] = None
    #: Where the spool goes and who ships it (``protocol/daemon.md``): ``{"sink": "directory"|"memory", "spool_dir",
    #: "spool_dir_from": "option"|"env"|"daemon"|"default", "uploaded_by": "daemon"|"self"|"none", "daemon": None |
    #: {"live", "pid", "version", "heartbeat_at", "spool_dir"}}``.
    telemetry: dict[str, Any] = field(default_factory=lambda: {"sink": "memory", "spool_dir": None, "spool_dir_from": None, "uploaded_by": "none", "daemon": None})
    #: S9: the ramp plan as this host walks it — {"experimentId", "weightBps", "arms", "step", "nextStepAt", "plan"}; None without an experiment.
    ramp: Optional[dict[str, Any]] = None
    #: S16: one entry per experiment the active manifest carries (per slot); ``ramp`` is the first of them.
    ramps: list[dict[str, Any]] = field(default_factory=list)
    #: 0.2.11: prompt variables and where they come from — ``{"sources": [names this application can fill],
    #: "unsourced": [{"tag", "arm", "names"}]}``: per slot and arm, the required variables neither a literal nor a
    #: source fills, so the call site must. Declarations only; no payload is read.
    variables: dict[str, Any] = field(default_factory=lambda: {"sources": [], "unsourced": []})
    #: T40: the customer's datastore this runtime hydrates from — ``{"region", "last_hydrate_at", "last_outcome",
    #: "newest_generation", "rows_from", "rollback"}``; None when none was given.
    datastore: Optional[dict[str, Any]] = None


@dataclass(frozen=True)
class ReleaseChange:
    generation: int
    staged_generation: Optional[int]


_HEALTHZ_LEVELS = {"ok": 0, "degraded": 1, "failing": 2}


def healthz_of(status: AgentStatus, *, spool_budget_bytes: Optional[int], now_ms: float) -> dict[str, Any]:
    """S14: what a probe asks, over any status document. ``ok`` is the liveness
    answer; ``status`` adds the one degraded middle. The rules, each a vector (``tests/test_healthz.py``):

    - ``failing`` (ok False): nothing verified to serve (generation 0); the lease lapsed under ``on_lease_expiry="halt"``.
    - ``degraded`` (ok True): the lease lapsed under ``degrade``; three or more consecutive sync failures; the uploader
      backing off; a forced downgrade in force; the telemetry daemon's file went stale and nothing here uploads instead
      (``upload_daemon_stale``); the spool at 80 % of its budget or more.
    - ``ok`` otherwise. ``reasons`` names every rule that fired, in that order. Keys are the wire document's (camelCase),
      the same as the TypeScript SDK's."""
    reasons: list[str] = []
    level = "ok"

    def raise_to(to: str, reason: str) -> None:
        nonlocal level
        reasons.append(reason)
        if _HEALTHZ_LEVELS[to] > _HEALTHZ_LEVELS[level]:
            level = to

    if status.generation <= 0:
        raise_to("failing", "no_verified_release")
    if status.lease_expired and status.on_lease_expiry == "halt":
        raise_to("failing", "lease_expired_halt")
    if status.lease_expired and status.on_lease_expiry == "degrade":
        raise_to("degraded", "lease_expired_degrade")
    if status.consecutive_sync_failures >= 3:
        raise_to("degraded", "sync_failing")
    backoff_until = (status.upload or {}).get("backoffUntil")
    if backoff_until and instant(backoff_until) > now_ms:
        raise_to("degraded", "upload_backing_off")
    if status.forced_downgrade:
        raise_to("degraded", "forced_downgrade")
    telemetry = status.telemetry or {}
    daemon = telemetry.get("daemon")
    if daemon is not None and not daemon.get("live") and telemetry.get("uploaded_by") == "none":
        raise_to("degraded", "upload_daemon_stale")
    depth_bytes = int(status.spool.get("depth_bytes", 0))
    if spool_budget_bytes is not None and spool_budget_bytes > 0 and depth_bytes >= spool_budget_bytes * 0.8:
        raise_to("degraded", "spool_near_budget")
    return {
        "ok": _HEALTHZ_LEVELS[level] < _HEALTHZ_LEVELS["failing"],
        "status": level,
        "reasons": reasons,
        "generation": status.generation,
        "stagedGeneration": status.staged_generation,
        "applyState": status.apply_state,
        "source": status.source,
        "leaseExpiresAt": status.lease_expires_at,
        "leaseExpired": status.lease_expired,
        "onLeaseExpiry": status.on_lease_expiry,
        "lastSyncAt": status.last_sync_at,
        "lastSyncOutcome": status.last_sync_outcome,
        "consecutiveSyncFailures": status.consecutive_sync_failures,
        "forcedDowngrade": status.forced_downgrade,
        "telemetry": {"uploadedBy": telemetry.get("uploaded_by", "none"), "daemon": None if daemon is None else ("live" if daemon.get("live") else "stale")},
        "spool": {"depthSegments": int(status.spool.get("depth_segments", 0)), "depthBytes": depth_bytes, "budgetBytes": spool_budget_bytes},
        "lastUploadAt": (status.upload or {}).get("lastUploadAt"),
        "backoffUntil": backoff_until,
    }


def healthz_response(healthz: Mapping[str, Any]) -> tuple[int, dict[str, str], str]:
    """An HTTP answer for any framework: ``(200, headers, body)`` when ok, ``503`` otherwise."""
    return (200 if healthz.get("ok") else 503, {"content-type": "application/json", "cache-control": "no-store"}, json.dumps(healthz, separators=(",", ":")))


class RenderRefusedError(Exception):
    """``render()`` refused by the control plane's standing instructions: a disable directive, or a lapsed lease on a ``halt`` target."""

    def __init__(self, reason: str, tag: str, generation: int):
        super().__init__(f"render {tag}: refused ({reason}) on generation {generation}")
        self.reason = reason
        self.tag = tag
        self.generation = generation


class AgentStartError(Exception):
    def __init__(self, code: str, message: str):  # "no_verified_release" | "kek_unavailable" | "store_corrupt" | "store_newer"
        super().__init__(message)
        self.code = code


def _coerce(kind, value):
    if value is None:
        return kind()
    if isinstance(value, kind):
        return value
    if isinstance(value, Mapping):
        return kind(**value)
    raise TypeError(f"expected {kind.__name__} or a mapping, got {type(value).__name__}")


def _spool_placement(options: Mapping[str, Any], store_dir: str, at_ms: float) -> dict[str, Any]:
    """``protocol/daemon.md`` › What an SDK does: the folder this process writes — ``telemetry.spool_dir``, else
    ``AIRPROMPTER_SPOOL_DIR``, else a live daemon's published ``spoolDir``, else ``<storeDir>/spool/telemetry``."""
    discovery = read_daemon_discovery(_default_fs(), store_dir, agent_id=options["agent_id"], target=options["target"], organization_id=options.get("organization_id"), now_ms=at_ms)
    telemetry: TelemetryOptions = options["telemetry"]
    if telemetry.spool_dir:
        return {"dir": os.path.abspath(telemetry.spool_dir), "from": "option", "discovery": discovery}
    env = os.environ.get(SPOOL_DIR_ENV)
    if env:
        return {"dir": os.path.abspath(env), "from": "env", "discovery": discovery}
    if discovery["live"]:
        return {"dir": os.path.abspath(discovery["discovery"]["spoolDir"]), "from": "daemon", "discovery": discovery}
    return {"dir": os.path.join(store_dir, "spool", "telemetry"), "from": "default", "discovery": discovery}


def _same_path(a: str, b: str) -> bool:
    """Two folders are one when they resolve to the same real path (a symlinked volume)."""
    return os.path.abspath(a) == os.path.abspath(b) or os.path.realpath(a) == os.path.realpath(b)


def _default_fs() -> Any:
    from airprompter_agent_core.ports import fs_or_default

    return fs_or_default(None)


def default_state_dir() -> str:
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or "."
    if os.environ.get("XDG_STATE_HOME"):
        return os.environ["XDG_STATE_HOME"]
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support")
    if sys.platform == "win32":
        return os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
    return os.path.join(home, ".local", "state")


def _host_os() -> str:
    name = platform.system().lower()
    return {"linux": "linux", "darwin": "darwin", "windows": "windows"}.get(name, "other")


# ----------------------------------------------------------------------------- the runtime


@dataclass
class _Timer:
    thread: Optional[threading.Timer] = None

    def cancel(self) -> None:
        if self.thread is not None:
            self.thread.cancel()
            self.thread = None

    @property
    def armed(self) -> bool:
        return self.thread is not None


class PromptHandle:
    """One prompt slot for one subject: ``render()`` (the call site's values, literals, and plain-callable sources
    on worker threads), ``render_async()`` (coroutine-function sources too), ``needs()`` and ``variables()``."""

    def __init__(self, agent: "AirPrompterAgent", tag: str, subject: Optional[str], tags: Optional[Mapping[str,str]] = None):
        self._agent = agent
        self._tag = tag
        self._subject = subject
        self._tags = copy_audience_tags(tags) if tags is not None else None

    def render(self, values: Optional[Mapping[str, Any]] = None, /, **kwargs: Any) -> Rendered:
        """Synchronous: the call site's values, literal sources and plain-callable sources (each on a worker thread
        under its timeout). A coroutine-function source in the way is ``VariableSourceRequiredError``."""
        merged = {**(values or {}), **kwargs}
        return self._agent._render(self._tag, self._subject, merged, self._tags)

    async def render_async(self, values: Optional[Mapping[str, Any]] = None, /, **kwargs: Any) -> Rendered:
        """The same render with every source awaited (each under its own timeout), values fenced by the stricter trust."""
        merged = {**(values or {}), **kwargs}
        return await self._agent._render_async(self._tag, self._subject, merged, self._tags)

    def needs(self, values: Optional[Mapping[str, Any]] = None, /, **kwargs: Any) -> list[str]:
        """The required names a render would still lack after these values and the registered sources — check it at
        start-up. Resolves the slot as a render would, so a disabled slot raises ``RenderRefusedError`` here too."""
        merged = {**(values or {}), **kwargs}
        return unsourced(variables=self.variables(), values=merged, registry=self._agent.variables)

    def variables(self) -> list[Mapping[str, Any]]:
        return list(self._agent._resolve_slot(self._tag, self._subject, tags=copy_audience_tags({**self._agent._audience_tags, **(self._tags or {})}))[0].get("variables", []))


@dataclass(frozen=True)
class WorkflowHandle(Workflow):
    """A workflow as the facade hands it out: the runtime's ``Workflow`` plus ``render_step()`` /
    ``render_step_async()`` — a step's text with its variables filled under the workflow's declarations, the same
    precedence and the same fencing as a prompt (the resolver renders both), each step scanned on its own: a source
    is called for step 3 and not for step 1 when only step 3 uses it."""

    _render_step: Optional[Callable[[str, Mapping[str, Any]], str]] = field(default=None, repr=False, compare=False)
    _render_step_async: Optional[Callable[[str, Mapping[str, Any]], Awaitable[str]]] = field(default=None, repr=False, compare=False)

    def render_step(self, step_id: str, values: Optional[Mapping[str, Any]] = None, /, **kwargs: Any) -> str:
        assert self._render_step is not None
        return self._render_step(step_id, {**(values or {}), **kwargs})

    async def render_step_async(self, step_id: str, values: Optional[Mapping[str, Any]] = None, /, **kwargs: Any) -> str:
        assert self._render_step_async is not None
        return await self._render_step_async(step_id, {**(values or {}), **kwargs})


class AirPrompterAgent:
    def __init__(self, options: dict[str, Any], store: Optional[SlotStore], trusted_root: Mapping[str, Any], own_instance_id: str, placement: Mapping[str, Any], run_ref_seed: Optional[str] = None):
        self._o = options
        self._store = store
        self._trusted_root: Mapping[str, Any] = trusted_root
        self._own_instance_id = own_instance_id
        self._sync_options: SyncOptions = options["sync"]
        self._apply_options: ApplyOptions = options["apply"]
        self._telemetry: TelemetryOptions = options["telemetry"]
        self._lock = threading.RLock()
        self._sync_lock = threading.Lock()
        self._heartbeat_lock = threading.Lock()
        self._active: Optional[LoadedSlot] = None
        self._source = "store"
        self._last_sync_ms: Optional[float] = None
        self._last_sync_outcome: Optional[str] = None
        self._consecutive_sync_failures = 0
        self._next_sync_ms: Optional[float] = None
        self._change_listeners: list[Callable[[ReleaseChange], None]] = []
        self._etag: Optional[str] = None
        self._edge_etag: Optional[str] = None
        self._timer = _Timer()
        self._window_timer = _Timer()
        self._heartbeat_timer = _Timer()
        self._last_refusal: Optional[str] = None
        # T15: the required models the last model_unavailable refusal named; empty once a release activates.
        self._unavailable_models: list[str] = []
        self._staged_manifest: Optional[Mapping[str, Any]] = None
        self._last_golden: Optional[dict[str, Any]] = None
        self._last_contact_ms: Optional[float] = None
        #: S3: the heartbeat named a generation the pointer has not shown; the next pass goes to the signed manifest.
        self._pointer_behind = False
        self._bundle_not_after: Optional[str] = None
        #: T40: what the last hydration from the customer's datastore found, and its poll timer.
        self._datastore_status: Optional[dict[str, Any]] = None
        self._datastore_timer = _Timer()
        # T9: directives from the latest manifest whose envelope verified — honoured even when that manifest was left staged,
        # held back, or ignored as the generation already held. A Freeze reaches a fleet that never unlocks.
        self._standing_directives: Optional[tuple[int, list[Mapping[str, Any]]]] = None
        self._resolver_for: Optional[tuple[Any, Any, ReleaseResolver]] = None
        #: S4: what the latest verified manifest asked for, and the generation whose advisory mismatch was already logged.
        self._manifest_apply_policy: Optional[tuple[int, str]] = None
        self._apply_policy_advisory_logged = 0
        self._heartbeat_interval_seconds = min(3600, max(30, int(round(options.get("heartbeat_seconds") or 300))))
        self._last_heartbeat_ms: Optional[float] = None
        self._next_heartbeat_ms: Optional[float] = None
        self._last_heartbeat_refusal: Optional[str] = None
        self._halt_without_contact_warned = False
        # T26 / S5: the runtime's own upload grant as the last heartbeat left it, the cadence it asked for, and a hold.
        self._upload_grant: Optional[UploadGrant] = None
        self._upload_interval_seconds = 300
        self._upload_retry_after_ms: Optional[float] = None
        self._uploader: Optional[SpoolUploader] = None
        #: S6: closes the windows of a minute that has passed, so an idle writer never parks a burst's last minute in an ``.open`` file.
        self._spool_timer = _Timer()
        self._flush_lock = threading.Lock()
        self._flush_segment_n = 0
        self._last_flush_minute: Optional[int] = None
        #: ``protocol/daemon.md``: the folder, where it came from, and the daemon's discovery file as last read.
        self._spool_dir: str = placement["dir"]
        self._spool_dir_from: str = placement["from"]
        self._discovery: Optional[dict[str, Any]] = placement.get("discovery")
        self._placing = threading.Lock()
        self._local_window: Optional[UpdateWindow] = parse_window(self._apply_options.window) if self._apply_options.window else None
        self._stamped_refusals: set[str] = set()
        self._stopped = False
        # S6: the runRef key is derived from the STORE's id, which every process on the host shares, so a run_ref minted by one
        # worker parses in another.
        self._audience_server_supported = False
        self._audience_tags = copy_audience_tags(options.get("tags") or {})
        self._audience_tag_keys = set(self._audience_tags)
        self._audience_prompt_labels = {}
        for tag,label in (options.get("prompt_labels") or {}).items(): self._register_prompt_label(tag,label)
        self._run_ref_key = hmac.new((run_ref_seed or own_instance_id).encode("utf-8"), b"runRef", hashlib.sha256).digest()
        # T33: the last renders by text hash, so a wrapped client can tell which slot a call is.
        self._renders = RenderRegistry()
        #: The application's variable sources (``start(variables=...)``, ``ap.variables.provide()``).
        self.variables = VariableSourceRegistry(options.get("variables"))
        # A source stricter than the prompt's declaration is said once per slot and name for the life of the process.
        self._stricter_said: set[str] = set()
        serverless = self._sync_options.mode == "on_invoke"
        sink_kind = self._telemetry.sink or ("memory" if serverless else "directory")
        # Every closed segment gets its manifest: the writer's scope and its heartbeat report, for the telemetry daemon.
        self._directory_sink: Optional[DirectorySink] = None if sink_kind == "memory" else DirectorySink(self._spool_dir, own_instance_id, self._telemetry.spool_budget_bytes or 100 * 1024 * 1024, manifest=self._manifest_context, now=self._now_ms)
        self._sink: SpoolSink = self._directory_sink if self._directory_sink is not None else MemorySink({"instanceId": own_instance_id}, self._telemetry.buffer_bytes or 256 * 1024)
        self.spool = SpoolWriter(self._sink, WriterIdentity(own_instance_id, self._telemetry.instance_class or ("ephemeral" if serverless else "resident"), _USER_AGENT))
        self._client: Optional[SyncClient] = None
        if options.get("api_key") and self._sync_options.mode != "offline":
            self._client = SyncClient(base_url=options.get("base_url") or "https://api.airprompter.com", agent_id=options["agent_id"], target=options["target"], api_key=options["api_key"], transport=options.get("transport"), user_agent=_USER_AGENT)

    # ------------------------------------------------------------------ start

    @classmethod
    def start(
        cls,
        *,
        organization_id: str,
        agent_id: str,
        target: str,
        root: Mapping[str, Any],
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        state_dir: Optional[str] = None,
        key_provider: Optional[KeyProvider] = None,
        countersign_root: Optional[Mapping[str, Any]] = None,
        require_countersign: Optional[bool] = None,
        sync: Optional[Union[SyncOptions, Mapping[str, Any]]] = None,
        vendored_bundle: Optional[Union[VendoredBundle, Mapping[str, Any]]] = None,
        distribution_key: Optional[DistributionKey] = None,
        datastore: Optional[Union[DatastoreOptions, Mapping[str, Any]]] = None,
        apply: Optional[Union[ApplyOptions, Mapping[str, Any]]] = None,
        golden: Optional[Union[GoldenOptions, Mapping[str, Any]]] = None,
        heartbeat_seconds: Optional[float] = None,
        models: Optional[Union[Mapping[str, Any], Sequence[str]]] = None,
        delimiters: Optional[Delimiters] = None,
        telemetry: Optional[Union[TelemetryOptions, Mapping[str, Any]]] = None,
        now: Optional[Callable[[], float]] = None,
        transport: Optional[httpx.BaseTransport] = None,
        random: Optional[Callable[[], float]] = None,
        logger: Optional[Callable[[dict[str, Any]], None]] = None,
        variables: Optional[Mapping[str, VariableSourceInput]] = None,
        tags: Optional[Mapping[str,str]] = None,
        prompt_labels: Optional[Mapping[str,str]] = None,
    ) -> "AirPrompterAgent":
        """``root`` is ``{"pinned": <P-256 public JWK>}`` for this environment, or a full root document (from the bundle or a previous accept).
        ``api_key`` absent means offline: serve the store or the vendored bundle, never call home.
        ``variables`` is how this application fills prompt variables from its own system: a literal per name, or a
        source (``{"resolve": callable, "trust": "operator"|"end_user", ...}``) consulted for a declared variable the
        version's text uses and the call site did not pass. ``ap.variables.provide()`` adds more after start."""
        raw_sync = sync if isinstance(sync, Mapping) else (vars(sync) if sync is not None else {})
        if raw_sync.get("mode") == "daemon" or "daemon_socket_path" in raw_sync:
            raise AgentStartError(
                "invalid_options",
                'sync mode "daemon" was removed in 0.3.0: the telemetry daemon (airprompterd) only ships telemetry and never serves a release. '
                "Start with the default mode (resident) — each process loads its release from its own store, the datastore or a vendored bundle — "
                "and keep the daemon running for telemetry (protocol/daemon.md)",
            )
        sync_options = _coerce(SyncOptions, sync)
        options: dict[str, Any] = {
            "tags": tags,
            "prompt_labels": prompt_labels,
            "organization_id": organization_id,
            "agent_id": agent_id,
            "target": target,
            "api_key": api_key,
            "base_url": base_url,
            "countersign_root": countersign_root,
            "require_countersign": require_countersign,
            "sync": sync_options,
            "vendored_bundle": _coerce(VendoredBundle, vendored_bundle) if vendored_bundle is not None else None,
            # The fleet's X25519 distribution private key: opens every sealed bundle this host is handed — the vendored
            # one and every apply_bundle() — when neither names its own. Held by runtimes, never by the puller.
            "distribution_key": distribution_key,
            "datastore": _coerce(DatastoreOptions, datastore) if datastore is not None else None,
            "apply": _coerce(ApplyOptions, apply),
            "golden": _coerce(GoldenOptions, golden) if golden is not None else None,
            "heartbeat_seconds": heartbeat_seconds,
            "models": models,
            "delimiters": delimiters,
            "telemetry": _coerce(TelemetryOptions, telemetry),
            "now": now,
            "transport": transport,
            "random": random,
            "logger": logger,
            "variables": variables,
        }
        resolved_state_dir = state_dir or default_state_dir()
        # The root is scoped to the HOSTED environment (the public service is "prod"), never to this app's target.
        pinned_root = trusted_root_from_pinned_key(purpose="platform", environment=root.get("hosted_environment", "prod"), pinned_root=root["pinned"]) if "pinned" in root else root
        provider = key_provider or file_key(os.path.join(SlotStore.path(state_dir=resolved_state_dir, agent_id=agent_id, target=target), "store.key"))
        try:
            # S8: store.json records who wrote it — this SDK by default.
            store = SlotStore.open(state_dir=resolved_state_dir, agent_id=agent_id, target=target, key_provider=provider, hooks=StoreHooks(writer={"name": "agent-sdk-python", "version": SDK_VERSION}))
        except StoreError as error:
            if error.code in ("kek_unavailable", "store_corrupt", "store_newer"):
                raise AgentStartError(error.code, str(error)) from error
            raise
        # The stored root (accepted on an earlier run) is trusted only if it still verifies against the pinned key.
        stored = store.state.get("root")
        now_iso = iso_ms(now() if now else now_ms())
        trusted = stored if stored and verify_root_metadata(candidate=stored, trusted=pinned_root, now=now_iso).ok else pinned_root
        # S6: the instance id is the PROCESS's, never the store's — N workers on one host are N instances in the fleet view, and
        # their same-minute windows keep distinct keys at ingest (the store's own id stays store.json's identity).
        agent = cls(options, store, trusted, cls.new_instance_id(), _spool_placement(options, store.dir, now() if now else now_ms()), store.instance_id)
        agent._boot()
        return agent

    # ------------------------------------------------------------------ boot

    def _verify_options(self, now: str) -> dict[str, Any]:
        return {"now": now, "root": self._trusted_root, "countersign_root": self._o.get("countersign_root"), "require_countersign": self._o.get("require_countersign")}

    def _take_vendored_bundle(self, now: str) -> None:
        vendored: VendoredBundle = self._o["vendored_bundle"]
        try:
            if isinstance(vendored.bundle, str):
                with open(vendored.bundle, encoding="utf-8") as f:
                    bundle = json.load(f)
            else:
                bundle = vendored.bundle
            contents = open_bundle(bundle, {"agentId": self._o["agent_id"], "target": self._o["target"]}, vendored.distribution_key or self._o.get("distribution_key"))
        except Exception as error:  # noqa: BLE001
            self._log({"event": "vendored_bundle_unusable", "reason": str(error)})
            return
        self._take_bundle(contents, "vendored_bundle", now)

    def _take_bundle(self, contents: Mapping[str, Any], source: str, now: str) -> dict[str, Any]:
        """A release handed to this host as a bundle — vendored at boot, or applied at run time from the customer's own
        store. With nothing active it is the tier-3 fallback: staged through the store and activated whatever its
        generation. With a release serving it is an UPDATE like any other: above the held generation it runs the same
        chain as OTA — signatures, scope, every payload's hash — and is staged, then the host's apply policy decides
        (auto activates; unlock_required stages, then the hook, the window, ``unlock()``); the held generation changes
        nothing; one BELOW it is refused — a rollback is ``rollback()``, never an older bundle; past ``notAfter`` it is
        refused as an update and applied only as the fallback. Never raises; the outcome says what happened."""
        store = self._store
        assert store is not None
        generation = int(contents["manifest"]["payload"]["generation"])
        days_left = (instant(contents["notAfter"]) - instant(now)) // 86_400_000
        # A first release staged under unlock_required (nothing active, something staged) is a HELD generation: a bundle
        # at or below it is not a fallback to activate around the unlock, it is the update path with its rules.
        updating = self._active is not None or self._staged_manifest is not None
        if updating:
            held = max(int(store.state.get("generation", 0)), int(self._staged_manifest["payload"]["generation"]) if self._staged_manifest else 0)
            if generation == held:
                return {"outcome": "unchanged", "generation": generation}
            if generation < held:
                self._log({"event": f"{source}_refused", "reason": "generation_rollback", "bundleGeneration": generation, "heldGeneration": held, "message": f"the bundle is generation {generation}; this host holds {held}. A bundle never moves a host backwards — a rollback is `airprompter rollback`, never an older bundle."})
                self._last_refusal = "generation_rollback"
                return {"outcome": "refused", "generation": generation, "reason": "generation_rollback", "held": held}
            held_back = store.state.get("heldBackBelow")
            if held_back is not None and generation <= int(held_back):
                self._log({"event": f"{source}_held_back", "bundleGeneration": generation, "heldBackBelow": held_back})
                return {"outcome": "held_back", "generation": generation, "heldBackBelow": int(held_back)}
            if days_left < 0:
                self._log({"event": f"{source}_refused", "reason": "expired", "bundleGeneration": generation, "notAfter": contents["notAfter"]})
                return {"outcome": "refused", "generation": generation, "reason": "expired"}
        else:
            self._bundle_not_after = contents["notAfter"]
            if days_left < 0:
                self._log({"event": f"{source}_past_not_after", "notAfter": contents["notAfter"]})
            elif days_left < VENDORED_BUNDLE_EXPIRY_WARNING_DAYS:
                self._log({"event": f"{source}_expiring_soon", "notAfter": contents["notAfter"], "daysLeft": days_left})
        try:
            verdict = verify_root_metadata(candidate=contents["keySet"], trusted=self._trusted_root, now=now)
            if verdict.ok:
                self._trusted_root = contents["keySet"]
                store.accept_root(contents["keySet"])
            payloads = bundle_payload_bytes(contents)
            # The same chain as OTA — signatures, scope, anti-rollback, every payload's hash — BEFORE a byte is staged, in
            # both branches. Staging first and letting load refuse left store.json advanced to a forged generation, and a
            # fresh host then refused every legitimate release below it: a compromised store could brick a fleet's runtimes.
            scope = {"organizationId": self._o["organization_id"], "agentId": self._o["agent_id"], "target": self._o["target"]}
            full = verify_manifest(manifest=contents["manifest"], root=self._trusted_root, now=now, scope=scope, stored_generation=int(store.state.get("generation", 0)) if updating else 0, payloads=payloads, countersign_root=self._o.get("countersign_root"), require_countersign=self._o.get("require_countersign"))
            if not full.ok:
                self._log({"event": f"{source}_refused", "reason": full.reason, "bundleGeneration": generation})
                self._last_refusal = full.reason
                return {"outcome": "refused", "generation": generation, "reason": full.reason}
            # T15: the models this application declared it can call gate a bundle exactly as they gate a release over the air.
            missing = required_models_missing(contents["manifest"]["payload"], self._declared_models())
            if missing:
                self._unavailable_models = list(missing)
                self.spool.refusal(at=now, reason="model_unavailable", generation=generation, tag=None, at_ms=self._now_ms())
                self._log({"event": f"{source}_refused", "reason": "model_unavailable", "bundleGeneration": generation, "models": missing})
                self._last_refusal = "model_unavailable"
                return {"outcome": "refused", "generation": generation, "reason": "model_unavailable", "detail": ", ".join(missing)}
            if updating:
                self._take_verified(contents["manifest"]["payload"])
                store.stage(manifest=contents["manifest"], payloads=payloads)
                decision = self._apply_policy(contents["manifest"])
                if decision == "staged":
                    self._log({"event": f"{source}_staged", "generation": generation})
                    self._emit_change()
                    return {"outcome": "staged", "generation": generation}
                if decision == "activated":
                    slot = store.activate()
                    loaded = store.load(slot, **self._verify_options(now))
                    with self._lock:
                        self._active = loaded
                        self._staged_manifest = None
                with self._lock:
                    self._source = "store"
                    self._last_refusal = None
                    self._unavailable_models = []
                self._log({"event": f"{source}_activated", "generation": self._active.generation})
                self._emit_change()
                return {"outcome": "activated", "generation": self._active.generation}
            # Stage through the store so the bundle's release becomes the encrypted A slot: verified above, like OTA.
            store.stage(manifest=contents["manifest"], payloads=payloads)
            slot = store.activate()
            loaded = store.load(slot, **self._verify_options(now))
            with self._lock:
                self._active = loaded
                self._staged_manifest = None
                self._source = "vendored_bundle" if source == "vendored_bundle" else "store"
                self._last_refusal = None
                self._unavailable_models = []
            self._log({"event": f"{source}_applied", "generation": self._active.generation})
            self._emit_change()
            return {"outcome": "activated", "generation": self._active.generation}
        except Exception as error:  # noqa: BLE001
            self._log({"event": f"{source}_unusable", "reason": str(error)})
            return {"outcome": "refused", "generation": generation, "reason": "unusable", "detail": str(error)}

    def apply_bundle(self, bundle: Union[Mapping[str, Any], str], *, distribution_key: Optional[DistributionKey] = None) -> dict[str, Any]:
        """A release from the customer's own store, at run time (T39). The fleet pattern: one puller writes the bundle
        into a database, every runtime reads the newest row and hands it here when the generation rises. The same chain
        and the same rules as a vendored bundle — verified before a byte is staged, the apply policy decides, never
        below the held generation (a restored backup or a stale replica cannot move a host backwards) — and the swap is
        atomic: renders in flight finish on the release they resolved against. Never raises on a bad bundle; the outcome
        says why."""
        if self._store is None:
            return {"outcome": "refused", "generation": None, "reason": "no_store"}
        now = self._now_iso()
        try:
            parsed = json.loads(bundle) if isinstance(bundle, str) else bundle
            vendored = self._o.get("vendored_bundle")
            key = distribution_key or self._o.get("distribution_key") or (vendored.distribution_key if vendored is not None else None)
            contents = open_bundle(parsed, {"agentId": self._o["agent_id"], "target": self._o["target"]}, key)
        except Exception as error:  # noqa: BLE001
            self._log({"event": "applied_bundle_unusable", "reason": str(error)})
            return {"outcome": "refused", "generation": None, "reason": "unusable", "detail": str(error)}
        # One pass over the store at a time, like sync_now: the pass under _sync_lock (so a sync and an apply never
        # interleave in the same slot). _take_bundle takes _lock only around the in-memory swap, so a render on another
        # thread never waits on the on_staged hook or the golden runs, and a hook that renders from a worker cannot
        # deadlock.
        with self._sync_lock:
            return self._take_bundle(contents, "applied_bundle", now)

    def _boot(self) -> None:
        """Store first (active slot, then the other), then the vendored bundle (S7: an update when newer, the fallback when nothing is held), then refuse. Zero network."""
        store = self._store
        if store is None:
            raise AgentStartError("no_verified_release", "boot without a store")
        now = self._now_iso()
        state = store.state
        active_slot = state.get("active")
        # The other slot is a fallback only when it holds a previously activated release: a release staged under
        # unlock_required and never unlocked is not approved for this host and is never served by accident.
        for slot in (active_slot, ("B" if active_slot == "A" else "A") if active_slot else None):
            if not slot or (slot != active_slot and slot == state.get("staged")):
                continue
            try:
                extra = {"expect_generation": state["generation"]} if slot == active_slot else {}
                loaded = store.load(slot, **self._verify_options(now), **extra)
                if slot != active_slot:
                    self._log({"event": "fallback_to_other_slot", "slot": slot})
                self._active = loaded
                self._source = "store"
                break
            except Exception as error:  # noqa: BLE001
                self._log({"event": "slot_unusable", "slot": slot, "reason": str(error)})
        # A staged slot left by an unanswered unlock (or a crash after staging) is still staged: report it, keep it verifiable.
        staged = state.get("staged")
        if staged and staged != active_slot:
            try:
                self._staged_manifest = store.load(staged, **self._verify_options(now)).manifest
            except Exception as error:  # noqa: BLE001
                self._log({"event": "staged_slot_unusable", "slot": staged, "reason": str(error)})
                store.discard_staged()
        if self._o.get("datastore") is not None:
            self._take_datastore(now)
        if self._o.get("vendored_bundle") is not None:
            self._take_vendored_bundle(now)
        if self._active is None and self._client is not None:
            # Nothing verified locally: one synchronous sync before serving is the only time the SDK waits on the network.
            self.sync_now()
        if self._active is None:
            # A first release staged under unlock_required (the sync just staged it, or a restart found it in the store) is
            # a host with nothing to serve yet — not a host that cannot run. T9 makes the unlock the customer's to give, and
            # a process that refuses to start can never give it: so it starts, heartbeats as generation 0 with the staged
            # generation beside it, keeps syncing, and answers unlock(), the window, or the hook. prompt() refuses until then.
            if self._staged_manifest is None:
                raise AgentStartError("no_verified_release", "no verified release in the store, no usable vendored bundle, and nothing could be fetched")
            self._log({"event": "awaiting_first_unlock", "generation": self._staged_manifest["payload"]["generation"]})
        if self._client is not None and self._sync_options.mode == "resident":
            self._schedule()
            # The first heartbeat goes out right after boot so the fleet view sees the instance before its first interval.
            threading.Thread(target=self._first_heartbeat, name="airprompter-heartbeat", daemon=True).start()
        # Who ships the spool: a live telemetry daemon naming this folder, else this process (with a client, or — S13 — a
        # sink of the customer's own, offline too), else nobody until one appears. Re-checked by the spool timer.
        self.check_telemetry_daemon()
        self._schedule_spool_close()
        self._schedule_window_unlock()
        self._schedule_datastore_poll()

    # ------------------------------------------------------------------ the customer's datastore (T40)

    def _schedule_datastore_poll(self) -> None:
        """Re-read the datastore on a timer, off the request path, when ``datastore.poll_seconds`` asks for it."""
        options: Optional[DatastoreOptions] = self._o.get("datastore")
        self._datastore_timer.cancel()
        if options is None or not options.poll_seconds or self._stopped:
            return

        def tick() -> None:
            try:
                self.hydrate()
            finally:
                self._schedule_datastore_poll()

        self._datastore_timer.thread = self._arm(max(1.0, float(options.poll_seconds)), tick)

    def hydrate(self) -> dict[str, Any]:
        """T40: hydrate from the customer's datastore now — the row for this region (else the global rows), the rollback
        in force applied. One pass over the store at a time, like ``apply_bundle``. Never raises; the outcome says what
        happened: a bundle outcome, ``rolled_back``, ``empty`` or ``unavailable``."""
        if self._o.get("datastore") is None:
            return {"outcome": "refused", "generation": None, "reason": "no_datastore"}
        if self._store is None:
            return {"outcome": "refused", "generation": None, "reason": "no_store"}
        with self._sync_lock:
            return self._take_datastore(self._now_iso())

    def _datastore_key(self) -> ReleaseKey:
        options: DatastoreOptions = self._o["datastore"]
        return ReleaseKey(self._o["organization_id"], self._o["agent_id"], self._o["target"], options.region)

    def _take_datastore(self, now: str) -> dict[str, Any]:
        """One read of the datastore and what it asks of this host. Without a rollback in force the newest row is an
        update like any ``apply_bundle`` (never below the held generation) — and a local hold the datastore no longer
        asks for is released first. With one in force the row it names is served: below what the host holds it is a
        forced downgrade (verified through the whole chain, stamped, ``forced_downgrade`` in the spool), and every
        generation up to the rollback's ``held_back_below`` is held back until the fleet moves past it."""
        options: DatastoreOptions = self._o["datastore"]
        store = self._store
        assert store is not None
        key = self._datastore_key()

        def record(plan: Optional[HydrationPlan], outcome: dict[str, Any]) -> dict[str, Any]:
            previous = self._datastore_status or {}
            rollback = previous.get("rollback")
            if plan is not None:
                control = plan.control
                rollback = {"generation": control.generation, "held_back_below": control.held_back_below, "scope": plan.control_scope, "set_at": control.set_at, **({"reason": control.reason} if control.reason else {})} if control else None
            self._datastore_status = {
                "region": key.region,
                "last_hydrate_at": now,
                "last_outcome": outcome["outcome"],
                "newest_generation": plan.newest if plan is not None else previous.get("newest_generation", 0),
                "rows_from": plan.rows_from if plan is not None else previous.get("rows_from"),
                "rollback": rollback,
            }
            return outcome

        try:
            plan = resolve_hydration(options.store, key)
        except Exception as error:  # noqa: BLE001 — the datastore is down: keep serving what is held
            detail = str(error)[:240]
            self._log({"event": "datastore_unavailable", "region": key.region, "reason": detail})
            return record(None, {"outcome": "unavailable", "generation": None, "detail": detail})
        if plan.missing_rollback_generation is not None:
            self._log({"event": "datastore_rollback_missing", "region": key.region, "generation": plan.missing_rollback_generation, "message": f"the datastore's rollback names generation {plan.missing_rollback_generation}, which it does not hold; serving the newest row"})
        if plan.row is None:
            return record(plan, {"outcome": "empty", "generation": None})
        try:
            vendored = self._o.get("vendored_bundle")
            contents = open_bundle(json.loads(plan.row.bundle), {"agentId": self._o["agent_id"], "target": self._o["target"]}, self._o.get("distribution_key") or (vendored.distribution_key if vendored is not None else None))
        except Exception as error:  # noqa: BLE001
            self._log({"event": "datastore_row_unusable", "region": key.region, "generation": plan.row.generation, "reason": str(error)})
            return record(plan, {"outcome": "refused", "generation": plan.row.generation, "reason": "unusable", "detail": str(error)})
        generation = int(contents["manifest"]["payload"]["generation"])
        control = plan.control
        if control is None:
            held_back = store.state.get("heldBackBelow")
            if held_back is not None and generation > int(store.state.get("generation", 0)):
                store.release_hold()
                self._log({"event": "datastore_hold_released", "heldBackBelow": held_back, "generation": generation})
            return record(plan, self._take_bundle(contents, "datastore", now))
        held = max(int(store.state.get("generation", 0)), int(self._staged_manifest["payload"]["generation"]) if self._staged_manifest else 0)
        if self._active is not None and self._active.generation == generation:
            outcome: dict[str, Any] = {"outcome": "unchanged", "generation": generation}
        elif self._active is not None and generation < held:
            outcome = self._take_rollback(contents, control.held_back_below, now)
        else:
            # Up to (or, with nothing active, onto) the rollback's generation: an update like any other, past a hold the
            # datastore's own rollback set — which is set again below either way.
            store.release_hold()
            outcome = self._take_bundle(contents, "datastore", now)
        store.hold_back(control.held_back_below)
        return record(plan, outcome)

    def _take_rollback(self, contents: Mapping[str, Any], held_back_below: int, now: str) -> dict[str, Any]:
        """The datastore's rollback below what the host holds — the whole chain, then a forced step down and a hold."""
        store = self._store
        assert store is not None
        generation = int(contents["manifest"]["payload"]["generation"])
        if instant(contents["notAfter"]) < instant(now):
            self._log({"event": "datastore_rollback_refused", "reason": "expired", "generation": generation, "notAfter": contents["notAfter"]})
            return {"outcome": "refused", "generation": generation, "reason": "expired"}
        try:
            verdict = verify_root_metadata(candidate=contents["keySet"], trusted=self._trusted_root, now=now)
            if verdict.ok:
                self._trusted_root = contents["keySet"]
                store.accept_root(contents["keySet"])
            payloads = bundle_payload_bytes(contents)
            scope = {"organizationId": self._o["organization_id"], "agentId": self._o["agent_id"], "target": self._o["target"]}
            # An older release is still a SIGNED release for this scope: everything but the counter is checked.
            full = verify_manifest(manifest=contents["manifest"], root=self._trusted_root, now=now, scope=scope, stored_generation=0, payloads=payloads, countersign_root=self._o.get("countersign_root"), require_countersign=self._o.get("require_countersign"))
            if not full.ok:
                self._log({"event": "datastore_rollback_refused", "reason": full.reason, "generation": generation})
                self._last_refusal = full.reason
                return {"outcome": "refused", "generation": generation, "reason": full.reason}
            missing = required_models_missing(contents["manifest"]["payload"], self._declared_models())
            if missing:
                self._log({"event": "datastore_rollback_refused", "reason": "model_unavailable", "generation": generation, "models": missing})
                return {"outcome": "refused", "generation": generation, "reason": "model_unavailable", "detail": ", ".join(missing)}
            # The inactive slot is overwritten: a staged release there is not approved for this host any more.
            if store.state.get("staged"):
                store.discard_staged()
            store.stage(manifest=contents["manifest"], payloads=payloads, force=True)
            slot = store.activate()
            store.hold_back(held_back_below)
            loaded = store.load(slot, **self._verify_options(now))
            with self._lock:
                self._active = loaded
                self._staged_manifest = None
                self._source = "store"
                self._last_refusal = None
            self.spool.refusal(at=now, reason="forced_downgrade", generation=generation, tag=None, at_ms=self._now_ms())
            self._log({"event": "datastore_rolled_back", "generation": generation, "heldBackBelow": held_back_below})
            self._emit_change()
            return {"outcome": "rolled_back", "generation": generation, "heldBackBelow": held_back_below}
        except Exception as error:  # noqa: BLE001
            self._log({"event": "datastore_rollback_unusable", "reason": str(error), "generation": generation})
            return {"outcome": "refused", "generation": generation, "reason": "unusable", "detail": str(error)}

    def _schedule_spool_close(self) -> None:
        """S6: once a minute, the windows of the minute that passed are written and the open segment closed — never the current minute."""
        self._spool_timer.cancel()
        if self._stopped or self._sync_options.mode == "on_invoke":
            return

        def tick() -> None:
            try:
                self.spool.close_stale_windows(self._now_ms())
                self.check_telemetry_daemon()
            finally:
                self._schedule_spool_close()

        self._spool_timer.thread = self._arm(60.0, tick)

    def check_telemetry_daemon(self) -> dict[str, Any]:
        """``protocol/daemon.md``, once a minute and at boot: where to write (an explicit folder never moves; a discovered one
        follows the daemon's ``daemon.json``) and who uploads — a live daemon naming this folder does, and this process's
        own uploader stops; when the daemon goes (its file stale or gone) the uploader starts again. Never raises."""
        with self._placing:
            try:
                self._place_telemetry()
            except Exception as error:  # noqa: BLE001
                self._log({"event": "telemetry_placement_failed", "reason": str(error)})
        return self._telemetry_placement()

    def _place_telemetry(self) -> None:
        sink = self._directory_sink
        if sink is None or self._store is None or self._stopped:
            return
        placement = _spool_placement(self._o, self._store.dir, self._now_ms())
        self._discovery = placement["discovery"]
        moved = placement["dir"] != self._spool_dir
        if moved:
            # The daemon published another folder (or went away and the store's is back): new segments go there.
            sink.move_to(placement["dir"], self._now_ms())
            self._log({"event": "spool_moved", "from": self._spool_dir, "to": placement["dir"], "source": placement["from"]})
            self._spool_dir = placement["dir"]
        self._spool_dir_from = placement["from"]
        # An uploader sweeps the folder it was started on: a move stops it, and a new one starts below if it is still ours.
        daemon_ships = self._daemon_ships_spool()
        if self._uploader is not None and (moved or daemon_ships):
            self._stop_uploader("upload_handed_to_daemon" if daemon_ships else "uploader_restarted")
        if not daemon_ships and self._sync_options.mode == "resident" and self._uploader is None:
            self._start_uploader()
            found = (self._discovery or {}).get("discovery")
            if self._uploader is not None and found:
                self._log({"event": "upload_taken_back", "reason": "daemon_ships_another_folder" if (self._discovery or {}).get("live") else (self._discovery or {}).get("reason")})

    def _daemon_ships_spool(self) -> bool:
        """A live daemon for this agent and target that ships somewhere (``sink`` is not ``none``) names the folder this
        process writes (the same path, symlinks resolved)."""
        found = self._discovery
        return bool(found and found.get("live") and found["discovery"].get("sink") != "none" and _same_path(found["discovery"]["spoolDir"], self._spool_dir))

    def _stop_uploader(self, event: str) -> None:
        uploader = self._uploader
        self._uploader = None
        if uploader is not None:
            uploader.stop()
        self._log({"event": event})

    def _telemetry_placement(self) -> dict[str, Any]:
        found = (self._discovery or {}).get("discovery")
        live = bool((self._discovery or {}).get("live"))
        daemon = None
        if found and (live or (self._discovery or {}).get("reason") == "stale"):
            daemon = {"live": live, "pid": found.get("pid"), "version": (found.get("daemon") or {}).get("version", ""), "heartbeat_at": found.get("heartbeatAt"), "spool_dir": found.get("spoolDir")}
        if self._directory_sink is None:
            return {"sink": "memory", "spool_dir": None, "spool_dir_from": None, "uploaded_by": "none", "daemon": daemon}
        uploaded_by = "self" if self._uploader is not None else ("daemon" if self._daemon_ships_spool() else "none")
        return {"sink": "directory", "spool_dir": self._spool_dir, "spool_dir_from": self._spool_dir_from, "uploaded_by": uploaded_by, "daemon": daemon}

    def _manifest_context(self) -> dict[str, Any]:
        """What each closed segment's manifest carries: this writer's scope and its heartbeat report as it stands."""
        return {"organizationId": self._o["organization_id"], "agentId": self._o["agent_id"], "target": self._o["target"], "report": self.heartbeat_body()}

    def _start_uploader(self) -> None:
        """S5: the telemetry daemon is an optimisation, never a requirement — a resident host with no live daemon uploads its own spool. The same
        uploader the daemon runs, in-process, on a timer off the request path: closed segments go out under this runtime's own
        grant, a failed pass backs off, and past the budget the oldest unsent segments are dropped and counted. Never blocks a render."""
        # S13: a sink of the customer's own (the OpenTelemetry bridge) needs no client and no grant: it runs offline too.
        custom_sink = self._telemetry.upload_sink
        if self._uploader is not None or (custom_sink is None and self._client is None) or self._store is None or not self._telemetry.upload or self._stopped:
            return
        if self._directory_sink is None:
            return  # a memory sink has no directory to sweep; flush_telemetry() is its path

        def grant_for(instance_id: str, report: Optional[dict[str, Any]] = None) -> GrantDecision:
            return self.request_upload_grant(instance_id=instance_id, instance_class=self._telemetry.instance_class or "resident", report=report)

        uploader = SpoolUploader(
            directory=self._spool_dir,
            instance_id=self._own_instance_id,
            # A shared folder: another agent's or target's segments are left for its own uploader.
            scope={"agentId": self._o["agent_id"], "target": self._o["target"]},
            **({"sink": custom_sink} if custom_sink is not None else {"grant_for": grant_for}),
            transport=self._o.get("transport"),
            now_ms=self._now_ms,
            rand=self._rand,
            logger=self._log,
            interval_seconds=self._upload_interval_seconds,
            budget_bytes=self._telemetry.spool_budget_bytes,
        )
        self._uploader = uploader
        uploader.start()
        self._log({"event": "uploader_started", "intervalSeconds": self._upload_interval_seconds, "sink": uploader.sink.kind})

    def upload_now(self) -> Optional[dict[str, Any]]:
        """S5: one upload pass now (tests and operators); ``None`` when this process runs no uploader. Never raises."""
        if self._uploader is None:
            return None
        result = self._uploader.run_once()
        return {"uploaded": len(result.uploaded), "quarantined": len(result.quarantined), "dropped": result.dropped, "held": result.held}

    def _first_heartbeat(self) -> None:
        try:
            self.heartbeat_now()
        finally:
            self._schedule_heartbeat()

    # ------------------------------------------------------------------ plumbing

    def on_change(self, listener: Callable[[ReleaseChange], None]) -> Callable[[], None]:
        """Called whenever the active or staged generation changes (sync, unlock, rollback, apply_bundle, hydrate)."""
        self._change_listeners.append(listener)
        return lambda: self._change_listeners.remove(listener) if listener in self._change_listeners else None

    def _emit_change(self) -> None:
        change = ReleaseChange(self.generation, self.status().staged_generation)
        for listener in list(self._change_listeners):
            listener(change)

    @property
    def release(self) -> Optional[LoadedSlot]:
        """The active, verified release this process serves (manifest + payload bytes), or None."""
        return self._active

    def _log(self, event: dict[str, Any]) -> None:
        logger = self._o.get("logger")
        if logger:
            logger({"sdk": SDK_NAME, "agentId": self._o["agent_id"], "target": self._o["target"], **event})

    def _now_ms(self) -> float:
        now = self._o.get("now")
        return now() if now else now_ms()

    def _now_iso(self) -> str:
        return iso_ms(self._now_ms())

    def _rand(self) -> float:
        rand = self._o.get("random")
        return rand() if rand else _random.random()

    def _arm(self, delay_seconds: float, fn: Callable[[], None]) -> threading.Timer:
        timer = threading.Timer(max(0.0, delay_seconds), fn)
        timer.daemon = True
        timer.start()
        return timer

    def _schedule(self) -> None:
        self._timer.cancel()
        if self._stopped:
            return
        delay_ms = jittered_delay_ms(self._sync_options.poll_seconds, self._rand)
        self._next_sync_ms = self._now_ms() + delay_ms

        def tick() -> None:
            try:
                self.sync_now()
            finally:
                self._schedule()

        self._timer.thread = self._arm(delay_ms / 1000, tick)

    # ------------------------------------------------------------------ apply policy (T9)

    def _apply_policy(self, manifest: Mapping[str, Any]) -> str:
        """``auto`` activates. ``unlock_required`` stages, then: inside an open update window → activates now; the customer's
        ``on_staged`` hook may call ``activate()`` (a hook that raises or never activates leaves the release staged and says so
        in the log); otherwise the window timer, an operator's ``unlock``, or the hook later. The policy is the host's (S4):
        the pin in store.json, tightened by a manifest and never loosened by one, with this process's own ``apply.policy`` on top."""
        payload = manifest["payload"]
        self._take_apply_policy(payload)
        policy = self._effective_apply_policy()["effective"]
        # T34: verified before activate — a staged release's golden sets run first; below the floor it stays staged.
        golden_options: Optional[GoldenOptions] = self._o.get("golden")
        if golden_options is not None and manifest_has_golden(manifest) and self._store is not None:
            staged_slot = self._store.state.get("staged")
            payloads = self._store.load(staged_slot, **self._verify_options(self._now_iso())).payloads if staged_slot else {}
            reports = self._run_golden_for(manifest, payloads, golden_options.invoke, golden_options.concurrency)
            if not golden_reports_meet(reports):
                self._staged_manifest = manifest
                for report in reports:
                    if not report.meets_threshold:
                        self._log({"event": "golden_set_failed", "generation": payload["generation"], "tag": report.tag, "arm": report.arm, "passed": report.passed, "cases": report.cases, "minPassBps": report.min_pass_bps})
                return "staged"
        if policy == "auto":
            return "activated"
        self._staged_manifest = manifest
        governing = self._window_in_force(manifest)
        if governing and window_state(governing[1], self._now_ms()).open:
            self._log({"event": "window_open_on_stage", "generation": payload["generation"], "source": governing[0]})
            self._staged_manifest = None
            return "activated"
        request = next((d for d in self._open_unlock_requests(payload) if d.get("releaseDigest") == payload.get("releaseDigest")), None)
        activation: list[Optional[dict[str, int]]] = []

        def activate() -> None:
            if not activation:
                activation.append(self.unlock())

        hook = self._apply_options.on_staged
        if hook is not None:
            try:
                hook(StagedRelease(payload["generation"], manifest, activate, request))
            except Exception as error:  # noqa: BLE001 — the hook refused (change control said no, or it broke)
                self._log({"event": "on_staged_hook_rejected", "generation": payload["generation"], "reason": str(error)})
        if activation and activation[0]:
            return "activated_externally"
        if self._staged_manifest is None:
            return "activated_externally"
        self._schedule_window_unlock()
        return "staged"

    def _window_in_force(self, manifest: Optional[Mapping[str, Any]]) -> Optional[tuple[str, UpdateWindow]]:
        """The window that governs this runtime: the local one, else the manifest's; None when neither is set."""
        if self._local_window:
            return ("local", self._local_window)
        carried = (manifest or {}).get("payload", {}).get("unlockWindow") if manifest else None
        if not carried:
            return None
        try:
            return ("manifest", parse_window(carried))
        except ValueError as error:
            self._log({"event": "manifest_window_unusable", "reason": str(error)})
            return None

    def _schedule_window_unlock(self) -> None:
        """While a release is staged and a window applies, wake at the next opening and activate."""
        self._window_timer.cancel()
        if self._stopped or self._staged_manifest is None:
            return
        governing = self._window_in_force(self._staged_manifest)
        if not governing:
            return
        state = window_state(governing[1], self._now_ms())
        delay_ms = max(1000, min(2_147_000_000, (0 if state.open else state.opens_at_ms - self._now_ms()) + 500))

        def fire() -> None:
            self._window_timer.thread = None
            staged = self._staged_manifest
            if staged is None:
                return
            if window_state(governing[1], self._now_ms()).open:
                self._log({"event": "window_unlock", "generation": staged["payload"]["generation"], "source": governing[0]})
                self.unlock()
            self._schedule_window_unlock()

        self._window_timer.thread = self._arm(delay_ms / 1000, fire)

    def _open_unlock_requests(self, payload: Optional[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
        """Unexpired ``request_unlock`` directives from the latest verified manifest (or the active one before any sync)."""
        standing = self._standing_directives
        if standing and (payload is None or standing[0] >= payload["generation"]):
            directives = standing[1]
        else:
            directives = list(payload.get("directives", [])) if payload else []
        now = self._now_ms()
        return [d for d in directives if d.get("kind") == "request_unlock" and instant(d["expiresAt"]) > now]

    # ------------------------------------------------------------------ sync

    def sync_now(self) -> None:
        """One sync pass now (resident timers call this; on_invoke hosts call it from ``invoke``). Never raises."""
        if self._client is None or self._store is None:
            return
        with self._sync_lock:
            root_url = self._sync_options.root_url

            def on_refusal(reason: str, generation: Optional[int]) -> None:
                self._last_refusal = reason
                self._log({"event": "sync_refused", "reason": reason, "generation": generation})

            def on_model_unavailable(models: list[str], generation: int) -> None:
                self._unavailable_models = list(models)
                self.spool.refusal(at=self._now_iso(), reason="model_unavailable", generation=generation, tag=None, at_ms=self._now_ms())

            result = sync_once(
                store=self._store,
                client=self._client,
                now=self._now_iso,
                scope={"organizationId": self._o["organization_id"], "agentId": self._o["agent_id"], "target": self._o["target"]},
                trusted_root=self._trusted_root,
                fetch_root=(lambda: self._fetch_root(root_url)) if root_url else None,
                active=self._active,
                etag=self._etag,
                edge_pointer_url=self._sync_options.edge_pointer_url,
                edge_etag=self._edge_etag,
                skip_pointer=self._pointer_behind,
                require_countersign=self._o.get("require_countersign"),
                countersign_root=self._o.get("countersign_root"),
                apply_policy=self._apply_policy,
                on_refusal=on_refusal,
                on_directives=self._take_verified,
                catalog=self._declared_models(),
                on_model_unavailable=on_model_unavailable,
            )
            with self._lock:
                self._etag = result.etag
                self._edge_etag = result.edge_etag
                self._trusted_root = result.trusted_root
                self._last_sync_ms = self._now_ms()
                self._last_sync_outcome = result.outcome
                # S3: contact is a signed manifest or the origin's authenticated answer — never the pointer's silence.
                contact = result.outcome in ("unchanged", "activated", "activated_externally", "staged", "nothing_promoted", "held_back")
                if contact:
                    self._last_contact_ms = self._now_ms()
                if result.outcome not in ("pointer_unchanged", "unavailable"):
                    self._pointer_behind = False
                self._consecutive_sync_failures = 0 if (contact or result.outcome == "pointer_unchanged") else self._consecutive_sync_failures + 1
                activated = result.outcome == "activated" and result.active is not None
                if activated:
                    self._active = result.active
                    self._source = "store"
                    self._staged_manifest = None
                    self._last_refusal = None
                    self._unavailable_models = []
            if activated:
                self._emit_change()
            if result.outcome == "staged":
                self._log({"event": "release_staged", "generation": result.generation})
                self._emit_change()

    def _declared_models(self) -> Optional[list[str]]:
        """T15: the models this application declared it can call; None when it declared nothing (then no release is refused over a model)."""
        models_option = self._o.get("models")
        if models_option is None:
            return None
        return list(models_option) if isinstance(models_option, (list, tuple)) else list(models_option.keys())

    def _take_verified(self, payload: Mapping[str, Any]) -> None:
        """Every manifest whose envelope verified, before the pass decides anything: the policy pin, then the directives."""
        self._take_apply_policy(payload)
        self._take_directives(payload)

    def _take_apply_policy(self, payload: Mapping[str, Any]) -> None:
        """S4: the apply policy is the customer's. The first verified manifest pins the host's policy (trust-on-first-use); a
        later manifest may tighten the pin (``auto`` → ``unlock_required``) and never loosen it — a manifest that says ``auto``
        against a pinned ``unlock_required`` is advisory, logged once per generation, and reported on the heartbeat."""
        store = self._store
        if store is None:
            return
        generation = int(payload["generation"])
        said = payload.get("applyPolicy", "auto")
        if self._manifest_apply_policy is None or generation >= self._manifest_apply_policy[0]:
            self._manifest_apply_policy = (generation, said)
        pin = store.state.get("applyPolicyPin")
        if not pin:
            store.pin_apply_policy(value=said, source="manifest", generation=generation, set_at=self._now_iso())
            self._log({"event": "apply_policy_pinned", "policy": said, "generation": generation})
            return
        if said == "unlock_required" and pin.get("value") == "auto":
            store.pin_apply_policy(value="unlock_required", source="manifest", generation=generation, set_at=self._now_iso())
            self._log({"event": "apply_policy_tightened", "from": pin.get("value"), "to": "unlock_required", "generation": generation, "previousSource": pin.get("source")})
            return
        if said == "auto" and pin.get("value") == "unlock_required" and self._apply_policy_advisory_logged < generation:
            self._apply_policy_advisory_logged = generation
            self._log({"event": "apply_policy_manifest_advisory", "manifestSaid": "auto", "pinned": "unlock_required", "pinnedBy": pin.get("source"), "generation": generation})

    def _effective_apply_policy(self) -> dict[str, Any]:
        """S4: the policy in force on this host and where it comes from (see ``AgentStatus.apply_policy``)."""
        local = self._apply_options.policy
        pin = self._store.state.get("applyPolicyPin") if self._store else None
        manifest_said = self._manifest_apply_policy[1] if self._manifest_apply_policy else None
        if local == "unlock_required":
            return {"effective": "unlock_required", "source": "local", "manifestSaid": manifest_said}
        if pin:
            return {"effective": pin["value"], "source": "operator" if pin.get("source") == "operator" else "pinned", "manifestSaid": manifest_said}
        return {"effective": local or manifest_said or "auto", "source": "local" if local else "manifest", "manifestSaid": manifest_said}

    def set_apply_policy(self, value: str, *, by: Optional[str] = None) -> dict[str, Any]:
        """S4: an operator's act on this host — the one way a pinned policy loosens. ``unlock_required`` tightens the pin by
        hand; ``auto`` loosens it, and a later manifest that says ``unlock_required`` tightens it again. Logged; host-wide
        through the store (every process sharing it reads the pin). Never called by sync."""
        if value not in ("auto", "unlock_required"):
            raise ValueError("apply policy is auto or unlock_required")
        store = self._store
        if store is None:
            raise AgentStartError("no_verified_release", "no store to record the policy in")
        before = store.state.get("applyPolicyPin") or None
        store.pin_apply_policy(value=value, source="operator", generation=self._manifest_apply_policy[0] if self._manifest_apply_policy else 0, set_at=self._now_iso())
        self._log({"event": "apply_policy_set", "policy": value, "previous": before.get("value") if before else None, "previousSource": before.get("source") if before else None, **({"by": by} if by else {})})
        return self._effective_apply_policy()

    def _take_directives(self, payload: Mapping[str, Any]) -> None:
        """T9: a verified manifest's directives stand from the moment its envelope verifies; a Freeze is honoured before anything else."""
        if self._standing_directives and self._standing_directives[0] > payload["generation"]:
            return
        before = self._disabled_now()
        self._standing_directives = (payload["generation"], list(payload.get("directives", [])))
        after = self._disabled_now()
        if before != after:
            self._log({"event": "disabled_by_directive" if after["agent"] or after["slots"] or after.get("arms") else "disable_lifted", "generation": payload["generation"], **after})
        requests = self._open_unlock_requests(payload)
        if requests:
            self._log({"event": "unlock_requested", "generation": payload["generation"], "requests": [{"releaseDigest": r.get("releaseDigest"), "expiresAt": r.get("expiresAt"), "requestedBy": r.get("requestedBy")} for r in requests]})

    def _ramp_statuses(self, manifest: Optional[Mapping[str, Any]]) -> list[dict[str, Any]]:
        """S9/S16: every experiment's plan as this host walks it — per slot, each on its own clock and retreat."""
        return [self._ramp_status_of(experiment) for experiment in experiments_of(manifest or {})]

    def _ramp_status(self, manifest: Optional[Mapping[str, Any]]) -> Optional[dict[str, Any]]:
        statuses = self._ramp_statuses(manifest)
        return statuses[0] if statuses else None

    def _ramp_status_of(self, experiment: Mapping[str, Any]) -> dict[str, Any]:
        arms = self._resolver().arms(experiment)
        now_ms = self._now_ms()
        plan = list(experiment.get("ramp") or [])
        step = -1
        for index, entry in enumerate(plan):
            if instant(entry["notBefore"]) <= now_ms:
                step = index
        nxt = plan[step + 1] if step + 1 < len(plan) else None
        return {
            "experimentId": experiment["experimentId"],
            "tag": experiment.get("tag"),
            "weightBps": [arm["weightBps"] for arm in arms] if arms else ramp_weights_at(experiment["arms"], experiment.get("ramp"), now_ms),
            "arms": [arm["arm"] for arm in experiment["arms"]],
            "step": step,
            "nextStepAt": nxt["notBefore"] if nxt else None,
            "plan": [{"notBefore": entry["notBefore"], "weightBps": list(entry["weightBps"])} for entry in plan],
        }

    def _disabled_now(self) -> dict[str, Any]:
        """What is disabled right now: the standing directives when they are as new as the active manifest, else the active manifest's own."""
        if self._active is None:
            standing = self._standing_directives
            return disabled_from(standing[1]).as_dict() if standing else {"agent": False, "slots": [], "arms": []}
        return self._resolver().disabled().as_dict()

    def _resolver(self) -> ReleaseResolver:
        """S10: the runtime over the active release — resolution, the ramp walk and rendering live in ``airprompter_agent_runtime``."""
        release = self._active
        if release is None:
            if self._staged_manifest is not None:
                raise AgentStartError("no_verified_release", f"no active release: generation {self._staged_manifest['payload']['generation']} is staged under unlock_required and waiting for an unlock")
            raise AgentStartError("no_verified_release", "no active release")
        cached = self._resolver_for
        if cached is not None and cached[0] is release and cached[1] is self._standing_directives:
            return cached[2]
        resolver = ReleaseResolver(
            release=release,
            run_ref_key=self._run_ref_key,
            tags=lambda: self._audience_tags,
            agent_id=self._o["agent_id"],
            target=self._o["target"],
            instance_id=self._own_instance_id,
            now_ms=self._now_ms,
            delimiters=self._o.get("delimiters"),
            standing_directives=self._standing_directives,
        )
        self._resolver_for = (release, self._standing_directives, resolver)
        return resolver

    def _fetch_root(self, url: str) -> Optional[dict[str, Any]]:
        try:
            with httpx.Client(transport=self._o.get("transport"), timeout=30.0) as http:
                response = http.get(url, headers={"user-agent": _USER_AGENT})
            if response.status_code != 200:
                return None
            return json.loads(response.text)
        except Exception:  # noqa: BLE001
            return None

    # ------------------------------------------------------------------ heartbeat (T9)

    def heartbeat_body(self) -> dict[str, Any]:
        """The protocol's heartbeat body, built from what this process knows about itself. Content-free by construction."""
        status = self.status()
        store_state = self._store.state if self._store else None
        models = self._declared_models() or []
        active_digest = self._active.manifest["payload"].get("releaseDigest") if self._active else None
        staged_digest = self._staged_manifest["payload"].get("releaseDigest") if self._staged_manifest else None
        apply_state = status.apply_state
        if status.apply_state == "awaiting_unlock" and self._staged_manifest is not None:
            apply_state = "awaiting_countersign" if self._o.get("require_countersign") and not self._staged_manifest.get("countersignatures") else "awaiting_unlock"
        mode = self._sync_options.mode
        source_names = self.variables.names()
        body: dict[str, Any] = {
            "protocol": PROTOCOL_VERSION,
            "instanceId": self._own_instance_id,
            "instanceClass": self._telemetry.instance_class or ("ephemeral" if mode == "on_invoke" else "resident"),
            "sdk": {"name": SDK_NAME, "version": SDK_VERSION},
            "host": {"os": _host_os(), "arch": platform.machine()[:16] or "unknown", "runtime": f"python {platform.python_version()}"[:64]},
            "syncMode": "on_invoke" if mode == "on_invoke" else ("resident" if self._client else "offline"),
            "heartbeatIntervalSeconds": self._heartbeat_interval_seconds,
            "generation": {"active": status.generation, **({"staged": status.staged_generation} if status.staged_generation is not None else {})},
            "applyState": apply_state,
            "storageProtection": status.storage_protection,
            # 0.3.4: the variable names this application can fill from its own sources — names, never values — so the seal
            # can warn about a `source: runtime` variable no live instance fills before the promotion, not after. Sent only
            # once the control plane has shown it speaks 0.3.4 (the active manifest's protocol): an older service refuses
            # the whole heartbeat over an unknown key, and a refused heartbeat is worse than an unreported name. Past that
            # gate the key is always sent — an empty list says "I fill nothing", which is a report; absence says nothing.
            "catalog": {"models": list(dict.fromkeys(models))[:256], **({"variables": source_names[:256]} if protocol_at_least(str((self._active.manifest["payload"] if self._active else {}).get("protocol", "0.0.0")), "0.3.4") else {}), "reportedAt": self._now_iso()},
            "lease": {**({"expiresAt": status.lease_expires_at} if status.lease_expires_at else {}), "expired": status.lease_expired},
            "spool": {
                "depthSegments": status.spool["depth_segments"],
                "depthBytes": status.spool["depth_bytes"],
                "droppedSegments": status.upload["droppedSegments"] if status.upload else 0,
                "quarantinedSegments": status.upload["quarantinedSegments"] if status.upload else 0,
                **({"lastUploadAt": status.upload["lastUploadAt"]} if status.upload and status.upload.get("lastUploadAt") else {}),
                **({"backoffUntil": status.upload["backoffUntil"]} if status.upload and status.upload.get("backoffUntil") else {}),
            },
            "unlockRequestsSeen": [r["releaseDigest"] for r in status.unlock_requests][:8],
            "disabled": {"agent": status.disabled["agent"], "slots": status.disabled["slots"], **({"arms": status.disabled["arms"]} if status.disabled.get("arms") else {})},
            # S4: what this host runs under, so the fleet view can say the console's setting is advisory here.
            "applyPolicy": {"effective": status.apply_policy["effective"], "source": status.apply_policy["source"]},
        }
        if active_digest:
            body["activeReleaseDigest"] = active_digest
        if staged_digest:
            body["stagedReleaseDigest"] = staged_digest
        active_payload = self._active.manifest["payload"] if self._active else {}
        if self._audience_server_supported or (active_payload.get("protocol") == AUDIENCE_PROTOCOL_VERSION and AUDIENCE_CAPABILITY in active_payload.get("requiredCapabilities", [])):
            body["capabilities"] = [AUDIENCE_CAPABILITY]
            body["registration"] = {"tagKeys": sorted(self._audience_tag_keys), "prompts": [{"tag": tag, "displayName": label} for tag,label in sorted(self._audience_prompt_labels.items())]}
        if status.apply_state == "refused" and status.last_refusal and _REFUSAL_WORD.match(status.last_refusal):
            body["refusal"] = status.last_refusal
            if status.last_refusal == "model_unavailable" and self._unavailable_models:
                body["unavailableModels"] = list(self._unavailable_models)[:16]
        if status.signing_key_id:
            body["signingKeyId"] = status.signing_key_id
        if store_state is not None:
            body["localRollback"] = {"active": store_state.get("heldBackBelow") is not None, "forced": store_state.get("forcedDowngrade") is True}
        return body

    def heartbeat_now(self) -> None:
        """One heartbeat now (resident timers call this; on_invoke hosts send one when the interval has elapsed). Never raises."""
        if self._client is None:
            return
        with self._heartbeat_lock:
            try:
                result = self._client.heartbeat(self.heartbeat_body())
                if result.status == "ok":
                    response = result.response or {}
                    behind = False
                    with self._lock:
                        self._audience_server_supported = response.get("protocol") == AUDIENCE_PROTOCOL_VERSION and AUDIENCE_CAPABILITY in response.get("capabilities", [])
                        self._last_heartbeat_ms = self._now_ms()
                        self._last_heartbeat_refusal = None
                        self._last_contact_ms = self._now_ms()
                        interval = response.get("heartbeatIntervalSeconds")
                        if isinstance(interval, (int, float)) and 30 <= interval <= 3600:
                            self._heartbeat_interval_seconds = int(interval)
                        self._take_grant(response)
                        # S3: the heartbeat names the origin's generation; a pointer that shows less is behind.
                        latest = response.get("latestGeneration")
                        if isinstance(latest, int) and not isinstance(latest, bool) and latest >= 0:
                            seen = max(
                                self._active.generation if self._active else 0,
                                self._staged_manifest["payload"]["generation"] if self._staged_manifest else 0,
                                self._store.state.get("generation", 0) if self._store else 0,
                            )
                            if latest > seen and not self._pointer_behind:
                                self._pointer_behind = True
                                behind = True
                                self._log({"event": "pointer_behind", "latestGeneration": latest, "seen": seen})
                    self._log({"event": "heartbeat", "intervalSeconds": self._heartbeat_interval_seconds, "expiresAt": response.get("expiresAt")})
                    if behind:
                        # Go now: the origin has something the pointer has not shown (a freeze, a dial-down, a release).
                        self.sync_now()
                elif result.status == "refused":
                    self._last_heartbeat_refusal = result.code or f"http_{result.http_status}"
                    self._log({"event": "heartbeat_refused", "httpStatus": result.http_status, "code": result.code})
                else:
                    self._log({"event": "heartbeat_failed", "httpStatus": result.http_status})
            except Exception as error:  # noqa: BLE001
                self._log({"event": "heartbeat_failed", "reason": str(error)})

    def _take_grant(self, response: Mapping[str, Any]) -> None:
        """T26: the heartbeat's answer carries the cadence and, on a host with a key, the upload grant or a hold."""
        interval = response.get("uploadIntervalSeconds")
        if isinstance(interval, (int, float)) and not isinstance(interval, bool) and interval >= 1:
            self._upload_interval_seconds = int(interval)
        grant = UploadGrant.from_wire(response.get("uploadGrant") or {})
        if grant is not None:
            self._upload_grant = grant
            self._upload_retry_after_ms = None
        else:
            self._upload_grant = None
            retry = response.get("retryAfterSeconds")
            self._upload_retry_after_ms = self._now_ms() + float(retry) * 1000 if isinstance(retry, (int, float)) and retry > 0 else None

    def request_upload_grant(self, *, instance_id: Optional[str] = None, instance_class: Optional[str] = None, report: Optional[Mapping[str, Any]] = None) -> GrantDecision:
        """T26: an upload grant for one writer's prefix — a heartbeat carrying that writer's instance id (this runtime's own by
        default). The uploader asks once per writer whose segments sit in this folder (a sibling that exited, a reclaimed
        segment); ``report`` is that writer's own heartbeat report from its manifest, sent with this process's ``spool``
        block. Never raises."""
        if self._client is None:
            return GrantDecision("unavailable", reason="offline")
        own = instance_id is None or instance_id == self._own_instance_id
        if own:
            self.heartbeat_now()
            if self._upload_grant is not None:
                return GrantDecision("grant", grant=self._upload_grant, upload_interval_seconds=self._upload_interval_seconds)
            if self._upload_retry_after_ms is not None:
                return GrantDecision("hold", retry_after_seconds=max(1, math.ceil((self._upload_retry_after_ms - self._now_ms()) / 1000)), reason="retry_after")
            return GrantDecision("unavailable", reason=self._last_heartbeat_refusal or "heartbeat_failed")
        try:
            own_body = self.heartbeat_body()
            body = {**report, "instanceId": instance_id, "spool": own_body["spool"]} if report else {**own_body, "instanceId": instance_id, **({"instanceClass": instance_class} if instance_class else {})}
            result = self._client.heartbeat(body)
            if result.status == "ok":
                response = result.response or {}
                interval = response.get("uploadIntervalSeconds")
                if isinstance(interval, (int, float)) and not isinstance(interval, bool) and interval >= 1:
                    self._upload_interval_seconds = int(interval)
                grant = UploadGrant.from_wire(response.get("uploadGrant") or {})
                if grant is not None:
                    return GrantDecision("grant", grant=grant, upload_interval_seconds=self._upload_interval_seconds)
                retry = response.get("retryAfterSeconds")
                return GrantDecision("hold", retry_after_seconds=int(retry) if isinstance(retry, (int, float)) and retry > 0 else 900, reason="retry_after")
            return GrantDecision("unavailable", reason=(result.code or f"http_{result.http_status}") if result.status == "refused" else f"http_{result.http_status}")
        except Exception as error:  # noqa: BLE001
            return GrantDecision("unavailable", reason=f"network:{error}")

    def flush_telemetry(self) -> dict[str, Any]:
        """T26 (D25 survives on serverless): the memory sink's rows, closed as one segment and POSTed under this runtime's own
        grant. Rows that cannot go (no grant, a hold, a refused POST) are put back so the next flush carries them; past the
        buffer the sink's own eviction reports the loss. Never raises; returns what happened."""
        drain = getattr(self._sink, "drain", None)
        if not callable(drain):
            return {"status": "nothing"}
        with self._flush_lock:
            rows = drain(self._now_ms())
            if not rows:
                return {"status": "nothing"}

            def requeue() -> None:
                for row in rows:
                    self._sink.append(row, self._now_ms())

            if self._upload_grant is not None and instant(self._upload_grant.expires_at) - 60_000 > self._now_ms():
                decision = GrantDecision("grant", grant=self._upload_grant)
            else:
                decision = self.request_upload_grant()
            if decision.kind != "grant" or decision.grant is None:
                requeue()
                reason = f"retry_after:{decision.retry_after_seconds}" if decision.kind == "hold" else str(decision.reason)
                return {"status": "held", "reason": reason, "rows": len(rows)}
            minute = epoch_minute(self._now_ms())
            self._flush_segment_n = self._flush_segment_n + 1 if self._last_flush_minute == minute else 0
            self._last_flush_minute = minute
            segment = segment_name(self._own_instance_id, minute, self._flush_segment_n)
            data = ("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n").encode("utf-8")
            outcome = post_segment(grant=decision.grant, segment=segment, data=data, transport=self._o.get("transport"), now_ms=self._now_ms)
            if outcome.status == "ok":
                self._log({"event": "telemetry_flushed", "segment": segment, "rows": len(rows)})
                return {"status": "uploaded", "segment": segment, "rows": len(rows)}
            requeue()
            if outcome.status == "refused" and outcome.expired:
                self._upload_grant = None
            reason = f"http_{outcome.http_status}" if outcome.status == "refused" else ("too_large" if outcome.status == "too_large" else f"network:{outcome.reason}")
            self._log({"event": "telemetry_flush_failed", "reason": reason, "rows": len(rows)})
            return {"status": "held", "reason": reason, "rows": len(rows)}

    def _schedule_heartbeat(self) -> None:
        self._heartbeat_timer.cancel()
        if self._stopped or self._client is None:
            return
        delay_ms = jittered_delay_ms(self._heartbeat_interval_seconds, self._rand)
        self._next_heartbeat_ms = self._now_ms() + delay_ms

        def tick() -> None:
            try:
                self.heartbeat_now()
            finally:
                self._schedule_heartbeat()

        self._heartbeat_timer.thread = self._arm(delay_ms / 1000, tick)

    # ------------------------------------------------------------------ serverless

    def invoke(self, handler: Callable[[], T]) -> T:
        """on_invoke mode: run the handler between two sync passes (the trailing one runs on its own thread, off the response path).
        S5: the invocation's rows are flushed before ``invoke()`` returns — a platform that freezes the process at the response
        (Lambda) would otherwise lose them with no ``dropped`` row possible. ``TelemetryOptions.flush="background"`` is the
        documented opt-out for hosts that keep running after the response."""
        self.sync_now()
        if self._last_heartbeat_ms is None or self._now_ms() - self._last_heartbeat_ms >= self._heartbeat_interval_seconds * 1000:
            threading.Thread(target=self.heartbeat_now, name="airprompter-heartbeat", daemon=True).start()
        try:
            return handler()
        finally:
            self.spool.close_windows(self._now_ms())
            threading.Thread(target=self.sync_now, name="airprompter-sync", daemon=True).start()
            # D25 on serverless: the invocation's rows go out under the runtime's own grant; a failure keeps them for the next one.
            if self._client is not None and callable(getattr(self._sink, "drain", None)):
                if self._telemetry.flush == "background":
                    threading.Thread(target=self.flush_telemetry, name="airprompter-flush", daemon=True).start()
                else:
                    self.flush_telemetry()

    # ------------------------------------------------------------------ unlock / rollback

    def unlock(self) -> Optional[dict[str, int]]:
        """Make a staged release live (an operator's ``airprompter unlock``, an update window, or the change-control hook)."""
        store = self._store
        assert store is not None
        with self._lock:
            if not store.state.get("staged"):
                return None
            self._window_timer.cancel()
            slot = store.activate()
            self._active = store.load(slot, now=self._now_iso(), root=self._trusted_root, countersign_root=self._o.get("countersign_root"))
            self._staged_manifest = None
            self._source = "store"
            generation = self._active.generation
        self._emit_change()
        return {"generation": generation}

    def rollback(self) -> dict[str, Any]:
        """Instant local rollback to the other slot. Forced when it goes below the stored generation; stamped on evidence.
        Raises ``StoreError`` ``release_staged`` while a release is staged (a rollback is never a quiet unlock) and
        ``no_previous_release`` when this host has held one release only."""
        store = self._store
        assert store is not None
        with self._lock:
            before = store.state["generation"]
            slot = store.rollback_local()
            self._active = store.load(slot, now=self._now_iso(), root=self._trusted_root, countersign_root=self._o.get("countersign_root"))
            forced = self._active.generation < before
            generation = self._active.generation
            if forced:
                self.spool.refusal(at=self._now_iso(), reason="forced_downgrade", generation=generation, tag=None, at_ms=self._now_ms())
        self._emit_change()
        return {"generation": generation, "forced": forced}

    # ------------------------------------------------------------------ guards

    def _stamp_refusal(self, reason: str, generation: int, tag: Optional[str]) -> None:
        # One row per (reason, generation, tag): the spool reports the condition, not every render that hit it.
        key = f"{reason}\0{generation}\0{tag or ''}"
        if key in self._stamped_refusals:
            return
        self._stamped_refusals.add(key)
        self.spool.refusal(at=self._now_iso(), reason=reason, generation=generation, tag=tag, at_ms=self._now_ms())

    def _lease_expires_at(self) -> Optional[str]:
        if self._active is None:
            return None
        payload = self._active.manifest["payload"]
        if self._last_contact_ms is not None:
            return iso_ms(self._last_contact_ms + payload["leaseSeconds"] * 1000)
        if self._bundle_not_after and self._source == "vendored_bundle":
            return iso_ms(instant(self._bundle_not_after))
        return iso_ms(instant(payload["issuedAt"]) + payload["leaseSeconds"] * 1000)

    def _guard_lease(self, tag: str) -> LoadedSlot:
        """The lease: the facade's rule (it knows the origin); the runtime knows nothing of contact."""
        active = self._active
        assert active is not None
        payload = active.manifest["payload"]
        expires_at = self._lease_expires_at()
        if expires_at and instant(expires_at) <= self._now_ms():
            # §6.4: degrade keeps serving and reports it; halt stops rendering. Either way the spool carries one row.
            self._stamp_refusal("lease_expired", active.generation, None)
            if payload.get("onLeaseExpiry") == "halt":
                # A runtime with no way to call home (no key, offline sync) can never renew: halt there is a self-inflicted
                # outage, so it degrades and says so once. The console refuses to save halt on an offline environment too.
                if self._client is None:
                    if not self._halt_without_contact_warned:
                        self._halt_without_contact_warned = True
                        self._log({"event": "halt_without_contact_degraded", "generation": active.generation})
                else:
                    raise RenderRefusedError("lease_expired", tag, active.generation)
        return active

    def _resolve_slot(self, tag: str, subject: Optional[str], return_resolved: bool = False, tags: Optional[Mapping[str,str]] = None):
        """S10: the runtime resolves; the facade turns a refusal into the spool row and the raised error, and guards the lease."""
        resolver = self._resolver()
        active = self._active
        assert active is not None
        outcome = resolver.resolve(tag, subject, tags)
        if not outcome.ok:
            if outcome.reason == "no_slot":
                raise KeyError(f"no slot {tag} on generation {active.generation}")
            self._stamp_refusal("disabled", active.generation, outcome.tag)
            raise RenderRefusedError("disabled", tag, active.generation)
        self._guard_lease(tag)
        assert outcome.slot is not None
        return outcome.slot if return_resolved else (outcome.slot.slot, outcome.slot.arm, outcome.slot.bucket)

    # ------------------------------------------------------------------ render

    def set_tags(self, tags: Mapping[str,str]) -> None:
        """Replace local process tags; remember only key names for registration."""
        copied = copy_audience_tags(tags)
        with self._lock:
            keys = self._audience_tag_keys | set(copied)
            if len(keys) > 64: raise ValueError("audience_tag_names_limit")
            self._audience_tag_keys = keys
            self._audience_tags = copied

    def _register_prompt_label(self, tag: str, label: str) -> None:
        if not isinstance(tag,str) or not re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*",tag) or len(tag) > 128 or not valid_audience_label(label): raise ValueError("prompt_label_invalid")
        if tag not in self._audience_prompt_labels and len(self._audience_prompt_labels) >= 32: raise ValueError("prompt_labels_limit")
        self._audience_prompt_labels[tag] = label

    def prompt(self, tag: str, *, subject: Optional[str] = None, tags: Optional[Mapping[str,str]] = None, display_name: Optional[str] = None) -> PromptHandle:
        with self._lock:
            self._register_prompt_label(tag, display_name if display_name is not None else self._audience_prompt_labels.get(tag, tag))
        return PromptHandle(self, tag, subject, tags)

    @dataclass(frozen=True)
    class _Prepared:
        """Everything a render captured under the lock, before any source runs: a release that activates while a
        source is being looked up must not mix generation N+1's text with generation N's run reference."""

        resolver: ReleaseResolver
        resolved: ReleaseSlot
        text: str
        plan: FillPlan

        @property
        def row(self) -> dict[str, Any]:
            return {"tag": self.resolved.slot["tag"], "version_id": self.resolved.slot["versionId"], "arm": self.resolved.arm, "model": self.resolved.slot["model"]}

    def _prepare(self, tag: str, subject: Optional[str], values: Mapping[str, Any], tags: Optional[Mapping[str,str]] = None) -> "AirPrompterAgent._Prepared":
        with self._lock:
            resolver = self._resolver()
            local_tags = copy_audience_tags({**self._audience_tags, **tags}) if tags is not None else self._audience_tags
            keys = self._audience_tag_keys | set(local_tags)
            if len(keys) > 64: raise ValueError("audience_tag_names_limit")
            self._audience_tag_keys = keys
            resolved = self._resolve_slot(tag, subject, True, local_tags)
            slot = resolved.slot
            text = resolver.text_of(slot)
            plan = plan_fill(tag=tag, variables=slot.get("variables", []), text=text, values=values, registry=self.variables)
            return AirPrompterAgent._Prepared(resolver, resolved, text, plan)

    def _finish(self, prepared: "AirPrompterAgent._Prepared", filled: FilledRender) -> Rendered:
        rendered = self._render_observed(lambda: prepared.resolver.render(prepared.resolved, filled.values, fenced=filled.fenced, text=prepared.text), prepared.row)
        # The registry keeps its own copy of the block: the one handed out is the caller's to edit.
        self._renders.register(rendered.text, Attribution(rendered.tag, rendered.version_id, rendered.arm, rendered.model, copy_inference(rendered.inference), rendered.audience_ids, rendered.run_minute))
        self._say_stricter(rendered.tag, prepared.resolved.slot, filled)
        return rendered

    def _context(self, prepared: "AirPrompterAgent._Prepared", tag: str, subject: Optional[str]) -> VariableSourceContext:
        return VariableSourceContext(tag=tag, name="", subject=subject, version_id=prepared.resolved.slot["versionId"], arm=prepared.resolved.arm)

    def _render(self, tag: str, subject: Optional[str], values: Mapping[str, Any], tags: Optional[Mapping[str,str]] = None) -> Rendered:
        prepared = self._prepare(tag, subject, values, tags)
        # The lock is released here: a source is the customer's code and may take its time.
        return self._finish(prepared, self._fill_observed(lambda: fill_sync(prepared.plan, self._context(prepared, tag, subject), self.variables), tag, prepared.row))

    async def _render_async(self, tag: str, subject: Optional[str], values: Mapping[str, Any], tags: Optional[Mapping[str,str]] = None) -> Rendered:
        prepared = self._prepare(tag, subject, values, tags)
        filled = await self._fill_observed_async(lambda: fill_async(prepared.plan, self._context(prepared, tag, subject), self.variables), tag, prepared.row)
        return self._finish(prepared, filled)

    def _render_observed(self, render: Callable[[], T], row: Mapping[str, Any]) -> T:
        """A render, observed: a ``MissingVariableError`` is also one content-free error row (``render_missing_variable``),
        so the board sees a version this host cannot render. The row names the slot, never a step (a step id is not
        a spool tag) and never a variable."""
        try:
            return render()
        except Exception as error:
            if type(error).__name__ == "MissingVariableError" or getattr(error, "code", None) == "render_missing_variable":
                self._missing_row(row)
            raise

    def _missing_row(self, row: Mapping[str, Any]) -> None:
        self.spool.observe(Observation(tag=row["tag"], version_id=row["version_id"], arm=row["arm"], model=row["model"], status="error", error_class="render_missing_variable", latency_ms=0, usage_source="unavailable"), self._now_ms())

    def _source_failed(self, error: BaseException, tag: str, row: Mapping[str, Any]) -> None:
        """A failed source is logged by name and reason only and counted as the same error row as a missing variable —
        the window schema has no class for "a source failed" (a protocol 0.3.4 note), and to the board the outcome is
        the same: this host could not render the version."""
        if is_variable_source_error(error):
            self._log({"event": "variable_source_failed", "tag": tag, "name": getattr(error, "variable", None), "reason": getattr(error, "reason", None)})
            self._missing_row(row)

    def _fill_observed(self, fill: Callable[[], FilledRender], tag: str, row: Mapping[str, Any]) -> FilledRender:
        try:
            return fill()
        except Exception as error:
            self._source_failed(error, tag, row)
            raise

    async def _fill_observed_async(self, fill: Callable[[], Awaitable[FilledRender]], tag: str, row: Mapping[str, Any]) -> FilledRender:
        try:
            return await fill()
        except Exception as error:
            self._source_failed(error, tag, row)
            raise

    def _say_stricter(self, tag: str, slot: Mapping[str, Any], filled: FilledRender) -> None:
        """A source stricter than the prompt's declaration is said once per slot and name for the life of the process —
        bounded by declared names; a declaration that later loosens again is not said a second time, by design."""
        for entry in filled.filled:
            if not entry.stricter:
                continue
            key = f"{tag}\u0000{entry.name}"
            with self._lock:  # check-and-add as one step: two first renders on two threads say it once, not twice
                if key in self._stricter_said:
                    continue
                self._stricter_said.add(key)
            declared = next((v.get("trust") for v in slot.get("variables", []) if v["name"] == entry.name), None)
            self._log({"event": "variable_source_trust_stricter", "tag": tag, "name": entry.name, "declared": declared})

    def workflow(self, tag: str, *, subject: Optional[str] = None) -> WorkflowHandle:
        """A workflow slot's steps in ordinal order, each with its prompt text, and ``render_step()`` /
        ``render_step_async()`` to fill a step's variables. A source sees the step id as its tag; the error row, when
        there is one, names the workflow slot."""
        with self._lock:
            resolver = self._resolver()
            resolved = self._resolve_slot(tag, subject, return_resolved=True)
            slot = resolved.slot
            workflow = resolver.workflow(resolved)
            for step in workflow.steps:
                self._renders.register(step.text, Attribution(step.step_id, step.version_id, workflow.arm, workflow.model, copy_inference(step.inference), step.audience_ids, step.run_minute))
        row = {"tag": tag, "version_id": slot["versionId"], "arm": workflow.arm, "model": workflow.model}
        declared = list(slot.get("variables", []))

        def step_of(step_id: str) -> WorkflowStep:
            step = next((entry for entry in workflow.steps if entry.step_id == step_id), None)
            if step is None:
                raise KeyError(f"no step {step_id} on {tag}")
            return step

        def finish(step: WorkflowStep, filled: FilledRender) -> str:
            text = self._render_observed(lambda: resolver.render_text(tag=step.step_id, text=step.text, variables=declared, values=filled.values, fenced=filled.fenced), row)
            self._renders.register(text, Attribution(step.step_id, step.version_id, workflow.arm, workflow.model, copy_inference(step.inference), step.audience_ids, step.run_minute))
            self._say_stricter(step.step_id, slot, filled)
            return text

        def context(step: WorkflowStep) -> VariableSourceContext:
            return VariableSourceContext(tag=step.step_id, name="", subject=subject, version_id=step.version_id, arm=workflow.arm)

        def render_step(step_id: str, values: Mapping[str, Any]) -> str:
            step = step_of(step_id)
            plan = plan_fill(tag=step.step_id, variables=declared, text=step.text, values=values, registry=self.variables)
            return finish(step, self._fill_observed(lambda: fill_sync(plan, context(step), self.variables), step.step_id, row))

        async def render_step_async(step_id: str, values: Mapping[str, Any]) -> str:
            step = step_of(step_id)
            plan = plan_fill(tag=step.step_id, variables=declared, text=step.text, values=values, registry=self.variables)
            return finish(step, await self._fill_observed_async(lambda: fill_async(plan, context(step), self.variables), step.step_id, row))

        return WorkflowHandle(model=workflow.model, arm=workflow.arm, steps=workflow.steps, variables=workflow.variables, _render_step=render_step, _render_step_async=render_step_async)

    def _variables_status(self) -> dict[str, Any]:
        """Per slot and arm of the active release: the required variables neither a literal nor a source fills, so the
        call site must. Declarations only — a required variable is needed whether or not the text uses it — so no
        payload is read; ``status()`` stays cheap for a probe. Every arm override for a tag counts, since a subject may
        land on any arm."""
        sources = self.variables.names()
        payload = self._active.manifest["payload"] if self._active else None
        if not payload:
            return {"sources": sources, "unsourced": []}
        seen: dict[str, dict[str, Any]] = {}

        def consider(slot: Mapping[str, Any], arm: str) -> None:
            names = unsourced(variables=slot.get("variables", []), values={}, registry=self.variables)
            if names:
                seen[f"{slot['tag']}\u0000{arm}"] = {"tag": slot["tag"], "arm": arm, "names": names}

        for slot in payload["slots"]:
            consider(slot, "none")
        for experiment in experiments_of(payload):
            for arm in experiment["arms"]:
                for override in arm.get("overrides", []):
                    consider(override, str(arm["arm"]))
        return {"sources": sources, "unsourced": sorted(seen.values(), key=lambda entry: (entry["tag"], entry["arm"]))}

    # ------------------------------------------------------------------ telemetry

    def report(self, observation: Optional[Observation] = None, /, **kwargs: Any) -> None:
        """Content-free measurements for one model call: an ``Observation``, or its fields as keywords."""
        self.spool.observe(observation if observation is not None else Observation(**kwargs), self._now_ms())

    def observe(self, rendered: Union[Rendered, WorkflowStep, ObserveTarget], call: Callable[[], T], *, checks: Optional[Mapping[str, int]] = None, model: Optional[str] = None) -> T:
        """Time a model call against a rendered prompt (or a workflow step) and report it: latency, ``usage`` read off the
        provider's response (OpenAI, Anthropic, Bedrock shapes, dicts or SDK objects), a raised failure classified into the
        closed error set, and (T29) the slot's declared output checks evaluated on the answer here on the host — only their
        counts leave. The result comes back unchanged; an error is re-raised after it is counted."""
        target = self._target_of(rendered, model)
        return observe_call(target, call, lambda o: self.spool.observe(o, self._now_ms()), checks=checks, model=model, now=self._now_ms, evaluate=self._check_evaluator(target))

    async def observe_async(self, rendered: Union[Rendered, WorkflowStep, ObserveTarget], call: Callable[[], Union[Awaitable[T], T]], *, checks: Optional[Mapping[str, int]] = None, model: Optional[str] = None) -> T:
        """``observe`` for a coroutine-returning call (``AsyncOpenAI``, ``AsyncAnthropic``)."""
        target = self._target_of(rendered, model)
        return await observe_call_async(target, call, lambda o: self.spool.observe(o, self._now_ms()), checks=checks, model=model, now=self._now_ms, evaluate=self._check_evaluator(target))

    def checks(self, rendered: Union[Rendered, WorkflowStep, ObserveTarget], output: Any, *, output_tokens: Optional[int] = None, record: bool = True) -> dict[str, Any]:
        """T29: run the slot's declared output checks on an output you already have (an app that calls the model without
        ``observe()``, or one that wants the per-check results) and count them on the window. Never raises."""
        target = self._target_of(rendered, None)
        declared = self._declared_checks_for(target.tag, target.arm)
        text = output if isinstance(output, str) else output_text_of(output)
        if not declared or text is None:
            return {"passed": 0, "failed": 0, "results": []}
        outcome = evaluate_checks(declared, text, output_tokens)
        if record and (outcome["passed"] or outcome["failed"]):
            self.spool.checks(tag=target.tag, version_id=target.version_id, arm=target.arm, model=target.model, passed=outcome["passed"], failed=outcome["failed"], at_ms=self._now_ms(), audience_ids=target.audience_ids, run_minute=target.run_minute)
        return outcome

    def _declared_checks_for(self, tag: str, arm: str) -> list[Mapping[str, Any]]:
        """The active manifest's checks for a slot on an arm (the arm's override when it carries one)."""
        active = self._active
        if active is None:
            return []
        payload = active.manifest["payload"]
        slot: Optional[Mapping[str, Any]] = None
        for candidate in (experiment_for_tag(payload, tag) or {}).get("arms", []):
            if candidate.get("arm") == arm:
                slot = next((o for o in candidate.get("overrides", []) if o.get("tag") == tag), None)
        if slot is None:
            slot = next((s for s in payload.get("slots", []) if s.get("tag") == tag), None)
        return list((slot or {}).get("outputChecks") or [])

    def _check_evaluator(self, target: ObserveTarget) -> Optional[Callable[[Any, Any], Optional[Mapping[str, int]]]]:
        declared = self._declared_checks_for(target.tag, target.arm)
        if not declared:
            return None

        def evaluate(result: Any, usage: Any) -> Optional[Mapping[str, int]]:
            text = output_text_of(result)
            if text is None:
                return None
            outcome = evaluate_checks(declared, text, usage.output if usage.source == "reported" else None)
            return {"passed": outcome["passed"], "failed": outcome["failed"]}

        return evaluate

    def _target_of(self, rendered: Union[Rendered, WorkflowStep, ObserveTarget], model: Optional[str]) -> ObserveTarget:
        if isinstance(rendered, ObserveTarget):
            return rendered
        if isinstance(rendered, WorkflowStep):
            facts = parse_run_ref(rendered.run_ref, self._run_ref_key)
            return ObserveTarget(rendered.step_id, rendered.version_id, facts.arm if facts else "none", model or rendered.model or "unknown", rendered.audience_ids, rendered.run_minute)
        return ObserveTarget(rendered.tag, rendered.version_id, rendered.arm, rendered.model, rendered.audience_ids, rendered.run_minute)

    # ------------------------------------------------------------------ T33: wrapped clients

    def wrap(self, client: T) -> T:
        """The ``openai`` or ``anthropic`` client (sync or async), observed without a change at the call site:
        ``chat.completions.create``, ``responses.create``, ``messages.create`` (``stream=True`` or not) and the
        ``.stream()`` helpers are timed, their usage and finish reason read, the slot's checks run on the text, and one
        content-free observation filed — attributed to the render whose text the request carries (or to an enclosing
        ``attribute()`` block). A call that names no render passes through untouched; nothing the wrapper does can fail
        the call. Everything else on the client is its own."""
        return wrap_client(client, self._wrap_hooks())  # type: ignore[return-value]

    def attribute(self, rendered: Union[Rendered, WorkflowStep, ObserveTarget]):
        """``with ap.attribute(rendered):`` — every wrapped call inside the block is that render's, whatever text it carries."""
        target = self._target_of(rendered, None)
        # The observe target carries no settings; the rendered prompt (or the workflow step) does.
        return attribution_scope(Attribution(target.tag, target.version_id, target.arm, target.model, copy_inference(getattr(rendered, "inference", None)), target.audience_ids, target.run_minute))

    def attribution_for(self, params: Any) -> Optional[Attribution]:
        """The render a request's parameters name: an explicit scope first, else a message whose text is a recent render."""
        return current_attribution() or self._renders.match(request_texts(params))

    def _wrap_hooks(self) -> WrapHooks:
        return WrapHooks(attribute=self.attribution_for, begin=self._begin_observation, log=self._log)

    def _begin_observation(self, attribution: Attribution, model: str) -> PendingObservation:
        target = ObserveTarget(attribution.tag, attribution.version_id, attribution.arm, attribution.model, attribution.audience_ids, attribution.run_minute)
        return PendingObservation(target, lambda o: self.spool.observe(o, self._now_ms()), model=model, now=self._now_ms, evaluate=self._check_evaluator(target))

    def golden(self, *, invoke: Optional[GoldenInvoke] = None, tag: Optional[str] = None, staged: bool = False, concurrency: Optional[int] = None) -> list[GoldenReport]:
        """T34: run the golden sets the active (or, with ``staged=True``, the staged) release carries — every slot with one,
        on the control arm and on each arm that overrides the slot — through the customer's model call, and record
        ``goldenPass`` per case on the arm's window. Returns the reports (counts and the names of failed expectations;
        never an output). ``tag`` narrows to one slot."""
        options: Optional[GoldenOptions] = self._o.get("golden")
        call = invoke or (options.invoke if options else None)
        if call is None:
            raise ValueError("golden(): no model call — pass invoke, or start with golden=GoldenOptions(invoke=…)")
        width = concurrency if concurrency is not None else (options.concurrency if options else None)
        if staged:
            if self._store is None or not self._store.state.get("staged") or self._staged_manifest is None:
                return []
            loaded = self._store.load(self._store.state["staged"], **self._verify_options(self._now_iso()))
            return self._run_golden_for(loaded.manifest, loaded.payloads, call, width, tag)
        if self._active is None:
            return []
        return self._run_golden_for(self._active.manifest, self._active.payloads, call, width, tag)

    def _run_golden_for(self, manifest: Mapping[str, Any], payloads: Mapping[str, bytes], invoke: GoldenInvoke, concurrency: Optional[int], only_tag: Optional[str] = None) -> list[GoldenReport]:
        payload = manifest["payload"]
        targets: list[tuple[Mapping[str, Any], str]] = [(slot, "none") for slot in payload.get("slots", []) if slot.get("goldenSet") and (not only_tag or slot["tag"] == only_tag)]
        for experiment in experiments_of(payload):
            for arm in experiment.get("arms", []):
                for override in arm.get("overrides", []):
                    if override.get("goldenSet") and (not only_tag or override["tag"] == only_tag):
                        targets.append((override, arm["arm"]))
        reports: list[GoldenReport] = []
        for slot, arm in targets:
            set_bytes = payloads.get(slot["goldenSet"]["contentHash"])
            text = payloads.get(slot["contentHash"])
            if set_bytes is None or text is None:
                self._log({"event": "golden_set_unavailable", "tag": slot["tag"], "arm": arm, "generation": payload["generation"]})
                continue
            golden_set = parse_golden_set(set_bytes, slot["goldenSet"])
            report = run_golden_set(slot=slot, arm=arm, text=text.decode("utf-8"), golden_set=golden_set, invoke=invoke, concurrency=concurrency, delimiters=self._o.get("delimiters"))
            # One goldenPass per case on the arm's window: the rollout reads pass counts per arm; nothing else leaves the host.
            for result in report.results:
                self.spool.outcomes(tag=slot["tag"], version_id=slot["versionId"], arm=arm, model=slot["model"], outcomes={"goldenPass": result.ok}, at_ms=self._now_ms())
            self._log({"event": "golden_set_run", "generation": payload["generation"], "tag": slot["tag"], "arm": arm, "setId": golden_set["setId"], "cases": report.cases, "passed": report.passed, "minPassBps": report.min_pass_bps, "met": report.meets_threshold})
            reports.append(report)
        self._last_golden = {"generation": payload["generation"], "met": golden_reports_meet(reports), "reports": [r.summary() for r in reports]}
        return reports

    def judge(self, run_ref: str, output: str, rubric: Union[JudgeRubric, str], invoke: Callable[[str], str]) -> JudgeResult:
        """T34: a rubric on the customer's own model, reporting only the score. ``rubric`` is a ``JudgeRubric``, one of the
        templates (``"protection"``, ``"helpfulness"``), or ``"prompt"`` — the ``## Success criteria`` section of the prompt
        the run rendered, read the way the hosted judge reads it. ``invoke`` receives the judge prompt and returns the reply.
        The score lands as ``judgeScore`` on the run's arm window, a failed protection criterion as ``flagged``; the output,
        the rubric text and the reply never reach the spool."""
        if isinstance(rubric, JudgeRubric):
            resolved = rubric
        elif rubric == "prompt":
            resolved = self._prompt_rubric_for(run_ref)
        else:
            resolved = JUDGE_RUBRICS[rubric]
        reply = invoke(judge_prompt(resolved, output))
        result = parse_judge_reply(reply, resolved)
        filed = self.feedback(run_ref, judge_signals_of(result))
        self._log({"event": "judged", "rubric": resolved.name, "criteria": len(resolved.criteria), "score": result.score, "flagged": result.flagged, "filed": filed})
        return result

    def _prompt_rubric_for(self, run_ref: str) -> JudgeRubric:
        facts = parse_run_ref(run_ref, self._run_ref_key)
        payload = self._active.manifest["payload"] if self._active else None
        slot = None
        if facts and payload:
            experiment = experiment_for_tag(payload, facts.tag)
            if experiment:
                arm = next((a for a in experiment["arms"] if a["arm"] == facts.arm), None)
                slot = next((entry for entry in (arm or {}).get("overrides", []) if entry["tag"] == facts.tag), None)
            slot = slot or next((entry for entry in payload["slots"] if entry["tag"] == facts.tag), None)
        text = self._active.payloads.get(slot["contentHash"]) if (slot and self._active) else None
        criteria = rubric_from_prompt(text.decode("utf-8")) if text else []
        return JudgeRubric(name="prompt", criteria=tuple(criteria), protection=JUDGE_RUBRICS["protection"].criteria)

    def feedback(self, run_ref: str, signals: Optional[Mapping[str, Any]] = None, /, **kwargs: Any) -> bool:
        """Quality signals against a run: numbers, booleans and declared enums only; anything else is refused."""
        facts = parse_run_ref(run_ref, self._run_ref_key)
        if facts is None:
            return False
        normalized = normalize_feedback({**(signals or {}), **kwargs})
        if normalized.rejected:
            self._log({"event": "feedback_rejected", "rejected": normalized.rejected})
        if not normalized.accepted:
            return False
        # Feedback rides on the run's window: same dimension set, no extra count (the run was already counted).
        payload = self._active.manifest["payload"] if self._active else None
        override = None
        experiment = experiment_for_tag(payload, facts.tag) if payload else None
        if experiment:
            arm = next((a for a in experiment["arms"] if a["arm"] == facts.arm), None)
            override = next((entry for entry in (arm or {}).get("overrides", []) if entry["tag"] == facts.tag), None)
        slot = override or (next((entry for entry in payload["slots"] if entry["tag"] == facts.tag), None) if payload else None)
        self.spool.outcomes(tag=facts.tag, version_id=facts.version_id, arm=facts.arm, model=slot["model"] if slot and slot["versionId"] == facts.version_id else "unknown", outcomes=normalized.outcomes, at_ms=self._now_ms(), audience_ids=facts.audience_ids, outcome_run_minute=facts.run_minute)
        return True

    # ------------------------------------------------------------------ status

    def healthz(self) -> dict[str, Any]:
        """S14: the in-process healthz — the rules of ``healthz_of`` over this process's own status. Never raises."""
        directory = callable(getattr(self._sink, "depth", None)) and not callable(getattr(self._sink, "drain", None))
        budget = (self._telemetry.spool_budget_bytes or 100 * 1024 * 1024) if directory else None
        return healthz_of(self.status(), spool_budget_bytes=budget, now_ms=self._now_ms())

    def healthz_response(self) -> tuple[int, dict[str, str], str]:
        """S14: ``(status_code, headers, body)`` for a ``GET /healthz`` handler in any framework."""
        return healthz_response(self.healthz())

    def status(self) -> AgentStatus:
        state = self._store.state if self._store else None
        manifest = self._active.manifest["payload"] if self._active else None
        lease_expires_at = self._lease_expires_at()
        depth_of = getattr(self._sink, "depth", None)
        depth = depth_of() if callable(depth_of) else {"segments": 0, "bytes": 0}
        if self._staged_manifest is not None:
            apply_state = "awaiting_unlock"
        elif self._last_refusal:
            apply_state = "refused"
        elif self._source == "vendored_bundle":
            apply_state = "vendored_fallback"
        else:
            apply_state = "active"
        governing = self._window_in_force(self._staged_manifest or (self._active.manifest if self._active else None))
        window = None
        if governing:
            ws = window_state(governing[1], self._now_ms())
            window = {"source": governing[0], "open": ws.open, "opens_at": iso_ms(ws.opens_at_ms), "closes_at": iso_ms(ws.closes_at_ms)}
        return AgentStatus(
            instance_id=self._own_instance_id,
            generation=self._active.generation if self._active else 0,
            staged_generation=self._staged_manifest["payload"]["generation"] if self._staged_manifest else None,
            apply_state=apply_state,
            last_refusal=self._last_refusal,
            storage_protection=self._store.storage_protection if self._store else "custom",
            signing_key_id=self._active.signing_key_id if self._active else None,
            lease_expires_at=lease_expires_at,
            lease_expired=instant(lease_expires_at) <= self._now_ms() if lease_expires_at else False,
            on_lease_expiry=manifest.get("onLeaseExpiry") if manifest else None,
            last_contact_at=None if self._last_contact_ms is None else iso_ms(self._last_contact_ms),
            forced_downgrade=bool(state and state.get("forcedDowngrade") is True),
            disabled=self._disabled_now(),
            unlock_requests=[{k: d[k] for k in ("releaseDigest", "requestedBy", "requestedAt", "expiresAt", "note") if k in d} for d in self._open_unlock_requests(manifest or (self._staged_manifest["payload"] if self._staged_manifest else None))],
            window=window,
            heartbeat={
                "last_at": None if self._last_heartbeat_ms is None else iso_ms(self._last_heartbeat_ms),
                "next_at": None if self._next_heartbeat_ms is None or not self._heartbeat_timer.armed else iso_ms(self._next_heartbeat_ms),
                "interval_seconds": self._heartbeat_interval_seconds,
                "last_refusal": self._last_heartbeat_refusal,
            },
            spool={"depth_segments": depth["segments"], "depth_bytes": depth["bytes"]},
            source=self._source,
            last_sync_at=None if self._last_sync_ms is None else iso_ms(self._last_sync_ms),
            last_sync_outcome=self._last_sync_outcome,
            consecutive_sync_failures=self._consecutive_sync_failures,
            next_sync_at=None if self._next_sync_ms is None or not self._timer.armed else iso_ms(self._next_sync_ms),
            golden=self._last_golden,
            apply_policy=self._effective_apply_policy(),
            upload=self._uploader.status() if self._uploader is not None else None,
            telemetry=self._telemetry_placement(),
            ramp=self._ramp_status(manifest),
            ramps=self._ramp_statuses(manifest),
            variables=self._variables_status(),
            datastore=(self._datastore_status or {"region": self._o["datastore"].region, "last_hydrate_at": None, "last_outcome": None, "newest_generation": 0, "rows_from": None, "rollback": None}) if self._o.get("datastore") is not None else None,
        )

    @property
    def generation(self) -> int:
        return self._active.generation if self._active else 0

    @property
    def manifest(self) -> Optional[Mapping[str, Any]]:
        return self._active.manifest if self._active else None

    @property
    def trusted_root_key_ids(self) -> list[str]:
        return list(self._trusted_root["signed"]["keys"].keys())

    @property
    def instance_id(self) -> str:
        """The runtime's own random id — this process's, fresh at every start (S6); never a hostname, never the store's."""
        return self._own_instance_id

    @staticmethod
    def thumbprint(jwk: Mapping[str, Any]) -> str:
        return key_thumbprint(jwk)

    @staticmethod
    def new_instance_id() -> str:
        return random_id()

    def drain_memory_sink(self) -> list[dict[str, Any]]:
        """The memory sink's rows on serverless hosts (the host's uploader takes them at invocation end); a ``dropped`` row closes an over-budget invocation."""
        drain = getattr(self._sink, "drain", None)
        return drain(self._now_ms()) if callable(drain) else []

    def refusal_row(self, *, at: str, reason: str, generation: int, tag: Optional[str]) -> None:
        self.spool.refusal(at=at, reason=reason, generation=generation, tag=tag, at_ms=self._now_ms())

    def stop(self) -> None:
        """Stop timers and uploads, and close the spool."""
        self._stopped = True
        self._timer.cancel()
        self._window_timer.cancel()
        self._spool_timer.cancel()
        self._heartbeat_timer.cancel()
        self._datastore_timer.cancel()
        with self._placing:
            if self._uploader is not None:
                self._uploader.stop()
        # A pass or a heartbeat in flight finishes first.
        with self._heartbeat_lock:
            pass
        with self._sync_lock:
            pass
        self.spool.close_windows(self._now_ms())
        if self._client is not None:
            self._client.close()

    def __enter__(self) -> "AirPrompterAgent":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.stop()
