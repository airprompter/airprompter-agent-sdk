"""The A/B slot store (D35), modelled on OS update partitions.

::

    <state_dir>/airprompter/<agentId>/<target>/
      store.json            active slot, staged slot, generation, root document, instanceId, wrapped DEK
      slots/A/manifest.json signed envelope, plaintext (no prompt text in it)
      slots/A/payloads/sha256-<hex>.enc
      slots/B/…

Stage into the inactive slot and fsync every file; flip ``active`` by
writing store.json to a temp file and renaming it. A crash mid-apply
leaves the previous slot intact and the staged slot either complete or
discarded on the next open. Every open verifies the manifest signature
against the stored root document and every payload's hash after decrypt.
Any failure marks the slot corrupt and the caller falls back: other slot
→ vendored bundle → refuse to start. Render never serves unverified bytes.

The on-disk layout is byte-for-byte the TypeScript SDK's, so a store one
SDK wrote is a store the other (and the host daemon) can open.
"""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

from .._util import b64url_decode, b64url_encode, fsync_dir, iso_ms, now_ms, random_id
from ..protocol.canonical_json import sha256_prefixed
from ..protocol.trust import Verdict, referenced_payloads, verify_manifest
from .key_provider import KeyProvider
from .payload_crypto import PayloadDecryptError, decrypt_payload, encrypt_payload, payload_aad

SlotName = str  # "A" | "B"


@dataclass
class LoadedSlot:
    slot: SlotName
    manifest: dict[str, Any]
    generation: int
    signing_key_id: str
    #: contentHash → plaintext bytes, all verified.
    payloads: dict[str, bytes] = field(default_factory=dict)


class StoreError(Exception):
    def __init__(self, code: str, message: str, detail: Optional[str] = None):
        # code: "kek_unavailable" | "store_corrupt" | "store_newer" | "slot_corrupt" | "generation_rollback" | "no_release" | "not_staged"
        super().__init__(message)
        self.code = code
        self.detail = detail


def _other_slot(slot: SlotName) -> SlotName:
    return "B" if slot == "A" else "A"


def _write_file_synced(path: str, data: bytes, mode: int = 0o600) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)


def _replace_file_atomically(path: str, data: bytes, before_rename: Optional[Callable[[str], None]] = None) -> None:
    """Write to a temp file, fsync, rename: the file is either the old one or the new one, never half."""
    temp = f"{path}.{os.urandom(4).hex()}.tmp"
    _write_file_synced(temp, data)
    if before_rename:
        before_rename(path)
    os.replace(temp, path)
    fsync_dir(os.path.dirname(path))


@dataclass
class StoreHooks:
    """Test seams: a crash between fsync and rename is the case the layout exists for."""

    before_rename: Optional[Callable[[str], None]] = None
    #: S8: the writer this runtime records in store.json (the SDK's or the daemon's name and version).
    writer: Optional[Mapping[str, str]] = None


#: S8: store.json is a cross-package contract (``protocol/store-format.md``): a reader at format N accepts N and N-1, writes N,
#: migrates an N-1 file forward on its first write, and refuses N+1 with ``store_newer`` naming the writer.
STORE_FORMAT_VERSION = 2
STORE_FORMATS_READ = frozenset({1, 2})
DEFAULT_WRITER = {"name": "agent-sdk-python", "version": "0.1.0"}


class SlotStore:
    def __init__(self, directory: str, file: dict[str, Any], dek: bytes, hooks: Optional[StoreHooks]):
        self.dir = directory
        self._file = file
        self._dek = dek
        self._hooks = hooks

    @staticmethod
    def path(*, state_dir: str, agent_id: str, target: str) -> str:
        return os.path.join(state_dir, "airprompter", agent_id, target)

    @classmethod
    def open(cls, *, state_dir: str, agent_id: str, target: str, key_provider: KeyProvider, hooks: Optional[StoreHooks] = None) -> "SlotStore":
        """Opens (creating on first use). Raises ``kek_unavailable`` when the key provider cannot produce the KEK."""
        directory = cls.path(state_dir=state_dir, agent_id=agent_id, target=target)
        for slot in ("A", "B"):
            os.makedirs(os.path.join(directory, "slots", slot, "payloads"), mode=0o700, exist_ok=True)
        store_path = os.path.join(directory, "store.json")
        if not os.path.exists(store_path):
            dek = os.urandom(32)
            try:
                wrapped = key_provider.wrap(dek)
            except Exception as error:  # noqa: BLE001 — whatever the provider raised is the reason
                raise StoreError("kek_unavailable", f"the key provider could not wrap the store key: {error}") from error
            file: dict[str, Any] = {
                "version": STORE_FORMAT_VERSION,
                "writer": dict(hooks.writer) if hooks and hooks.writer else dict(DEFAULT_WRITER),
                "agentId": agent_id,
                "target": target,
                "instanceId": random_id(),
                "wrappedDek": b64url_encode(wrapped),
                "storageProtection": key_provider.storage_protection,
                "active": None,
                "staged": None,
                "generation": 0,
                "root": None,
                "updatedAt": iso_ms(now_ms()),
            }
            _replace_file_atomically(store_path, json.dumps(file, indent=2).encode("utf-8"))
            return cls(directory, file, dek, hooks)
        try:
            with open(store_path, encoding="utf-8") as f:
                file = json.load(f)
        except (OSError, ValueError) as error:
            raise StoreError("store_corrupt", "store.json is unreadable") from error
        version = file.get("version")
        if isinstance(version, int) and not isinstance(version, bool) and version > STORE_FORMAT_VERSION:
            # N+1: written by something newer than this reader. Never guessed at; the writer is named so the operator knows what to update.
            writer = file.get("writer")
            named = f"{writer.get('name')} {writer.get('version')}" if isinstance(writer, Mapping) else "an unknown writer"
            raise StoreError("store_newer", f"store.json is format {version}, written by {named}; this runtime reads formats {' and '.join(str(v) for v in sorted(STORE_FORMATS_READ))} — update it, or roll the writer back before its next write", named)
        if version not in STORE_FORMATS_READ or file.get("agentId") != agent_id or file.get("target") != target:
            raise StoreError("store_corrupt", "store.json belongs to another agent or target")
        try:
            dek = key_provider.unwrap(b64url_decode(file["wrappedDek"]))
        except Exception as error:  # noqa: BLE001
            raise StoreError("kek_unavailable", f"the key provider could not unwrap the store key: {error}") from error
        if len(dek) != 32:
            raise StoreError("store_corrupt", "unwrapped store key has the wrong length")
        return cls(directory, file, dek, hooks)

    @property
    def state(self) -> Mapping[str, Any]:
        return self._file

    @property
    def instance_id(self) -> str:
        return self._file["instanceId"]

    @property
    def storage_protection(self) -> str:
        return self._file["storageProtection"]

    def rotate_key(self, provider: KeyProvider) -> None:
        """KEK rotation: the DEK is re-WRAPPED under the new provider, never re-generated — every payload stays readable and nothing is re-encrypted."""
        wrapped = provider.wrap(self._dek)
        self._write({**self._file, "wrappedDek": b64url_encode(wrapped), "storageProtection": provider.storage_protection})

    def accept_root(self, root: Mapping[str, Any]) -> None:
        """Persist a newly accepted root document (the caller verified it)."""
        self._write({**self._file, "root": dict(root)})

    def pin_apply_policy(self, *, value: str, source: str, generation: int, set_at: str) -> None:
        """S4: record the apply policy this host holds — ``{"value", "source": "manifest" | "operator", "generation", "setAt"}``."""
        self._write({**self._file, "applyPolicyPin": {"value": value, "source": source, "generation": generation, "setAt": set_at}})

    def stage(self, *, manifest: Mapping[str, Any], payloads: Mapping[str, bytes], force: bool = False) -> SlotName:
        """Stage a verified release into the inactive slot. Refuses a generation below the active one unless ``force`` (a forced downgrade is stamped on evidence)."""
        generation = manifest["payload"]["generation"]
        if generation < self._file["generation"] and not force:
            raise StoreError("generation_rollback", f"generation {generation} is below the stored {self._file['generation']}")
        for content_hash, byte_length in referenced_payloads(manifest["payload"]).items():
            data = payloads.get(content_hash)
            if data is None:
                raise StoreError("slot_corrupt", f"payload {content_hash} missing from the stage set", "payload_missing")
            if len(data) != byte_length or sha256_prefixed(data) != content_hash:
                raise StoreError("slot_corrupt", f"payload {content_hash} does not hash", "payload_hash_mismatch")
        slot = _other_slot(self._file["active"]) if self._file["active"] else "A"
        slot_dir = os.path.join(self.dir, "slots", slot)
        shutil.rmtree(os.path.join(slot_dir, "payloads"), ignore_errors=True)
        os.makedirs(os.path.join(slot_dir, "payloads"), mode=0o700, exist_ok=True)
        for content_hash, data in payloads.items():
            aad = payload_aad(agent_id=self._file["agentId"], target=self._file["target"], generation=generation, content_hash=content_hash)
            _write_file_synced(os.path.join(slot_dir, "payloads", f"{content_hash.replace(':', '-')}.enc"), encrypt_payload(self._dek, data, aad))
        _write_file_synced(os.path.join(slot_dir, "manifest.json"), json.dumps(manifest, separators=(",", ":")).encode("utf-8"))
        next_file = {**self._file, "staged": slot}
        if force and generation < self._file["generation"]:
            next_file["forcedDowngrade"] = True
        self._write(next_file)
        return slot

    def activate(self) -> SlotName:
        """Flip ``active`` to the staged slot: one atomic store.json replace."""
        slot = self._file.get("staged")
        if not slot:
            raise StoreError("not_staged", "nothing is staged")
        generation = self._read_manifest(slot)["payload"]["generation"]
        next_file = dict(self._file)
        held = next_file.get("heldBackBelow")
        if held is not None and generation > held:
            del next_file["heldBackBelow"]  # Moving past a held-back generation ends the hold; a forced downgrade stays stamped.
        next_file.update({"active": slot, "staged": None, "generation": generation})
        self._write(next_file)
        return slot

    def rollback_local(self) -> SlotName:
        """Instant local rollback: the previous release is the other slot. Stamped on evidence by the caller."""
        if not self._file.get("active"):
            raise StoreError("no_release", "nothing is active")
        previous = _other_slot(self._file["active"])
        generation = self._read_manifest(previous)["payload"]["generation"]
        downgrade = generation < self._file["generation"]
        next_file = {**self._file, "active": previous, "staged": None, "generation": generation, "forcedDowngrade": downgrade}
        if downgrade:
            next_file["heldBackBelow"] = self._file["generation"]
        self._write(next_file)
        return previous

    def discard_staged(self) -> None:
        """Discard a staged slot (a crashed apply, or a refused unlock)."""
        slot = self._file.get("staged")
        if not slot:
            return
        shutil.rmtree(os.path.join(self.dir, "slots", slot, "payloads"), ignore_errors=True)
        try:
            os.remove(os.path.join(self.dir, "slots", slot, "manifest.json"))
        except FileNotFoundError:
            pass
        self._write({**self._file, "staged": None})

    def load(
        self,
        slot: SlotName,
        *,
        now: str,
        root: Optional[Mapping[str, Any]] = None,
        require_countersign: Optional[bool] = None,
        countersign_root: Optional[Mapping[str, Any]] = None,
        expect_generation: Optional[int] = None,
    ) -> LoadedSlot:
        """Load and verify a slot. Raises ``slot_corrupt`` on any failure — never returns unverified bytes."""
        trusted = root if root is not None else self._file.get("root")
        if not trusted:
            raise StoreError("slot_corrupt", "no trusted root document to verify against")
        manifest = self._read_manifest(slot)
        generation = manifest["payload"]["generation"]
        # The active slot must hold the generation store.json says it holds: directories swapped on disk put an older
        # manifest (self-consistent, still signed) behind the active letter, and this is where that shows.
        if expect_generation is not None and generation != expect_generation:
            raise StoreError("slot_corrupt", f"slot {slot} holds generation {generation}, store.json expects {expect_generation}", "generation_rollback")
        payloads: dict[str, bytes] = {}
        for content_hash in referenced_payloads(manifest["payload"]):
            path = os.path.join(self.dir, "slots", slot, "payloads", f"{content_hash.replace(':', '-')}.enc")
            if not os.path.exists(path):
                raise StoreError("slot_corrupt", f"payload {content_hash} missing", "payload_missing")
            with open(path, "rb") as f:
                sealed = f.read()
            try:
                payloads[content_hash] = decrypt_payload(self._dek, sealed, payload_aad(agent_id=self._file["agentId"], target=self._file["target"], generation=generation, content_hash=content_hash))
            except PayloadDecryptError as error:
                raise StoreError("slot_corrupt", f"payload {content_hash} does not decrypt for this slot", "payload_hash_mismatch") from error
        scope = {"organizationId": manifest["payload"]["organizationId"], "agentId": self._file["agentId"], "target": self._file["target"]}
        # A stored slot is checked against itself, not the store's counter: the counter is the anti-rollback for NEW manifests.
        verdict: Verdict = verify_manifest(manifest=manifest, root=trusted, now=now, scope=scope, stored_generation=0, payloads=payloads, countersign_root=countersign_root, require_countersign=require_countersign)
        if not verdict.ok:
            # Expired root: the bytes are still the last verified release; report and serve (D39). Everything else is corrupt.
            if verdict.reason == "root_expired":
                relaxed_root = {**trusted, "signed": {**trusted["signed"], "expires": "9999-12-31T23:59:59Z"}}
                relaxed = verify_manifest(manifest=manifest, root=relaxed_root, now=now, scope=scope, stored_generation=0, payloads=payloads)
                if relaxed.ok:
                    return LoadedSlot(slot, manifest, generation, relaxed.signing_key_id or "", payloads)
            raise StoreError("slot_corrupt", f"slot {slot} failed verification: {verdict.reason}", verdict.reason)
        return LoadedSlot(slot, manifest, generation, verdict.signing_key_id or "", payloads)

    def list_slot_files(self, slot: SlotName) -> list[str]:
        base = os.path.join(self.dir, "slots", slot)
        if not os.path.isdir(base):
            return []
        names = []
        for root_dir, _dirs, files in os.walk(base):
            for name in files:
                names.append(os.path.relpath(os.path.join(root_dir, name), base))
        return sorted(names)

    def _read_manifest(self, slot: SlotName) -> dict[str, Any]:
        path = os.path.join(self.dir, "slots", slot, "manifest.json")
        if not os.path.exists(path):
            raise StoreError("slot_corrupt", f"slot {slot} has no manifest")
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError) as error:
            raise StoreError("slot_corrupt", f"slot {slot} manifest is unreadable", "schema_invalid") from error

    def _write(self, next_file: dict[str, Any]) -> None:
        # S8: what this reader would write — an N-1 file migrates forward here, on the first write, never on open (the rollback window).
        file = {**next_file, "version": STORE_FORMAT_VERSION, "writer": dict(self._hooks.writer) if self._hooks and self._hooks.writer else dict(DEFAULT_WRITER), "updatedAt": iso_ms(now_ms())}
        _replace_file_atomically(os.path.join(self.dir, "store.json"), json.dumps(file, indent=2).encode("utf-8"), self._hooks.before_rename if self._hooks else None)
        self._file = file
