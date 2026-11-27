"""The OpenAI driver (Python): the real ``openai`` client over a recorded ``httpx.MockTransport``, instrumented with
``instrument(client, ap, slot=, model_for=, now=)`` as a developer would, running the fixture's program
(``program.py``): Chat Completions calls, plain or streamed, with the application's own tool loop, and a bare-client
baseline when the fixture asks for one.

Example::

    result = drive_run(ap=ap, fixture=fixture, clock=clock)   # {"calls": [...], "runRefs": [...]}
"""
from __future__ import annotations

from typing import Any

import openai

from airprompter_agent.frameworks.openai import instrument
from drivers.program import feedback_of, model_for_of, run_program, seen_with_baseline
from drivers.recorded import openai_chat, openai_responses


def _tool(name: str) -> dict:
    return {"type": "function", "function": {"name": name, "description": f"the {name} tool", "parameters": {"type": "object", "properties": {}}}}


def chat_turn(client: Any, step: dict, history: list) -> list:
    if not history:
        if step.get("system") is not None:
            history.append({"role": "system", "content": step["system"]})
        history.append({"role": "user", "content": step.get("user", "hi")})
    request = {"model": step["model"], "messages": list(history), **({"tools": [_tool(n) for n in step["tools"]]} if step.get("tools") else {}), **(step.get("params") or {})}
    if step.get("stream"):
        content, calls = "", {}
        # ``includeUsage: false``: the caller's plain ``stream=True``, as most code writes it.
        for chunk in client.chat.completions.create(**request, stream=True, **({} if step.get("includeUsage") is False else {"stream_options": {"include_usage": True}})):
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta is None:
                continue
            content += delta.content or ""
            for call in delta.tool_calls or []:
                calls[call.index] = {"id": call.id, "type": "function", "function": {"name": call.function.name, "arguments": call.function.arguments or "{}"}}
        tool_calls = [calls[i] for i in sorted(calls)]
    else:
        message = client.chat.completions.create(**request).choices[0].message
        content = message.content or ""
        tool_calls = [{"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}} for c in message.tool_calls or []]
    if not tool_calls:
        return []
    history.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
    history.extend({"role": "tool", "tool_call_id": call["id"], "content": "found it"} for call in tool_calls)
    return [call["function"]["name"] for call in tool_calls]


def responses_turn(client: Any, step: dict, history: list) -> list:
    """One step's next Responses call (``api: "responses"``): instructions, input items, function calls and their outputs."""
    if not history:
        history.append({"role": "user", "content": step.get("user", "hi")})
    tools = [{"type": "function", "name": n, "description": f"the {n} tool", "parameters": {"type": "object", "properties": {}}} for n in step.get("tools") or []]
    response = client.responses.create(model=step["model"], input=list(history), **({"instructions": step["system"]} if step.get("system") is not None else {}), **({"tools": tools} if tools else {}), **(step.get("params") or {}))
    calls = [item for item in response.output if item.type == "function_call"]
    for call in calls:
        history.append({"type": "function_call", "call_id": call.call_id, "name": call.name, "arguments": call.arguments})
        history.append({"type": "function_call_output", "call_id": call.call_id, "output": "found it"})
    return [call.name for call in calls]


def _turn(client: Any, step: dict, history: list) -> list:
    return responses_turn(client, step, history) if step.get("api") == "responses" else chat_turn(client, step, history)


def drive_run(*, ap: Any, fixture: dict, clock: Any, **_: Any) -> dict:
    record = openai_responses if any(step.get("api") == "responses" for step in fixture["agent"]["steps"]) else openai_chat
    provider = record(fixture["recorded"]["turns"], clock=clock)
    clients = [instrument(openai.OpenAI(api_key="test-only", http_client=provider.http_client(), max_retries=0), ap, slot=spec.get("slot"), model_for=model_for_of(spec.get("modelFor")), now=clock) for spec in fixture["agent"]["clients"]]
    refs = run_program(ap, fixture, lambda step, history, run: _turn(clients[step.get("client", 0)], step, history))
    results = feedback_of(ap, fixture, refs)
    baseline = None
    if fixture["agent"].get("baseline"):
        baseline = record(fixture["recorded"]["turns"])
        bare = openai.OpenAI(api_key="test-only", http_client=baseline.http_client(), max_retries=0)
        run_program(ap, fixture, lambda step, history, run: _turn(bare, step, history), scope="none")
    return {"calls": seen_with_baseline(provider, baseline), "runRefs": refs, **({"results": results} if results else {})}
