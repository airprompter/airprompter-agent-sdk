"""Rule 2 as a pure function: what the current reductions do to a slot a run has already pinned. Every ``place``, pinned
or not, asks this. Only a reduction reaches a pinned slot; ramp steps and rollbacks wait for the next run.

Example::

    verdict = pin_verdict(slot="support.reply", arm="candidate", disabled=resolver.disabled(), frozen=resolver.frozen(slot, tags), experiment_id="exp_1")
    if verdict.kind == "replace":
        re_place()  # the pinned arm was disabled, and its share went to control
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from ..release.resolver import Disabled


@dataclass(frozen=True)
class PinVerdict:
    #: ``disabled``: the agent or the slot is disabled, or the experiment is frozen: pass through, keep the pin for the
    #: row. ``replace``: the pinned arm is disabled: place again. ``stands``: the pin serves.
    kind: str
    #: For ``disabled``: the slot to stamp, None for the whole agent.
    stamp_tag: Optional[str] = None


def pin_verdict(*, slot: str, arm: Optional[str], disabled: Disabled, frozen: bool, experiment_id: Optional[str]) -> PinVerdict:
    if disabled.agent:
        return PinVerdict("disabled", None)
    if slot in disabled.slots or frozen:
        return PinVerdict("disabled", slot)
    if not arm or arm == "none" or experiment_id is None:
        return PinVerdict("stands")
    return PinVerdict("replace") if arm in disabled.arms_for(experiment_id) else PinVerdict("stands")
