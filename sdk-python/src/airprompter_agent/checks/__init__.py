"""Declared output checks (T29 / 5-E, checks.md): deterministic, on the host, on the output the SDK already sees;
the result is two counters on the window (``checks.passed`` / ``checks.failed``) and never leaves the process. A
port of ``conformance/checks.mjs``; ``vectors/checks.json`` pins the two.

Regex safety rule: RE2-class syntax only — no backreferences, no lookaround, no atomic or possessive groups, no
quantified group whose body is itself quantified — patterns of at most 256 characters, and an output over 64 KiB
fails a pattern check closed rather than being scanned in part.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Mapping, Optional, Sequence

CHECK_BOUNDS = {
    "maxChecks": 8,
    "nameMaxLength": 64,
    "patternMaxLength": 256,
    "subjectMaxBytes": 65536,
    "schemaMaxBytes": 16384,
    "enumMaxValues": 64,
    "enumValueMaxLength": 128,
    "pathMaxLength": 128,
    "maxTokens": 1_000_000,
}

_NAME = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
_COUNTED = re.compile(r"^\{\d+(?:,\d*)?\}")
_GROUP_QUANTIFIER = re.compile(r"^(?:[*+?]|\{\d+(?:,\d*)?\})")


def utf8_bytes(text: str) -> int:
    return len(text.encode("utf-8"))


def estimate_tokens(text: str) -> int:
    """ceil(bytes / 4): the estimate when the provider reported no output tokens."""
    return math.ceil(utf8_bytes(text) / 4)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def pattern_refusal(pattern: Any) -> Optional[str]:
    """Why a pattern is refused, or None when it is RE2-class and inside the cap."""
    if not isinstance(pattern, str) or pattern == "":
        return "empty"
    if len(pattern) > CHECK_BOUNDS["patternMaxLength"]:
        return "too_long"
    if re.search(r"\\[1-9]", pattern) or "\\k<" in pattern:
        return "backreference"
    if re.search(r"\(\?<?[=!]", pattern):
        return "lookaround"
    if "(?>" in pattern or re.search(r"[*+?}]\+", pattern):
        return "possessive_or_atomic"
    depth = 0
    bodies: list[dict[str, bool]] = []
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "[":
            j = i + 1
            if j < n and pattern[j] == "^":
                j += 1
            if j < n and pattern[j] == "]":
                j += 1
            while j < n and pattern[j] != "]":
                if pattern[j] == "\\":
                    j += 1
                j += 1
            i = j + 1
            continue
        if ch == "(":
            depth += 1
            bodies.append({"quantified": False})
            i += 1
            continue
        if ch == ")":
            body = bodies.pop() if bodies else None
            depth -= 1
            group_quantified = _GROUP_QUANTIFIER.match(pattern[i + 1 :]) is not None
            if group_quantified and body is not None and body["quantified"]:
                return "nested_quantifier"
            if group_quantified and bodies:
                bodies[-1]["quantified"] = True
            i += 1
            continue
        if ch == "{":
            counted = _COUNTED.match(pattern[i:])
            if counted is None:
                return "invalid"
            if bodies:
                bodies[-1]["quantified"] = True
            i += len(counted.group(0))
            continue
        if ch == "}":
            return "invalid"
        if ch in "*+" and bodies:
            bodies[-1]["quantified"] = True
        i += 1
    if depth != 0:
        return "unbalanced"
    try:
        re.compile(pattern, re.ASCII)
    except re.error:
        return "invalid"
    return None


def _schema_pattern_refusal(schema: Any) -> Optional[str]:
    if isinstance(schema, list):
        for entry in schema:
            bad = _schema_pattern_refusal(entry)
            if bad:
                return bad
        return None
    if not isinstance(schema, Mapping):
        return None
    for key, value in schema.items():
        if key == "pattern" and isinstance(value, str):
            bad = pattern_refusal(value)
            if bad:
                return bad
            continue
        bad = _schema_pattern_refusal(value)
        if bad:
            return bad
    return None


def check_refusal(check: Any) -> Optional[str]:
    """Why a declared check is refused, or None when it is well-formed."""
    if not isinstance(check, Mapping):
        return "not_an_object"
    name = check.get("name")
    if not isinstance(name, str) or not _NAME.match(name) or len(name) > CHECK_BOUNDS["nameMaxLength"]:
        return "bad_name"
    kind = check.get("kind")
    if kind == "json_schema":
        schema = check.get("schema")
        if not isinstance(schema, Mapping):
            return "schema_not_an_object"
        if utf8_bytes(json.dumps(schema, separators=(",", ":"), ensure_ascii=False)) > CHECK_BOUNDS["schemaMaxBytes"]:
            return "schema_too_large"
        bad = _schema_pattern_refusal(schema)
        return f"schema_pattern_{bad}" if bad else None
    if kind == "enum":
        path = check.get("path")
        if not isinstance(path, str) or len(path) > CHECK_BOUNDS["pathMaxLength"]:
            return "bad_path"
        values = check.get("values")
        if not isinstance(values, list) or len(values) == 0 or len(values) > CHECK_BOUNDS["enumMaxValues"]:
            return "bad_values"
        if not all(isinstance(v, str) and 0 < len(v) <= CHECK_BOUNDS["enumValueMaxLength"] for v in values):
            return "bad_values"
        if len(set(values)) != len(values):
            return "duplicate_values"
        return None
    if kind == "length":
        lo = check.get("minTokens")
        hi = check.get("maxTokens")

        def ok_int(v: Any) -> bool:
            return _is_int(v) and 0 <= v <= CHECK_BOUNDS["maxTokens"]

        if lo is None and hi is None:
            return "no_bound"
        if lo is not None and not ok_int(lo):
            return "bad_bound"
        if hi is not None and not ok_int(hi):
            return "bad_bound"
        if lo is not None and hi is not None and lo > hi:
            return "inverted_bounds"
        return None
    if kind in ("must_match", "must_not_match"):
        refusal = pattern_refusal(check.get("pattern"))
        if refusal:
            return f"pattern_{refusal}"
        flags = check.get("flags")
        if flags is not None and flags != "i":
            return "bad_flags"
        return None
    return "unknown_kind"


def checks_refusals(checks: Any) -> list[dict[str, Any]]:
    """Every refusal of a declared list; empty when all pass."""
    refusals: list[dict[str, Any]] = []
    if not isinstance(checks, list):
        return [{"name": None, "reason": "not_a_list"}]
    if len(checks) > CHECK_BOUNDS["maxChecks"]:
        refusals.append({"name": None, "reason": "too_many"})
    names: set[str] = set()
    for check in checks:
        reason = check_refusal(check)
        name = check.get("name") if isinstance(check, Mapping) and isinstance(check.get("name"), str) else None
        if reason:
            refusals.append({"name": name, "reason": reason})
        if name is not None:
            if name in names:
                refusals.append({"name": name, "reason": "duplicate_name"})
            names.add(name)
    return refusals


def _parse_json(text: str) -> tuple[bool, Any]:
    try:
        return True, json.loads(text)
    except ValueError:
        starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
        start = min(starts) if starts else -1
        end = max(text.rfind("}"), text.rfind("]"))
        if start < 0 or end <= start:
            return False, None
        try:
            return True, json.loads(text[start : end + 1])
        except ValueError:
            return False, None


def _type_of(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "integer" if value.is_integer() else "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, Mapping):
        return "object"
    return "unknown"


def _canon(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def validate_json_schema(schema: Any, value: Any) -> bool:
    """The JSON Schema subset checks.md names; unknown keywords are ignored."""
    if not isinstance(schema, Mapping):
        return True
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        actual = _type_of(value)
        if not any(t == actual or (t == "number" and actual == "integer") for t in types):
            return False
    if isinstance(schema.get("enum"), list) and not any(_canon(v) == _canon(value) for v in schema["enum"]):
        return False
    if "const" in schema and _canon(schema["const"]) != _canon(value):
        return False
    if isinstance(schema.get("anyOf"), list) and not any(validate_json_schema(sub, value) for sub in schema["anyOf"]):
        return False
    if isinstance(value, str):
        length = len(value)
        if isinstance(schema.get("minLength"), (int, float)) and length < schema["minLength"]:
            return False
        if isinstance(schema.get("maxLength"), (int, float)) and length > schema["maxLength"]:
            return False
        pattern = schema.get("pattern")
        if isinstance(pattern, str):
            if pattern_refusal(pattern) or utf8_bytes(value) > CHECK_BOUNDS["subjectMaxBytes"]:
                return False
            if re.search(pattern, value, re.ASCII) is None:
                return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(schema.get("minimum"), (int, float)) and value < schema["minimum"]:
            return False
        if isinstance(schema.get("maximum"), (int, float)) and value > schema["maximum"]:
            return False
    if isinstance(value, list):
        if isinstance(schema.get("minItems"), (int, float)) and len(value) < schema["minItems"]:
            return False
        if isinstance(schema.get("maxItems"), (int, float)) and len(value) > schema["maxItems"]:
            return False
        if "items" in schema and not all(validate_json_schema(schema["items"], item) for item in value):
            return False
    if isinstance(value, Mapping):
        properties = schema.get("properties") if isinstance(schema.get("properties"), Mapping) else {}
        for key in schema.get("required", []) if isinstance(schema.get("required"), list) else []:
            if key not in value:
                return False
        for key, sub in properties.items():
            if key in value and not validate_json_schema(sub, value[key]):
                return False
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    return False
    return True


def value_at_path(value: Any, path: str) -> tuple[bool, Any]:
    """A dotted path into parsed JSON; "" is the whole value."""
    if path == "":
        return True, value
    current = value
    for part in path.split("."):
        if isinstance(current, list) and part.isdigit():
            index = int(part)
            if index >= len(current):
                return False, None
            current = current[index]
        elif isinstance(current, Mapping) and part in current:
            current = current[part]
        else:
            return False, None
    return True, current


def evaluate_check(check: Mapping[str, Any], text: Any, output_tokens: Optional[int]) -> dict[str, Any]:
    """One check on one output; never raises. ``output_tokens`` None = estimate."""
    text = text if isinstance(text, str) else ""
    kind = check.get("kind")
    name = check.get("name")

    def fail(reason: str) -> dict[str, Any]:
        return {"name": name, "kind": kind, "verdict": "fail", "reason": reason}

    def passed() -> dict[str, Any]:
        return {"name": name, "kind": kind, "verdict": "pass"}

    if kind == "json_schema":
        ok, value = _parse_json(text)
        if not ok:
            return fail("not_json")
        return passed() if validate_json_schema(check.get("schema"), value) else fail("schema_mismatch")
    if kind == "enum":
        path = check.get("path", "")
        if path == "":
            trimmed = text.strip()
            ok, value = _parse_json(trimmed)
            candidate: Any = value if ok and isinstance(value, str) else trimmed
        else:
            ok, value = _parse_json(text)
            if not ok:
                return fail("not_json")
            found, candidate = value_at_path(value, path)
            if not found:
                return fail("path_missing")
        if not isinstance(candidate, str):
            return fail("not_a_string")
        return passed() if candidate in check.get("values", []) else fail("not_in_enum")
    if kind == "length":
        tokens = output_tokens if _is_int(output_tokens) and output_tokens >= 0 else estimate_tokens(text)
        if check.get("minTokens") is not None and tokens < check["minTokens"]:
            return fail("too_short")
        if check.get("maxTokens") is not None and tokens > check["maxTokens"]:
            return fail("too_long")
        return passed()
    if kind in ("must_match", "must_not_match"):
        pattern = check.get("pattern")
        if pattern_refusal(pattern):
            return fail("pattern_refused")
        if utf8_bytes(text) > CHECK_BOUNDS["subjectMaxBytes"]:
            return fail("subject_too_long")
        flags = re.ASCII | (re.IGNORECASE if check.get("flags") == "i" else 0)
        matched = re.search(pattern, text, flags) is not None
        if kind == "must_match":
            return passed() if matched else fail("no_match")
        return fail("matched") if matched else passed()
    return fail("unknown_kind")


def evaluate_checks(checks: Optional[Sequence[Mapping[str, Any]]], text: Any, output_tokens: Optional[int] = None) -> dict[str, Any]:
    """Every enabled check on one output: the window's counters and the per-check results."""
    results = [evaluate_check(check, text, output_tokens) for check in (checks or []) if not (isinstance(check, Mapping) and check.get("enabled") is False)]
    return {
        "passed": sum(1 for r in results if r["verdict"] == "pass"),
        "failed": sum(1 for r in results if r["verdict"] == "fail"),
        "results": results,
    }


def project_checks(checks: Optional[Sequence[Mapping[str, Any]]]) -> list[dict[str, Any]]:
    """The pin / manifest projection: enabled checks only, sorted by name, the kind's own members only."""
    projected: list[dict[str, Any]] = []
    for check in checks or []:
        if not isinstance(check, Mapping) or check.get("enabled") is False:
            continue
        kind = check["kind"]
        entry: dict[str, Any] = {"kind": kind, "name": check["name"]}
        if kind == "json_schema":
            entry["schema"] = check["schema"]
        elif kind == "enum":
            entry["path"] = check["path"]
            entry["values"] = list(check["values"])
        elif kind == "length":
            if check.get("minTokens") is not None:
                entry["minTokens"] = check["minTokens"]
            if check.get("maxTokens") is not None:
                entry["maxTokens"] = check["maxTokens"]
        else:
            entry["pattern"] = check["pattern"]
            if check.get("flags"):
                entry["flags"] = check["flags"]
        projected.append(entry)
    return sorted(projected, key=lambda e: e["name"].encode("utf-16-be", "surrogatepass"))


def output_text_of(result: Any) -> Optional[str]:
    """The output text of whatever the provider answered (a string; OpenAI, Anthropic, Bedrock Converse shapes; dicts or SDK objects); None when nothing recognisable."""
    if isinstance(result, str):
        return result

    def get(obj: Any, key: str) -> Any:
        if isinstance(obj, Mapping):
            return obj.get(key)
        return getattr(obj, key, None)

    def parts_text(parts: Any) -> Optional[str]:
        if isinstance(parts, str):
            return parts
        if not isinstance(parts, (list, tuple)):
            return None
        texts = [get(part, "text") for part in parts]
        texts = [t for t in texts if isinstance(t, str)]
        return "".join(texts) if texts else None

    if result is None:
        return None
    choices = get(result, "choices")
    if isinstance(choices, (list, tuple)) and choices:
        message = get(choices[0], "message")
        if message is not None:
            return parts_text(get(message, "content"))
    content = get(result, "content")
    if content is not None:
        return parts_text(content)
    output = get(result, "output")
    if output is not None:
        message = get(output, "message")
        if message is not None:
            return parts_text(get(message, "content"))
    output_text = get(result, "output_text")
    if isinstance(output_text, str):
        return output_text
    return None


__all__ = [
    "CHECK_BOUNDS",
    "check_refusal",
    "checks_refusals",
    "estimate_tokens",
    "evaluate_check",
    "evaluate_checks",
    "output_text_of",
    "pattern_refusal",
    "project_checks",
    "utf8_bytes",
    "validate_json_schema",
    "value_at_path",
]
