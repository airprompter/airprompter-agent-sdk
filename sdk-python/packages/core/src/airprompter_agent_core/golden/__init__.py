"""Golden sets (T34, 5-D): known inputs with the properties a right answer has,
run against the pinned model on the customer's own key before a staged
release activates (``protocol/golden-sets.md``).

The set is a payload the manifest slot references (``goldenSet.contentHash``),
encrypted at rest like the prompt it exercises. Each case is a set of variable
values and a list of expectations in the output-check grammar (checks.md), so
the same evaluator the runtime already runs inside ``observe()`` decides a
case. The customer supplies the model call (``invoke``); nothing here talks to
a provider. Only counts leave the host: ``goldenPass`` on the arm's window,
one per case, and the apply decision.
"""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional, Sequence, Union

from ..checks import estimate_tokens, evaluate_checks
from ..protocol.trust import experiments_of
from ..render.template import Delimiters, render_template

GOLDEN_SET_FORMAT = "airprompter-golden-set"
GOLDEN_SET_VERSION = 1
GOLDEN_MAX_CASES = 50
GOLDEN_MAX_EXPECTATIONS = 8
#: Cases run this many at a time by default; the customer's rate limits are the real bound.
GOLDEN_DEFAULT_CONCURRENCY = 4

_CASE_ID = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
_VARIABLE_NAME = re.compile(r"^[a-zA-Z0-9_.-]{1,64}$")


class GoldenSetError(Exception):
    """The payload is not a golden set: ``reason`` is one of not_json, not_a_golden_set, case_invalid, reference_mismatch."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def parse_golden_set(data: bytes, reference: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """The payload's bytes as a set: shape only (the checks themselves are validated when evaluated)."""
    try:
        doc = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise GoldenSetError("not_json", "golden set payload is not JSON") from error
    if not isinstance(doc, dict) or doc.get("format") != GOLDEN_SET_FORMAT or doc.get("version") != GOLDEN_SET_VERSION or not isinstance(doc.get("setId"), str) or not isinstance(doc.get("cases"), list):
        raise GoldenSetError("not_a_golden_set", "golden set payload has the wrong shape")
    floor = doc.get("minPassBps")
    if not isinstance(floor, int) or isinstance(floor, bool) or floor < 0 or floor > 10000:
        raise GoldenSetError("not_a_golden_set", "minPassBps is not in 0…10000")
    cases = doc["cases"]
    if len(cases) < 1 or len(cases) > GOLDEN_MAX_CASES:
        raise GoldenSetError("not_a_golden_set", f"a golden set carries 1…{GOLDEN_MAX_CASES} cases")
    seen: set[str] = set()
    for entry in cases:
        case_id = entry.get("caseId") if isinstance(entry, dict) else None
        if not isinstance(case_id, str) or not _CASE_ID.match(case_id) or case_id in seen:
            raise GoldenSetError("case_invalid", "a case id is missing, malformed or repeated")
        seen.add(case_id)
        variables = entry.get("variables")
        if not isinstance(variables, dict):
            raise GoldenSetError("case_invalid", f"{case_id}: variables is not an object")
        for name, value in variables.items():
            if not isinstance(name, str) or not _VARIABLE_NAME.match(name) or not isinstance(value, str):
                raise GoldenSetError("case_invalid", f"{case_id}: variable {name} is not a named string")
        expect = entry.get("expect")
        if not isinstance(expect, list) or len(expect) < 1 or len(expect) > GOLDEN_MAX_EXPECTATIONS:
            raise GoldenSetError("case_invalid", f"{case_id}: 1…{GOLDEN_MAX_EXPECTATIONS} expectations")
        names: set[str] = set()
        for check in expect:
            name = check.get("name") if isinstance(check, dict) else None
            if not isinstance(name, str) or not isinstance(check.get("kind"), str) or name in names:
                raise GoldenSetError("case_invalid", f"{case_id}: an expectation is missing its kind or name, or repeats a name")
            names.add(name)
    if reference is not None and (reference.get("setId") != doc["setId"] or reference.get("cases") != len(cases)):
        raise GoldenSetError("reference_mismatch", f"the manifest names {reference.get('setId')} with {reference.get('cases')} cases; the payload is {doc['setId']} with {len(cases)}")
    return doc


@dataclass(frozen=True)
class GoldenInvocation:
    """What the customer's model call receives: the rendered prompt and the facts around it. Never stored by the SDK."""

    tag: str
    case_id: str
    #: The slot's text rendered with the case's variables — the prompt the pinned model is asked.
    text: str
    model: str
    arm: str
    variables: Mapping[str, str]
    #: 0.3.1: the slot's inference settings — the call is made as production makes it, or the gate measures something else.
    inference: Optional[Mapping[str, Any]] = None


#: The customer's model call: the output text, or ``{"text": …, "output_tokens": …}`` (a length band uses the count).
GoldenInvoke = Callable[[GoldenInvocation], Union[str, Mapping[str, Any]]]


@dataclass
class GoldenCaseResult:
    case_id: str
    ok: bool
    #: The expectations that failed, by name — never the output.
    failed: list[str] = field(default_factory=list)
    #: Set when the case could not be rendered or the model call raised; counted as a failure.
    error: Optional[str] = None


@dataclass
class GoldenReport:
    tag: str
    arm: str
    set_id: str
    model: str
    cases: int
    passed: int
    failed: int
    #: floor(passed / cases × 10000).
    pass_bps: int
    min_pass_bps: int
    #: pass_bps ≥ min_pass_bps.
    meets_threshold: bool
    results: list[GoldenCaseResult] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {"tag": self.tag, "arm": self.arm, "cases": self.cases, "passed": self.passed, "minPassBps": self.min_pass_bps}


def pass_bps_of(passed: int, cases: int) -> int:
    return (passed * 10000) // cases if cases > 0 else 0


def run_golden_set(
    *,
    slot: Mapping[str, Any],
    arm: str,
    text: str,
    golden_set: Mapping[str, Any],
    invoke: GoldenInvoke,
    concurrency: Optional[int] = None,
    delimiters: Optional[Delimiters] = None,
    on_case: Optional[Callable[[GoldenCaseResult], None]] = None,
) -> GoldenReport:
    """Run every case: render the slot's text with the case's variables (the same fencing as ``prompt().render()``), ask
    the customer's model, evaluate the case's expectations on the answer. A case whose render or call raises counts as
    failed with the error's class (never its text). Cases run ``concurrency`` at a time."""
    cases: Sequence[Mapping[str, Any]] = golden_set["cases"]

    def one(entry: Mapping[str, Any]) -> GoldenCaseResult:
        try:
            rendered = render_template(tag=slot["tag"], text=text, variables=slot.get("variables", []), values=entry["variables"], delimiters=delimiters)
            answer = invoke(GoldenInvocation(tag=slot["tag"], case_id=entry["caseId"], text=rendered, model=slot["model"], arm=arm, variables=entry["variables"], inference=slot.get("inference")))
            if isinstance(answer, str):
                output_text, output_tokens = answer, None
            else:
                output_text = str(answer.get("text", ""))
                tokens = answer.get("output_tokens", answer.get("outputTokens"))
                output_tokens = tokens if isinstance(tokens, int) and not isinstance(tokens, bool) else None
            outcome = evaluate_checks(entry["expect"], output_text, output_tokens if output_tokens is not None else estimate_tokens(output_text))
            failed = [r["name"] for r in outcome["results"] if r["verdict"] == "fail"]
            result = GoldenCaseResult(case_id=entry["caseId"], ok=not failed, failed=failed)
        except Exception as error:  # noqa: BLE001 — a class of failure is reported, never the text
            result = GoldenCaseResult(case_id=entry["caseId"], ok=False, error=type(error).__name__)
        if on_case:
            on_case(result)
        return result

    width = max(1, min(concurrency or GOLDEN_DEFAULT_CONCURRENCY, len(cases)))
    if width == 1:
        results = [one(entry) for entry in cases]
    else:
        with ThreadPoolExecutor(max_workers=width) as pool:
            results = list(pool.map(one, cases))
    passed = sum(1 for r in results if r.ok)
    bps = pass_bps_of(passed, len(results))
    return GoldenReport(
        tag=slot["tag"],
        arm=arm,
        set_id=golden_set["setId"],
        model=slot["model"],
        cases=len(results),
        passed=passed,
        failed=len(results) - passed,
        pass_bps=bps,
        min_pass_bps=golden_set["minPassBps"],
        meets_threshold=bps >= golden_set["minPassBps"],
        results=results,
    )


def golden_reports_meet(reports: Sequence[GoldenReport]) -> bool:
    """The runtime's decision over every report of a staged release: all thresholds met. No reports meets."""
    return all(report.meets_threshold for report in reports)


def manifest_has_golden(manifest: Mapping[str, Any]) -> bool:
    payload = manifest["payload"]
    if any(slot.get("goldenSet") for slot in payload.get("slots", [])):
        return True
    return any(override.get("goldenSet") for experiment in experiments_of(payload) for arm in experiment.get("arms", []) for override in arm.get("overrides", []))
