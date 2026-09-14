"""``runRef``: a compact, content-free token a customer keeps beside their own
trace to attach feedback later. ``agent·target·slot·versionId·arm·generation·bucket``,
HMAC-signed with a per-store key so a forged ref cannot file signals
against a version that was never run here. Carries no subject and no text.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from typing import Optional

from .._util import b64url_decode, b64url_encode

_SEP = "·"


@dataclass(frozen=True)
class RunRefFacts:
    agent_id: str
    target: str
    tag: str
    version_id: str
    arm: str
    generation: int
    bucket: Optional[int]


def _mac(body: str, key: bytes) -> str:
    return b64url_encode(hmac.new(key, body.encode("utf-8"), hashlib.sha256).digest())[:22]


def mint_run_ref(facts: RunRefFacts, key: bytes) -> str:
    body = _SEP.join([facts.agent_id, facts.target, facts.tag, facts.version_id, facts.arm, str(facts.generation), "-" if facts.bucket is None else str(facts.bucket)])
    return f"{b64url_encode(body.encode('utf-8'))}.{_mac(body, key)}"


def parse_run_ref(token: str, key: bytes) -> Optional[RunRefFacts]:
    dot = token.rfind(".")
    if dot <= 0:
        return None
    try:
        body = b64url_decode(token[:dot]).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    mac = token[dot + 1 :]
    expected = _mac(body, key)
    if len(mac) != len(expected) or not hmac.compare_digest(mac.encode("ascii", "replace"), expected.encode("ascii")):
        return None
    parts = body.split(_SEP)
    if len(parts) != 7:
        return None
    agent_id, target, tag, version_id, arm, generation, bucket = parts
    try:
        return RunRefFacts(agent_id, target, tag, version_id, arm, int(generation), None if bucket == "-" else int(bucket))
    except ValueError:
        return None
