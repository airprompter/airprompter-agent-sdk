"""The trust chain (``protocol/trust-chain.md``): thumbprints, ES256 over
canonical bytes, root-metadata acceptance R1–R5 and manifest verification
M1–M12. Pure over its inputs; ``now`` is always passed in. This is what
decides whether bytes go live, so it never reads the network or the disk.

Example::

    trusted = trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=pinned_jwk)   # the ROOT alone; signing keys come with the root document
    if verify_root_metadata(candidate=fetched_root, trusted=trusted, now=now_iso).ok:                    # R1–R5, else root_rollback, root_expired …
        trusted = fetched_root
    verdict = verify_manifest(manifest=manifest, root=trusted, now=now_iso, scope=scope, stored_generation=held_generation, payloads=payloads)   # M1–M12
    if not verdict.ok:
        refuse(verdict.reason)   # "unknown_signing_key", "generation_rollback", "payload_hash_mismatch" …
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Optional, overload

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature

from .._util import b64url_decode, b64url_encode, instant
from .assignment import AssignmentError, capabilities_implemented, servable_experiments, servable_overrides, servable_slots, valid_audience_manifest, validate_ramp
from .canonical_json import MAX_SAFE_INTEGER, canonical_bytes, canonical_json, sha256_prefixed

SUPPORTED_PROTOCOL_MAJORS = frozenset({3})
_PROTOCOL_SHAPE = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
_CONTENT_HASH = re.compile(r"sha256:[0-9a-f]{64}")
#: The shape of a stage: the only check a target gets. It feeds store paths and spool directories, so a start refuses anything else.
TARGET_SLUG = re.compile(r"[a-z][a-z0-9-]{0,31}")
#: The grammar of ``agentId``: it names a store directory, so it is checked at the door like ``target``.
AGENT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
#: One AirPrompter deployment: what a platform root belongs to, never an agent's stage.
HostedEnvironment = Literal["dev", "staging", "prod"]
#: S4: the directive kinds a runtime honours. `disable` acts without a local act; `request_unlock` only asks.
DIRECTIVE_KINDS = frozenset({"request_unlock", "disable"})
_SIGNATURE = re.compile(r"^[A-Za-z0-9_-]{86}$")


def key_thumbprint(jwk: Mapping[str, Any]) -> str:
    """RFC 7638: sha256 over canonical {crv, kty, x, y}, lowercase hex."""
    return hashlib.sha256(canonical_json({"crv": jwk["crv"], "kty": jwk["kty"], "x": jwk["x"], "y": jwk["y"]}).encode("utf-8")).hexdigest()


def public_jwk_of(jwk: Mapping[str, Any]) -> dict[str, str]:
    return {"kty": "EC", "crv": "P-256", "x": jwk["x"], "y": jwk["y"]}


def _public_key(jwk: Mapping[str, Any]) -> ec.EllipticCurvePublicKey:
    x = int.from_bytes(b64url_decode(jwk["x"]), "big")
    y = int.from_bytes(b64url_decode(jwk["y"]), "big")
    return ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()


def _private_key(jwk: Mapping[str, Any]) -> ec.EllipticCurvePrivateKey:
    public = ec.EllipticCurvePublicNumbers(int.from_bytes(b64url_decode(jwk["x"]), "big"), int.from_bytes(b64url_decode(jwk["y"]), "big"), ec.SECP256R1())
    return ec.EllipticCurvePrivateNumbers(int.from_bytes(b64url_decode(jwk["d"]), "big"), public).private_key()


def generate_p256_jwk() -> dict[str, str]:
    """A fresh P-256 private JWK (tests, countersign ceremonies run off-box)."""
    key = ec.generate_private_key(ec.SECP256R1())
    numbers = key.private_numbers()
    return {
        "kty": "EC",
        "crv": "P-256",
        "x": b64url_encode(numbers.public_numbers.x.to_bytes(32, "big")),
        "y": b64url_encode(numbers.public_numbers.y.to_bytes(32, "big")),
        "d": b64url_encode(numbers.private_value.to_bytes(32, "big")),
    }


def sign_bytes(data: bytes, private_jwk: Mapping[str, Any]) -> str:
    """ES256, P1363 r‖s, base64url without padding. Local keys only (the platform signs in KMS)."""
    der = _private_key(private_jwk).sign(data, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return b64url_encode(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


def verify_bytes(data: bytes, signature: str, public_jwk: Mapping[str, Any]) -> bool:
    if not _SIGNATURE.match(signature):
        return False
    try:
        raw = b64url_decode(signature)
        if len(raw) != 64:
            return False
        der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
        _public_key(public_jwk).verify(der, data, ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError, KeyError, TypeError):
        return False


@overload
def trusted_root_from_pinned_key(*, purpose: Literal["platform"], environment: HostedEnvironment, pinned_root: Mapping[str, Any]) -> dict[str, Any]: ...
@overload
def trusted_root_from_pinned_key(*, purpose: Literal["countersign"], environment: str, pinned_root: Mapping[str, Any]) -> dict[str, Any]: ...
def trusted_root_from_pinned_key(*, purpose: str, environment: str, pinned_root: Mapping[str, Any]) -> dict[str, Any]:
    """The synthetic trusted document a runtime starts from: the pinned root key alone, in the root role. A platform
    root belongs to a deployment; a customer's countersign root belongs to the stage it signs for, any target slug."""
    key_id = key_thumbprint(pinned_root)
    return {
        "signed": {
            "type": "root",
            "protocol": "0.0.0",
            "purpose": purpose,
            "environment": environment,
            "version": 0,
            "expires": "9999-12-31T23:59:59Z",
            "keys": {key_id: {"keyType": "ecdsa-p256", "scheme": "ES256", "publicKey": public_jwk_of(pinned_root)}},
            "roles": {"root": {"keyIds": [key_id], "threshold": 1}, "targets": {"keyIds": [], "threshold": 1}},
        },
        "signatures": [],
    }


def _count_valid_signatures(data: bytes, signatures: list[Mapping[str, Any]], key_ids: list[str], keys: Mapping[str, Any]) -> int:
    seen: set[str] = set()
    valid = 0
    for signature in signatures:
        key_id = signature.get("keyId")
        if key_id not in key_ids or key_id in seen:
            continue
        key = keys.get(key_id)
        if not key:
            continue
        if verify_bytes(data, str(signature.get("sig", "")), key["publicKey"]):
            seen.add(key_id)
            valid += 1
    return valid


@dataclass(frozen=True)
class Verdict:
    ok: bool
    reason: Optional[str] = None
    signing_key_id: Optional[str] = None
    generation: Optional[int] = None
    #: Refused, but its signature, scope and generation verified, so its disables reach this host (``capabilities.md``).
    directives_stand: bool = False


def verify_root_metadata(*, candidate: Mapping[str, Any], trusted: Mapping[str, Any], now: str) -> Verdict:
    """R1–R5."""
    signed = candidate["signed"]
    trusted_signed = trusted["signed"]
    if signed.get("purpose") != trusted_signed.get("purpose") or signed.get("environment") != trusted_signed.get("environment"):
        return Verdict(False, "root_scope_mismatch")
    for key_id, key in signed.get("keys", {}).items():
        if key_thumbprint(key["publicKey"]) != key_id:
            return Verdict(False, "key_id_mismatch")
    if signed["version"] < trusted_signed["version"]:
        return Verdict(False, "root_rollback")
    if signed["version"] == trusted_signed["version"] and canonical_json(signed) != canonical_json(trusted_signed):
        return Verdict(False, "root_rollback")
    role = trusted_signed["roles"]["root"]
    if _count_valid_signatures(canonical_bytes(signed), list(candidate.get("signatures", [])), list(role["keyIds"]), trusted_signed["keys"]) < role["threshold"]:
        return Verdict(False, "root_signature_invalid")
    if not instant(signed["expires"]) > instant(now):
        return Verdict(False, "root_expired")
    return Verdict(True)


def slot_hashes(entry: Mapping[str, Any]) -> dict[str, int]:
    """Every hash a slot or an override names, with its declared length: its own, its steps', its golden set's."""
    steps = entry.get("steps")
    golden = entry.get("goldenSet")
    pairs = [(entry.get("contentHash"), entry.get("byteLength"))]
    pairs += [(step.get("contentHash"), step.get("byteLength")) for step in (steps if isinstance(steps, list) else []) if isinstance(step, Mapping)]
    if isinstance(golden, Mapping):
        pairs.append((golden.get("contentHash"), golden.get("byteLength")))
    return {content_hash: length for content_hash, length in pairs if isinstance(content_hash, str)}


def _override_lists(payload: Mapping[str, Any]) -> list[Any]:
    return [override for experiment in servable_experiments(payload) for arm in (experiment["arms"] if isinstance(experiment.get("arms"), list) else []) for override in servable_overrides(arm)]


def referenced_payloads(payload: Mapping[str, Any]) -> dict[str, int]:
    """Every content hash a manifest references, with the declared length: servable slots, their steps, arm overrides."""
    hashes: dict[str, int] = {}
    for slot in [*servable_slots(payload), *_override_lists(payload)]:
        hashes.update(slot_hashes(slot))
    return hashes


def _pair_of(value: Mapping[str, Any]) -> Optional[tuple[str, int]]:
    content_hash, byte_length = value.get("contentHash"), value.get("byteLength")
    return (content_hash, byte_length) if isinstance(content_hash, str) and _CONTENT_HASH.fullmatch(content_hash) and type(byte_length) is int and 0 <= byte_length <= MAX_SAFE_INTEGER else None


def carried_payloads(payload: Mapping[str, Any]) -> dict[str, int]:
    """Every ``{contentHash, byteLength}`` pair anywhere under a manifest payload, whatever holds it. Pull paths only: a
    puller carries a release for runtimes that may know more than it does, so it fetches what a newer runtime needs
    (a ``slot.variants[*].pin``, an open slot) without being able to read it. A runtime reads ``referenced_payloads``."""
    hashes: dict[str, int] = {}
    pending: list[Any] = [payload]
    while pending:
        value = pending.pop()
        if isinstance(value, Mapping):
            pair = _pair_of(value)
            if pair:
                hashes[pair[0]] = pair[1]
            pending.extend(value.values())
        elif isinstance(value, (list, tuple)):
            pending.extend(value)
    return hashes


def optional_payloads(payload: Mapping[str, Any]) -> set[str]:
    """The hashes named only under a slot or an arm override carrying ``requires``, by the same walk: the only payloads a
    store or a carrier may go without (M9). A hash named anywhere else is required, so a ``requires`` slot sharing it
    cannot excuse it, and a ``requires`` anywhere but those two positions excuses nothing."""
    positions: set[int] = set()
    slots = payload.get("slots")
    positions.update(id(slot) for slot in (slots if isinstance(slots, list) else []))
    experiments = payload.get("experiments")
    for experiment in experiments if isinstance(experiments, list) else []:
        arms = experiment.get("arms") if isinstance(experiment, Mapping) else None
        for arm in arms if isinstance(arms, list) else []:
            overrides = arm.get("overrides") if isinstance(arm, Mapping) else None
            positions.update(id(override) for override in (overrides if isinstance(overrides, list) else []))
    plain: set[str] = set()
    under_requires: set[str] = set()
    pending: list[tuple[Any, bool]] = [(payload, False)]
    while pending:
        value, under = pending.pop()
        if isinstance(value, Mapping):
            inside = under or (id(value) in positions and "requires" in value)
            pair = _pair_of(value)
            if pair:
                (under_requires if inside else plain).add(pair[0])
            pending.extend((member, inside) for member in value.values())
        elif isinstance(value, (list, tuple)):
            pending.extend((member, under) for member in value)
    return under_requires - plain


def experiment_conflict(payload: Mapping[str, Any]) -> str | None:
    """M15 (S16): the per-prompt shape is consistent: an arm-scoped disable names its experiment; every ``experiments[]``
    entry names a slot of the release, no slot twice; each arm's overrides this SDK can serve name that slot only. An
    arm-scoped disable names one of the experiments. It reads every experiment, a skipped one too, so an arm disable
    naming one still loads. None when it holds."""
    directives = payload.get("directives")
    disables = [d for d in (directives if isinstance(directives, list) else []) if isinstance(d, Mapping) and d.get("kind") == "disable" and d.get("scope") == "arm"]
    if any(not isinstance(d.get("experimentId"), str) for d in disables):
        return "experiment_conflict"
    listed = payload.get("experiments")
    if listed is None:
        return None
    if not isinstance(listed, list) or not listed:
        return "experiment_conflict"
    slots = payload.get("slots")
    slot_tags = {slot.get("tag") for slot in (slots if isinstance(slots, list) else []) if isinstance(slot, Mapping) and isinstance(slot.get("tag"), str)}
    seen: set[str] = set()
    ids: set[str] = set()
    for experiment in listed:
        if not isinstance(experiment, Mapping) or not isinstance(experiment.get("tag"), str):
            return "experiment_conflict"
        tag = experiment["tag"]
        if tag not in slot_tags or tag in seen:
            return "experiment_conflict"
        seen.add(tag)
        if isinstance(experiment.get("experimentId"), str):
            ids.add(experiment["experimentId"])
        arms = experiment.get("arms")
        for arm in arms if isinstance(arms, list) else []:
            # An override this SDK cannot serve is dropped before the check: a rubric override of another tag must not refuse the manifest.
            for override in servable_overrides(arm):
                if override.get("tag") != tag:
                    return "experiment_conflict"
    return None if all(d["experimentId"] in ids for d in disables) else "experiment_conflict"


def _key_usable_at(key: Mapping[str, Any], now: str) -> bool:
    at = instant(now)
    if key.get("notBefore") and not instant(key["notBefore"]) <= at:
        return False
    if key.get("notAfter") and not at < instant(key["notAfter"]):
        return False
    return True


def verify_manifest(
    *,
    manifest: Mapping[str, Any],
    root: Mapping[str, Any],
    now: str,
    scope: Mapping[str, str],
    stored_generation: int,
    payloads: Optional[Mapping[str, bytes]] = None,
    countersign_root: Optional[Mapping[str, Any]] = None,
    require_countersign: Optional[bool] = None,
    carrying: bool = False,
    absent_requires: bool = False,
) -> Verdict:
    """M1–M15. ``payloads=None`` skips M9/M10 (verify the envelope before fetching). ``carrying`` is a pull path's check: no
    capability refusal and no servable filter, so a puller carries a release it cannot read itself. M9 and M10 run over
    ``carried_payloads``. The runtime that opens the bundle verifies it again, in full. ``absent_requires`` lets M9 pass
    over ``optional_payloads``: only a store load and a carrying path say so."""
    payload = manifest["payload"]
    root_signed = root["signed"]
    if not instant(root_signed["expires"]) > instant(now):
        return Verdict(False, "root_expired")
    protocol = payload.get("protocol")
    version = _PROTOCOL_SHAPE.fullmatch(protocol) if isinstance(protocol, str) else None
    try:
        major = int(version.group(1)) if version else None
    except ValueError:  # past Python's integer-parsing limit: no major this SDK reads
        major = None
    if major not in SUPPORTED_PROTOCOL_MAJORS:
        return Verdict(False, "protocol_unsupported")
    if "requiredCapabilities" in payload and not isinstance(payload["requiredCapabilities"], list):
        return Verdict(False, "protocol_unsupported")
    # A manifest asking for a capability this SDK lacks may use shapes it cannot read, so only the envelope is checked.
    capable = capabilities_implemented(payload)
    if capable and not valid_audience_manifest(payload):
        return Verdict(False, "protocol_unsupported")

    targets = root_signed["roles"]["targets"]
    keys = root_signed["keys"]
    named = [s for s in manifest.get("signatures", []) if isinstance(s, Mapping) and isinstance(s.get("keyId"), str) and s["keyId"] in targets["keyIds"] and s["keyId"] in keys]
    if not named:
        return Verdict(False, "unknown_signing_key")
    usable = [s for s in named if _key_usable_at(keys[s["keyId"]], now)]
    if not usable:
        return Verdict(False, "signing_key_expired")
    valid = _count_valid_signatures(canonical_bytes(payload), usable, list(targets["keyIds"]), keys)
    if valid == 0:
        return Verdict(False, "signature_invalid")
    if valid < targets["threshold"]:
        return Verdict(False, "signature_threshold")

    if payload.get("organizationId") != scope["organizationId"] or payload.get("agentId") != scope["agentId"] or payload.get("target") != scope["target"]:
        return Verdict(False, "scope_mismatch")
    if payload["generation"] < stored_generation:
        return Verdict(False, "generation_rollback")
    if not capable and not carrying:
        return Verdict(False, "protocol_unsupported", directives_stand=True)
    # What this SDK cannot read, it cannot judge: a carrier leaves M13 to M15 of such a manifest to the runtime.
    if capable:
        # M13 (S4): the directive kinds a runtime honours are a closed set; one it does not know refuses the whole manifest.
        directives = payload.get("directives")
        if not isinstance(directives, list) or any(not isinstance(d, Mapping) or not isinstance(d.get("kind"), str) or d["kind"] not in DIRECTIVE_KINDS for d in directives):
            return Verdict(False, "directive_unknown")
        # M15 (S16): the per-prompt shape is consistent, or the manifest is refused whole before any payload.
        conflict = experiment_conflict(payload)
        if conflict:
            return Verdict(False, conflict)
        # M14 (S9): every experiment's ramp plan, when present, is well-formed — a malformed one is refused whole.
        for experiment in servable_experiments(payload):
            if "ramp" not in experiment:
                continue
            try:
                if experiment["ramp"] is None:
                    raise AssignmentError("ramp_invalid")
                validate_ramp(experiment["ramp"], len(experiment.get("arms") or []))
            except AssignmentError as error:
                if error.reason == "ramp_invalid":
                    return Verdict(False, "ramp_invalid")
                raise

    if payloads is not None:
        optional = optional_payloads(payload) if absent_requires else set()
        for content_hash, byte_length in (carried_payloads(payload) if carrying else referenced_payloads(payload)).items():
            data = payloads.get(content_hash)
            if data is None:
                # What only a `requires` entry names may be absent from a store or a carrier (M9). Every other caller needs it all.
                if content_hash in optional:
                    continue
                return Verdict(False, "payload_missing")
            if len(data) != byte_length or sha256_prefixed(data) != content_hash:
                return Verdict(False, "payload_hash_mismatch")

    if payload.get("requireCountersign") or require_countersign:
        digests = [payload.get("releaseDigest"), *[arm.get("releaseDigest") if isinstance(arm, Mapping) else None for experiment in servable_experiments(payload) for arm in (experiment["arms"] if isinstance(experiment.get("arms"), list) else [])]]
        role = (countersign_root or {}).get("signed", {}).get("roles", {}).get("targets", {"keyIds": [], "threshold": 1})
        cs_keys = (countersign_root or {}).get("signed", {}).get("keys", {})
        for digest in sorted({digest for digest in digests if isinstance(digest, str)}):
            candidates = [c for c in manifest.get("countersignatures") or [] if c.get("releaseDigest") == digest and c.get("keyId") in role["keyIds"] and c.get("keyId") in cs_keys]
            if not candidates:
                return Verdict(False, "countersign_missing")
            if _count_valid_signatures(digest.encode("utf-8"), candidates, list(role["keyIds"]), cs_keys) < role["threshold"]:
                return Verdict(False, "countersign_invalid")
        if any(not isinstance(digest, str) for digest in digests):
            return Verdict(False, "countersign_missing")
    return Verdict(True, signing_key_id=usable[0]["keyId"], generation=payload["generation"])


INFERENCE_DIGEST_KEYS = ("maxOutputTokens", "reasoningEffort", "stopSequences", "temperatureMilli", "topPBps")


def inference_digest_input(inference: Mapping[str, Any]) -> dict[str, Any]:
    """The inference block as the digest covers it: the known keys, each only when set (a JSON null is unset; canonical JSON sorts them)."""
    out: dict[str, Any] = {}
    for key in INFERENCE_DIGEST_KEYS:
        value = inference.get(key)
        if value is None:
            continue
        out[key] = list(value) if key == "stopSequences" else value
    return out


def _step_digest_input(step: Mapping[str, Any]) -> dict[str, Any]:
    out = {"stepId": step["stepId"], "ordinal": step["ordinal"], "promptArtifactId": step["promptArtifactId"], "promptVersionId": step["promptVersionId"], "contentHash": step["contentHash"], "byteLength": step["byteLength"]}
    inference = step.get("inference")
    if inference is not None:
        # A step's own settings, projected as a slot's are.
        out["inference"] = inference_digest_input(inference)
    return out


def release_digest_input(slots: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The digest input: pins sorted by tag, projected to exactly the covered members (canonical-json.md). An open slot
    projects the members it has."""
    projected = []
    for slot in sorted(slots, key=lambda s: s["tag"].encode("utf-16-be", "surrogatepass")):
        entry: dict[str, Any] = {key: slot[key] for key in ("tag", "kind", "artifactId", "versionId", "versionOrdinal", "contentHash", "byteLength", "model") if key in slot}
        if slot.get("variables") is not None:
            # `default` and `source` ride the digest only when the pin carries them, so a slot without them keeps its digest.
            entry["variables"] = [
                {"name": v["name"], "required": v["required"], "trust": v["trust"], **({"default": v["default"]} if v.get("default") is not None else {}), **({"source": v["source"]} if v.get("source") is not None else {})}
                for v in slot["variables"]
            ]
        if slot.get("requires") is not None:
            entry["requires"] = slot["requires"]
        if slot.get("modelRequired") is True:
            entry["modelRequired"] = True
        if slot.get("outputChecks"):
            entry["outputChecks"] = list(slot["outputChecks"])
        golden = slot.get("goldenSet")
        if golden:
            entry["goldenSet"] = {"setId": golden["setId"], "cases": golden["cases"], "contentHash": golden["contentHash"], "byteLength": golden["byteLength"], "minPassBps": golden["minPassBps"]}
        inference = slot.get("inference")
        if inference is not None:
            entry["inference"] = inference_digest_input(inference)
        if slot.get("steps") is not None:
            entry["steps"] = [_step_digest_input(s) for s in slot["steps"]]
        projected.append(entry)
    return projected


def release_digest(slots: list[Mapping[str, Any]]) -> str:
    return sha256_prefixed(canonical_bytes(release_digest_input(slots)))
