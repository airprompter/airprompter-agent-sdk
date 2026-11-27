"""What the framework adapters share, for ``airprompter_agent.frameworks.contract`` alone: the one module allowed to
import this one (``tools/lint_imports.py``). It is not on ``airprompter_agent.runtime``, so none of it falls under the 1.0
promise until the contract itself does. The TypeScript twin is ``runtime/adapter/index.ts``.

Example::

    # frameworks/contract.py
    from airprompter_agent.runtime.adapter import acquire_run, begin_measure, choose_model, measure_call, settings_for
"""

from .adapt import AcquiredRun, MappedSettings, Measure, _begin_call, acquire_run, apply_settings, begin_measure, choose_model, measure_call, measure_call_async, settings_for
from .events import ADAPTER_EVENTS
from .instrument import ApplyPlacement, InstrumentRuntime, instrument_client
from .proxy import ClientMethod, Pending, StreamAccumulator, read_field

__all__ = [
    # Internal even here: for ``frameworks/contract._open_call`` alone (AIR-2547).
    "_begin_call",
    "ADAPTER_EVENTS",
    "AcquiredRun",
    "ApplyPlacement",
    "ClientMethod",
    "InstrumentRuntime",
    "MappedSettings",
    "Measure",
    "Pending",
    "StreamAccumulator",
    "acquire_run",
    "apply_settings",
    "begin_measure",
    "choose_model",
    "instrument_client",
    "measure_call",
    "measure_call_async",
    "read_field",
    "settings_for",
]
