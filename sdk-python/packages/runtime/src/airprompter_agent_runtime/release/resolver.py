"""The runtime over a verified release (S10): which slot a subject gets, under which arm — the signed ramp plan walked
on this host's clock (S9), a disabled arm's share handed to the control, a disabled agent or slot refused — and the
rendered text with its run reference. Pure over a ``LoadedRelease``: the slot store, a daemon, and a bundle the
customer loaded all look the same from here, and nothing here touches a file, a socket or a clock it was not handed.

The lease, the spool's refusal rows and the daemon's contact are the facade's (``airprompter_agent``): this class
says *what* would be refused and why; the facade decides what to record."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional, Sequence

from airprompter_agent_core.protocol.assignment import assign_arm, effective_arms, ordered_steps
from airprompter_agent_core.protocol.trust import experiment_for_tag, experiments_of
from airprompter_agent_core.release.reader import LoadedRelease, ReleaseSlot
from airprompter_agent_core.render.run_ref import RunRefFacts, mint_run_ref
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
    arm: str
    generation: int
    run_ref: str
    tag: str
    #: 0.3.1: how the model is called for this slot, as the version declared it — the wrappers apply it.
    inference: Optional[Mapping[str, Any]] = None


@dataclass(frozen=True)
class WorkflowStep:
    step_id: str
    ordinal: int
    version_id: str
    text: str
    run_ref: str
    #: 0.3.2: how the model is called for this step, as its prompt version declared it — the wrappers apply it.
    inference: Optional[Mapping[str, Any]] = None
    #: The workflow's pinned model (every step runs on it); the settings above are for it.
    model: Optional[str] = None


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
    #: Arm names disabled by directives that name no experiment (the legacy single experiment).
    arms: list[str] = field(default_factory=list)
    #: S16: arm names disabled per experiment id; a directive without an id counts for every experiment.
    arms_by_experiment: dict[str, list[str]] = field(default_factory=dict)

    def arms_for(self, experiment_id: str) -> set[str]:
        """S16: the arms disabled for one experiment — those named with its id, plus any named without one."""
        return {*self.arms, *self.arms_by_experiment.get(experiment_id, [])}

    def as_dict(self) -> dict[str, Any]:
        """The heartbeat's shape: agent / slots / arms, every disabled arm name flattened."""
        flat = [*self.arms, *[arm for arms in self.arms_by_experiment.values() for arm in arms]]
        return {"agent": self.agent, "slots": list(self.slots), "arms": flat}


@dataclass(frozen=True)
class ResolveOutcome:
    """``ok`` with the slot, or a refusal as data: ``reason`` is "disabled" or "no_slot"; ``tag`` is None when the whole
    agent is disabled."""

    ok: bool
    slot: Optional[ReleaseSlot] = None
    reason: Optional[str] = None
    tag: Optional[str] = None


def disabled_from(directives: Sequence[Mapping[str, Any]]) -> Disabled:
    """What ``disable`` directives say, as data."""
    slots: list[str] = []
    arms: list[str] = []
    arms_by_experiment: dict[str, list[str]] = {}
    agent = False
    for directive in directives:
        if directive.get("kind") != "disable":
            continue
        if directive.get("scope") == "agent":
            agent = True
        elif directive.get("scope") == "arm" and directive.get("arm"):
            if directive.get("experimentId"):
                arms_by_experiment.setdefault(str(directive["experimentId"]), []).append(str(directive["arm"]))
            else:
                arms.append(str(directive["arm"]))
        elif directive.get("tag"):
            slots.append(str(directive["tag"]))
    return Disabled(agent=agent, slots=slots, arms=arms, arms_by_experiment=arms_by_experiment)


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
    ):
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
        """S16: every experiment this release carries — one per slot, or the legacy single one."""
        return experiments_of(self._payload)

    def experiment_for(self, tag: str) -> Mapping[str, Any] | None:
        """S16: the experiment that decides a slot, by tag — the entry naming it, else the legacy single one, else None."""
        return experiment_for_tag(self._payload, tag)

    def arms(self, experiment_or_tag: Mapping[str, Any] | str | None = None) -> list[dict[str, Any]] | None:
        """S9: an experiment's arms as they stand now — the signed plan walked on this host's clock, then any disabled
        arm's share handed to the control. None when there is no such experiment, or when every arm is disabled (a
        freeze for that slot). Without an argument: the legacy single experiment, or the first of ``experiments[]``."""
        if isinstance(experiment_or_tag, str):
            experiment = self.experiment_for(experiment_or_tag)
        elif experiment_or_tag is not None:
            experiment = experiment_or_tag
        else:
            listed = self.experiments()
            experiment = listed[0] if listed else None
        if not experiment:
            return None
        disabled = self.disabled().arms_for(str(experiment.get("experimentId")))
        return effective_arms(arms=experiment["arms"], ramp=experiment.get("ramp"), disabled_arms=disabled, now_ms=self._now_ms())

    def resolve(self, tag: str, subject: Optional[str] = None) -> ResolveOutcome:
        """The slot a subject gets for a tag, or why not. Refusals are data: the facade records them."""
        payload = self._payload
        disabled = self.disabled()
        if disabled.agent:
            return ResolveOutcome(False, reason="disabled", tag=None)
        if tag in disabled.slots:
            return ResolveOutcome(False, reason="disabled", tag=tag)
        slot = next((entry for entry in payload["slots"] if entry["tag"] == tag), None)
        if slot is None:
            return ResolveOutcome(False, reason="no_slot", tag=tag)
        # S16: the experiment for this slot — its own salt and arms, so two slots split independently.
        experiment = self.experiment_for(tag)
        if not experiment:
            return ResolveOutcome(True, ReleaseSlot(slot, "none", None))
        subject_value = self._instance_id if experiment.get("subjectKey") == "instance" or subject is None else subject
        arms = self.arms(experiment)
        if arms is None:
            return ResolveOutcome(False, reason="disabled", tag=tag)
        assigned = assign_arm(salt=experiment["salt"], subject=subject_value, arms=arms)
        override = next((entry for entry in assigned.arm.get("overrides", []) if entry["tag"] == tag), None)
        return ResolveOutcome(True, ReleaseSlot(override or slot, str(assigned.arm["arm"]), assigned.bucket))

    def text_of(self, slot: Mapping[str, Any]) -> str:
        """A slot's verified payload as text."""
        data = self.release.payloads.get(slot["contentHash"])
        if data is None:
            raise KeyError(f"payload {slot['contentHash']} not loaded")
        return data.decode("utf-8")

    def render(self, resolved: ReleaseSlot, values: Optional[Mapping[str, Any]] = None) -> Rendered:
        """Render a prompt slot the resolver already resolved."""
        slot = resolved.slot
        generation = self.release.generation
        text = render_template(tag=slot["tag"], text=self.text_of(slot), variables=slot.get("variables", []), values=dict(values or {}), delimiters=self._delimiters)
        facts = RunRefFacts(self._agent_id, self._target, slot["tag"], slot["versionId"], resolved.arm, generation, resolved.bucket)
        return Rendered(text=text, model=slot["model"], version_id=slot["versionId"], arm=resolved.arm, generation=generation, run_ref=mint_run_ref(facts, self._run_ref_key), tag=slot["tag"], inference=copy_inference(slot.get("inference")))

    def workflow(self, resolved: ReleaseSlot) -> Workflow:
        """A workflow slot's steps in ordinal order, each with its prompt text and run reference."""
        slot = resolved.slot
        if slot.get("kind") != "workflow" or not slot.get("steps"):
            raise ValueError(f"{slot['tag']} is not a workflow slot")
        generation = self.release.generation
        steps = [
            WorkflowStep(
                step_id=step["stepId"],
                ordinal=step["ordinal"],
                version_id=step["promptVersionId"],
                text=(self.release.payloads.get(step["contentHash"]) or b"").decode("utf-8"),
                run_ref=mint_run_ref(RunRefFacts(self._agent_id, self._target, step["stepId"], step["promptVersionId"], resolved.arm, generation, resolved.bucket), self._run_ref_key),
                inference=copy_inference(step.get("inference")),
                model=slot["model"],
            )
            for step in ordered_steps(slot["tag"], slot["steps"])
        ]
        return Workflow(model=slot["model"], arm=resolved.arm, steps=steps, variables=list(slot.get("variables", [])))
