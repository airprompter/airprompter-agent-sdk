"""``ap.wrap(client)`` (T33, D65): the ``openai`` and ``anthropic`` clients
observed without a change at the call site.

::

    openai = ap.wrap(OpenAI())
    rendered = ap.prompt("support.triage").render(team="Billing", ticket=text)
    completion = openai.chat.completions.create(model=rendered.model, messages=[{"role": "system", "content": rendered.text}, ...])

The wrapper is a proxy over the client's *public* method surface —
``chat.completions.create``, ``responses.create``, ``messages.create``
(``stream=True`` or not) and the ``.stream()`` context-manager helpers, sync
and async — that attributes each call to a rendered prompt
(``attribution.py``), times it, reads ``usage`` and the finish reason off
the response (or off the stream as it goes by), runs the slot's declared
output checks on the text, and files one content-free observation. No
provider code is vendored, no internal is patched, nothing is imported from
the provider packages: the shapes read here are their documented response
and stream-event shapes, as SDK objects or dicts.

A wrapper failure never fails the customer's call: attribution and tapping
are guarded, an unattributed call passes straight through, and a stream
left unfinished reports what was seen.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

from .observe import PendingObservation
from .attribution import Attribution

WRAPPED_METHODS: Mapping[tuple[str, ...], str] = {
    ("chat", "completions", "create"): "chat",
    ("chat", "completions", "stream"): "chat",
    ("chat", "completions", "parse"): "chat",
    ("responses", "create"): "responses",
    ("responses", "stream"): "responses",
    ("responses", "parse"): "responses",
    ("messages", "create"): "messages",
    ("messages", "stream"): "messages",
    ("beta", "messages", "create"): "messages",
    ("beta", "messages", "stream"): "messages",
    ("beta", "chat", "completions", "parse"): "chat",
}
"""The public methods a wrapped client observes (path → stream kind); anything else is forwarded untouched."""


@dataclass(frozen=True)
class WrapHooks:
    #: The rendered prompt a call belongs to, from its parameters; None passes the call through unobserved.
    attribute: Callable[[Any], Optional[Attribution]]
    #: Starts the clock for one call; the returned observation settles with the provider-shaped result or the error.
    begin: Callable[[Attribution, str], PendingObservation]
    log: Callable[[Mapping[str, Any]], None]


def wrap_client(client: Any, hooks: WrapHooks) -> Any:
    """``client`` with its observed methods reporting to ``hooks``; everything else is the client's own. Wrapping twice is once."""
    if type(client) is _Proxy:  # noqa: E721 — `isinstance` would see through the proxy's __class__
        return client
    return _Proxy(client, (), hooks)


def _is_prefix(path: tuple[str, ...]) -> bool:
    return any(len(entry) > len(path) and entry[: len(path)] == path for entry in WRAPPED_METHODS)


class _Proxy:
    """Attribute access forwards to the client; the observed methods come back wrapped, their parents as proxies."""

    __slots__ = ("_ap_target", "_ap_path", "_ap_hooks")

    def __init__(self, target: Any, path: tuple[str, ...], hooks: WrapHooks):
        object.__setattr__(self, "_ap_target", target)
        object.__setattr__(self, "_ap_path", path)
        object.__setattr__(self, "_ap_hooks", hooks)

    def __getattr__(self, name: str) -> Any:
        target = object.__getattribute__(self, "_ap_target")
        value = getattr(target, name)
        path = object.__getattribute__(self, "_ap_path") + (name,)
        kind = WRAPPED_METHODS.get(path)
        if kind is not None and callable(value):
            return _wrap_method(value, kind, ".".join(path), object.__getattribute__(self, "_ap_hooks"))
        if _is_prefix(path) and not callable(value) and not isinstance(value, (str, bytes, int, float, bool)):
            return _Proxy(value, path, object.__getattribute__(self, "_ap_hooks"))
        return value

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(object.__getattribute__(self, "_ap_target"), name, value)

    @property
    def __class__(self) -> Any:  # type: ignore[override] — `isinstance(ap.wrap(client), OpenAI)` stays true
        return type(object.__getattribute__(self, "_ap_target"))

    def __repr__(self) -> str:
        return f"wrapped({object.__getattribute__(self, '_ap_target')!r})"

    def __dir__(self) -> list[str]:
        return dir(object.__getattribute__(self, "_ap_target"))

    def __enter__(self) -> Any:
        object.__getattribute__(self, "_ap_target").__enter__()
        return self

    def __exit__(self, *exc: Any) -> Any:
        return object.__getattribute__(self, "_ap_target").__exit__(*exc)

    async def __aenter__(self) -> Any:
        await object.__getattribute__(self, "_ap_target").__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        return await object.__getattribute__(self, "_ap_target").__aexit__(*exc)


def _params_of(args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> Any:
    if kwargs:
        return kwargs
    return args[0] if args else {}


def _wrap_method(original: Callable[..., Any], kind: str, method: str, hooks: WrapHooks) -> Callable[..., Any]:
    def call(*args: Any, **kwargs: Any) -> Any:
        params = _params_of(args, kwargs)
        attribution: Optional[Attribution] = None
        try:
            attribution = hooks.attribute(params)
        except Exception as error:  # noqa: BLE001
            hooks.log({"event": "wrap_attribution_failed", "method": method, "reason": str(error)})
        if attribution is None:
            hooks.log({"event": "wrap_unattributed", "method": method})
            return original(*args, **kwargs)
        model = params.get("model") if isinstance(params, Mapping) else None
        pending = hooks.begin(attribution, model if isinstance(model, str) else attribution.model)
        try:
            out = original(*args, **kwargs)
        except BaseException as error:
            pending.fail(error)
            raise
        try:
            return _tap(out, kind, pending)
        except Exception as error:  # noqa: BLE001
            hooks.log({"event": "wrap_tap_failed", "method": method, "reason": str(error)})
            pending.settle(None)
            return out

    call.__name__ = getattr(original, "__name__", "create")
    call.__doc__ = getattr(original, "__doc__", None)
    return call


def _tap(out: Any, kind: str, pending: PendingObservation) -> Any:
    """The response, a stream, a stream helper, or a coroutine of one: settle ``pending`` when the result is known."""
    if inspect.isawaitable(out):
        return _tap_awaitable(out, kind, pending)
    if hasattr(out, "__anext__"):
        return _TappedAsyncStream(out, kind, pending)
    if hasattr(out, "__next__"):
        return _TappedStream(out, kind, pending)
    if hasattr(out, "__aenter__"):
        return _TappedAsyncManager(out, kind, pending)
    if hasattr(out, "__enter__") and not isinstance(out, (str, bytes, Mapping)):
        return _TappedManager(out, kind, pending)
    pending.settle(out)
    return out


async def _tap_awaitable(out: Any, kind: str, pending: PendingObservation) -> Any:
    try:
        value = await out
    except BaseException as error:
        pending.fail(error)
        raise
    try:
        return _tap(value, kind, pending)
    except Exception:  # noqa: BLE001
        pending.settle(None)
        return value


# ---------------------------------------------------------------------------
# Stream accumulators: a provider-shaped final result from the events seen
# ---------------------------------------------------------------------------


def _get(value: Any, name: str) -> Any:
    if value is None or isinstance(value, (str, bytes, int, float, bool)):
        return None
    if isinstance(value, Mapping):
        return value.get(name)
    try:
        return getattr(value, name, None)
    except Exception:  # noqa: BLE001
        return None


def _first(value: Any) -> Any:
    return value[0] if isinstance(value, (list, tuple)) and value else None


class _Accumulator:
    def __init__(self, kind: str):
        self.kind = kind
        self.text = ""
        self.finish: Optional[str] = None
        self.usage: Any = None
        self.response: Any = None
        self.input_tokens: Optional[int] = None
        self.cached: Optional[int] = None
        self.output_tokens: Optional[int] = None

    def push(self, chunk: Any) -> None:
        try:
            if self.kind == "chat":
                self._push_chat(chunk)
            elif self.kind == "responses":
                self._push_responses(chunk)
            else:
                self._push_messages(chunk)
        except Exception:  # noqa: BLE001 — an unexpected chunk shape never interrupts the customer's stream
            pass

    def _push_chat(self, chunk: Any) -> None:
        choice = _first(_get(chunk, "choices"))
        delta = _get(_get(choice, "delta"), "content")
        if isinstance(delta, str):
            self.text += delta
        finish = _get(choice, "finish_reason")
        if isinstance(finish, str):
            self.finish = finish
        usage = _get(chunk, "usage")
        if usage is not None:
            self.usage = usage

    def _push_responses(self, chunk: Any) -> None:
        kind = str(_get(chunk, "type") or "")
        if kind == "response.output_text.delta":
            delta = _get(chunk, "delta")
            if isinstance(delta, str):
                self.text += delta
        if kind in ("response.completed", "response.incomplete", "response.failed") and _get(chunk, "response") is not None:
            self.response = _get(chunk, "response")

    def _push_messages(self, chunk: Any) -> None:
        kind = str(_get(chunk, "type") or "")
        if kind == "message_start":
            usage = _get(_get(chunk, "message"), "usage")
            self._read_anthropic_usage(usage)
        elif kind == "content_block_delta":
            delta = _get(chunk, "delta")
            if _get(delta, "type") == "text_delta" and isinstance(_get(delta, "text"), str):
                self.text += _get(delta, "text")
        elif kind == "message_delta":
            self._read_anthropic_usage(_get(chunk, "usage"))
            stop = _get(_get(chunk, "delta"), "stop_reason")
            if isinstance(stop, str):
                self.finish = stop

    def _read_anthropic_usage(self, usage: Any) -> None:
        for name, attr in (("input_tokens", "input_tokens"), ("cache_read_input_tokens", "cached"), ("output_tokens", "output_tokens")):
            value = _get(usage, name)
            if isinstance(value, int) and not isinstance(value, bool):
                setattr(self, attr, value)

    def final(self) -> Any:
        if self.kind == "chat":
            result: dict[str, Any] = {"choices": [{"finish_reason": self.finish or "stop", "message": {"role": "assistant", "content": self.text}}]}
            if self.usage is not None:
                result["usage"] = self.usage
            return result
        if self.kind == "responses":
            return self.response if self.response is not None else {"output_text": self.text}
        result = {"stop_reason": self.finish or "end_turn", "content": [{"type": "text", "text": self.text}]}
        if self.input_tokens is not None or self.output_tokens is not None:
            usage: dict[str, int] = {"input_tokens": self.input_tokens or 0, "output_tokens": self.output_tokens or 0}
            if self.cached is not None:
                usage["cache_read_input_tokens"] = self.cached
            result["usage"] = usage
        return result


# ---------------------------------------------------------------------------
# Streams (`stream=True`): every event passes through; the final shape settles at the end
# ---------------------------------------------------------------------------


class _Forwarding:
    __slots__ = ("_ap_inner", "_ap_acc", "_ap_pending")

    def __init__(self, inner: Any, kind: str, pending: PendingObservation):
        object.__setattr__(self, "_ap_inner", inner)
        object.__setattr__(self, "_ap_acc", _Accumulator(kind))
        object.__setattr__(self, "_ap_pending", pending)

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_ap_inner"), name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(object.__getattribute__(self, "_ap_inner"), name, value)

    @property
    def __class__(self) -> Any:  # type: ignore[override]
        return type(object.__getattribute__(self, "_ap_inner"))

    def __repr__(self) -> str:
        return f"wrapped({object.__getattribute__(self, '_ap_inner')!r})"

    def _ap_settle(self) -> None:
        acc: _Accumulator = object.__getattribute__(self, "_ap_acc")
        object.__getattribute__(self, "_ap_pending").settle(acc.final())


class _TappedStream(_Forwarding):
    def __iter__(self) -> Any:
        return self

    def __next__(self) -> Any:
        inner = object.__getattribute__(self, "_ap_inner")
        try:
            chunk = next(inner)
        except StopIteration:
            self._ap_settle()
            raise
        except BaseException as error:
            object.__getattribute__(self, "_ap_pending").fail(error)
            raise
        object.__getattribute__(self, "_ap_acc").push(chunk)
        return chunk

    def __enter__(self) -> Any:
        inner = object.__getattribute__(self, "_ap_inner")
        if hasattr(inner, "__enter__"):
            inner.__enter__()
        return self

    def __exit__(self, *exc: Any) -> Any:
        # A consumer that stopped early: report what was seen (usually no usage yet → unavailable).
        if exc and exc[1] is not None:
            object.__getattribute__(self, "_ap_pending").fail(exc[1])
        else:
            self._ap_settle()
        inner = object.__getattribute__(self, "_ap_inner")
        return inner.__exit__(*exc) if hasattr(inner, "__exit__") else None

    def close(self) -> None:
        self._ap_settle()
        inner = object.__getattribute__(self, "_ap_inner")
        if hasattr(inner, "close"):
            inner.close()


class _TappedAsyncStream(_Forwarding):
    def __aiter__(self) -> Any:
        return self

    async def __anext__(self) -> Any:
        inner = object.__getattribute__(self, "_ap_inner")
        try:
            chunk = await inner.__anext__()
        except StopAsyncIteration:
            self._ap_settle()
            raise
        except BaseException as error:
            object.__getattribute__(self, "_ap_pending").fail(error)
            raise
        object.__getattribute__(self, "_ap_acc").push(chunk)
        return chunk

    async def __aenter__(self) -> Any:
        inner = object.__getattribute__(self, "_ap_inner")
        if hasattr(inner, "__aenter__"):
            await inner.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        if exc and exc[1] is not None:
            object.__getattribute__(self, "_ap_pending").fail(exc[1])
        else:
            self._ap_settle()
        inner = object.__getattribute__(self, "_ap_inner")
        return await inner.__aexit__(*exc) if hasattr(inner, "__aexit__") else None

    async def close(self) -> None:
        self._ap_settle()
        inner = object.__getattribute__(self, "_ap_inner")
        if hasattr(inner, "close"):
            result = inner.close()
            if inspect.isawaitable(result):
                await result


# ---------------------------------------------------------------------------
# Stream helpers (`messages.stream()`, `chat.completions.stream()`, `responses.stream()`): context managers whose
# stream accumulates on its own. The final result is what the customer read through `get_final_*`, else the helper's
# public snapshot when the context closes, else what went by.
# ---------------------------------------------------------------------------

_FINAL_METHODS = ("get_final_completion", "get_final_response", "get_final_message")
_SNAPSHOTS = ("current_completion_snapshot", "current_message_snapshot")


class _TappedHelper(_Forwarding):
    __slots__ = ("_ap_captured",)

    def __init__(self, inner: Any, kind: str, pending: PendingObservation):
        super().__init__(inner, kind, pending)
        object.__setattr__(self, "_ap_captured", None)

    def __getattr__(self, name: str) -> Any:
        value = getattr(object.__getattribute__(self, "_ap_inner"), name)
        if name in _FINAL_METHODS and callable(value):
            return self._ap_capture(value)
        return value

    def _ap_capture(self, method: Callable[..., Any]) -> Callable[..., Any]:
        def captured(*args: Any, **kwargs: Any) -> Any:
            result = method(*args, **kwargs)
            if inspect.isawaitable(result):

                async def awaited() -> Any:
                    value = await result
                    object.__setattr__(self, "_ap_captured", value)
                    return value

                return awaited()
            object.__setattr__(self, "_ap_captured", result)
            return result

        return captured

    def __iter__(self) -> Any:
        for event in object.__getattribute__(self, "_ap_inner"):
            object.__getattribute__(self, "_ap_acc").push(event)
            yield event

    async def __aiter__(self) -> Any:
        async for event in object.__getattribute__(self, "_ap_inner"):
            object.__getattribute__(self, "_ap_acc").push(event)
            yield event

    def _ap_finish(self, exc: Optional[BaseException]) -> None:
        pending: PendingObservation = object.__getattribute__(self, "_ap_pending")
        if exc is not None:
            pending.fail(exc)
            return
        captured = object.__getattribute__(self, "_ap_captured")
        if captured is not None:
            pending.settle(captured)
            return
        inner = object.__getattribute__(self, "_ap_inner")
        for name in _SNAPSHOTS:
            try:
                snapshot = getattr(inner, name, None)
            except Exception:  # noqa: BLE001
                snapshot = None
            if snapshot is not None:
                pending.settle(snapshot)
                return
        self._ap_settle()


class _TappedManager(_Forwarding):
    __slots__ = ("_ap_helper",)

    def __init__(self, inner: Any, kind: str, pending: PendingObservation):
        super().__init__(inner, kind, pending)
        object.__setattr__(self, "_ap_helper", None)

    def __enter__(self) -> Any:
        try:
            stream = object.__getattribute__(self, "_ap_inner").__enter__()
        except BaseException as error:
            object.__getattribute__(self, "_ap_pending").fail(error)
            raise
        helper = _TappedHelper(stream, object.__getattribute__(self, "_ap_acc").kind, object.__getattribute__(self, "_ap_pending"))
        object.__setattr__(self, "_ap_helper", helper)
        return helper

    def __exit__(self, *exc: Any) -> Any:
        helper = object.__getattribute__(self, "_ap_helper")
        if helper is not None:
            helper._ap_finish(exc[1] if exc else None)
        return object.__getattribute__(self, "_ap_inner").__exit__(*exc)


class _TappedAsyncManager(_Forwarding):
    __slots__ = ("_ap_helper",)

    def __init__(self, inner: Any, kind: str, pending: PendingObservation):
        super().__init__(inner, kind, pending)
        object.__setattr__(self, "_ap_helper", None)

    async def __aenter__(self) -> Any:
        try:
            stream = await object.__getattribute__(self, "_ap_inner").__aenter__()
        except BaseException as error:
            object.__getattribute__(self, "_ap_pending").fail(error)
            raise
        helper = _TappedHelper(stream, object.__getattribute__(self, "_ap_acc").kind, object.__getattribute__(self, "_ap_pending"))
        object.__setattr__(self, "_ap_helper", helper)
        return helper

    async def __aexit__(self, *exc: Any) -> Any:
        helper = object.__getattribute__(self, "_ap_helper")
        if helper is not None:
            helper._ap_finish(exc[1] if exc else None)
        return await object.__getattribute__(self, "_ap_inner").__aexit__(*exc)


__all__ = ["WRAPPED_METHODS", "WrapHooks", "wrap_client"]
