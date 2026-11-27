"""The helpers every framework adapter uses, re-exported by ``airprompter_agent.frameworks.contract``: which model a
placement runs on, the sealed settings under a framework's own key names, and one model call timed into a run. They
decide nothing about versions or rows: the run session owns those. The TypeScript twin is ``runtime/wrap/adapt.ts``.

Example::

    placed = run.place("support.reply")
    if placed.kind == "approved":
        model = choose_model(release_model_id=placed.model, caller_model=params.get("model"), caller_model_id=params.get("model"), resolve=lambda id: id)
        if model is None:
            run.decline("support.reply", "model_unresolved")
        mapped = settings_for(placed.settings, {"temperatureMilli": "temperature", "maxOutputTokens": "max_tokens"})
        reply = measure_call(run, "support.reply", lambda: client.call(**params, **mapped.values, model=model), model=placed.model)
"""

from __future__ import annotations

import inspect
import threading
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, NamedTuple, Optional, TypeVar, Union

from airprompter_agent.core import output_text_of
from airprompter_agent.core._util import now_ms

from .inference import INFERENCE_KEYS, AppliedInference, apply_inference, temperature_of, top_p_of
from .observe import classify_error, classify_result, normalize_usage
from .run import AgentRuntime, RunInput, RunSession

T = TypeVar("T")


class AcquiredRun(NamedTuple):
    """What ``acquire_run`` answers: ``.run`` and ``.owned`` (TypeScript's ``{ run, owned }``). It unpacks as a pair, but
    new code reads the fields by name: a field added later would break a two-name unpack."""

    run: RunSession
    owned: bool


def acquire_run(ap: AgentRuntime, input: Optional[RunInput] = None) -> AcquiredRun:
    """Rule 3 of the contract: the run this hook is inside, else one opened (get-or-create with ``resume``). End it only
    if ``owned``."""
    current = ap.current_run()
    if current is not None:
        return AcquiredRun(current, False)
    return AcquiredRun(ap.open_run(input) if input is not None else ap.open_run(), True)


def choose_model(*, release_model_id: str, caller_model: Any, caller_model_id: Optional[str], model_for: Optional[Callable[[str, Any], Any]] = None, resolve: Optional[Callable[[str], Any]] = None) -> Any:
    """In order: ``model_for`` when given; else the caller's model when its id equals the release's; else the adapter's
    own ``resolve``; else None, and the adapter calls ``run.decline(slot, "model_unresolved")``. Approved text never runs
    on a model the release did not pin. A string result is for the adapter to build."""
    if model_for is not None:
        return model_for(release_model_id, caller_model)
    if caller_model_id is not None and caller_model_id == release_model_id:
        return caller_model
    if resolve is not None:
        return resolve(release_model_id)
    return None


def _value_of(key: str, settings: Mapping[str, Any]) -> Any:
    if key == "temperatureMilli":
        return temperature_of(settings)
    if key == "topPBps":
        return top_p_of(settings)
    value = settings.get(key)
    if value is None:
        return None
    return list(value) if key == "stopSequences" else value


@dataclass(frozen=True)
class MappedSettings:
    #: The settings under the framework's names, floats where the wire holds integers.
    values: dict[str, Any] = field(default_factory=dict)
    #: Settings this framework has no name for: not sent, to be logged.
    unsupported: list[str] = field(default_factory=list)
    #: Names the caller had set to another value: the release's replaced them. Empty without ``caller``.
    overridden: list[str] = field(default_factory=list)


def settings_for(settings: Mapping[str, Any], keys: Mapping[str, str], caller: Optional[Mapping[str, Any]] = None) -> MappedSettings:
    """Sealed settings under a framework's own key names. With ``caller`` (the call's own options), what they replace is reported."""
    mapped = MappedSettings()
    for key in INFERENCE_KEYS:
        value = _value_of(key, settings or {})
        if value is None:
            continue
        name = keys.get(key)
        if name is None:
            mapped.unsupported.append(key)
            continue
        mapped.values[name] = value
        if caller is not None and caller.get(name) is not None and caller.get(name) != value:
            mapped.overridden.append(name)
    return mapped


def apply_settings(kind: str, params: Mapping[str, Any], settings: Mapping[str, Any]) -> AppliedInference:
    """The sealed settings on a direct client's request: a copy, the release's values over the call site's."""
    return apply_inference(kind, params, settings or {})


class Measure:
    """One model call timed into a run, under the release's model id (``placement.model``), settling later: when the response arrives, a stream has gone by, or a stream
    helper's context closes. Settles once; never raises. ``on_settled`` runs after the record (an owned run's end)."""

    def __init__(self, run: RunSession, slot: str, *, model: str, step: Optional[str] = None, now: Optional[Callable[[], float]] = None, read: Optional[Callable[[Any], Any]] = None, tools_observed: bool = False, on_settled: Optional[Callable[[], None]] = None):
        self._run = run
        self._slot = slot
        self._model = model
        self._step = step
        self._now = now or now_ms
        self._read = read
        self._tools_observed = tools_observed
        self._on_settled = on_settled
        self._started = self._now()
        self._settled = False
        self._lock = threading.Lock()

    @property
    def settled(self) -> bool:
        return self._settled

    def settle(self, result: Any) -> None:
        self._finish(result, None)

    def fail(self, error: BaseException) -> None:
        self._finish(None, error)

    def _finish(self, result: Any, error: Optional[BaseException]) -> None:
        with self._lock:
            if self._settled:
                return
            self._settled = True
        try:
            latency = max(0.0, self._now() - self._started)
            base: dict[str, Any] = {"model": self._model, "latency_ms": latency, "step": self._step}
            if self._tools_observed:
                # Only when set: a session written to the RunSession Protocol need not take it.
                base["tools_observed"] = True
            if error is not None:
                self._run.record_model_call(self._slot, **base, error_class=classify_error(error))
            else:
                try:
                    shaped = self._read(result) if self._read else result
                    self._run.record_model_call(self._slot, **base, usage=normalize_usage(shaped), error_class=classify_result(shaped), output_text=output_text_of(shaped))
                except Exception:  # noqa: BLE001 — an unreadable result still counts as a call, with no usage
                    self._run.record_model_call(self._slot, **base)
        except Exception:  # noqa: BLE001 — measuring never fails the customer's call
            pass
        finally:
            if self._on_settled is not None:
                try:
                    self._on_settled()
                except Exception:  # noqa: BLE001
                    pass


def begin_measure(run: RunSession, slot: str, *, model: str, step: Optional[str] = None, now: Optional[Callable[[], float]] = None, read: Optional[Callable[[Any], Any]] = None, tools_observed: bool = False, on_settled: Optional[Callable[[], None]] = None) -> Measure:
    """Start the clock for a call that settles later (a stream): ``.settle(result)`` or ``.fail(error)`` once."""
    return Measure(run, slot, model=model, step=step, now=now, read=read, tools_observed=tools_observed, on_settled=on_settled)


def measure_call(run: RunSession, slot: str, call: Callable[[], T], *, model: str, step: Optional[str] = None, now: Optional[Callable[[], float]] = None, read: Optional[Callable[[Any], Any]] = None, tools_observed: bool = False) -> T:
    """Times one model call into a session: usage, finish reason, error class, output text for declared checks. Re-raises."""
    measure = begin_measure(run, slot, model=model, step=step, now=now, read=read, tools_observed=tools_observed)
    try:
        result = call()
    except BaseException as error:
        measure.fail(error)
        raise
    measure.settle(result)
    return result


async def measure_call_async(run: RunSession, slot: str, call: Callable[[], Union[Awaitable[T], T]], *, model: str, step: Optional[str] = None, now: Optional[Callable[[], float]] = None, read: Optional[Callable[[Any], Any]] = None, tools_observed: bool = False) -> T:
    """``measure_call`` for a coroutine."""
    measure = begin_measure(run, slot, model=model, step=step, now=now, read=read, tools_observed=tools_observed)
    try:
        result = call()
        if inspect.isawaitable(result):
            result = await result
    except BaseException as error:
        measure.fail(error)
        raise
    measure.settle(result)
    return result  # type: ignore[return-value]


__all__ = ["AcquiredRun", "MappedSettings", "Measure", "acquire_run", "apply_settings", "begin_measure", "choose_model", "measure_call", "measure_call_async", "settings_for"]
