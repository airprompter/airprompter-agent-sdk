"""The ``anthropic`` client, observed.

::

    rendered = ap.prompt("support.triage").render(team="Billing", ticket=text)
    message = messages_create(ap, rendered, client, messages=[{"role": "user", "content": text}], max_tokens=1024)

The rendered text is the ``system`` prompt unless ``system_from_rendered=False``;
the model is the slot's unless ``model=`` overrides it. The response comes
back untouched (usage is read off ``message.usage``; a ``max_tokens`` stop
counts as ``truncated``).
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from ..agent import AirPrompterAgent, Rendered


def messages_create(ap: AirPrompterAgent, rendered: Rendered, client: Any, *, messages: Sequence[Mapping[str, Any]], max_tokens: int = 1024, model: Optional[str] = None, system_from_rendered: bool = True, checks: Optional[Mapping[str, int]] = None, **create_kwargs: Any) -> Any:
    """``client.messages.create(...)`` timed and reported against ``rendered``."""
    named = model or rendered.model
    kwargs = {"system": rendered.text, **create_kwargs} if system_from_rendered else create_kwargs
    return ap.observe(rendered, lambda: client.messages.create(model=named, max_tokens=max_tokens, messages=list(messages), **kwargs), model=named, checks=checks)


async def messages_create_async(ap: AirPrompterAgent, rendered: Rendered, client: Any, *, messages: Sequence[Mapping[str, Any]], max_tokens: int = 1024, model: Optional[str] = None, system_from_rendered: bool = True, checks: Optional[Mapping[str, int]] = None, **create_kwargs: Any) -> Any:
    """The ``AsyncAnthropic`` counterpart."""
    named = model or rendered.model
    kwargs = {"system": rendered.text, **create_kwargs} if system_from_rendered else create_kwargs
    return await ap.observe_async(rendered, lambda: client.messages.create(model=named, max_tokens=max_tokens, messages=list(messages), **kwargs), model=named, checks=checks)
