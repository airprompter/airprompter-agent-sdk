"""The slot's inference settings (protocol 0.3.1, ``slots[].inference``), applied to a wrapped provider call. The
release owns them: a version's temperature, top-p, output cap, stop sequences and reasoning effort are reviewed and
sealed with the prompt text, so the call goes out with those values whatever the call site wrote — and a call site
that wrote a different value is told once, in the log, never failed. The wire carries integers (canonical-json.md);
the providers take floats, converted here."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

INFERENCE_KEYS = ("temperatureMilli", "topPBps", "maxOutputTokens", "stopSequences", "reasoningEffort")

#: The provider parameter each setting lands on, per request shape; None when the shape has no such parameter.
_PARAMETER: dict[str, dict[str, Optional[str]]] = {
    "chat": {"temperatureMilli": "temperature", "topPBps": "top_p", "maxOutputTokens": "max_completion_tokens", "stopSequences": "stop", "reasoningEffort": "reasoning_effort"},
    "responses": {"temperatureMilli": "temperature", "topPBps": "top_p", "maxOutputTokens": "max_output_tokens", "stopSequences": None, "reasoningEffort": "reasoning"},
    "messages": {"temperatureMilli": "temperature", "topPBps": "top_p", "maxOutputTokens": "max_tokens", "stopSequences": "stop_sequences", "reasoningEffort": None},
}


def temperature_of(inference: Mapping[str, Any]) -> Optional[float]:
    value = inference.get("temperatureMilli")
    return None if value is None else value / 1000


def top_p_of(inference: Mapping[str, Any]) -> Optional[float]:
    value = inference.get("topPBps")
    return None if value is None else value / 10000


def _value_for(key: str, inference: Mapping[str, Any], kind: str) -> Any:
    if key == "temperatureMilli":
        return temperature_of(inference)
    if key == "topPBps":
        return top_p_of(inference)
    if key == "maxOutputTokens":
        return inference.get("maxOutputTokens")
    if key == "stopSequences":
        stops = inference.get("stopSequences")
        return list(stops) if stops is not None else None
    if key == "reasoningEffort":
        effort = inference.get("reasoningEffort")
        if effort is None:
            return None
        return {"effort": effort} if kind == "responses" else effort
    return None


@dataclass
class AppliedInference:
    params: dict[str, Any]
    #: Parameters the call site had set to something else: the release's value replaced them.
    overridden: list[str] = field(default_factory=list)
    #: Settings this request shape cannot carry (a stop sequence on Responses, a reasoning effort on Messages).
    unsupported: list[str] = field(default_factory=list)


def apply_inference(kind: str, params: Mapping[str, Any], inference: Mapping[str, Any]) -> AppliedInference:
    """A copy of ``params`` with the slot's settings applied; the original mapping is never mutated."""
    out: dict[str, Any] = dict(params)
    applied = AppliedInference(params=out)
    table = _PARAMETER.get(kind, {})
    for key in INFERENCE_KEYS:
        if key not in inference:
            continue
        value = _value_for(key, inference, kind)
        if value is None:
            continue
        parameter = table.get(key)
        if parameter is None:
            applied.unsupported.append(key)
            continue
        if parameter in out and json.dumps(out[parameter], sort_keys=True) != json.dumps(value, sort_keys=True):
            applied.overridden.append(parameter)
        out[parameter] = value
        # OpenAI chat: the legacy cap is the same lever; a call site still writing it would otherwise send both.
        if kind == "chat" and parameter == "max_completion_tokens" and "max_tokens" in out:
            del out["max_tokens"]
            if "max_tokens" not in applied.overridden:
                applied.overridden.append("max_tokens")
    return applied
