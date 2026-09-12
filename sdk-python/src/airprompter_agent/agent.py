"""``AirPrompterAgent`` — the runtime a customer application holds.

``start()`` reads the store before any network and serves immediately from
the last verified release (other slot → vendored bundle → refuse to start
when nothing verifies); sync runs in the background per mode. ``prompt(tag)``
renders with trust-aware variables and hands back a content-free ``run_ref``;
``workflow(tag)`` yields steps in order; ``report()``, ``observe()`` and
``feedback()`` feed the spool. Zero network on the render path, ever.

Threads: resident mode runs its sync, heartbeat and window timers on daemon
threads; every public method is safe to call from any thread. ``stop()``
cancels the timers, waits for a pass in flight, and closes the spool.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import platform
import random as _random
import re
import sys
import threading
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Optional, Sequence, TypeVar, Union

import httpx

from ._util import instant, iso_ms, now_ms, random_id
from .apply.window import UpdateWindow, parse_window, window_state
from .bundle.apbundle import DistributionKey, bundle_payload_bytes, open_bundle
from .protocol.assignment import assign_arm, ordered_steps
from .protocol.trust import key_thumbprint, trusted_root_from_pinned_key, verify_root_metadata
from .render.run_ref import RunRefFacts, mint_run_ref, parse_run_ref
from .render.template import Delimiters, render_template
from .spool.feedback import normalize_feedback
from .spool.writer import DirectorySink, MemorySink, Observation, SpoolSink, SpoolWriter, WriterIdentity
from .store.key_provider import KeyProvider, file_key
from .store.slot_store import LoadedSlot, SlotStore, StoreError
from .sync.client import SyncClient
from .sync.daemon import DaemonClient, daemon_socket_path
from .sync.loop import jittered_delay_ms, sync_once
from .checks import evaluate_checks, output_text_of
from .telemetry.observe import ObserveTarget, observe_call, observe_call_async

SDK_NAME = "agent-sdk-python"
SDK_VERSION = "0.1.0"
#: The protocol this SDK speaks; the heartbeat names it (the manifest carries its own).
PROTOCOL_VERSION = "0.2.5"
_USER_AGENT = f"{SDK_NAME}/{SDK_VERSION}"
_REFUSAL_WORD = re.compile(r"^[a-z_]+$")

T = TypeVar("T")


# ----------------------------------------------------------------------------- options


@dataclass
class SyncOptions:
    mode: str = "resident"  # "resident" | "on_invoke" | "daemon" | "offline"
    poll_seconds: float = 30
    edge_pointer_url: Optional[str] = None
    root_url: Optional[str] = None
    daemon_socket_path: Optional[str] = None


@dataclass
class StagedRelease:
    """What the ``on_staged`` hook receives: call ``activate()`` to go live; return (or raise) without it to leave the release staged."""

    generation: int
    manifest: Mapping[str, Any]
    activate: Callable[[], None]
    unlock_request: Optional[Mapping[str, Any]]


@dataclass
class ApplyOptions:
    #: Overrides the manifest's policy locally (the local side can be stricter, never looser).
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


@dataclass
class VendoredBundle:
    #: A path to a ``.apbundle`` file, or the parsed document.
    bundle: Union[str, Mapping[str, Any]]
    distribution_key: Optional[DistributionKey] = None


@dataclass(frozen=True)
class Rendered:
    text: str
    model: str
    version_id: str
    arm: str
    generation: int
    run_ref: str
    tag: str


@dataclass(frozen=True)
class WorkflowStep:
    step_id: str
    ordinal: int
    version_id: str
    text: str
    run_ref: str


@dataclass(frozen=True)
class Workflow:
    model: str
    arm: str
    steps: list[WorkflowStep]
    variables: list[Mapping[str, Any]]


@dataclass
class AgentStatus:
    instance_id: str
    generation: int
    staged_generation: Optional[int]
    apply_state: str  # "active" | "staged" | "awaiting_unlock" | "refused" | "vendored_fallback"
    last_refusal: Optional[str]
    storage_protection: str  # a StorageProtection, or "daemon"
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
    source: str  # "store" | "vendored_bundle" | "daemon"
    daemon: Optional[dict[str, Any]]
    last_sync_at: Optional[str]
    last_sync_outcome: Optional[str]
    consecutive_sync_failures: int
    next_sync_at: Optional[str]


@dataclass(frozen=True)
class ReleaseChange:
    generation: int
    staged_generation: Optional[int]


class RenderRefusedError(Exception):
    """``render()`` refused by the control plane's standing instructions: a disable directive, or a lapsed lease on a ``halt`` target."""

    def __init__(self, reason: str, tag: str, generation: int):
        super().__init__(f"render {tag}: refused ({reason}) on generation {generation}")
        self.reason = reason
        self.tag = tag
        self.generation = generation


class AgentStartError(Exception):
    def __init__(self, code: str, message: str):  # "no_verified_release" | "kek_unavailable" | "store_corrupt"
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
    def __init__(self, agent: "AirPrompterAgent", tag: str, subject: Optional[str]):
        self._agent = agent
        self._tag = tag
        self._subject = subject

    def render(self, values: Optional[Mapping[str, Any]] = None, /, **kwargs: Any) -> Rendered:
        merged = {**(values or {}), **kwargs}
        return self._agent._render(self._tag, self._subject, merged)

    def variables(self) -> list[Mapping[str, Any]]:
        return list(self._agent._resolve_slot(self._tag, self._subject)[0].get("variables", []))


class AirPrompterAgent:
    def __init__(self, options: dict[str, Any], store: Optional[SlotStore], trusted_root: Mapping[str, Any], own_instance_id: str, spool_dir: str):
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
        self._daemon: Optional[DaemonClient] = None
        self._daemon_socket: Optional[str] = None
        self._daemon_staged_generation: Optional[int] = None
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
        self._last_contact_ms: Optional[float] = None
        self._bundle_not_after: Optional[str] = None
        # T9: directives from the latest manifest whose envelope verified — honoured even when that manifest was left staged,
        # held back, or ignored as the generation already held. A Freeze reaches a fleet that never unlocks.
        self._standing_directives: Optional[tuple[int, list[Mapping[str, Any]]]] = None
        self._heartbeat_interval_seconds = min(3600, max(30, int(round(options.get("heartbeat_seconds") or 300))))
        self._last_heartbeat_ms: Optional[float] = None
        self._next_heartbeat_ms: Optional[float] = None
        self._last_heartbeat_refusal: Optional[str] = None
        self._halt_without_contact_warned = False
        self._local_window: Optional[UpdateWindow] = parse_window(self._apply_options.window) if self._apply_options.window else None
        self._stamped_refusals: set[str] = set()
        self._stopped = False
        self._run_ref_key = hmac.new(own_instance_id.encode("utf-8"), b"runRef", hashlib.sha256).digest()
        serverless = self._sync_options.mode == "on_invoke"
        sink_kind = self._telemetry.sink or ("memory" if serverless else "directory")
        self._sink: SpoolSink = MemorySink({"instanceId": own_instance_id}, self._telemetry.buffer_bytes or 256 * 1024) if sink_kind == "memory" else DirectorySink(spool_dir, own_instance_id, self._telemetry.spool_budget_bytes or 100 * 1024 * 1024)
        self.spool = SpoolWriter(self._sink, WriterIdentity(own_instance_id, self._telemetry.instance_class or ("ephemeral" if serverless else "resident"), _USER_AGENT))
        self._client: Optional[SyncClient] = None
        if options.get("api_key") and self._sync_options.mode not in ("offline", "daemon"):
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
        apply: Optional[Union[ApplyOptions, Mapping[str, Any]]] = None,
        heartbeat_seconds: Optional[float] = None,
        models: Optional[Union[Mapping[str, Any], Sequence[str]]] = None,
        delimiters: Optional[Delimiters] = None,
        telemetry: Optional[Union[TelemetryOptions, Mapping[str, Any]]] = None,
        now: Optional[Callable[[], float]] = None,
        transport: Optional[httpx.BaseTransport] = None,
        random: Optional[Callable[[], float]] = None,
        logger: Optional[Callable[[dict[str, Any]], None]] = None,
    ) -> "AirPrompterAgent":
        """``root`` is ``{"pinned": <P-256 public JWK>}`` for this environment, or a full root document (from the bundle or a previous accept).
        ``api_key`` absent means offline: serve the store or the vendored bundle, never call home."""
        sync_options = _coerce(SyncOptions, sync)
        options: dict[str, Any] = {
            "organization_id": organization_id,
            "agent_id": agent_id,
            "target": target,
            "api_key": api_key,
            "base_url": base_url,
            "countersign_root": countersign_root,
            "require_countersign": require_countersign,
            "sync": sync_options,
            "vendored_bundle": _coerce(VendoredBundle, vendored_bundle) if vendored_bundle is not None else None,
            "apply": _coerce(ApplyOptions, apply),
            "heartbeat_seconds": heartbeat_seconds,
            "models": models,
            "delimiters": delimiters,
            "telemetry": _coerce(TelemetryOptions, telemetry),
            "now": now,
            "transport": transport,
            "random": random,
            "logger": logger,
        }
        resolved_state_dir = state_dir or default_state_dir()
        pinned_root = trusted_root_from_pinned_key(purpose="platform", environment=target, pinned_root=root["pinned"]) if "pinned" in root else root
        if sync_options.mode == "daemon":
            # The host daemon holds the store and its key; this process attaches and never touches store files.
            socket_path = sync_options.daemon_socket_path or daemon_socket_path(state_dir=resolved_state_dir, agent_id=agent_id, target=target)
            client = DaemonClient.connect(socket_path=socket_path, agent_id=agent_id, target=target, sdk=_USER_AGENT)
            if client:
                store_dir = SlotStore.path(state_dir=resolved_state_dir, agent_id=agent_id, target=target)
                agent = cls(options, None, pinned_root, cls.new_instance_id(), os.path.join(store_dir, "spool", "telemetry"))
                agent._daemon_socket = socket_path
                agent._attach_daemon(client)
                return agent
            if logger:
                logger({"sdk": SDK_NAME, "agentId": agent_id, "target": target, "event": "daemon_absent", "socketPath": socket_path})
            # No daemon on this host: in-process sync from this process's own store, exactly as resident mode.
            options["sync"] = SyncOptions(mode="resident", poll_seconds=sync_options.poll_seconds, edge_pointer_url=sync_options.edge_pointer_url, root_url=sync_options.root_url, daemon_socket_path=sync_options.daemon_socket_path)
        provider = key_provider or file_key(os.path.join(SlotStore.path(state_dir=resolved_state_dir, agent_id=agent_id, target=target), "store.key"))
        try:
            store = SlotStore.open(state_dir=resolved_state_dir, agent_id=agent_id, target=target, key_provider=provider)
        except StoreError as error:
            if error.code in ("kek_unavailable", "store_corrupt"):
                raise AgentStartError(error.code, str(error)) from error
            raise
        # The stored root (accepted on an earlier run) is trusted only if it still verifies against the pinned key.
        stored = store.state.get("root")
        now_iso = iso_ms(now() if now else now_ms())
        trusted = stored if stored and verify_root_metadata(candidate=stored, trusted=pinned_root, now=now_iso).ok else pinned_root
        agent = cls(options, store, trusted, store.instance_id, os.path.join(store.dir, "spool", "telemetry"))
        agent._boot()
        return agent

    # ------------------------------------------------------------------ daemon attachment

    def _attach_daemon(self, client: DaemonClient) -> None:
        """Daemon mode: the active release comes over the socket; ``generation`` events refresh it; a lost daemon keeps what is held and reconnects."""
        with self._lock:
            self._daemon = client
            self._daemon_staged_generation = client.hello.staged_generation
            self._active = client.slot()
            self._source = "daemon"
            self._last_contact_ms = self._now_ms()
        self._log({"event": "daemon_attached", "generation": self._active.generation, "daemon": client.hello.daemon})

        def on_event(event: dict[str, Any]) -> None:
            if event.get("event") == "generation":
                staged = event.get("stagedGeneration")
                self._daemon_staged_generation = staged if isinstance(staged, int) else None
                self._refresh_from_daemon()
            if event.get("event") == "shutdown":
                self._log({"event": "daemon_shutdown"})

        def on_close() -> None:
            if self._daemon is not client:
                return
            self._daemon = None
            self._log({"event": "daemon_lost", "socketPath": self._daemon_socket})
            self._schedule_daemon_reconnect()

        client.on_event(on_event)
        client.on_close(on_close)

    def _refresh_from_daemon(self) -> None:
        daemon = self._daemon
        if not daemon:
            return
        try:
            slot = daemon.slot()
        except Exception as error:  # noqa: BLE001
            self._log({"event": "daemon_slot_unavailable", "reason": str(error)})
            return
        with self._lock:
            changed = slot.generation != (self._active.generation if self._active else None)
            self._active = slot
            self._source = "daemon"
            self._last_contact_ms = self._now_ms()
            self._last_refusal = None
        if changed:
            self._emit_change()

    def _schedule_daemon_reconnect(self) -> None:
        self._timer.cancel()
        if self._stopped:
            return

        def reconnect() -> None:
            try:
                client = DaemonClient.connect(socket_path=self._daemon_socket or "", agent_id=self._o["agent_id"], target=self._o["target"], sdk=_USER_AGENT)
                if client:
                    self._attach_daemon(client)
                    return
            except Exception as error:  # noqa: BLE001
                self._log({"event": "daemon_reconnect_failed", "reason": str(error)})
            self._schedule_daemon_reconnect()

        self._timer.thread = self._arm(jittered_delay_ms(self._sync_options.poll_seconds, self._rand) / 1000, reconnect)

    # ------------------------------------------------------------------ boot

    def _verify_options(self, now: str) -> dict[str, Any]:
        return {"now": now, "root": self._trusted_root, "countersign_root": self._o.get("countersign_root"), "require_countersign": self._o.get("require_countersign")}

    def _boot(self) -> None:
        """Store first (active slot, then the other), then the vendored bundle, then refuse. Zero network."""
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
        vendored: Optional[VendoredBundle] = self._o.get("vendored_bundle")
        if self._active is None and vendored is not None:
            try:
                if isinstance(vendored.bundle, str):
                    with open(vendored.bundle, encoding="utf-8") as f:
                        bundle = json.load(f)
                else:
                    bundle = vendored.bundle
                contents = open_bundle(bundle, {"agentId": self._o["agent_id"], "target": self._o["target"]}, vendored.distribution_key)
                self._bundle_not_after = contents["notAfter"]
                if instant(contents["notAfter"]) <= instant(now):
                    self._log({"event": "vendored_bundle_past_not_after", "notAfter": contents["notAfter"]})
                verdict = verify_root_metadata(candidate=contents["keySet"], trusted=self._trusted_root, now=now)
                if verdict.ok:
                    self._trusted_root = contents["keySet"]
                    store.accept_root(contents["keySet"])
                # Stage through the store so the bundle's release becomes the encrypted A slot: the same verification path as OTA.
                store.stage(manifest=contents["manifest"], payloads=bundle_payload_bytes(contents))
                slot = store.activate()
                self._active = store.load(slot, **self._verify_options(now))
                self._source = "vendored_bundle"
                self._log({"event": "vendored_bundle_applied", "generation": self._active.generation})
            except Exception as error:  # noqa: BLE001
                self._log({"event": "vendored_bundle_unusable", "reason": str(error)})
        if self._active is None and self._client is not None:
            # Nothing verified locally: one synchronous sync before serving is the only time the SDK waits on the network.
            self.sync_now()
        if self._active is None:
            raise AgentStartError("no_verified_release", "no verified release in the store, no usable vendored bundle, and nothing could be fetched")
        if self._client is not None and self._sync_options.mode == "resident":
            self._schedule()
            # The first heartbeat goes out right after boot so the fleet view sees the instance before its first interval.
            threading.Thread(target=self._first_heartbeat, name="airprompter-heartbeat", daemon=True).start()
        self._schedule_window_unlock()

    def _first_heartbeat(self) -> None:
        try:
            self.heartbeat_now()
        finally:
            self._schedule_heartbeat()

    # ------------------------------------------------------------------ plumbing

    def on_change(self, listener: Callable[[ReleaseChange], None]) -> Callable[[], None]:
        """Called whenever the active or staged generation changes (sync, unlock, rollback, daemon event)."""
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
        in the log); otherwise the window timer, an operator's ``unlock``, or the hook later. The local policy can only tighten."""
        payload = manifest["payload"]
        local = self._apply_options.policy
        policy = "unlock_required" if local == "unlock_required" or payload.get("applyPolicy") == "unlock_required" else "auto"
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
        daemon = self._daemon
        if daemon is not None:
            try:
                daemon.request("sync")
                self._refresh_from_daemon()
            except Exception as error:  # noqa: BLE001
                self._log({"event": "daemon_sync_failed", "reason": str(error)})
            return
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
                require_countersign=self._o.get("require_countersign"),
                countersign_root=self._o.get("countersign_root"),
                apply_policy=self._apply_policy,
                on_refusal=on_refusal,
                on_directives=self._take_directives,
                catalog=self._declared_models(),
                on_model_unavailable=on_model_unavailable,
            )
            with self._lock:
                self._etag = result.etag
                self._edge_etag = result.edge_etag
                self._trusted_root = result.trusted_root
                self._last_sync_ms = self._now_ms()
                self._last_sync_outcome = result.outcome
                contact = result.outcome in ("unchanged", "activated", "activated_externally", "staged", "nothing_promoted", "held_back")
                if contact:
                    self._last_contact_ms = self._now_ms()
                self._consecutive_sync_failures = 0 if contact else self._consecutive_sync_failures + 1
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

    def _take_directives(self, payload: Mapping[str, Any]) -> None:
        """T9: a verified manifest's directives stand from the moment its envelope verifies; a Freeze is honoured before anything else."""
        if self._standing_directives and self._standing_directives[0] > payload["generation"]:
            return
        before = self._disabled_now()
        self._standing_directives = (payload["generation"], list(payload.get("directives", [])))
        after = self._disabled_now()
        if before != after:
            self._log({"event": "disabled_by_directive" if after["agent"] or after["slots"] else "disable_lifted", "generation": payload["generation"], **after})
        requests = self._open_unlock_requests(payload)
        if requests:
            self._log({"event": "unlock_requested", "generation": payload["generation"], "requests": [{"releaseDigest": r.get("releaseDigest"), "expiresAt": r.get("expiresAt"), "requestedBy": r.get("requestedBy")} for r in requests]})

    def _disabled_now(self) -> dict[str, Any]:
        """What is disabled right now: the standing directives when they are as new as the active manifest, else the active manifest's own."""
        active = self._active.manifest["payload"] if self._active else None
        standing = self._standing_directives
        if standing and (active is None or standing[0] >= active["generation"]):
            return self._disabled_from(standing[1])
        return self._disabled_from(active.get("directives", [])) if active else {"agent": False, "slots": []}

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
            "storageProtection": "custom" if status.storage_protection == "daemon" else status.storage_protection,
            "catalog": {"models": list(dict.fromkeys(models))[:256], "reportedAt": self._now_iso()},
            "lease": {**({"expiresAt": status.lease_expires_at} if status.lease_expires_at else {}), "expired": status.lease_expired},
            "spool": {"depthSegments": status.spool["depth_segments"], "depthBytes": status.spool["depth_bytes"], "droppedSegments": 0, "quarantinedSegments": 0},
            "unlockRequestsSeen": [r["releaseDigest"] for r in status.unlock_requests][:8],
            "disabled": status.disabled,
        }
        if active_digest:
            body["activeReleaseDigest"] = active_digest
        if staged_digest:
            body["stagedReleaseDigest"] = staged_digest
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
        if self._client is None or self._daemon is not None:
            return
        with self._heartbeat_lock:
            try:
                result = self._client.heartbeat(self.heartbeat_body())
                if result.status == "ok":
                    response = result.response or {}
                    with self._lock:
                        self._last_heartbeat_ms = self._now_ms()
                        self._last_heartbeat_refusal = None
                        self._last_contact_ms = self._now_ms()
                        interval = response.get("heartbeatIntervalSeconds")
                        if isinstance(interval, (int, float)) and 30 <= interval <= 3600:
                            self._heartbeat_interval_seconds = int(interval)
                    self._log({"event": "heartbeat", "intervalSeconds": self._heartbeat_interval_seconds, "expiresAt": response.get("expiresAt")})
                elif result.status == "refused":
                    self._last_heartbeat_refusal = result.code or f"http_{result.http_status}"
                    self._log({"event": "heartbeat_refused", "httpStatus": result.http_status, "code": result.code})
                else:
                    self._log({"event": "heartbeat_failed", "httpStatus": result.http_status})
            except Exception as error:  # noqa: BLE001
                self._log({"event": "heartbeat_failed", "reason": str(error)})

    def _schedule_heartbeat(self) -> None:
        self._heartbeat_timer.cancel()
        if self._stopped or self._client is None or self._daemon is not None:
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
        """on_invoke mode: run the handler between two sync passes (the trailing one runs on its own thread, off the response path)."""
        self.sync_now()
        if self._last_heartbeat_ms is None or self._now_ms() - self._last_heartbeat_ms >= self._heartbeat_interval_seconds * 1000:
            threading.Thread(target=self.heartbeat_now, name="airprompter-heartbeat", daemon=True).start()
        try:
            return handler()
        finally:
            self.spool.close_windows(self._now_ms())
            threading.Thread(target=self.sync_now, name="airprompter-sync", daemon=True).start()

    # ------------------------------------------------------------------ unlock / rollback

    def unlock(self) -> Optional[dict[str, int]]:
        """Make a staged release live (an operator's ``airprompter unlock``, an update window, or the change-control hook). Host-wide when attached to a daemon."""
        daemon = self._daemon
        if daemon is not None:
            result = daemon.request("unlock")
            self._refresh_from_daemon()
            return None if result.get("generation") is None else {"generation": int(result["generation"])}
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
        """Instant local rollback to the other slot. Forced when it goes below the stored generation; stamped on evidence. Host-wide when attached to a daemon."""
        daemon = self._daemon
        if daemon is not None:
            result = daemon.request("rollback")
            self._refresh_from_daemon()
            return {"generation": int(result["generation"]), "forced": bool(result.get("forced"))}
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

    def _disabled_by(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        standing = self._standing_directives
        if standing and standing[0] >= payload["generation"]:
            return self._disabled_from(standing[1])
        return self._disabled_from(payload.get("directives", []))

    @staticmethod
    def _disabled_from(directives: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        slots: list[str] = []
        agent = False
        for directive in directives:
            if directive.get("kind") != "disable":
                continue
            if directive.get("scope") == "agent":
                agent = True
            elif directive.get("tag"):
                slots.append(str(directive["tag"]))
        return {"agent": agent, "slots": slots}

    def _lease_expires_at(self) -> Optional[str]:
        if self._active is None:
            return None
        payload = self._active.manifest["payload"]
        if self._last_contact_ms is not None:
            return iso_ms(self._last_contact_ms + payload["leaseSeconds"] * 1000)
        if self._bundle_not_after and self._source == "vendored_bundle":
            return iso_ms(instant(self._bundle_not_after))
        return iso_ms(instant(payload["issuedAt"]) + payload["leaseSeconds"] * 1000)

    def _guard(self, tag: str) -> LoadedSlot:
        active = self._active
        if active is None:
            raise AgentStartError("no_verified_release", "no active release")
        payload = active.manifest["payload"]
        disabled = self._disabled_by(payload)
        if disabled["agent"] or tag in disabled["slots"]:
            self._stamp_refusal("disabled", active.generation, None if disabled["agent"] else tag)
            raise RenderRefusedError("disabled", tag, active.generation)
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

    def _resolve_slot(self, tag: str, subject: Optional[str]) -> tuple[Mapping[str, Any], str, Optional[int]]:
        active = self._guard(tag)
        payload = active.manifest["payload"]
        slot = next((entry for entry in payload["slots"] if entry["tag"] == tag), None)
        if slot is None:
            raise KeyError(f"no slot {tag} on generation {active.generation}")
        experiment = payload.get("experiment")
        if not experiment:
            return slot, "none", None
        subject_value = self._own_instance_id if experiment.get("subjectKey") == "instance" or subject is None else subject
        assigned = assign_arm(salt=experiment["salt"], subject=subject_value, arms=experiment["arms"])
        override = next((entry for entry in assigned.arm.get("overrides", []) if entry["tag"] == tag), None)
        return (override or slot), str(assigned.arm["arm"]), assigned.bucket

    def _text_of(self, slot: Mapping[str, Any]) -> str:
        data = self._active.payloads.get(slot["contentHash"]) if self._active else None
        if data is None:
            raise KeyError(f"payload {slot['contentHash']} not loaded")
        return data.decode("utf-8")

    # ------------------------------------------------------------------ render

    def prompt(self, tag: str, *, subject: Optional[str] = None) -> PromptHandle:
        return PromptHandle(self, tag, subject)

    def _render(self, tag: str, subject: Optional[str], values: Mapping[str, Any]) -> Rendered:
        with self._lock:
            slot, arm, bucket = self._resolve_slot(tag, subject)
            text = render_template(tag=tag, text=self._text_of(slot), variables=slot.get("variables", []), values=values, delimiters=self._o.get("delimiters"))
            generation = self._active.generation if self._active else 0
        facts = RunRefFacts(self._o["agent_id"], self._o["target"], tag, slot["versionId"], arm, generation, bucket)
        return Rendered(text=text, model=slot["model"], version_id=slot["versionId"], arm=arm, generation=generation, run_ref=mint_run_ref(facts, self._run_ref_key), tag=tag)

    def workflow(self, tag: str, *, subject: Optional[str] = None) -> Workflow:
        """A workflow slot's steps in ordinal order, each with its prompt text."""
        with self._lock:
            slot, arm, bucket = self._resolve_slot(tag, subject)
            if slot.get("kind") != "workflow" or not slot.get("steps"):
                raise ValueError(f"{tag} is not a workflow slot")
            active = self._active
            assert active is not None
            steps = [
                WorkflowStep(
                    step_id=step["stepId"],
                    ordinal=step["ordinal"],
                    version_id=step["promptVersionId"],
                    text=(active.payloads.get(step["contentHash"]) or b"").decode("utf-8"),
                    run_ref=mint_run_ref(RunRefFacts(self._o["agent_id"], self._o["target"], step["stepId"], step["promptVersionId"], arm, active.generation, bucket), self._run_ref_key),
                )
                for step in ordered_steps(tag, slot["steps"])
            ]
            return Workflow(model=slot["model"], arm=arm, steps=steps, variables=list(slot.get("variables", [])))

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
            self.spool.checks(tag=target.tag, version_id=target.version_id, arm=target.arm, model=target.model, passed=outcome["passed"], failed=outcome["failed"], at_ms=self._now_ms())
        return outcome

    def _declared_checks_for(self, tag: str, arm: str) -> list[Mapping[str, Any]]:
        """The active manifest's checks for a slot on an arm (the arm's override when it carries one)."""
        active = self._active
        if active is None:
            return []
        payload = active.manifest["payload"]
        slot: Optional[Mapping[str, Any]] = None
        for candidate in (payload.get("experiment") or {}).get("arms", []):
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
            return ObserveTarget(rendered.step_id, rendered.version_id, facts.arm if facts else "none", model or "unknown")
        return ObserveTarget(rendered.tag, rendered.version_id, rendered.arm, rendered.model)

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
        if payload and payload.get("experiment"):
            arm = next((a for a in payload["experiment"]["arms"] if a["arm"] == facts.arm), None)
            override = next((entry for entry in (arm or {}).get("overrides", []) if entry["tag"] == facts.tag), None)
        slot = override or (next((entry for entry in payload["slots"] if entry["tag"] == facts.tag), None) if payload else None)
        self.spool.outcomes(tag=facts.tag, version_id=facts.version_id, arm=facts.arm, model=slot["model"] if slot else "unknown", outcomes=normalized.outcomes, at_ms=self._now_ms())
        return True

    # ------------------------------------------------------------------ status

    def status(self) -> AgentStatus:
        state = self._store.state if self._store else None
        manifest = self._active.manifest["payload"] if self._active else None
        lease_expires_at = self._lease_expires_at()
        depth = self._sink.depth() if isinstance(self._sink, DirectorySink) else {"segments": 0, "bytes": 0}
        if self._staged_manifest is not None or (self._daemon_socket and self._daemon_staged_generation is not None):
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
            staged_generation=self._daemon_staged_generation if self._daemon_socket else (self._staged_manifest["payload"]["generation"] if self._staged_manifest else None),
            apply_state=apply_state,
            last_refusal=self._last_refusal,
            storage_protection=self._store.storage_protection if self._store else "daemon",
            signing_key_id=self._active.signing_key_id if self._active else None,
            lease_expires_at=lease_expires_at,
            lease_expired=instant(lease_expires_at) <= self._now_ms() if lease_expires_at else False,
            on_lease_expiry=manifest.get("onLeaseExpiry") if manifest else None,
            last_contact_at=None if self._last_contact_ms is None else iso_ms(self._last_contact_ms),
            forced_downgrade=bool(state and state.get("forcedDowngrade") is True),
            disabled=self._disabled_now(),
            unlock_requests=[{k: d[k] for k in ("releaseDigest", "requestedBy", "requestedAt", "expiresAt", "note") if k in d} for d in self._open_unlock_requests(manifest)],
            window=window,
            heartbeat={
                "last_at": None if self._last_heartbeat_ms is None else iso_ms(self._last_heartbeat_ms),
                "next_at": None if self._next_heartbeat_ms is None or not self._heartbeat_timer.armed else iso_ms(self._next_heartbeat_ms),
                "interval_seconds": self._heartbeat_interval_seconds,
                "last_refusal": self._last_heartbeat_refusal,
            },
            spool={"depth_segments": depth["segments"], "depth_bytes": depth["bytes"]},
            source=self._source,
            daemon={"attached": self._daemon is not None, "socket_path": self._daemon_socket} if self._daemon_socket else None,
            last_sync_at=None if self._last_sync_ms is None else iso_ms(self._last_sync_ms),
            last_sync_outcome=self._last_sync_outcome,
            consecutive_sync_failures=self._consecutive_sync_failures,
            next_sync_at=None if self._next_sync_ms is None or not self._timer.armed else iso_ms(self._next_sync_ms),
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
        """The runtime's own random id (the store's, or a fresh one per daemon-attached process; never a hostname)."""
        return self._own_instance_id

    @staticmethod
    def thumbprint(jwk: Mapping[str, Any]) -> str:
        return key_thumbprint(jwk)

    @staticmethod
    def new_instance_id() -> str:
        return random_id()

    def drain_memory_sink(self) -> list[dict[str, Any]]:
        """The memory sink's rows on serverless hosts (the host's uploader takes them at invocation end); a ``dropped`` row closes an over-budget invocation."""
        return self._sink.drain(self._now_ms()) if isinstance(self._sink, MemorySink) else []

    def refusal_row(self, *, at: str, reason: str, generation: int, tag: Optional[str]) -> None:
        self.spool.refusal(at=at, reason=reason, generation=generation, tag=tag, at_ms=self._now_ms())

    def stop(self) -> None:
        """Stop timers, detach from the daemon, and close the spool."""
        self._stopped = True
        self._timer.cancel()
        self._window_timer.cancel()
        self._heartbeat_timer.cancel()
        # A pass or a heartbeat in flight finishes first.
        with self._heartbeat_lock:
            pass
        with self._sync_lock:
            pass
        daemon = self._daemon
        self._daemon = None
        if daemon is not None:
            daemon.close()
        self.spool.close_windows(self._now_ms())
        if self._client is not None:
            self._client.close()

    def __enter__(self) -> "AirPrompterAgent":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.stop()
