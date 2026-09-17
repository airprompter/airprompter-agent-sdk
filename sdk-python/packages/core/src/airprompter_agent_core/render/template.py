"""Rendering a slot's text with its declared variables.

``{{name}}`` placeholders are the only substitution. A variable declared
``end_user`` (D55) is never dropped into the text raw: it is wrapped in the
delimiters declared for it — by default an XML-style element named after
the variable — so the model sees where untrusted input starts and stops,
and the assurance lens can find it. A missing required variable raises:
that is the customer's bug and silence would ship a broken prompt.
Sync and telemetry failures degrade; render contract failures raise.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Sequence


class MissingVariableError(ValueError):
    """A required variable nobody supplied. ``code`` is the spool's error class for the row the facade writes."""

    code = "render_missing_variable"

    def __init__(self, tag: str, missing: list[str]):
        plural = "s" if len(missing) > 1 else ""
        super().__init__(f"render {tag}: missing required variable{plural} {', '.join(missing)}")
        self.tag = tag
        self.missing = missing


class UnknownVariableError(ValueError):
    """A value for a name the slot does not declare: the caller's bug, refused before any text is built."""

    code = "render_unknown_variable"

    def __init__(self, tag: str, unknown: list[str]):
        plural = "s" if len(unknown) > 1 else ""
        super().__init__(f"render {tag}: variable{plural} {', '.join(unknown)} not declared on this slot")
        self.tag = tag
        self.unknown = unknown


@dataclass(frozen=True)
class Delimiters:
    open: Callable[[str], str]
    close: Callable[[str], str]


#: ``<name>…</name>``: visible to the model, easy to find in the text, and never confusable with ``{{name}}``.
xml_delimiters = Delimiters(open=lambda name: f"<{name}>", close=lambda name: f"</{name}>")

_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z0-9_.-]{1,64})\s*\}\}")


def placeholders_of(text: str) -> set[str]:
    """The variable names a text uses — the same pattern the render substitutes, so a source is consulted for
    exactly the variables this version's text needs and never for one it dropped."""
    return {match.group(1) for match in _PLACEHOLDER.finditer(text)}


def _stringify(value: Any) -> str:
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _escape_fence(value: str, close: str) -> str:
    return value.replace(close, close.replace("<", "&lt;", 1)) if close else value


def render_template(
    *,
    tag: str,
    text: str,
    variables: Sequence[Mapping[str, Any]],
    values: Mapping[str, Any],
    delimiters: Optional[Delimiters] = None,
    strict_variables: bool = True,
) -> str:
    declared = {variable["name"]: variable for variable in variables}
    fence = delimiters or xml_delimiters
    present = {name for name, value in values.items() if value is not None}
    missing = [variable["name"] for variable in variables if variable.get("required") and variable["name"] not in present]
    if missing:
        raise MissingVariableError(tag, missing)
    if strict_variables:
        unknown = [name for name in values if name in present and name not in declared]
        if unknown:
            raise UnknownVariableError(tag, unknown)

    def substitute(match: "re.Match[str]") -> str:
        name = match.group(1)
        variable = declared.get(name)
        if variable is None:
            return match.group(0)  # an undeclared placeholder in the text is left for the author to see
        value = values.get(name)
        if value is None:
            return ""
        rendered = _stringify(value)
        # End-user text is fenced; a value that carries the closing fence cannot break out of it.
        if variable.get("trust") == "end_user":
            return f"{fence.open(name)}{_escape_fence(rendered, fence.close(name))}{fence.close(name)}"
        return rendered

    return _PLACEHOLDER.sub(substitute, text)
