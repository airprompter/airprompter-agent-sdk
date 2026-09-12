"""The feedback catalogue (``protocol/schemas/feedback-signals.schema.json``)
normalised into window outcomes. Numbers, booleans and the declared enums
only; anything else — free text above all — is named in ``rejected`` and
never reaches the spool. ``protocol/vectors/feedback.json`` pins every rule.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Mapping, Union

BOOLEAN_SIGNALS = ("flagged", "accepted", "edited", "regenerated", "copied", "followUp", "escalated", "abandoned", "corrected", "resolved", "reopened", "converted", "refunded", "slaMet")
UNIT_SIGNALS = ("editDistanceRatio", "judgeScore")
COUNT_SIGNALS = ("regenerations", "timeToAcceptMs")
#: T34: written by the runtime on a window (a golden-set run), never accepted from ``feedback()``; reserved so ``custom`` cannot shadow it.
RUNTIME_SIGNALS = ("goldenPass",)
CATALOGUE = frozenset({"thumbs", "rating", "correctedValue", "custom", *BOOLEAN_SIGNALS, *UNIT_SIGNALS, *COUNT_SIGNALS, *RUNTIME_SIGNALS})
OUTCOME_NAME = re.compile(r"^[a-z][a-zA-Z0-9]{0,31}$")

FeedbackRejection = str  # "invalid_value" | "invalid_name" | "reserved_name" | "unknown_signal" | "needs_slot_enum"


@dataclass
class NormalizedFeedback:
    #: True when at least one signal became an outcome — the value ``feedback()`` returns.
    accepted: bool
    outcomes: dict[str, Union[int, float, bool]] = field(default_factory=dict)
    rejected: dict[str, FeedbackRejection] = field(default_factory=dict)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_finite_number(value: Any) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)) and math.isfinite(value)


def normalize_feedback(signals: Mapping[str, Any]) -> NormalizedFeedback:
    outcomes: dict[str, Union[int, float, bool]] = {}
    rejected: dict[str, FeedbackRejection] = {}
    for name, value in signals.items():
        if name == "thumbs":
            if value in ("up", "down"):
                outcomes["thumbs"] = value == "up"
            else:
                rejected[name] = "invalid_value"
        elif name == "rating":
            if _is_int(value) and 1 <= value <= 5:
                outcomes["rating"] = value
            else:
                rejected[name] = "invalid_value"
        elif name in BOOLEAN_SIGNALS:
            if isinstance(value, bool):
                outcomes[name] = value
            else:
                rejected[name] = "invalid_value"
        elif name in UNIT_SIGNALS:
            if _is_finite_number(value) and 0 <= value <= 1:
                outcomes[name] = value
            else:
                rejected[name] = "invalid_value"
        elif name in COUNT_SIGNALS:
            if _is_int(value) and value >= 0:
                outcomes[name] = value
            else:
                rejected[name] = "invalid_value"
        elif name == "correctedValue":
            # Aggregating per enum value needs the slot's declared output check, which this writer does not hold yet.
            rejected[name] = "needs_slot_enum" if isinstance(value, str) and len(value) <= 64 else "invalid_value"
        elif name in RUNTIME_SIGNALS:
            rejected[name] = "reserved_name"
        elif name == "custom":
            if not isinstance(value, Mapping) or len(value) > 8:
                rejected[name] = "invalid_value"
                continue
            for custom_name, custom_value in value.items():
                if not isinstance(custom_name, str) or not OUTCOME_NAME.match(custom_name):
                    rejected[f"custom.{custom_name}"] = "invalid_name"
                elif custom_name in CATALOGUE:
                    rejected[f"custom.{custom_name}"] = "reserved_name"
                elif isinstance(custom_value, bool) or _is_finite_number(custom_value):
                    outcomes[custom_name] = custom_value
                else:
                    rejected[f"custom.{custom_name}"] = "invalid_value"
        else:
            rejected[name] = "unknown_signal"
    return NormalizedFeedback(accepted=len(outcomes) > 0, outcomes=outcomes, rejected=rejected)
