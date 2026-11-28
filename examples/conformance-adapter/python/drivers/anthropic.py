"""The Anthropic driver (Python): the real ``anthropic`` client over a recorded ``httpx.MockTransport``, instrumented
with ``instrument(client, ap, slot=, model_for=, now=)``, running the fixture's program (``program.py``): Messages
calls, plain or streamed, with the application's own tool loop, and a bare-client baseline when asked.

Example::

    result = drive_run(ap=ap, fixture=fixture, clock=clock)   # {"calls": [...], "runRefs": [...]}
"""
from __future__ import annotations

from typing import Any

import anthropic

from airprompter_agent.frameworks.anthropic import instrument
from drivers.program import feedback_of, model_for_of, run_program, seen_with_baseline
from drivers.recorded import anthropic_messages


def _tool(name: str) -> dict:
    return {"name": name, "description": f"the {name} tool", "input_schema": {"type": "object", "properties": {}}}


def messages_turn(client: Any, step: dict, history: list) -> list:
    if not history:
        history.append({"role": "user", "content": step.get("user", "hi")})
    request = {"model": step["model"], "max_tokens": 1024, "messages": list(history), **({"system": step["system"]} if step.get("system") is not None else {}), **({"tools": [_tool(n) for n in step["tools"]]} if step.get("tools") else {}), **(step.get("params") or {})}
    if step.get("stream"):
        blocks: dict = {}
        for event in client.messages.create(**request, stream=True):
            if event.type == "content_block_start":
                block = event.content_block
                blocks[event.index] = {"type": block.type, "text": getattr(block, "text", "") or "", "id": getattr(block, "id", None), "name": getattr(block, "name", None)}
            elif event.type == "content_block_delta" and event.delta.type == "text_delta":
                blocks[event.index]["text"] += event.delta.text
        content = [blocks[i] for i in sorted(blocks)]
    else:
        content = [{"type": b.type, "text": getattr(b, "text", ""), "id": getattr(b, "id", None), "name": getattr(b, "name", None)} for b in client.messages.create(**request).content]
    uses = [block for block in content if block["type"] == "tool_use"]
    if not uses:
        return []
    history.append({"role": "assistant", "content": [{"type": "tool_use", "id": b["id"], "name": b["name"], "input": {}} if b["type"] == "tool_use" else {"type": "text", "text": b["text"]} for b in content]})
    history.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": use["id"], "content": "found it"} for use in uses]})
    return [use["name"] for use in uses]


def drive_run(*, ap: Any, fixture: dict, clock: Any, **_: Any) -> dict:
    provider = anthropic_messages(fixture["recorded"]["turns"], clock=clock)
    clients = [instrument(anthropic.Anthropic(api_key="test-only", http_client=provider.http_client(), max_retries=0), ap, slot=spec.get("slot"), model_for=model_for_of(spec.get("modelFor")), now=clock) for spec in fixture["agent"]["clients"]]
    refs = run_program(ap, fixture, lambda step, history, run: messages_turn(clients[step.get("client", 0)], step, history))
    results = feedback_of(ap, fixture, refs)
    baseline = None
    if fixture["agent"].get("baseline"):
        baseline = anthropic_messages(fixture["recorded"]["turns"])
        bare = anthropic.Anthropic(api_key="test-only", http_client=baseline.http_client(), max_retries=0)
        run_program(ap, fixture, lambda step, history, run: messages_turn(bare, step, history), scope="none")
    return {"calls": seen_with_baseline(provider, baseline), "runRefs": refs, **({"results": results} if results else {})}
