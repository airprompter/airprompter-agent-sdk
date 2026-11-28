"""``airprompter_agent.sync``: pulling and holding releases: the encrypted restart-safe slot store, the key
providers, the sync pass and its loop, the apply policy and its windows, and the customer's datastore. What the store
loads is a ``LoadedSlot`` (a ``LoadedRelease`` for ``airprompter_agent.runtime``); this layer never imports
the runtime or the telemetry layer.

Example::

    from airprompter_agent.sync import SlotStore, file_key

    store = SlotStore.open(state_dir="/var/lib/acme", agent_id="agt_1", target="prod", key_provider=file_key("/var/lib/acme/store.key"))
    loaded = store.load(store.state["active"], now=now_iso)   # the active slot, verified on every open, or StoreError
    pull_to_datastore(datastore=releases, region="eu-west-1", client=client, scope=scope, trusted_root=root, now=now, distribution_public_key=fleet_public_raw)
"""

from .apply.window import UpdateWindow, WindowState, is_known_time_zone, parse_window, validate_window, window_state
from .store.key_provider import KeyProvider, custom_key_provider, file_key, kms, os_keystore, vault
from .store.datastore_records import (
    DatastoreRecordError,
    datastore_keys,
    decode_datastore_record,
    encode_datastore_record,
)
from .store.kv_store import FileKvStore, KvEntry, KvStore, KvStoreReport, MemoryKvStore, check_kv_store
from .store.release_datastore import (
    DatastoreRollbackResult,
    HydrationPlan,
    KvReleaseDatastore,
    MemoryReleaseDatastore,
    ReleaseControl,
    ReleaseDatastore,
    ReleaseKey,
    StoredReleaseRow,
    clear_datastore_rollback,
    kv_release_datastore,
    prune_datastore,
    resolve_hydration,
    rollback_datastore,
)
from .store.payload_crypto import PayloadDecryptError
from .store.slot_store import LoadedSlot, SlotStore, StoreError, StoreHooks
from .sync.loop import SyncPassOutput, jittered_delay_ms, sync_once
from .sync.pull_bundle import PullBundleResult, PullEdgeState, next_pull_delay_ms, pull_bundle
from .sync.pull_to_datastore import PullToDatastoreResult, pull_to_datastore
from .sync.loop import required_models_missing

# The names 1.0 promises (docs/stability.md), one per line: tests/test_package_shape.py pins them. Every other name
# imported above is the layer's own, for the layers above it, and not public.
__all__ = [
    "DatastoreRollbackResult",
    "FileKvStore",
    "KeyProvider",
    "KvEntry",
    "KvReleaseDatastore",
    "KvStore",
    "KvStoreReport",
    "LoadedSlot",
    "MemoryKvStore",
    "MemoryReleaseDatastore",
    "PayloadDecryptError",
    "PullBundleResult",
    "PullEdgeState",
    "PullToDatastoreResult",
    "ReleaseControl",
    "ReleaseDatastore",
    "ReleaseKey",
    "SlotStore",
    "StoreError",
    "StoreHooks",
    "StoredReleaseRow",
    "SyncPassOutput",
    "UpdateWindow",
    "WindowState",
    "check_kv_store",
    "clear_datastore_rollback",
    "custom_key_provider",
    "file_key",
    "is_known_time_zone",
    "kms",
    "kv_release_datastore",
    "next_pull_delay_ms",
    "os_keystore",
    "parse_window",
    "prune_datastore",
    "pull_bundle",
    "pull_to_datastore",
    "rollback_datastore",
    "sync_once",
    "validate_window",
    "vault",
    "window_state",
]

# Imported for the layers above and never public: named here so each import is used on purpose, and so no one
# reads one as a promise. tests/test_package_shape.py checks this and ``__all__`` cover every import, apart.
_FOR_THE_LAYERS_ABOVE = (
    DatastoreRecordError,
    HydrationPlan,
    datastore_keys,
    decode_datastore_record,
    encode_datastore_record,
    jittered_delay_ms,
    required_models_missing,
    resolve_hydration,
)
