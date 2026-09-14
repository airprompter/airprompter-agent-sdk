"""The ``openai`` client, observed.

::

    rendered = ap.prompt("support.triage").render(team="Billing", ticket=text)
    completion = chat_completion(ap, rendered, client, messages=[{"role": "user", "content": text}])

The rendered text goes in as the system message (Chat Completions) or the
``instructions`` (Responses API) unless ``system_from_rendered=False``; the
model is the slot's unless ``model=`` overrides it (the override is what the
window names). The response comes back untouched.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from ..agent import AirPrompterAgent, Rendered


def _messages(rendered: Rendered, messages: Optional[Sequence[Mapping[str, Any]]], system_from_rendered: bool) -> list[Mapping[str, Any]]:
    tail = list(messages or [])
    return ([{"role": "system", "content": rendered.text}] + tail) if system_from_rendered else tail


def chat_completion(ap: AirPrompterAgent, rendered: Rendered, client: Any, *, messages: Optional[Sequence[Mapping[str, Any]]] = None, model: Optional[str] = None, system_from_rendered: bool = True, checks: Optional[Mapping[str, int]] = None, **create_kwargs: Any) -> Any:
    """``client.chat.completions.create(...)`` timed and reported against ``rendered``."""
    named = model or rendered.model
    return ap.observe(rendered, lambda: client.chat.completions.create(model=named, messages=_messages(rendered, messages, system_from_rendered), **create_kwargs), model=named, checks=checks)


async def chat_completion_async(ap: AirPrompterAgent, rendered: Rendered, client: Any, *, messages: Optional[Sequence[Mapping[str, Any]]] = None, model: Optional[str] = None, system_from_rendered: bool = True, checks: Optional[Mapping[str, int]] = None, **create_kwargs: Any) -> Any:
    """The ``AsyncOpenAI`` counterpart."""
    named = model or rendered.model
    return await ap.observe_async(rendered, lambda: client.chat.completions.create(model=named, messages=_messages(rendered, messages, system_from_rendered), **create_kwargs), model=named, checks=checks)


def responses_create(ap: AirPrompterAgent, rendered: Rendered, client: Any, *, input: Any, model: Optional[str] = None, system_from_rendered: bool = True, checks: Optional[Mapping[str, int]] = None, **create_kwargs: Any) -> Any:  # noqa: A002 — the OpenAI parameter is named input
    """``client.responses.create(...)`` timed and reported against ``rendered``; the rendered text is the ``instructions``."""
    named = model or rendered.model
    kwargs = {"instructions": rendered.text, **create_kwargs} if system_from_rendered else create_kwargs
    return ap.observe(rendered, lambda: client.responses.create(model=named, input=input, **kwargs), model=named, checks=checks)


async def responses_create_async(ap: AirPrompterAgent, rendered: Rendered, client: Any, *, input: Any, model: Optional[str] = None, system_from_rendered: bool = True, checks: Optional[Mapping[str, int]] = None, **create_kwargs: Any) -> Any:  # noqa: A002
    named = model or rendered.model
    kwargs = {"instructions": rendered.text, **create_kwargs} if system_from_rendered else create_kwargs
    return await ap.observe_async(rendered, lambda: client.responses.create(model=named, input=input, **kwargs), model=named, checks=checks)
