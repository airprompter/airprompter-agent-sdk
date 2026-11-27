"""``airprompter_agent.frameworks.contract``: the one contract every framework adapter follows. An adapter asks the run
for the approved prompt, model and settings, puts them into the framework's call, and reports what the call cost. It
imports this module and its framework, nothing else (``tools/lint_imports.py`` enforces it). The TypeScript twin is
``@airprompter/agent-sdk/frameworks/contract``.

Stability: this module is public so third-party adapters can read it, but it is outside the 1.0 promise. A minor
release may change it while the LangChain and OpenAI Agents adapters prove its shapes.

Rules for every adapter:

1. Read ``run.run_ref`` late and store the latest value in framework state. It grows as slots pin. Never cache it.
2. The run owns text, version and rows. An adapter never mints a run reference, never writes a row, never reads a
   release.
3. Finding the run: ``acquire_run(ap, RunInput(resume=ref))`` — ``ap.current_run()``, else, with no scope across hooks,
   ``ap.open_run``, which is get-or-create and safe on every hook. End only a run it says you ``owned``.
4. A stream returned out of ``ap.run`` is the caller's to consume inside it. Records that arrive after the run ended are
   dropped with one log.

Check ``placed.kind == "approved"`` and treat anything else as a passthrough, which always leaves the framework's
request untouched: its own prompt and model run. The release's model wins
or the slot declines (``run.decline(slot, "model_unresolved")``): approved text never runs on a model the release did
not pin.

Measure under the release's model id (``placed.model``) whatever id the framework sent, through ``measure_call`` or,
for a start and end in different hooks or a stream, ``begin_measure``. Pass the agent's clock as ``now`` so a recorded
run replays the same. Log with ``ADAPTER_EVENTS``, each event carrying ``adapter``, ``slot`` and ``method``.

Not to be confused with the repository's top-level ``integrations/`` folder (the Zapier and n8n platforms, TypeScript
only), which reaches the SDK only through ``frameworks/steps``.

Example::

    from airprompter_agent.frameworks.contract import RunInput, acquire_run, choose_model, measure_call, settings_for

    def on_model_call(ap, request):
        run, _owned = acquire_run(ap, RunInput(resume=request.state.get("run_ref")))
        placed = run.place("support.reply")
        if placed.kind != "approved":
            return request.next()
        # A string would be an id to build a model from; this framework cannot, so only its own model object will do.
        model = choose_model(release_model_id=placed.model, caller_model=request.model, caller_model_id=request.model.id)
        if model is None or isinstance(model, str):
            run.decline("support.reply", "model_unresolved")
            return request.next()
        mapped = settings_for(placed.settings, {"temperatureMilli": "temperature", "maxOutputTokens": "max_tokens"})
        request.state["run_ref"] = run.run_ref   # rule 1: the latest value, read late
        return measure_call(run, "support.reply", lambda: request.next(system=placed.instructions, model=model, **mapped.values), model=placed.model)
"""

from airprompter_agent.core import output_text_of
from airprompter_agent.runtime import AgentRuntime, AppliedInference, Approved, Attribution, ModelResolver, Passthrough, Placement, RunInput, RunSession, UsageNormalized, classify_error, classify_result, normalize_usage
from airprompter_agent.runtime.adapter import (
    ADAPTER_EVENTS,
    ApplyPlacement,
    ClientMethod,
    InstrumentRuntime,
    MappedSettings,
    Measure,
    Pending,
    StreamAccumulator,
    acquire_run,
    apply_settings,
    begin_measure,
    choose_model,
    instrument_client,
    measure_call,
    measure_call_async,
    read_field,
    settings_for,
)

__all__ = [
    "ADAPTER_EVENTS",
    "AgentRuntime",
    "AppliedInference",
    "ApplyPlacement",
    "Approved",
    "Attribution",
    "ClientMethod",
    "InstrumentRuntime",
    "MappedSettings",
    "Measure",
    "ModelResolver",
    "Passthrough",
    "Pending",
    "Placement",
    "RunInput",
    "RunSession",
    "StreamAccumulator",
    "UsageNormalized",
    "acquire_run",
    "apply_settings",
    "begin_measure",
    "choose_model",
    "classify_error",
    "classify_result",
    "instrument_client",
    "measure_call",
    "measure_call_async",
    "normalize_usage",
    "output_text_of",
    "read_field",
    "settings_for",
]
