"""The slot's inference settings (protocol 0.3.1, ``slots[].inference``; 0.3.2 on a workflow step), applied to a
wrapped provider call. The release owns them: a version's temperature, top-p, output cap, stop sequences and reasoning
effort are reviewed and sealed with the prompt text, so the call goes out with those values whatever the call site
wrote — and a call site that wrote a different value is told once, in the log, never failed. The wire carries integers
(canonical-json.md); the providers take floats, converted here.

Settings sealed for one model are refused by another (Anthropic Messages takes one of ``temperature`` / ``top_p``, and
none beside ``thinking``; an OpenAI reasoning model takes neither), so they go only on a call to the release's model: a
call site that names another model keeps its own parameters and is told why.

Example::

    applied = apply_inference("chat", {"model": "gpt-5", "temperature": 1, "max_tokens": 900}, {"temperatureMilli": 200, "maxOutputTokens": 400}, model="gpt-5")
    applied.params       # {"model": "gpt-5", "temperature": 0.2, "max_completion_tokens": 400} — max_tokens dropped: one lever, not two
    applied.overridden   # ["temperature", "max_tokens"]: told once in the log, never failed
    apply_inference("chat", {"model": "gpt-5-mini"}, inference, model="gpt-5").skipped   # "model_mismatch": another model keeps its own
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Optional

#: The settings in one order, so every log line and every SDK names them alike.
INFERENCE_KEYS = ("temperatureMilli", "topPBps", "maxOutputTokens", "stopSequences", "reasoningEffort")

#: The provider parameter each setting lands on, per request shape; None when the shape has no such parameter.
_PARAMETER: dict[str, dict[str, Optional[str]]] = {
    "chat": {"temperatureMilli": "temperature", "topPBps": "top_p", "maxOutputTokens": "max_completion_tokens", "stopSequences": "stop", "reasoningEffort": "reasoning_effort"},
    "responses": {"temperatureMilli": "temperature", "topPBps": "top_p", "maxOutputTokens": "max_output_tokens", "stopSequences": None, "reasoningEffort": "reasoning"},
    "messages": {"temperatureMilli": "temperature", "topPBps": "top_p", "maxOutputTokens": "max_tokens", "stopSequences": "stop_sequences", "reasoningEffort": None},
}

#: Why a setting was not applied: the request shape has no such parameter; Messages takes one sampling parameter
#: (temperature goes, top-p does not); Messages takes none beside a ``thinking`` block the call site set.
UnsupportedReason = Literal["shape", "one_sampling_parameter", "thinking"]


def temperature_of(inference: Mapping[str, Any]) -> Optional[float]:
    value = inference.get("temperatureMilli")
    return None if value is None else value / 1000


def top_p_of(inference: Mapping[str, Any]) -> Optional[float]:
    value = inference.get("topPBps")
    return None if value is None else value / 10000


def _value_for(key: str, inference: Mapping[str, Any]) -> Any:
    """A JSON null in the block is unset (the schema forbids it; a lenient reader treats it as absent)."""
    if key == "temperatureMilli":
        return temperature_of(inference)
    if key == "topPBps":
        return top_p_of(inference)
    if key == "stopSequences":
        stops = inference.get("stopSequences")
        return list(stops) if stops is not None else None
    return inference.get(key)


def _same(left: Any, right: Any) -> bool:
    try:
        return json.dumps(left, sort_keys=True) == json.dumps(right, sort_keys=True)
    except (TypeError, ValueError):
        return False


@dataclass
class AppliedInference:
    params: dict[str, Any]
    #: Parameters the call site had set to something else: the release's value replaced them.
    overridden: list[str] = field(default_factory=list)
    #: Settings that were not applied, each as ``{"setting": …, "reason": …}``.
    unsupported: list[dict[str, str]] = field(default_factory=list)
    #: Set when nothing was applied because the call names a model other than the release's.
    skipped: Optional[Literal["model_mismatch"]] = None


def apply_inference(kind: str, params: Mapping[str, Any], inference: Mapping[str, Any], *, model: Optional[str] = None) -> AppliedInference:
    """A copy of ``params`` with the slot's settings applied; the original mapping is never mutated. With ``model`` (the
    release's model for the slot), a call that names another model is left alone and reported as ``model_mismatch``."""
    out: dict[str, Any] = dict(params)
    applied = AppliedInference(params=out)
    called = params.get("model")
    if model is not None and isinstance(called, str) and called != model:
        applied.skipped = "model_mismatch"
        return applied
    table = _PARAMETER.get(kind, {})
    thinking = kind == "messages" and out.get("thinking") is not None
    both_sampling = kind == "messages" and inference.get("temperatureMilli") is not None and inference.get("topPBps") is not None
    for key in INFERENCE_KEYS:
        value = _value_for(key, inference)
        if value is None:
            continue
        parameter = table.get(key)
        if parameter is None:
            applied.unsupported.append({"setting": key, "reason": "shape"})
            continue
        if thinking and key in ("temperatureMilli", "topPBps"):
            applied.unsupported.append({"setting": key, "reason": "thinking"})
            continue
        if both_sampling and key == "topPBps":
            applied.unsupported.append({"setting": key, "reason": "one_sampling_parameter"})
            continue
        if key == "reasoningEffort" and kind == "responses":
            # The Responses ``reasoning`` object has other members (``summary``): the effort is set, the rest kept.
            existing = out.get("reasoning")
            existing = dict(existing) if isinstance(existing, Mapping) else {}
            if existing.get("effort") is not None and existing["effort"] != value:
                applied.overridden.append("reasoning.effort")
            out["reasoning"] = {**existing, "effort": value}
            continue
        if out.get(parameter) is not None and not _same(out[parameter], value):
            applied.overridden.append(parameter)
        out[parameter] = value
        # OpenAI chat: the legacy cap is the same lever; a call site still writing it would otherwise send both.
        if kind == "chat" and parameter == "max_completion_tokens" and out.get("max_tokens") is not None:
            del out["max_tokens"]
            if "max_tokens" not in applied.overridden:
                applied.overridden.append("max_tokens")
    return applied
