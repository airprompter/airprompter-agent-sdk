"""Provider wrappers. ``ap.wrap(client)`` (T33, D65) observes the ``openai``
and ``anthropic`` clients without a change at the call site — the call is
attributed to the render whose text it carries, or to a ``with
ap.attribute(rendered):`` block. The explicit helpers here (``chat_completion``,
``messages_create``, …) place the rendered text for you and call
``ap.observe`` by name; the LiteLLM callback attributes by ``metadata`` or
by the same text match. Each imports its client library lazily — the SDK
installs and runs without any of them — and none reads anything of a call
but its usage, finish reason and (for the declared checks) its output text.
"""

from .anthropic import messages_create, messages_create_async
from ..telemetry.attribution import Attribution, RenderRegistry, attribution_scope, current_attribution, request_texts
from .litellm import AirPrompterLiteLLMCallback, litellm_metadata
from .openai import chat_completion, chat_completion_async, responses_create, responses_create_async
from ..telemetry.wrap import WRAPPED_METHODS, WrapHooks, wrap_client

__all__ = [
    "WRAPPED_METHODS",
    "AirPrompterLiteLLMCallback",
    "Attribution",
    "RenderRegistry",
    "WrapHooks",
    "attribution_scope",
    "current_attribution",
    "request_texts",
    "wrap_client",
    "chat_completion",
    "chat_completion_async",
    "litellm_metadata",
    "messages_create",
    "messages_create_async",
    "responses_create",
    "responses_create_async",
]
