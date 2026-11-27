"""A provider-neutral proxy over a client's public method surface, and the taps that watch what a call returns: a
response, a coroutine of one, a ``stream=True`` stream (sync or async), or a ``.stream()`` context-manager helper. Which
methods are intercepted, and how a stream's events fold into one provider-shaped result, are passed in by the adapter
(``frameworks/openai``, ``frameworks/anthropic``). No provider package is imported and no internal is patched.

A tap never fails the customer's call: an event it cannot read passes through, and a consumer that stops early settles
with what was seen.

Example::

    client = proxy_client(OpenAI(), [ClientMethod(("chat", "completions", "create"), "chat", ChatAccumulator)], intercept)
    # intercept(method, original, args, kwargs, name) runs instead of each listed method; tap_result(out, method, pending) watches what it returns
"""

from __future__ import annotations

import functools
import inspect
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Protocol, Sequence


class StreamAccumulator(Protocol):
    """Folds a stream's events into one result the observe path reads (usage, finish reason, output text)."""

    def push(self, chunk: Any) -> None: ...

    def final(self) -> Any: ...


class Pending(Protocol):
    """A measurement whose clock started at the call: it settles once, with the folded result or the error."""

    def settle(self, result: Any) -> None: ...

    def fail(self, error: BaseException) -> None: ...


@dataclass(frozen=True)
class ClientMethod:
    """One intercepted method: its path on the client, the request shape it takes, and how its stream folds."""

    path: tuple[str, ...]
    #: ``chat``, ``responses`` or ``messages``: the settings table's request shape (``inference.py``).
    kind: str
    accumulate: Callable[[], StreamAccumulator]
    #: A ``.stream()`` helper: it answers a context manager, read by its own ``get_final_*`` methods.
    helper: bool = False


#: Runs instead of each listed method: ``(method, original, args, kwargs, dotted_name) -> result``.
Intercept = Callable[[ClientMethod, Callable[..., Any], tuple, dict, str], Any]


def read_field(value: Any, name: str) -> Any:
    """``value[name]`` for a mapping, ``value.name`` for an SDK object, else None. Never raises."""
    if value is None or isinstance(value, (str, bytes, int, float, bool)):
        return None
    if isinstance(value, Mapping):
        return value.get(name)
    try:
        return getattr(value, name, None)
    except Exception:  # noqa: BLE001
        return None


def proxy_client(client: Any, methods: Sequence[ClientMethod], intercept: Intercept) -> Any:
    """``client`` with each listed method routed through ``intercept``; everything else is the client's own. Proxying twice is once."""
    if type(client) is _Proxy:  # noqa: E721 — `isinstance` would see through the proxy's __class__
        return client
    return _Proxy(client, (), {method.path: method for method in methods}, intercept)


class _Proxy:
    """Attribute access forwards to the client; the listed methods come back intercepted, their parents as proxies."""

    __slots__ = ("_ap_target", "_ap_path", "_ap_methods", "_ap_intercept")

    def __init__(self, target: Any, path: tuple[str, ...], methods: Mapping[tuple[str, ...], ClientMethod], intercept: Intercept):
        object.__setattr__(self, "_ap_target", target)
        object.__setattr__(self, "_ap_path", path)
        object.__setattr__(self, "_ap_methods", methods)
        object.__setattr__(self, "_ap_intercept", intercept)

    def __getattr__(self, name: str) -> Any:
        target = object.__getattribute__(self, "_ap_target")
        value = getattr(target, name)
        path = object.__getattribute__(self, "_ap_path") + (name,)
        methods: Mapping[tuple[str, ...], ClientMethod] = object.__getattribute__(self, "_ap_methods")
        method = methods.get(path)
        intercept: Intercept = object.__getattribute__(self, "_ap_intercept")
        if method is not None and callable(value):
            dotted = ".".join(path)

            def call(*args: Any, **kwargs: Any) -> Any:
                return intercept(method, value, args, kwargs, dotted)

            try:
                functools.update_wrapper(call, value)
            except (AttributeError, TypeError):
                call.__name__ = getattr(value, "__name__", name)
            # Libraries that route on it (instructor's is_async) still see an async client's method as async.
            if is_async(value) and hasattr(inspect, "markcoroutinefunction"):
                inspect.markcoroutinefunction(call)
            return call
        is_prefix = any(len(entry) > len(path) and entry[: len(path)] == path for entry in methods)
        if is_prefix and not callable(value) and not isinstance(value, (str, bytes, int, float, bool)):
            return _Proxy(value, path, methods, intercept)
        return value

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(object.__getattribute__(self, "_ap_target"), name, value)

    @property
    def __class__(self) -> Any:  # type: ignore[override] — `isinstance(instrument(client, ap), OpenAI)` stays true
        return type(object.__getattribute__(self, "_ap_target"))

    def __repr__(self) -> str:
        return f"instrumented({object.__getattribute__(self, '_ap_target')!r})"

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


def is_async(method: Callable[..., Any]) -> bool:
    """Whether a client method answers a coroutine: an ``async def``, or a plain decorator over one (``functools.wraps``
    without marking, as the ``openai`` and ``anthropic`` clients' own decorators are). A sync facade that wraps an
    ``async def`` and runs it to completion would read as async; no provider client does that."""
    try:
        return inspect.iscoroutinefunction(method) or inspect.iscoroutinefunction(inspect.unwrap(method))
    except Exception:  # noqa: BLE001
        return False


def tap_result(out: Any, method: ClientMethod, pending: Pending) -> Any:
    """The response, a stream, a stream helper, or a coroutine of one: settle ``pending`` when the result is known."""
    if inspect.isawaitable(out):
        return _tap_awaitable(out, method, pending)
    if hasattr(out, "__anext__"):
        return _TappedAsyncStream(out, method, pending)
    if hasattr(out, "__next__"):
        return _TappedStream(out, method, pending)
    if hasattr(out, "__aenter__"):
        return _TappedAsyncManager(out, method, pending)
    if hasattr(out, "__enter__") and not isinstance(out, (str, bytes, Mapping)):
        return _TappedManager(out, method, pending)
    pending.settle(out)
    return out


async def _tap_awaitable(out: Any, method: ClientMethod, pending: Pending) -> Any:
    try:
        value = await out
    except BaseException as error:
        pending.fail(error)
        raise
    try:
        return tap_result(value, method, pending)
    except Exception:  # noqa: BLE001
        pending.settle(None)
        return value


class _Guarded:
    """An accumulator whose unexpected event shape never interrupts the customer's stream."""

    __slots__ = ("_inner",)

    def __init__(self, inner: StreamAccumulator):
        self._inner = inner

    def push(self, chunk: Any) -> None:
        try:
            self._inner.push(chunk)
        except Exception:  # noqa: BLE001
            pass

    def final(self) -> Any:
        try:
            return self._inner.final()
        except Exception:  # noqa: BLE001
            return None


# ---------------------------------------------------------------------------
# Streams (`stream=True`): every event passes through; the final shape settles at the end
# ---------------------------------------------------------------------------


class _Forwarding:
    __slots__ = ("_ap_inner", "_ap_acc", "_ap_pending", "_ap_method")

    def __init__(self, inner: Any, method: ClientMethod, pending: Pending):
        object.__setattr__(self, "_ap_inner", inner)
        object.__setattr__(self, "_ap_acc", _Guarded(method.accumulate()))
        object.__setattr__(self, "_ap_pending", pending)
        object.__setattr__(self, "_ap_method", method)

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
        acc: _Guarded = object.__getattribute__(self, "_ap_acc")
        object.__getattribute__(self, "_ap_pending").settle(acc.final())


class _TappedStream(_Forwarding):
    def __iter__(self) -> Any:
        # A generator, so a consumer that breaks out of the loop settles with what was seen, as the TypeScript tap does.
        try:
            while True:
                try:
                    chunk = self.__next__()
                except StopIteration:
                    return
                yield chunk
        finally:
            self._ap_settle()

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
    async def __aiter__(self) -> Any:
        # An async generator, so a consumer that breaks out of the loop settles with what was seen: at once with
        # ``async with`` or ``aclose()``, else when the event loop closes the generator, which may be after the run ended.
        try:
            while True:
                try:
                    chunk = await self.__anext__()
                except StopAsyncIteration:
                    return
                yield chunk
        finally:
            self._ap_settle()

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

    def __init__(self, inner: Any, method: ClientMethod, pending: Pending):
        super().__init__(inner, method, pending)
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

    def __next__(self) -> Any:
        event = next(object.__getattribute__(self, "_ap_inner"))
        object.__getattribute__(self, "_ap_acc").push(event)
        return event

    async def __aiter__(self) -> Any:
        async for event in object.__getattribute__(self, "_ap_inner"):
            object.__getattribute__(self, "_ap_acc").push(event)
            yield event

    def _ap_finish(self, exc: Optional[BaseException]) -> None:
        pending: Pending = object.__getattribute__(self, "_ap_pending")
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

    def __init__(self, inner: Any, method: ClientMethod, pending: Pending):
        super().__init__(inner, method, pending)
        object.__setattr__(self, "_ap_helper", None)

    def __enter__(self) -> Any:
        try:
            stream = object.__getattribute__(self, "_ap_inner").__enter__()
        except BaseException as error:
            object.__getattribute__(self, "_ap_pending").fail(error)
            raise
        helper = _TappedHelper(stream, object.__getattribute__(self, "_ap_method"), object.__getattribute__(self, "_ap_pending"))
        object.__setattr__(self, "_ap_helper", helper)
        return helper

    def __exit__(self, *exc: Any) -> Any:
        helper = object.__getattribute__(self, "_ap_helper")
        if helper is not None:
            helper._ap_finish(exc[1] if exc else None)
        return object.__getattribute__(self, "_ap_inner").__exit__(*exc)


class _TappedAsyncManager(_Forwarding):
    __slots__ = ("_ap_helper",)

    def __init__(self, inner: Any, method: ClientMethod, pending: Pending):
        super().__init__(inner, method, pending)
        object.__setattr__(self, "_ap_helper", None)

    async def __aenter__(self) -> Any:
        try:
            stream = await object.__getattribute__(self, "_ap_inner").__aenter__()
        except BaseException as error:
            object.__getattribute__(self, "_ap_pending").fail(error)
            raise
        helper = _TappedHelper(stream, object.__getattribute__(self, "_ap_method"), object.__getattribute__(self, "_ap_pending"))
        object.__setattr__(self, "_ap_helper", helper)
        return helper

    async def __aexit__(self, *exc: Any) -> Any:
        helper = object.__getattribute__(self, "_ap_helper")
        if helper is not None:
            helper._ap_finish(exc[1] if exc else None)
        return await object.__getattribute__(self, "_ap_inner").__aexit__(*exc)


__all__ = ["ClientMethod", "Intercept", "Pending", "StreamAccumulator", "proxy_client", "read_field", "tap_result"]
