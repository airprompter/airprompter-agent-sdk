"""Provider wrappers: ``openai``, ``anthropic`` and a LiteLLM callback. Each
imports its client library lazily — the SDK installs and runs without any
of them — and every wrapper is a thin, explicit way to call ``ap.observe``:
the rendered prompt names the slot, version, arm and model; the wrapper
places the text, times the call, reads usage off the response and files
one content-free observation. Nothing else about the call is read.
"""

from .anthropic import messages_create, messages_create_async
from .litellm import AirPrompterLiteLLMCallback, litellm_metadata
from .openai import chat_completion, chat_completion_async, responses_create, responses_create_async

__all__ = [
    "AirPrompterLiteLLMCallback",
    "chat_completion",
    "chat_completion_async",
    "litellm_metadata",
    "messages_create",
    "messages_create_async",
    "responses_create",
    "responses_create_async",
]
