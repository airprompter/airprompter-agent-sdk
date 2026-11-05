"""The runtime over a verified release (S10): which slot a subject gets, under which arm — the signed ramp plan walked
on this host's clock (S9), a disabled arm's share handed to the control, a disabled agent or slot refused — and the
rendered text with its run reference. Pure over a ``LoadedRelease``: the slot store, a daemon, and a bundle the
customer loaded all look the same from here, and nothing here touches a file, a socket or a clock it was not handed.

The lease, the spool's refusal rows and the daemon's contact are the facade's (``airprompter_agent``): this class
says *what* would be refused and why; the facade decides what to record.

Example::

    resolver = ReleaseResolver(release=reader.current(), run_ref_key=run_ref_key, agent_id="agt_1", target="prod", instance_id="host-1", now_ms=clock.now_ms)
    outcome = resolver.resolve("support.reply", subject="user-42")   # the arm is sticky per subject; the ramp is read on now_ms
    if not outcome.ok:
        record(outcome.reason)                                       # "disabled" | "no_slot" — the facade writes the refusal row
    rendered = resolver.render(outcome.slot, {"customer_name": "Ada"})   # .text, .model, .run_ref, .inference
    flow = resolver.workflow(resolver.resolve("onboarding.flow").slot)   # steps in ordinal order, each with its own run_ref
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

from airprompter_agent_core.protocol.assignment import assign_arm, effective_arms, frozen_experiment, ordered_steps, servable_experiments, servable_slots
from airprompter_agent_core.protocol.assignment import matches_audience, captured_audience_ids
from airprompter_agent_core.protocol.trust import slot_hashes
from airprompter_agent_core.telemetry.rows import minute_of
from airprompter_agent_core.release.reader import LoadedRelease, ReleaseSlot
from airprompter_agent_core.render.run_ref import RunRefFacts, mint_run_ref, new_run_id
from airprompter_agent_core.render.template import render_template


def copy_inference(inference: Optional[Mapping[str, Any]]) -> Optional[dict[str, Any]]:
    """A plain copy of an inference block (stop sequences included; serialisable, picklable): what is handed out, and
    what each holder keeps, so no two holders share one mutable object and nothing the runtime holds can be edited."""
    if inference is None:
        return None
    return {key: (list(value) if key == "stopSequences" and value is not None else value) for key, value in inference.items()}


@dataclass(frozen=True)
class Rendered:
    text: str
    model: str
    version_id: str
    artifact_id: str
    arm: str
    generation: int
    run_ref: str
    tag: str
    #: How the model is called for this slot, as the version declared it: the wrappers apply it.
    inference: Optional[Mapping[str, Any]] = None
    audience_ids: Optional[tuple[str, ...]] = None
    run_minute: Optional[str] = None


@dataclass(frozen=True)
class WorkflowStep:
    step_id: str
    ordinal: int
    version_id: str
    artifact_id: str
    text: str
    run_ref: str
    #: How the model is called for this step, as its prompt version declared it: the wrappers apply it.
    inference: Optional[Mapping[str, Any]] = None
    #: The workflow's pinned model (every step runs on it); the settings above are for it.
    model: Optional[str] = None
    audience_ids: Optional[tuple[str, ...]] = None
    run_minute: Optional[str] = None


@dataclass(frozen=True)
class Workflow:
    model: str
    arm: str
    steps: list[WorkflowStep]
    variables: list[Mapping[str, Any]]


@dataclass(frozen=True)
class Disabled:
    agent: bool = False
    slots: list[str] = field(default_factory=list)
    #: S16: arm names disabled per experiment id.
    arms_by_experiment: dict[str, list[str]] = field(default_factory=dict)

    def arms_for(self, experiment_id: Any) -> set[str]:
        """S16: the arms disabled for one experiment."""
        return set(self.arms_by_experiment.get(experiment_id, [])) if isinstance(experiment_id, str) else set()

    def as_dict(self) -> dict[str, Any]:
        """The heartbeat's shape: agent / slots / arms, every disabled arm name flattened."""
        return {"agent": self.agent, "slots": list(self.slots), "arms": [arm for arms in self.arms_by_experiment.values() for arm in arms]}


@dataclass(frozen=True)
class ResolveOutcome:
    """``ok`` with the slot, or a refusal as data: ``reason`` is "disabled" or "no_slot"; ``tag`` is None when the whole
    agent is disabled."""

    ok: bool
    slot: Optional[ReleaseSlot] = None
    reason: Optional[str] = None
    tag: Optional[str] = None


def disabled_from(directives: Sequence[Mapping[str, Any]]) -> Disabled:
    """What ``disable`` directives say, as data. An arm-scoped disable always names its experiment (M15)."""
    slots: list[str] = []
    arms_by_experiment: dict[str, list[str]] = {}
    agent = False
    for directive in directives:
        if directive.get("kind") != "disable":
            continue
        if directive.get("scope") == "agent":
            agent = True
        elif directive.get("scope") == "arm":
            if directive.get("arm") and isinstance(directive.get("experimentId"), str):
                arms_by_experiment.setdefault(directive["experimentId"], []).append(str(directive["arm"]))
        elif directive.get("tag"):
            slots.append(str(directive["tag"]))
    return Disabled(agent=agent, slots=slots, arms_by_experiment=arms_by_experiment)


def _entry(*, tag: str, artifact_id: str, version_id: str, model: str, arm: str, bucket: Optional[int], run_minute: str, audience_ids: Optional[Sequence[str]]) -> dict[str, Any]:
    """One run reference entry, in the key order the TypeScript SDK writes, so a token is the same bytes in both."""
    return {"tag": tag, "artifactId": artifact_id, "versionId": version_id, "model": model, "arm": arm, "bucket": bucket, "runMinute": run_minute, **({"audienceIds": list(audience_ids)} if audience_ids is not None else {})}


@dataclass(frozen=True)
class AudienceReleaseSlot(ReleaseSlot):
    audience_ids: Optional[tuple[str, ...]] = None
    run_minute: Optional[str] = None


class ReleaseResolver:
    def __init__(
        self,
        *,
        release: LoadedRelease,
        run_ref_key: bytes,
        agent_id: str,
        target: str,
        instance_id: str,
        now_ms: Callable[[], float],
        delimiters: Any = None,
        standing_directives: Optional[tuple[int, Sequence[Mapping[str, Any]]]] = None,
        tags: Optional[Callable[[], Mapping[str,str]]] = None,
    ):
        self._tags = tags or (lambda: {})
        self.release = release
        self._run_ref_key = run_ref_key
        self._agent_id = agent_id
        self._target = target
        self._instance_id = instance_id
        self._now_ms = now_ms
        self._delimiters = delimiters
        #: Directives that outrank the release's own: (generation, directives) — the facade keeps the latest verified
        #: manifest's directives standing across a downgrade.
        self._standing = standing_directives

    @property
    def _payload(self) -> Mapping[str, Any]:
        return self.release.manifest["payload"]

    def directives(self) -> Sequence[Mapping[str, Any]]:
        """The directives in force: the standing set when it is as new as this release, else the release's own."""
        if self._standing and self._standing[0] >= self._payload["generation"]:
            return self._standing[1]
        return self._payload.get("directives", [])

    def disabled(self) -> Disabled:
        return disabled_from(self.directives())

    def experiments(self) -> list[Mapping[str, Any]]:
        """S16: every experiment this host acts on: one per slot it can serve."""
        return servable_experiments(self._payload)

    def frozen(self, tag: str, tags: Mapping[str, str]) -> bool:
        """A run this experiment would decide, with every arm disabled: refused, on a host that sits the experiment out too."""
        return frozen_experiment(self._payload, self.disabled().arms_for, tag, tags)

    def experiment_for(self, tag: str) -> Mapping[str, Any] | None:
        """S16: the experiment that decides a slot, by tag, else None."""
        return next((experiment for experiment in self.experiments() if experiment["tag"] == tag), None)

    def arms(self, experiment_or_tag: Mapping[str, Any] | str | None = None) -> list[dict[str, Any]] | None:
        """S9: an experiment's arms as they stand now — the signed plan walked on this host's clock, then any disabled
        arm's share handed to the control. None when there is no such experiment, or when every arm is disabled (a
        freeze for that slot). Without an argument: the first of ``experiments[]``."""
        if isinstance(experiment_or_tag, str):
            experiment = self.experiment_for(experiment_or_tag)
        elif experiment_or_tag is not None:
            experiment = experiment_or_tag
        else:
            listed = self.experiments()
            experiment = listed[0] if listed else None
        if not experiment:
            return None
        disabled = self.disabled().arms_for(experiment.get("experimentId"))
        return effective_arms(arms=experiment["arms"], ramp=experiment.get("ramp"), disabled_arms=disabled, now_ms=self._now_ms())

    def resolve(self, tag: str, subject: Optional[str] = None, tags: Optional[Mapping[str,str]] = None) -> ResolveOutcome:
        """The slot a subject gets for a tag, or why not. Refusals are data: the facade records them."""
        payload = self._payload
        local_tags = self._tags() if tags is None else tags
        disabled = self.disabled()
        if disabled.agent:
            return ResolveOutcome(False, reason="disabled", tag=None)
        if tag in disabled.slots:
            return ResolveOutcome(False, reason="disabled", tag=tag)

        def present(entry: Mapping[str, Any]) -> bool:
            # A slot carrying `requires` is here only with every payload it names: main, steps and golden set (trust-chain.md M9).
            if "requires" not in entry:
                return True
            hashes = slot_hashes(entry)
            return len(hashes) > 0 and all(content_hash in self.release.payloads for content_hash in hashes)

        slot = next((entry for entry in servable_slots(payload) if entry.get("tag") == tag), None)
        if slot is None or not present(slot):
            return ResolveOutcome(False, reason="no_slot", tag=tag)
        now = self._now_ms()
        cohort = {"run_minute": minute_of(now), **({"audience_ids": captured_audience_ids(payload["observations"], tag, local_tags, now)} if "observations" in payload else {})}
        # S16: the experiment for this slot — its own salt and arms, so two slots split independently.
        experiment = self.experiment_for(tag)
        if self.frozen(tag, local_tags):
            return ResolveOutcome(False, reason="disabled", tag=tag)
        # An own-tag override this release does not hold: sit out before assignment, so control runs here keep no candidate share.
        if experiment and any(entry["tag"] == tag and not present(entry) for arm in experiment["arms"] for entry in arm.get("overrides", [])):
            return ResolveOutcome(True, AudienceReleaseSlot(slot, "none", None, **cohort))
        if not experiment or (experiment.get("audience") and not matches_audience(experiment["audience"]["selector"],local_tags)):
            return ResolveOutcome(True, AudienceReleaseSlot(slot, "none", None, **cohort))
        subject_value = self._instance_id if experiment.get("subjectKey") == "instance" or subject is None else subject
        arms = self.arms(experiment)
        if arms is None:
            return ResolveOutcome(False, reason="disabled", tag=tag)
        assigned = assign_arm(salt=experiment["salt"], subject=subject_value, arms=arms)
        override = next((entry for entry in assigned.arm.get("overrides", []) if entry["tag"] == tag), None)
        return ResolveOutcome(True, AudienceReleaseSlot(override or slot, str(assigned.arm["arm"]), assigned.bucket, **cohort))

    def text_of(self, slot: Mapping[str, Any]) -> str:
        """A slot's verified payload as text."""
        data = self.release.payloads.get(slot["contentHash"])
        if data is None:
            raise KeyError(f"payload {slot['contentHash']} not loaded")
        return data.decode("utf-8")

    def render(self, resolved: ReleaseSlot, values: Optional[Mapping[str, Any]] = None, *, fenced: Optional[Iterable[str]] = None, text: Optional[str] = None) -> Rendered:
        """Render a prompt slot the resolver already resolved. ``fenced`` names variables a source of ``end_user``
        trust filled: they are fenced whatever the slot declared. ``text`` is the payload already decoded by a caller
        that scanned it for placeholders, so it is not decoded twice."""
        slot = resolved.slot
        generation = self.release.generation
        rendered_text = self.render_text(tag=slot["tag"], text=self.text_of(slot) if text is None else text, variables=slot.get("variables", []), values=values or {}, fenced=fenced)
        run_minute = getattr(resolved, "run_minute", None) or minute_of(self._now_ms())
        audience_ids = getattr(resolved, "audience_ids", None)
        facts = RunRefFacts(self._agent_id, self._target, new_run_id(), (_entry(tag=slot["tag"], artifact_id=slot["artifactId"], version_id=slot["versionId"], model=slot["model"], arm=resolved.arm, bucket=resolved.bucket, run_minute=run_minute, audience_ids=audience_ids),))
        return Rendered(text=rendered_text, model=slot["model"], version_id=slot["versionId"], artifact_id=slot["artifactId"], arm=resolved.arm, generation=generation, run_ref=mint_run_ref(facts, self._run_ref_key), tag=slot["tag"], inference=copy_inference(slot.get("inference")), audience_ids=audience_ids, run_minute=run_minute)

    def render_text(self, *, tag: str, text: str, variables: Sequence[Mapping[str, Any]], values: Mapping[str, Any], fenced: Optional[Iterable[str]] = None) -> str:
        """The one render path: a prompt's text or a workflow step's, with the slot's declarations and this
        resolver's delimiters, so both fence the same way. ``fenced`` tightens declarations to ``end_user``;
        nothing here can loosen one."""
        tighten = set(fenced or ())
        declared = [({**v, "trust": "end_user"} if v["name"] in tighten and v.get("trust") != "end_user" else v) for v in variables] if tighten else list(variables)
        return render_template(tag=tag, text=text, variables=declared, values=dict(values), delimiters=self._delimiters)

    def workflow(self, resolved: ReleaseSlot) -> Workflow:
        """A workflow slot's steps in ordinal order, each with its prompt text and run reference."""
        slot = resolved.slot
        if slot.get("kind") != "workflow" or not slot.get("steps"):
            raise ValueError(f"{slot['tag']} is not a workflow slot")
        run_minute = getattr(resolved, "run_minute", None) or minute_of(self._now_ms())
        audience_ids = getattr(resolved, "audience_ids", None)
        # One ref per step, one entry each, sharing one run id. The entry's tag is the slot's: rows never carry a step in ``tag``.
        run_id = new_run_id()
        steps = [
            WorkflowStep(
                step_id=step["stepId"],
                ordinal=step["ordinal"],
                version_id=step["promptVersionId"],
                artifact_id=step["promptArtifactId"],
                text=(self.release.payloads.get(step["contentHash"]) or b"").decode("utf-8"),
                run_ref=mint_run_ref(RunRefFacts(self._agent_id, self._target, run_id, (_entry(tag=slot["tag"], artifact_id=step["promptArtifactId"], version_id=step["promptVersionId"], model=slot["model"], arm=resolved.arm, bucket=resolved.bucket, run_minute=run_minute, audience_ids=audience_ids),)), self._run_ref_key),
                audience_ids=audience_ids, run_minute=run_minute,
                inference=copy_inference(step.get("inference")),
                model=slot["model"],
            )
            for step in ordered_steps(slot["tag"], slot["steps"])
        ]
        return Workflow(model=slot["model"], arm=resolved.arm, steps=steps, variables=list(slot.get("variables", [])))
