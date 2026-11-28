"""A direct provider client (``openai``, ``anthropic``, sync or async) as an adapter: the proxy over its methods,
placement from the run, and measurement into the run. Each provider adapter passes its method table and its
``apply_placement``; this file holds what they share. The TypeScript twin is ``runtime/wrap/instrument.ts``.

=================================  ==============================================  ==============================
Situation                          Placement                                       Measure
=================================  ==============================================  ==============================
``slot``, run open                 ``run.place(slot)`` (``place_async`` on an      ``run.record_model_call``
                                   async client), applied to a copy
``slot``, no run                   ``ap.open_run()``, ended when the call settles  same
``slot``, a ``.stream()`` helper   untouched                                       not measured; one log
no ``slot``, in ``ap.attribute``   the scope's settings, on the release's model    ``ap._begin_observation``
                                                                                   (not on another model)
no ``slot``, no scope              untouched                                       not observed; one log
placement is ``passthrough``       untouched                                       not measured
=================================  ==============================================  ==============================

The release's model wins or nothing is applied: a call naming another model with no ``model_for`` declines the slot
(slot mode) or goes out as written and unobserved (scope mode), with one ``model_unresolved`` log. A failure here never
fails the customer's call: the request goes out as the caller wrote it. A sealed setting whose keyword the installed
client's method does not take (read from its signature before the call, never by a second request) is left off, with
one ``adapter_inference_unsupported`` log (reason ``client``), and the call goes out with the rest of the placement.

Example::

    openai = instrument_client(OpenAI(), ap, adapter="openai", methods=OPENAI_METHODS, slot="support.reply", apply=apply_placement)
    with ap.run(subject=user_id):
        openai.chat.completions.create(model="gpt-5", messages=messages)   # the approved text, model and settings
"""

from __future__ import annotations

import dataclasses
import inspect
import threading
from typing import Any, Callable, Mapping, Optional, Protocol, Sequence

from .adapt import acquire_run, begin_measure, choose_model
from .attribution import Attribution
from .events import ADAPTER_EVENTS
from .inference import _PARAMETER, INFERENCE_KEYS, _value_for, apply_inference
from .observe import classify_error
from .proxy import ClientMethod, Pending, is_async, proxy_client, tap_result
from .run import AgentRuntime, Approved, RunSession

#: The adapter's placement: instructions in the system position, the model and the settings, on a copy.
ApplyPlacement = Callable[[Mapping[str, Any], Approved, str], dict[str, Any]]


class InstrumentRuntime(AgentRuntime, Protocol):
    """What a direct client needs from the agent: the run, the ``ap.attribute`` scope, and an observation that settles later."""

    def current_attribution(self) -> Optional[Attribution]: ...

    def _begin_observation(self, attribution: Attribution, model: str) -> Pending: ...


class _EndOnly:
    """A passthrough on a run this client opened: nothing is measured, and the run ends when the call settles."""

    def __init__(self, run: RunSession):
        self._run = run

    def settle(self, result: Any) -> None:
        self._run.end()

    def fail(self, error: BaseException) -> None:
        self._run.end()


class _Nothing:
    def settle(self, result: Any) -> None:
        pass

    def fail(self, error: BaseException) -> None:
        pass


def _accepted_keywords(method: Callable[..., Any]) -> Optional[frozenset[str]]:
    """The keywords ``method`` takes, or None when it takes any (``**kwargs``) or its signature cannot be read: then
    nothing is left off. The provider SDKs declare every parameter, so a keyword missing here is one the installed
    release would refuse with a ``TypeError`` before sending anything. Read before the call rather than retried after a
    ``TypeError``: one raised while reading the response would make a retry a second request."""
    try:
        parameters = list(inspect.signature(method).parameters.values())
    except Exception:  # noqa: BLE001 — an unreadable signature leaves the placement as it is
        return None
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters):
        return None
    return frozenset(p.name for p in parameters if p.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY))


def _refused_by_client(kind: str, caller: Mapping[str, Any], params: dict[str, Any], inference: Mapping[str, Any], accepted: Optional[frozenset[str]]) -> list[dict[str, str]]:
    """The sealed settings this placement put on ``params`` whose keyword the client does not take: removed from
    ``params`` (the adapter's own copy) and returned as ``{"setting", "reason": "client"}``. A keyword only the caller
    set is the caller's, and stays."""
    if accepted is None or not inference:
        return []
    skipped = {entry["setting"] for entry in apply_inference(kind, caller, inference).unsupported}
    refused: list[dict[str, str]] = []
    for key in INFERENCE_KEYS:
        parameter = _PARAMETER.get(kind, {}).get(key)
        if parameter is None or key in skipped or _value_for(key, inference) is None:
            continue
        if parameter in params and parameter not in accepted:
            value = params.pop(parameter)
            # An openai release older than ``max_completion_tokens`` takes the cap as ``max_tokens``: the same lever.
            if parameter == "max_completion_tokens" and "max_tokens" in accepted:
                params["max_tokens"] = value
                continue
            refused.append({"setting": key, "reason": "client"})
    return refused


def _model_of(params: Any) -> Optional[str]:
    model = params.get("model") if isinstance(params, Mapping) else None
    return model if isinstance(model, str) else None


def instrument_client(client: Any, ap: InstrumentRuntime, *, adapter: str, methods: Sequence[ClientMethod], apply: ApplyPlacement, slot: Optional[str] = None, model_for: Optional[Callable[[str, Optional[str]], Optional[str]]] = None, now: Optional[Callable[[], float]] = None) -> Any:
    """``client`` with its model calls placed and measured per the table above. Instrumenting twice is once: the first slot stays."""
    said: set[tuple[Any, ...]] = set()
    lock = threading.Lock()
    accepted: dict[str, Optional[frozenset[str]]] = {}

    def log(event: str, **fields: Any) -> None:
        # A customer logger that raises never reaches the call.
        try:
            ap.log({"event": event, "adapter": adapter, **fields})
        except Exception:  # noqa: BLE001
            pass

    def once(event: str, key: Optional[tuple[Any, ...]] = None, **fields: Any) -> None:
        key = (event, *(key if key is not None else (fields.get("method"), fields.get("model"))))
        with lock:
            if key in said:
                return
            said.add(key)
        log(event, **fields)

    def fit_client(original: Callable[..., Any], kind: str, caller: Mapping[str, Any], params: dict[str, Any], inference: Mapping[str, Any], name: str, tag: Optional[str], model: str) -> None:
        """Leave off the sealed settings the installed client cannot take: one log per slot, method, model and settings
        (the installed client does not change while the process runs, so every later call would say the same)."""
        if name not in accepted:
            accepted[name] = _accepted_keywords(original)
        refused = _refused_by_client(kind, caller, params, inference, accepted[name])
        if refused:
            once(ADAPTER_EVENTS["inference_unsupported"], key=(tag, name, model, tuple(entry["setting"] for entry in refused)), slot=tag, method=name, settings=refused)

    def model_from(release_model_id: str, kwargs: Mapping[str, Any]) -> Optional[str]:
        """The release's model for this call, or None when it runs elsewhere and nothing maps it."""
        caller = _model_of(kwargs)
        chosen = choose_model(release_model_id=release_model_id, caller_model=caller, caller_model_id=caller, model_for=model_for, resolve=(lambda id: id) if caller is None else None)
        return chosen if isinstance(chosen, str) else None

    def placed_kwargs(run: RunSession, placement: Any, method: ClientMethod, original: Callable[..., Any], kwargs: dict, name: str) -> Optional[tuple[dict, str]]:
        """The keyword arguments to send and the release's model id, or None to send the caller's untouched."""
        if placement.kind != "approved":
            return None
        try:
            model = model_from(placement.model, kwargs)
            if model is None:
                once(ADAPTER_EVENTS["model_unresolved"], slot=slot, method=name, model=placement.model)
                run.decline(slot, "model_unresolved")  # type: ignore[arg-type]
                return None
            params = apply(kwargs, dataclasses.replace(placement, model=model), method.kind)
            fit_client(original, method.kind, kwargs, params, placement.settings or {}, name, slot, placement.model)
            return params, placement.model
        except Exception as error:  # noqa: BLE001
            log(ADAPTER_EVENTS["placement_failed"], slot=slot, method=name, reason=str(error))
            # The slot pinned a version this call will not serve: decline it, so no row or feedback names that version.
            try:
                run.decline(slot, "model_unresolved")  # type: ignore[arg-type]
            except Exception:  # noqa: BLE001
                pass
            return None

    def pending_for(run: RunSession, owned: bool, send: Optional[tuple[dict, str]]) -> Pending:
        if send is None:
            return _EndOnly(run) if owned else _Nothing()
        return begin_measure(run, slot, model=send[1], now=now, on_settled=run.end if owned else None)  # type: ignore[arg-type]

    def place(run: RunSession, method: ClientMethod, original: Callable[..., Any], args: tuple, kwargs: dict, name: str) -> Optional[tuple[dict, str]]:
        # The provider SDKs take keyword arguments only; a positional call is passed through untouched.
        if args:
            return None
        try:
            placement = run.place(slot)  # type: ignore[arg-type]
        except Exception as error:  # noqa: BLE001
            log(ADAPTER_EVENTS["placement_failed"], slot=slot, method=name, reason=str(error))
            return None
        return placed_kwargs(run, placement, method, original, kwargs, name)

    async def place_async(run: RunSession, method: ClientMethod, original: Callable[..., Any], args: tuple, kwargs: dict, name: str) -> Optional[tuple[dict, str]]:
        if args:
            return None
        try:
            placement = await run.place_async(slot)  # type: ignore[arg-type]
        except Exception as error:  # noqa: BLE001
            log(ADAPTER_EVENTS["placement_failed"], slot=slot, method=name, reason=str(error))
            return None
        return placed_kwargs(run, placement, method, original, kwargs, name)

    def slot_call(method: ClientMethod, original: Callable[..., Any], args: tuple, kwargs: dict, name: str) -> Any:
        if is_async(original):
            # The run is found when the coroutine runs, so one created and never awaited opens nothing.
            return _async_slot_call(method, original, args, kwargs, name)
        try:
            run, owned = acquire_run(ap)
        except Exception as error:  # noqa: BLE001
            log(ADAPTER_EVENTS["placement_failed"], slot=slot, method=name, reason=str(error))
            return original(*args, **kwargs)
        send = place(run, method, original, args, kwargs, name)
        pending = pending_for(run, owned, send)
        try:
            out = original(*args, **(send[0] if send is not None else kwargs))
        except BaseException as error:
            pending.fail(error)
            raise
        return _tapped(out, method, pending, name)

    async def _async_slot_call(method: ClientMethod, original: Callable[..., Any], args: tuple, kwargs: dict, name: str) -> Any:
        try:
            run, owned = acquire_run(ap)
        except Exception as error:  # noqa: BLE001
            log(ADAPTER_EVENTS["placement_failed"], slot=slot, method=name, reason=str(error))
            return await original(*args, **kwargs)
        try:
            send = await place_async(run, method, original, args, kwargs, name)
        except BaseException as error:
            # Cancelled while placing: a run this call opened ends here, with the class, rather than at the idle sweep.
            if owned:
                run.end(error_class=classify_error(error))
            raise
        pending = pending_for(run, owned, send)
        try:
            out = await original(*args, **(send[0] if send is not None else kwargs))
        except BaseException as error:
            pending.fail(error)
            raise
        return _tapped(out, method, pending, name)

    def _tapped(out: Any, method: ClientMethod, pending: Pending, name: str) -> Any:
        try:
            return tap_result(out, method, pending)
        except Exception as error:  # noqa: BLE001
            log(ADAPTER_EVENTS["tap_failed"], slot=slot, method=name, reason=str(error))
            pending.settle(None)
            return out

    def scope_call(method: ClientMethod, original: Callable[..., Any], args: tuple, kwargs: dict, name: str) -> Any:
        attribution: Optional[Attribution] = None
        try:
            attribution = ap.current_attribution()
        except Exception as error:  # noqa: BLE001
            log(ADAPTER_EVENTS["attribution_failed"], method=name, reason=str(error))
        if attribution is None:
            once(ADAPTER_EVENTS["unattributed"], method=name)
            return original(*args, **kwargs)
        unresolved = False
        if not args:
            try:
                # The caller placed the text. The release's model and sealed settings go on, or nothing does.
                model = model_from(attribution.model, kwargs)
                if model is None:
                    unresolved = True
                    once(ADAPTER_EVENTS["model_unresolved"], slot=attribution.tag, method=name, model=attribution.model)
                else:
                    applied = apply_inference(method.kind, {**kwargs, "model": model}, attribution.inference or {})
                    if applied.overridden:
                        log(ADAPTER_EVENTS["inference_overridden"], slot=attribution.tag, method=name, parameters=applied.overridden)
                    if applied.unsupported:
                        log(ADAPTER_EVENTS["inference_unsupported"], slot=attribution.tag, method=name, settings=applied.unsupported)
                    fit_client(original, method.kind, kwargs, applied.params, attribution.inference or {}, name, attribution.tag, attribution.model)
                    kwargs = applied.params
            except Exception as error:  # noqa: BLE001
                log(ADAPTER_EVENTS["placement_failed"], slot=attribution.tag, method=name, reason=str(error))
                # Whatever went out, it was not placed by the release: not this version's numbers.
                unresolved = True
        # Another model's numbers must not count against this version: the call goes out as written, unobserved.
        if unresolved:
            return original(*args, **kwargs)
        try:
            # Under the release's id, as every adapter measures, whatever id ``model_for`` sent the call under.
            pending = ap._begin_observation(attribution, attribution.model)
        except Exception as error:  # noqa: BLE001
            log(ADAPTER_EVENTS["attribution_failed"], slot=attribution.tag, method=name, reason=str(error))
            return original(*args, **kwargs)
        try:
            out = original(*args, **kwargs)
        except BaseException as error:
            pending.fail(error)
            raise
        return _tapped(out, method, pending, name)

    def intercept(method: ClientMethod, original: Callable[..., Any], args: tuple, kwargs: dict, name: str) -> Any:
        if slot is not None:
            if method.helper:
                once(ADAPTER_EVENTS["stream_helper_unmeasured"], slot=slot, method=name)
                return original(*args, **kwargs)
            return slot_call(method, original, args, kwargs, name)
        return scope_call(method, original, args, kwargs, name)

    return proxy_client(client, methods, intercept)


__all__ = ["ApplyPlacement", "InstrumentRuntime", "instrument_client"]
