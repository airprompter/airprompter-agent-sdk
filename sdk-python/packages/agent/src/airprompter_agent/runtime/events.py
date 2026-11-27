"""The log events every adapter writes, in both SDKs: one vocabulary, so the conformance suite and a customer's alerting
can name them. Every event carries ``adapter`` (the framework, as its module names it) and, where there is one,
``slot`` and ``method`` (the client method's dotted path). None carries a prompt, an output or a value. The TypeScript
twin is ``runtime/wrap/events.ts``.

Example::

    ap.log({"event": ADAPTER_EVENTS["model_unresolved"], "adapter": "openai", "slot": "support.reply", "method": "chat.completions.create", "model": "gpt-5"})
"""

from __future__ import annotations

from types import MappingProxyType

ADAPTER_EVENTS = MappingProxyType(
    {
        #: No slot and no ``ap.attribute`` scope: the call passed through unobserved. Once per method.
        "unattributed": "adapter_unattributed",
        #: A ``.stream()`` helper on a slot-bound client passed through unmeasured. Once per method.
        "stream_helper_unmeasured": "adapter_stream_helper_unmeasured",
        #: The release's model could not be served: the slot declined for the run. Once per method and model.
        "model_unresolved": "model_unresolved",
        #: Placement raised: the caller's request went out unchanged.
        "placement_failed": "adapter_placement_failed",
        #: The call site set a sealed setting to another value: the release's replaced it (``parameters``).
        "inference_overridden": "adapter_inference_overridden",
        #: A sealed setting the call cannot carry was not sent (``settings``: ``[{"setting", "reason"}]``).
        "inference_unsupported": "adapter_inference_unsupported",
        #: Watching the response failed: the call's own result came back, measured with what was seen.
        "tap_failed": "adapter_tap_failed",
        #: Reading the ``ap.attribute`` scope failed: the call passed through unobserved.
        "attribution_failed": "adapter_attribution_failed",
    }
)

__all__ = ["ADAPTER_EVENTS"]
