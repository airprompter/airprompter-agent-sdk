#!/usr/bin/env python3
"""The Python SDK through the conformance harness's adapter contract (S14).

JSON lines on stdin / stdout: ``{"id", "fn", "args"}`` in, ``{"id", "result"}``
or ``{"id", "error": {"reason", "message"}}`` out. Any language writes one of
these; this one is the proof that the vectors the harness owns are runnable
against an SDK the harness never imports. See ``conformance/ADAPTER.md`` for
the twenty-one operations. Usage::

    node conformance/harness.mjs --adapter-command "python3 examples/conformance-adapter/python/adapter.py"

Needs the SDK importable (``pip install airprompter-agent-core airprompter-agent-telemetry``,
or ``PYTHONPATH`` over the source trees as this repository's CI sets it).
"""
from __future__ import annotations

import base64
import dataclasses
import json
import sys
from typing import Any, Callable

from airprompter_agent_core.checks import checks_refusals, evaluate_checks, pattern_refusal, project_checks
from airprompter_agent_core.protocol.assignment import assign_arm, effective_arms, ordered_steps, ramp_weights_at, validate_ramp
from airprompter_agent_core.protocol.canonical_json import canonical_json, sha256_prefixed
from airprompter_agent_core.protocol.trust import experiment_conflict, experiment_for_tag, trusted_root_from_pinned_key, verify_manifest, verify_root_metadata
from airprompter_agent_core.telemetry.feedback import normalize_feedback
from airprompter_agent_core.telemetry.rows import epoch_minute, latency_bucket_index, minute_of
from airprompter_agent_telemetry.otel import spool_rows_to_otlp
from airprompter_agent_telemetry.spool.writer import MemorySink, Observation, SegmentPlanner, SpoolWriter, WriterIdentity, segment_name


def _plain(value: Any) -> Any:
    """Dataclasses and tuples as JSON; the wire names are the protocol's camelCase."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {_camel(k): _plain(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.capitalize() for part in rest)


def _verdict(v: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": v.ok}
    if v.reason is not None:
        out["reason"] = v.reason
    if getattr(v, "signing_key_id", None) is not None:
        out["signingKeyId"] = v.signing_key_id
    if getattr(v, "generation", None) is not None:
        out["generation"] = v.generation
    return out


def op_canonical_json(a: dict) -> dict:
    text = canonical_json(json.loads(a["json"]))
    return {"text": text, "sha256": sha256_prefixed(text.encode("utf-8"))}


def op_ordered_steps(a: dict) -> dict:
    return {"order": [s["stepId"] for s in ordered_steps(a["slotTag"], a["steps"])]}


def op_assign_arm(a: dict) -> dict:
    r = assign_arm(salt=a["salt"], subject=a["subject"], arms=a["arms"])
    arm = r.arm["arm"] if isinstance(r.arm, dict) else r.arm
    return {"subjectHash": r.subject_hash, "bucket": r.bucket, "arm": arm}


def op_experiment_for_tag(a: dict) -> dict:
    return {"experiment": experiment_for_tag(a["payload"], a["tag"])}


def op_experiment_conflict(a: dict) -> dict:
    return {"reason": experiment_conflict(a["payload"])}


def op_validate_ramp(a: dict) -> dict:
    validate_ramp(a["ramp"], a["armCount"])
    return {"ok": True}


def op_ramp_weights_at(a: dict) -> dict:
    return {"weightBps": ramp_weights_at(a["arms"], a["ramp"], a["nowMs"])}


def op_effective_arms(a: dict) -> dict:
    return {"arms": effective_arms(arms=a["arms"], ramp=a.get("ramp"), disabled_arms=set(a.get("disabledArms") or []), now_ms=a["nowMs"])}


def op_verify_root_metadata(a: dict) -> dict:
    trusted = a.get("trusted") or trusted_root_from_pinned_key(purpose=a["pinned"]["purpose"], environment=a["pinned"]["environment"], pinned_root=a["pinned"]["pinnedRoot"])
    return _verdict(verify_root_metadata(candidate=a["candidate"], trusted=trusted, now=a["now"]))


def op_verify_manifest(a: dict) -> dict:
    payloads = {p["contentHash"]: base64.urlsafe_b64decode(p["bytes"] + "=" * (-len(p["bytes"]) % 4)) for p in a["payloads"]} if a.get("payloads") is not None else None
    return _verdict(verify_manifest(manifest=a["manifest"], root=a["root"], now=a["now"], scope=a["scope"], stored_generation=a["storedGeneration"], payloads=payloads, countersign_root=a.get("countersignRoot"), require_countersign=bool(a.get("requireCountersign"))))


def op_latency_bucket_index(a: dict) -> dict:
    return {"bucket": latency_bucket_index(a["latencyMs"])}


def op_minute_of(a: dict) -> dict:
    return {"minute": minute_of(a["epochMs"]), "epochMinute": epoch_minute(a["epochMs"])}


def op_segment_name(a: dict) -> dict:
    return {"name": segment_name(a["instanceId"], epoch_minute(a["epochMs"]), a["n"])}


def op_plan_segments(a: dict) -> dict:
    planner = SegmentPlanner(a["instanceId"])
    plan = []
    for step in a["appends"]:
        segment, rotated = planner.append(step["epochMs"], step["lineBytes"])
        plan.append({"segment": segment, "rotated": rotated})
    return {"plan": plan}


def op_aggregate_windows(a: dict) -> dict:
    sink = MemorySink()
    writer = SpoolWriter(sink, WriterIdentity(a["instanceId"], a["instanceClass"], a["sdk"]))
    for event in a["events"]:
        if event["kind"] == "observe":
            writer.observe(Observation.from_wire(event["observation"]), event["at"])
        elif event["kind"] == "feedback":
            fb = event["feedback"]
            writer.outcomes(tag=fb["tag"], version_id=fb["versionId"], arm=fb["arm"], model=fb["model"], outcomes=fb["outcomes"], at_ms=event["at"])
        elif event["kind"] == "close":
            writer.close_windows(event["at"])
    return {"windows": [row for row in sink.drain() if row["type"] == "window"]}


def op_normalize_feedback(a: dict) -> dict:
    return {"normalized": _plain(normalize_feedback(a["signals"]))}


def op_evaluate_checks(a: dict) -> dict:
    return {"evaluation": evaluate_checks(a["checks"], a["input"]["text"], a["input"].get("outputTokens"))}


def op_pattern_refusal(a: dict) -> dict:
    return {"refusal": pattern_refusal(a["pattern"])}


def op_checks_refusals(a: dict) -> dict:
    return {"refusals": checks_refusals(a["checks"])}


def op_project_checks(a: dict) -> dict:
    return {"projected": project_checks(a["checks"])}


def op_spool_rows_to_otlp(a: dict) -> dict:
    return {"request": spool_rows_to_otlp(a["rows"], resource=a.get("resource"), sdk_version=a.get("sdkVersion") or "0.1.0")}


OPS: dict[str, Callable[[dict], dict]] = {
    "canonicalJson": op_canonical_json,
    "orderedSteps": op_ordered_steps,
    "assignArm": op_assign_arm,
    "experimentForTag": op_experiment_for_tag,
    "experimentConflict": op_experiment_conflict,
    "validateRamp": op_validate_ramp,
    "rampWeightsAt": op_ramp_weights_at,
    "effectiveArms": op_effective_arms,
    "verifyRootMetadata": op_verify_root_metadata,
    "verifyManifest": op_verify_manifest,
    "latencyBucketIndex": op_latency_bucket_index,
    "minuteOf": op_minute_of,
    "segmentName": op_segment_name,
    "planSegments": op_plan_segments,
    "aggregateWindows": op_aggregate_windows,
    "normalizeFeedback": op_normalize_feedback,
    "evaluateChecks": op_evaluate_checks,
    "patternRefusal": op_pattern_refusal,
    "checksRefusals": op_checks_refusals,
    "projectChecks": op_project_checks,
    "spoolRowsToOtlp": op_spool_rows_to_otlp,
}


def answer(message: dict) -> dict:
    fn = message.get("fn")
    if fn == "capabilities":
        return {"id": message.get("id"), "result": {"ops": sorted(OPS)}}
    op = OPS.get(fn or "")
    if op is None:
        return {"id": message.get("id"), "error": {"reason": "unsupported", "message": f"{fn} is not implemented"}}
    try:
        return {"id": message.get("id"), "result": _plain(op(message.get("args") or {}))}
    except Exception as error:  # noqa: BLE001 — a refusal the protocol names travels as its reason
        reason = getattr(error, "reason", None)
        return {"id": message.get("id"), "error": {"reason": reason if isinstance(reason, str) else "error", "message": str(error)}}


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        sys.stdout.write(json.dumps(answer(message), separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
