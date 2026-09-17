"""``airprompter_agent_sync`` — pulling and holding releases: the encrypted restart-safe slot store, the key
providers, the sync pass and its loop, the apply policy and its windows, and the daemon client. What the store or the
daemon loads is a ``LoadedSlot`` (a ``LoadedRelease`` for ``airprompter_agent_runtime``); this package never imports
the runtime or the telemetry package (S10).

Example::

    from airprompter_agent_sync import SlotStore, file_key

    store = SlotStore.open(state_dir="/var/lib/acme", agent_id="agt_1", target="prod", key_provider=file_key("/var/lib/acme/store.key"))
    loaded = store.load(store.state["active"], now=now_iso)   # the active slot, verified on every open, or StoreError
"""

from .apply.window import UpdateWindow, WindowState, is_known_time_zone, parse_window, validate_window, window_state
from .store.key_provider import KeyProvider, custom_key_provider, file_key, kms, os_keystore, unwrap_with_raw_key, vault, wrap_with_raw_key
from .store.payload_crypto import PayloadDecryptError, decrypt_payload, encrypt_payload, payload_aad
from .store.slot_store import LoadedSlot, SlotStore, StoreError, StoreHooks
from .sync.daemon import DAEMON_MAX_LINE_BYTES, DaemonClient, DaemonError, DaemonHello, daemon_socket_path
from .sync.loop import SyncPassOutput, jittered_delay_ms, sync_once
from .sync.pull_bundle import DEFAULT_MAX_POINTER_AGE_MS, PullBundleResult, PullEdgeState, next_pull_delay_ms, pull_bundle

__all__ = [
    "DAEMON_MAX_LINE_BYTES",
    "DaemonClient",
    "DaemonError",
    "DaemonHello",
    "KeyProvider",
    "LoadedSlot",
    "PayloadDecryptError",
    "SlotStore",
    "StoreError",
    "StoreHooks",
    "SyncPassOutput",
    "UpdateWindow",
    "WindowState",
    "custom_key_provider",
    "daemon_socket_path",
    "decrypt_payload",
    "encrypt_payload",
    "file_key",
    "is_known_time_zone",
    "jittered_delay_ms",
    "kms",
    "os_keystore",
    "parse_window",
    "payload_aad",
    "sync_once",
    "pull_bundle",
    "PullBundleResult",
    "PullEdgeState",
    "DEFAULT_MAX_POINTER_AGE_MS",
    "next_pull_delay_ms",
    "unwrap_with_raw_key",
    "validate_window",
    "vault",
    "window_state",
    "wrap_with_raw_key",
]
