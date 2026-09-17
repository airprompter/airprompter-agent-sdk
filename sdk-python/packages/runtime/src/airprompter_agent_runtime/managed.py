"""Managed ("hosted") mode (§18, T23): no store, no models, no keys of your
own. ``ManagedAgent.start()`` reads the environment's catalogue (slot tags,
declared variables, workflow step ids, the experiment's salt and arms)
with a run key, and ``run()`` / ``stream()`` POST to the run route. The
subject never leaves the process: ``subjectHash`` is
``hex(SHA-256(salt ‖ subject))`` computed here, exactly as client mode
computes it, so an A/B across modes is one A/B. Refusals are typed; the
only retry is a 429 honouring ``Retry-After``. Every run streams under the
hood — the run route sits behind an edge that closes a silent connection
at 60 s, and a JSON run is silent until the model finishes — and ``run()``
assembles the ``done`` frame for callers who did not ask to stream.
Sources the application registered (``start(variables=...)``) fill required
declared variables here, before the POST — the hosted route has no way into
your systems, and a source stricter than the slot's declaration is refused
rather than sent raw.

Example::

    agent = ManagedAgent.start(agent_id="agt_…", target="prod", api_key=os.environ["AIRPROMPTER_RUN_KEY"], base_url=RUN_URL,
                               variables={"customer_tier": {"resolve": lambda ctx: crm.tier_of(ctx.subject), "trust": "operator"}})
    agent.needs("support.triage", {"ticket": text})     # [] — everything required is covered
    result = agent.run("support.triage", {"ticket": text}, subject=customer_id)
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Iterator, Mapping, Optional
from urllib.parse import quote

import httpx

from airprompter_agent_core.protocol.assignment import subject_hash as salted_subject_hash

from .variables.fill import fill_sync, plan_fill, stricter_sources, supplied, unsourced
from .variables.sources import VariableSourceContext, VariableSourceError, VariableSourceInput, VariableSourceRegistry, VariableSourceRequiredError

MANAGED_SDK_USER_AGENT = "airprompter-agent-sdk-python/managed"

MANAGED_REFUSAL_CODES = (
    "unauthorized",
    "forbidden",
    "invalid_request",
    "render_missing_variable",
    "render_unknown_variable",
    "model_not_priced",
    "model_not_offered",
    "allowance_exhausted",
    "agent_cap_exhausted",
    "target_not_hosted",
    "slot_not_found",
    "nothing_promoted",
    "step_not_found",
    "already_executed",
    "rate_limited",
    "agent_rate_limited",
    "model_unavailable",
    "internal",
)


class ManagedRunError(Exception):
    """The run route said no (or the edge did): the code the route named, its status, and what it told us."""

    def __init__(self, code: str, status: int, message: str, detail: Optional[str] = None, retry_after_seconds: Optional[float] = None):
        super().__init__(f"{code} ({status}): {message}")
        self.code = code
        self.status = status
        self.detail = detail
        self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True)
class ManagedRunResult:
    run_id: str
    run_ref: str
    output: str
    model: str
    version_id: str
    arm: str
    generation: int
    usage: dict[str, int]  # inputTokens / cachedInputTokens / outputTokens
    latency_ms: int
    price_micros: int
    price_book_revision: str
    stop_reason: str  # "end_turn" | "max_tokens" | "stop_sequence" | "cancelled" | "unknown"
    source: str  # "executed" | "replayed"
    metadata: Optional[dict[str, str]] = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, done: Mapping[str, Any]) -> "ManagedRunResult":
        return cls(
            run_id=str(done.get("runId", "")),
            run_ref=str(done.get("runRef", "")),
            output=str(done.get("output", "")),
            model=str(done.get("model", "")),
            version_id=str(done.get("versionId", "")),
            arm=str(done.get("arm", "none")),
            generation=int(done.get("generation", 0)),
            usage=dict(done.get("usage") or {}),
            latency_ms=int(done.get("latencyMs", 0)),
            price_micros=int(done.get("priceMicros", 0)),
            price_book_revision=str(done.get("priceBookRevision", "")),
            stop_reason=str(done.get("stopReason", "unknown")),
            source=str(done.get("source", "executed")),
            metadata=dict(done["metadata"]) if done.get("metadata") else None,
            raw=dict(done),
        )


@dataclass(frozen=True)
class SseFrame:
    event: str
    data: str


def _frame_of(raw: str) -> Optional[SseFrame]:
    event = "message"
    data: list[str] = []
    for line in raw.split("\n"):
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:][1:] if line[5:].startswith(" ") else line[5:])
    return SseFrame(event, "\n".join(data)) if data else None


def parse_sse(chunks: Iterable[str]) -> Iterator[SseFrame]:
    """SSE frames from a text chunk stream: ``event: x\\ndata: y\\n\\n``, tolerant of partial chunks."""
    buffer = ""
    for chunk in chunks:
        buffer += chunk
        boundary = buffer.find("\n\n")
        while boundary >= 0:
            raw = buffer[:boundary]
            buffer = buffer[boundary + 2 :]
            frame = _frame_of(raw)
            if frame:
                yield frame
            boundary = buffer.find("\n\n")
    tail = _frame_of(buffer)
    if tail:
        yield tail


def _safe_json(text: str) -> Any:
    try:
        return json.loads(text)
    except ValueError:
        return {"error": text[:200]}


def _refusal_from(status: int, body: Any, retry_after_header: Optional[str]) -> ManagedRunError:
    parsed = body if isinstance(body, dict) else {}
    code = parsed.get("code") or ("unauthorized" if status == 401 else "forbidden" if status == 403 else "rate_limited" if status == 429 else "internal" if status >= 500 else "invalid_request")
    retry_after = parsed.get("retryAfterSeconds")
    if retry_after is None and retry_after_header:
        try:
            retry_after = float(retry_after_header)
        except ValueError:
            retry_after = None
    return ManagedRunError(str(code), status, str(parsed.get("error") or f"HTTP {status}"), parsed.get("detail"), retry_after)


class ManagedRunStream:
    """The stream: iterate the deltas as they arrive; ``result`` is the assembled ``done`` frame once the stream ends (it drains the rest if you ask early)."""

    def __init__(self, response: httpx.Response, on_done: Callable[[ManagedRunResult], None]):
        self._response = response
        self._on_done = on_done
        self._result: Optional[ManagedRunResult] = None
        self._error: Optional[BaseException] = None
        self._settled = False
        self._frames = parse_sse(response.iter_text())

    def __iter__(self) -> Iterator[str]:
        try:
            for frame in self._frames:
                if frame.event == "delta":
                    yield str(json.loads(frame.data).get("delta", ""))
                elif frame.event == "done":
                    self._result = ManagedRunResult.from_wire(json.loads(frame.data))
                    self._settled = True
                    self._on_done(self._result)
                elif frame.event == "error":
                    body = json.loads(frame.data)
                    self._settled = True
                    self._error = ManagedRunError(str(body.get("code", "internal")), 200, str(body.get("error", "")), body.get("detail"), body.get("retryAfterSeconds"))
                    return
            if not self._settled:
                self._error = ManagedRunError("internal", 200, "the stream ended without a done frame")
        except ManagedRunError:
            raise
        except Exception as error:  # noqa: BLE001
            if not self._settled:
                self._error = error
            raise
        finally:
            self._response.close()

    @property
    def result(self) -> ManagedRunResult:
        if self._result is None and self._error is None:
            for _delta in self:
                pass
        if self._error is not None:
            raise self._error
        assert self._result is not None
        return self._result


_MANAGED_SYNC_HINT = "managed runs are synchronous; register a plain callable for it"


class ManagedWorkflow:
    def __init__(self, agent: "ManagedAgent", tag: str, subject: Optional[str]):
        self._agent = agent
        self._tag = tag
        self._subject = subject
        slot = next((s for s in agent.slots.get("slots", []) if s.get("tag") == tag), None)
        self.steps: list[Mapping[str, Any]] = list((slot or {}).get("steps") or [])

    def step(self, step_id: str, variables: Mapping[str, str], **options: Any) -> ManagedRunResult:
        """The customer executes tools between steps and calls ``step()`` for each."""
        return self._agent.run(self._tag, variables, subject=self._subject, step_id=step_id, **options)


class ManagedAgent:
    def __init__(self, *, agent_id: str, target: str, api_key: str, base_url: str, catalogue: dict[str, Any], transport: Optional[httpx.BaseTransport], max_rate_limit_retries: int, sleep: Callable[[float], None], instance_id: Optional[str], user_agent: str, timeout: float, variables: Optional[Mapping[str, VariableSourceInput]] = None):
        #: The application's variable sources (``start(variables=...)``, ``agent.variables.provide()``): consulted for
        #: every required declared variable a call site did not pass, before the run is posted — the hosted route has
        #: no way into the application's systems. See ``variables/sources.py``.
        self.variables = VariableSourceRegistry(variables)
        self._agent_id = agent_id
        self._target = target
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._catalogue = catalogue
        self._client = httpx.Client(transport=transport, timeout=timeout)
        self._retries = max_rate_limit_retries
        self._sleep = sleep
        self._instance_id = instance_id or hashlib.sha256(f"{os.getpid()}:{time.time()}:{random.random()}".encode("utf-8")).hexdigest()
        self._user_agent = user_agent

    @classmethod
    def start(cls, *, agent_id: str, target: str, api_key: str, base_url: str, transport: Optional[httpx.BaseTransport] = None, max_rate_limit_retries: int = 2, sleep: Optional[Callable[[float], None]] = None, instance_id: Optional[str] = None, user_agent: str = MANAGED_SDK_USER_AGENT, timeout: float = 120.0, variables: Optional[Mapping[str, VariableSourceInput]] = None) -> "ManagedAgent":
        """Reads the catalogue once; refuses (typed) when the key, the target or the promotion is not there.
        ``api_key`` is a run key (``agent_run`` kind, ``agent.run`` scope); ``base_url`` the run route's origin (the AgentRunUrl output of the execution stack).
        ``variables`` registers how this process fills declared variables from its own system (a literal, or a source with its
        trust). This client is synchronous, so a source must be a plain callable: a coroutine function is refused at run time."""
        agent = cls(agent_id=agent_id, target=target, api_key=api_key, base_url=base_url, catalogue={}, transport=transport, max_rate_limit_retries=max_rate_limit_retries, sleep=sleep or time.sleep, instance_id=instance_id, user_agent=user_agent, timeout=timeout, variables=variables)
        agent._catalogue = agent._read_catalogue()
        return agent

    def close(self) -> None:
        self._client.close()

    def _read_catalogue(self) -> dict[str, Any]:
        response = self._client.get(f"{self._base_url}/v1/agents/{quote(self._agent_id, safe='')}/targets/{self._target}/slots", headers={"authorization": f"Bearer {self._api_key}", "accept": "application/json", "user-agent": self._user_agent})
        if response.status_code != 200:
            raise _refusal_from(response.status_code, _safe_json(response.text), response.headers.get("retry-after"))
        return json.loads(response.text)

    @property
    def slots(self) -> dict[str, Any]:
        """The catalogue as last read: tags, variables, steps, the experiment's arms."""
        return self._catalogue

    def refresh(self) -> dict[str, Any]:
        """Re-reads the catalogue (a run answered with a newer generation, or on a schedule of your own)."""
        self._catalogue = self._read_catalogue()
        return self._catalogue

    def experiment_for(self, tag: str) -> Optional[dict]:
        """S17: the experiment that splits a slot — the per-prompt one by tag, else the legacy single one (it covers every slot), else None."""
        entries = self._catalogue.get("experiments")
        if entries:
            return next((e for e in entries if e.get("tag") in (tag, None)), None)
        return self._catalogue.get("experiment")

    def subject_hash_for(self, subject: Optional[str], tag: Optional[str] = None) -> Optional[str]:
        """The hash the route buckets on: the slot's experiment salt over the subject (or this instance when the experiment assigns by instance). Never the subject."""
        experiment = self._catalogue.get("experiment") if tag is None else self.experiment_for(tag)
        if not experiment:
            return None
        value = self._instance_id if experiment.get("subjectKey") == "instance" or subject is None else subject
        return salted_subject_hash(experiment["salt"], value)

    def feedback(self, run_ref: str, signals: Optional[Mapping[str, Any]] = None, /, **kwargs: Any) -> dict[str, Any]:
        """T30: quality signals against a run, by the ``runRef`` it returned — from this process or any other that kept
        the ref. Numbers, booleans and the declared enums only; the answer says what landed and what was refused and why.
        A ref that does not verify, or one for another agent or environment, raises ``ManagedRunError`` (``invalid_run_ref``)."""
        payload = {**(signals or {}), **kwargs}
        url = f"{self._base_url}/v1/agents/{quote(self._agent_id, safe='')}/targets/{self._target}/feedback"
        headers = {"authorization": f"Bearer {self._api_key}", "content-type": "application/json", "accept": "application/json", "user-agent": self._user_agent}
        response = self._client.post(url, headers=headers, content=json.dumps({"runRef": run_ref, "signals": payload}))
        if response.status_code != 202:
            raise _refusal_from(response.status_code, _safe_json(response.text), response.headers.get("retry-after"))
        return json.loads(response.text)

    def run(self, tag: str, variables: Mapping[str, str], **options: Any) -> ManagedRunResult:
        """One managed run: streams under the hood, returns the assembled result."""
        stream = self.stream(tag, variables, **options)
        for _delta in stream:
            pass
        return stream.result

    def workflow(self, tag: str, *, subject: Optional[str] = None) -> ManagedWorkflow:
        return ManagedWorkflow(self, tag, subject)

    def needs(self, tag: str, values: Optional[Mapping[str, Any]] = None) -> list[str]:
        """The required declared variables a run of this slot would still lack after these values and the registered sources."""
        slot = next((s for s in self._catalogue.get("slots", []) if s.get("tag") == tag), None)
        if slot is None:
            raise KeyError(f"no slot {tag} in the catalogue")
        return unsourced(variables=slot.get("variables") or [], values=values or {}, registry=self.variables)

    def _fill_for_run(self, tag: str, values: Mapping[str, str], subject: Optional[str]) -> dict[str, str]:
        """The values a run posts: the call site's, then the application's sources for required declared variables it
        left unfilled. Trust cannot be tightened here — the hosted run fences by the slot's declaration — so a source
        stricter than the declaration is refused BEFORE any lookup (``VariableSourceError``, reason ``unfenceable``),
        never sent raw. Only what this run would actually fill can be unfenceable: an optional variable no run posts
        is not refused. The catalogue types trust as a string; anything but ``end_user`` counts as the looser
        declaration, which is the safe direction."""
        slot = next((s for s in self._catalogue.get("slots", []) if s.get("tag") == tag), None)
        if slot is None or not self.variables.names():
            return dict(values)
        declared = slot.get("variables") or []
        plan = plan_fill(tag=tag, variables=declared, text=None, values=values, registry=self.variables)
        if not plan.literal and not plan.async_:
            return dict(values)
        planned = {*plan.literal, *plan.async_}
        unfenceable = [name for name in stricter_sources(declared, self.variables) if name in planned]
        if unfenceable:
            raise VariableSourceError(tag, unfenceable[0], "unfenceable")
        # The managed client is synchronous throughout (there is no run_async): a coroutine-function source cannot be
        # run here, and the refusal says so rather than pointing at a render_async() this client does not have.
        awaitable = [name for name in planned if (entry := self.variables.get(name)) is not None and entry.kind == "source" and entry.awaitable]
        if awaitable:
            raise VariableSourceRequiredError(tag, awaitable, hint=_MANAGED_SYNC_HINT)
        try:
            filled = fill_sync(plan, VariableSourceContext(tag=tag, name="", subject=subject, version_id=None, arm=None), self.variables)
        except VariableSourceRequiredError as error:
            # A plain callable that handed back a coroutine: the same refusal, with the hint that applies here.
            raise VariableSourceRequiredError(tag, error.names, hint=_MANAGED_SYNC_HINT) from None
        return {name: str(value) for name, value in filled.values.items() if supplied(filled.values, name)}

    def stream(self, tag: str, variables: Mapping[str, str], *, subject: Optional[str] = None, step_id: Optional[str] = None, idempotency_key: Optional[str] = None, max_output_tokens: Optional[int] = None, metadata: Optional[Mapping[str, str]] = None) -> ManagedRunStream:
        """The run as SSE: iterate the deltas, read ``result``. Declared variables the call site left unfilled are
        filled from the application's sources first (``_fill_for_run``)."""
        body: dict[str, Any] = {"tag": tag, "variables": self._fill_for_run(tag, variables, subject), "stream": True}
        subject_digest = self.subject_hash_for(subject, tag)
        if subject_digest:
            body["subjectHash"] = subject_digest
        if step_id:
            body["stepId"] = step_id
        if idempotency_key:
            body["idempotencyKey"] = idempotency_key
        if max_output_tokens:
            body["maxOutputTokens"] = max_output_tokens
        if metadata:
            body["metadata"] = dict(metadata)
        url = f"{self._base_url}/v1/agents/{quote(self._agent_id, safe='')}/targets/{self._target}/run"
        headers = {"authorization": f"Bearer {self._api_key}", "content-type": "application/json", "accept": "text/event-stream", "user-agent": self._user_agent}
        attempt = 0
        while True:
            request = self._client.build_request("POST", url, headers=headers, content=json.dumps(body).encode("utf-8"))
            response = self._client.send(request, stream=True)
            if response.status_code == 200:
                return ManagedRunStream(response, self._on_done)
            response.read()
            refusal = _refusal_from(response.status_code, _safe_json(response.text), response.headers.get("retry-after"))
            response.close()
            if response.status_code == 429 and attempt < self._retries:
                attempt += 1
                self._sleep(max(1.0, refusal.retry_after_seconds or 1.0))
                continue
            raise refusal

    def _on_done(self, done: ManagedRunResult) -> None:
        if done.generation != self._catalogue.get("generation"):
            # A newer promotion answered: the catalogue may have new tags; read it lazily on the next call.
            self._catalogue = {**self._catalogue, "generation": done.generation}
