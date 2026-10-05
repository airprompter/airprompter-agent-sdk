"""``runRef``: a compact, content-free token a customer keeps beside their own
trace to attach feedback later. ``agent·target·slot·versionId·arm·generation·bucket``,
HMAC-signed with a per-store key so a forged ref cannot file signals
against a version that was never run here. Carries no subject and no text.

Example::

    facts = RunRefFacts(agent_id="agt_1", target="prod", tag="support.reply", version_id="ver_9", arm="none", generation=12, bucket=None)
    run_ref = mint_run_ref(facts, key)   # the per-store key; keep the token beside your own trace
    parse_run_ref(run_ref, key)          # the facts back, or None for a forged or foreign token
"""

from __future__ import annotations

import json
import re
from ..protocol.assignment import valid_audience_ids

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
    audience_ids: Optional[tuple[str, ...]] = None
    run_minute: Optional[str] = None


def _mac(body: str, key: bytes) -> str:
    return b64url_encode(hmac.new(key, body.encode("utf-8"), hashlib.sha256).digest())[:22]


def mint_run_ref(facts: RunRefFacts, key: bytes) -> str:
    body = _SEP.join([facts.agent_id, facts.target, facts.tag, facts.version_id, facts.arm, str(facts.generation), "-" if facts.bucket is None else str(facts.bucket)])
    if facts.audience_ids is not None:
        body += _SEP + json.dumps([facts.audience_ids, facts.run_minute], separators=(",", ":"))
    return f"{b64url_encode(body.encode('utf-8'))}.{_mac(body, key)}"


def parse_run_ref(token: str, key: bytes) -> Optional[RunRefFacts]:
    dot = token.rfind(".")
    if dot <= 0 or len(token) > 4096:
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
    if len(parts) not in (7, 8):
        return None
    cohort = {}
    if len(parts) == 8:
        try:
            ids, minute = json.loads(parts[7])
            if not valid_audience_ids(ids) or not isinstance(minute,str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z",minute): return None
            from .._util import instant
            instant(minute)
            cohort = {"audience_ids": tuple(ids), "run_minute": minute}
        except (ValueError, TypeError): return None
    agent_id, target, tag, version_id, arm, generation, bucket = parts[:7]
    try:
        return RunRefFacts(agent_id, target, tag, version_id, arm, int(generation), None if bucket == "-" else int(bucket), **cohort)
    except ValueError:
        return None
