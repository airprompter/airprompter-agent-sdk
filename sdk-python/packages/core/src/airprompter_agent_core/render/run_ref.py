"""``runRef``: a compact, content-free token a customer keeps beside their own
trace to attach feedback later. Its legacy seven-part body remains readable;
Team runs add an authenticated JSON extension with the atomic artifact/model
pair and, when targeted, opaque audience IDs plus the original run minute.
The per-store HMAC prevents forged feedback. No subject, tag value, or prompt
text is carried.

Example::

    facts = RunRefFacts(agent_id="agt_1", target="prod", tag="support.reply", version_id="ver_9", arm="none", generation=12, bucket=None,
                        artifact_id="prm_reply", model="gpt-5", audience_ids=("aud_AAAAAAAAAAAAAAAAAAAAAA",), run_minute="2026-09-12T14:03:00Z")
    run_ref = mint_run_ref(facts, key)   # the per-store key; keep the token beside your own trace
    parse_run_ref(run_ref, key)          # authenticated facts, or None for a forged/malformed token
"""

from __future__ import annotations

import json
import re
from ..protocol.assignment import valid_audience_ids

import hashlib
import hmac
from dataclasses import dataclass
from typing import Optional

from .._util import b64url_decode, b64url_encode, instant

_SEP = "·"
_ARTIFACT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")


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
    artifact_id: Optional[str] = None
    model: Optional[str] = None


def _mac(body: str, key: bytes) -> str:
    return b64url_encode(hmac.new(key, body.encode("utf-8"), hashlib.sha256).digest())[:22]


def mint_run_ref(facts: RunRefFacts, key: bytes) -> str:
    if any(not isinstance(value, str) or _SEP in value for value in (facts.agent_id, facts.target, facts.tag, facts.version_id, facts.arm)):
        raise ValueError("run_ref_facts_invalid")
    if not isinstance(facts.generation, int) or isinstance(facts.generation, bool) or not 1 <= facts.generation <= 9007199254740991 or facts.bucket is not None and (
        not isinstance(facts.bucket, int) or isinstance(facts.bucket, bool) or not 0 <= facts.bucket <= 9999
    ):
        raise ValueError("run_ref_facts_invalid")
    if (facts.artifact_id is None) != (facts.model is None) or facts.artifact_id is not None and (
        not isinstance(facts.artifact_id, str) or not _ARTIFACT_ID.fullmatch(facts.artifact_id)
        or not isinstance(facts.model, str) or not _MODEL_ID.fullmatch(facts.model)
    ):
        raise ValueError("run_ref_facts_invalid")
    try:
        if facts.run_minute is not None:
            if not isinstance(facts.run_minute, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z", facts.run_minute): raise ValueError
            instant(facts.run_minute)
            if facts.artifact_id is None and facts.audience_ids is None: raise ValueError
        if facts.audience_ids is not None and (not valid_audience_ids(facts.audience_ids) or facts.run_minute is None): raise ValueError
    except (ValueError, TypeError, OverflowError):
        raise ValueError("run_ref_facts_invalid") from None
    body = _SEP.join([facts.agent_id, facts.target, facts.tag, facts.version_id, facts.arm, str(facts.generation), "-" if facts.bucket is None else str(facts.bucket)])
    extension = None
    if facts.artifact_id is not None:
        extension = {"artifactId": facts.artifact_id, "model": facts.model}
        if facts.run_minute is not None:
            extension["runMinute"] = facts.run_minute
        if facts.audience_ids is not None:
            extension["audienceIds"] = facts.audience_ids
    elif facts.audience_ids is not None:
        extension = [facts.audience_ids, facts.run_minute]
    if extension is not None:
        body += _SEP + json.dumps(extension, separators=(",", ":"))
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
    agent_id, target, tag, version_id, arm, generation_text, bucket_text = parts[:7]
    if not re.fullmatch(r"[1-9][0-9]*", generation_text) or bucket_text != "-" and not re.fullmatch(r"(?:0|[1-9][0-9]{0,3})", bucket_text):
        return None
    generation = int(generation_text)
    bucket = None if bucket_text == "-" else int(bucket_text)
    if generation > 9007199254740991 or bucket is not None and bucket > 9999:
        return None
    cohort = {}
    if len(parts) == 8:
        try:
            extension = json.loads(parts[7])
            if isinstance(extension, list):
                if len(extension) != 2: return None
                ids, minute = extension
                if not valid_audience_ids(ids) or not isinstance(minute,str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z",minute): return None
                from .._util import instant
                instant(minute)
                cohort = {"audience_ids": tuple(ids), "run_minute": minute}
            elif isinstance(extension, dict):
                if not set(extension).issubset({"artifactId","model","audienceIds","runMinute"}): return None
                artifact_id = extension.get("artifactId")
                if not isinstance(artifact_id,str) or not _ARTIFACT_ID.fullmatch(artifact_id): return None
                model = extension.get("model")
                if not isinstance(model,str) or not _MODEL_ID.fullmatch(model): return None
                cohort = {"artifact_id": artifact_id, "model": model}
                minute = extension.get("runMinute")
                if minute is not None:
                    if not isinstance(minute,str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z",minute): return None
                    from .._util import instant
                    instant(minute)
                    cohort["run_minute"] = minute
                if "audienceIds" in extension:
                    ids = extension.get("audienceIds")
                    if not valid_audience_ids(ids) or minute is None: return None
                    cohort["audience_ids"] = tuple(ids)
            else: return None
        except (ValueError, TypeError): return None
    return RunRefFacts(agent_id, target, tag, version_id, arm, generation, bucket, **cohort)
