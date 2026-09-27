"""The datastore format (T40, ``protocol/datastore-format.md``, format 1): where a scope's records live in a key-value
store, and the canonical text of each record. Every SDK and every adapter reads what another wrote, so this is the
contract — ``protocol/vectors/datastore.json`` pins it byte for byte, and ``datastoreRecords.ts`` is the same code.

Example::

    keys = datastore_keys("airprompter/", ReleaseKey("org_1", "agt_1", "prod", "eu-west-1"))
    keys.release(42)   # "airprompter/v1/org_1/agt_1/prod/region.eu-west-1/releases/000000000042.json"
    text = encode_datastore_record({"kind": "latest", "generation": 42})   # '{"format":1,"generation":42,"kind":"latest"}'
    decode_datastore_record(text, "latest")   # or raises DatastoreRecordError("datastore_record_newer" | "datastore_record_invalid")
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from airprompter_agent_core.protocol.canonical_json import canonical_json

DATASTORE_FORMAT = 1


class DatastoreRecordError(Exception):
    """A record this reader will not serve: ``datastore_record_newer`` (a later format) or ``datastore_record_invalid``."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _safe(byte: int) -> bool:
    return 0x30 <= byte <= 0x39 or 0x41 <= byte <= 0x5A or 0x61 <= byte <= 0x7A or byte in (0x5F, 0x2D)


def encode_key_segment(value: str) -> str:
    """One key segment: UTF-8, every byte outside ``A–Z a–z 0–9 _ -`` as ``%XX`` (uppercase). Empty is refused."""
    if not isinstance(value, str) or not value:
        raise ValueError("a datastore key segment is a non-empty string")
    return "".join(chr(b) if _safe(b) else f"%{b:02X}" for b in value.encode("utf-8"))


@dataclass(frozen=True)
class DatastoreKeys:
    base: str
    releases_prefix: str
    latest: str
    edge: str
    control: str

    def release(self, generation: int) -> str:
        return f"{self.releases_prefix}{generation:012d}.json"


def datastore_keys(prefix: str, key: Any) -> DatastoreKeys:
    """``key`` is a ``ReleaseKey`` (``organization_id``, ``agent_id``, ``target``, ``region``)."""
    scope = "global" if key.region is None else f"region.{encode_key_segment(key.region)}"
    base = f"{prefix}v1/{encode_key_segment(key.organization_id)}/{encode_key_segment(key.agent_id)}/{encode_key_segment(key.target)}/{scope}/"
    return DatastoreKeys(base=base, releases_prefix=f"{base}releases/", latest=f"{base}latest.json", edge=f"{base}edge.json", control=f"{base}control.json")


_RELEASE_NAME = re.compile(r"^(\d{12})\.json$")


def generation_of_release_key(releases_prefix: str, key: str) -> Optional[int]:
    if not key.startswith(releases_prefix):
        return None
    match = _RELEASE_NAME.match(key[len(releases_prefix):])
    return int(match.group(1)) if match else None


_FIELDS = {
    "release": ("generation", "releaseDigest", "createdAt", "notAfter", "bundle", "rollout"),
    "latest": ("generation",),
    "edge": ("pointerUrl", "pointerEtag", "manifestEtag", "lastOriginAt"),
    "control": ("generation", "heldBackBelow", "setAt"),
}
_OPTIONAL = {"control": ("reason", "setBy")}


def encode_datastore_record(fields: Mapping[str, Any]) -> str:
    """The canonical text of a record: ``format``, ``kind``, the kind's fields (and its optional ones when set)."""
    kind = fields["kind"]
    record: dict[str, Any] = {"format": DATASTORE_FORMAT, "kind": kind}
    for name in _FIELDS[kind]:
        record[name] = fields[name]
    for name in _OPTIONAL.get(kind, ()):
        if fields.get(name) is not None:
            record[name] = fields[name]
    return canonical_json(record)


def _generation_ok(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def decode_datastore_record(text: str, kind: str, key_generation: Optional[int] = None) -> dict[str, Any]:
    """Decode and check a record of ``kind`` (and, for a release, the generation its key names). Never returns what it refused."""
    try:
        record = json.loads(text)
    except (ValueError, TypeError):
        raise DatastoreRecordError("datastore_record_invalid", f"the {kind} record is not JSON") from None
    if not isinstance(record, dict):
        raise DatastoreRecordError("datastore_record_invalid", f"the {kind} record is not an object")
    fmt = record.get("format")
    if not isinstance(fmt, int) or isinstance(fmt, bool):
        raise DatastoreRecordError("datastore_record_invalid", f"the {kind} record names no format")
    if fmt > DATASTORE_FORMAT:
        raise DatastoreRecordError("datastore_record_newer", f"the {kind} record is format {fmt}; this reader reads format {DATASTORE_FORMAT} — update the SDK or the adapter that reads it")
    if fmt != DATASTORE_FORMAT:
        raise DatastoreRecordError("datastore_record_invalid", f"the {kind} record is format {fmt}")
    if record.get("kind") != kind:
        raise DatastoreRecordError("datastore_record_invalid", f"a {record.get('kind')} record where a {kind} record belongs")
    for name in _FIELDS[kind]:
        if name not in record:
            raise DatastoreRecordError("datastore_record_invalid", f"the {kind} record lacks {name}")
    if kind in ("release", "latest", "control") and not _generation_ok(record["generation"]):
        raise DatastoreRecordError("datastore_record_invalid", f"the {kind} record's generation is not a positive integer")
    if kind == "control" and not _generation_ok(record["heldBackBelow"]):
        raise DatastoreRecordError("datastore_record_invalid", "the control record's heldBackBelow is not a positive integer")
    if kind == "release":
        if not isinstance(record["bundle"], dict) or not isinstance(record["rollout"], dict):
            raise DatastoreRecordError("datastore_record_invalid", "the release record lacks its bundle or rollout")
        if key_generation is not None and record["generation"] != key_generation:
            raise DatastoreRecordError("datastore_record_invalid", f"a generation {record['generation']} release under the key of generation {key_generation}")
    del record["format"]
    return record
