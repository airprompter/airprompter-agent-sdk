"""``runRef``: a compact, content-free token a customer keeps beside their own trace to attach feedback later. One body
form: ``[agentId, target, runId, entries]`` as JSON, base64url, then the same 22-character HMAC. One entry per slot the
run used, so a one-slot run is a list of one. ``run_id`` is fixed, because a token that grows cannot be the run's
identity. The token carries no subject, tag values, or prompt text.

Readers are tolerant so a host can grow a ref a later SDK wrote: a body element past the fourth lands in ``extra``,
unknown keys stay on their entry, and both survive ``mint_run_ref``. Readers accept more than minting writes. A hosted
run's ref (prompt-haven) is a different token and is never parsed here.

An entry is the wire's own dict (camelCase), so its unknown keys and its key order survive a re-mint. Built here and in
the TypeScript SDK in the same key order, a token is byte-identical in both.

Example::

    key = run_ref_key_from(api_key, "agt_1", "prod")   # the same on every instance of this agent and target
    facts = RunRefFacts("agt_1", "prod", new_run_id(), ({"tag": "support.reply", "artifactId": "prm_reply", "versionId": "ver_9", "model": "gpt-5", "arm": "none", "bucket": None, "runMinute": "2026-09-12T14:03:00Z"},))
    run_ref = mint_run_ref(facts, key)         # keep the token beside your own trace
    parse_run_ref(run_ref, [key, previous])    # tries each key: the facts, or None for a forged or malformed token
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence, Union

from .._util import b64url_decode, b64url_encode
from ..protocol.assignment import valid_audience_ids, valid_audience_minute

RUN_REF_MAX_ENTRIES = 8
#: Eight worst-case entries are about 9,500 characters.
RUN_REF_MAX_TOKEN_LENGTH = 12288
#: Reading stays above minting, so a later minor can raise what is minted.
RUN_REF_READ_MAX_ENTRIES = 32
RUN_REF_READ_MAX_TOKEN_LENGTH = 40960

_ARTIFACT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")
_MAC = re.compile(r"[A-Za-z0-9_-]{22}")
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


@dataclass(frozen=True)
class RunRefFacts:
    agent_id: str
    target: str
    run_id: str
    #: Tags are unique. ``tag``, ``artifactId``, ``versionId``, ``model``, ``arm``, ``bucket``, ``runMinute``, optional ``audienceIds``.
    entries: Sequence[Mapping[str, Any]]
    #: Body elements past the fourth, kept for a later re-mint.
    extra: Sequence[Any] = ()

    @classmethod
    def from_wire(cls, facts: Mapping[str, Any]) -> "RunRefFacts":
        """The protocol's camelCase shape (as the vectors carry it)."""
        return cls(facts["agentId"], facts["target"], facts["runId"], facts["entries"], facts.get("extra", ()))

    def to_wire(self) -> dict[str, Any]:
        return {"agentId": self.agent_id, "target": self.target, "runId": self.run_id, "entries": list(self.entries), **({"extra": list(self.extra)} if self.extra else {})}


def _non_empty(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def _valid_entry(entry: Any) -> bool:
    if not isinstance(entry, Mapping):
        return False
    if not _non_empty(entry.get("tag")) or not _non_empty(entry.get("versionId")) or not _non_empty(entry.get("arm")):
        return False
    artifact_id, model = entry.get("artifactId"), entry.get("model")
    if not isinstance(artifact_id, str) or not _ARTIFACT_ID.fullmatch(artifact_id) or not isinstance(model, str) or not _MODEL_ID.fullmatch(model):
        return False
    if "bucket" not in entry:
        return False
    bucket = entry["bucket"]
    if bucket is not None and (type(bucket) is not int or not 0 <= bucket <= 9999):
        return False
    return valid_audience_minute(entry.get("runMinute")) and ("audienceIds" not in entry or valid_audience_ids(entry["audienceIds"]))


def _body_of(elements: list[Any]) -> bytes:
    """``JSON.stringify``'s bytes: a lone surrogate, which UTF-8 cannot carry, is escaped the way it escapes one."""
    text = json.dumps(elements, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return _LONE_SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", text).encode("utf-8")


def _mac(body: bytes, key: bytes) -> str:
    return b64url_encode(hmac.new(key, body, hashlib.sha256).digest())[:22]


def new_run_id() -> str:
    """22 base64url characters from 16 random bytes."""
    return b64url_encode(secrets.token_bytes(16))


def run_ref_key_from(secret: str, agent_id: str, target: str) -> bytes:
    """The key instances of one agent and target share: derived, so the secret itself never keys a token."""
    return hmac.new(secret.encode("utf-8"), f"airprompter runRef v1\0{agent_id}\0{target}".encode("utf-8"), hashlib.sha256).digest()


def mint_run_ref(facts: RunRefFacts, key: bytes) -> str:
    """Raises ``run_ref_facts_invalid`` past either minting bound, on repeated tags, or on an entry that does not fit."""
    entries = facts.entries
    if not _non_empty(facts.agent_id) or not _non_empty(facts.target) or not _non_empty(facts.run_id) or not isinstance(entries, (list, tuple)) or len(entries) > RUN_REF_MAX_ENTRIES:
        raise ValueError("run_ref_facts_invalid")
    if not all(_valid_entry(entry) for entry in entries) or len({entry["tag"] for entry in entries}) != len(entries):
        raise ValueError("run_ref_facts_invalid")
    try:
        body = _body_of([facts.agent_id, facts.target, facts.run_id, [dict(entry) for entry in entries], *facts.extra])
    except (TypeError, ValueError):
        raise ValueError("run_ref_facts_invalid") from None
    token = f"{b64url_encode(body)}.{_mac(body, key)}"
    if len(token) > RUN_REF_MAX_TOKEN_LENGTH:
        raise ValueError("run_ref_facts_invalid")
    return token


def _refuse_constant(name: str) -> None:
    raise ValueError(name)


def parse_run_ref(token: str, keys: Union[bytes, Sequence[bytes]]) -> Optional[RunRefFacts]:
    """The authenticated facts, or None for a forged or malformed token. ``keys`` is tried in order, so a rotation keeps older refs working."""
    if not isinstance(token, str):
        return None
    dot = token.rfind(".")
    if dot <= 0 or len(token) > RUN_REF_READ_MAX_TOKEN_LENGTH:
        return None
    mac = token[dot + 1 :]
    if not _MAC.fullmatch(mac):
        return None
    try:
        body = b64url_decode(token[:dot])
    except ValueError:
        return None
    candidates = [keys] if isinstance(keys, (bytes, bytearray, memoryview)) else keys
    if not any(hmac.compare_digest(mac.encode("ascii"), _mac(body, bytes(key)).encode("ascii")) for key in candidates):
        return None
    try:
        parsed = json.loads(body.decode("utf-8"), parse_constant=_refuse_constant)
    except (ValueError, RecursionError):
        return None
    if not isinstance(parsed, list) or len(parsed) < 4:
        return None
    agent_id, target, run_id, entries, *extra = parsed
    if not _non_empty(agent_id) or not _non_empty(target) or not _non_empty(run_id) or not isinstance(entries, list) or len(entries) > RUN_REF_READ_MAX_ENTRIES or not all(_valid_entry(entry) for entry in entries):
        return None
    return RunRefFacts(agent_id, target, run_id, entries, extra)
