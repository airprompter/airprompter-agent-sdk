"""The trust chain (``protocol/trust-chain.md``): thumbprints, ES256 over
canonical bytes, root-metadata acceptance R1–R5 and manifest verification
M1–M12. Pure over its inputs; ``now`` is always passed in. This is what
decides whether bytes go live, so it never reads the network or the disk.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature

from .._util import b64url_decode, b64url_encode, instant
from .canonical_json import canonical_bytes, canonical_json, sha256_prefixed

SUPPORTED_PROTOCOL_MAJORS = frozenset({0})
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


def trusted_root_from_pinned_key(*, purpose: str, environment: str, pinned_root: Mapping[str, Any]) -> dict[str, Any]:
    """The synthetic trusted document a runtime starts from: the pinned root key alone, in the root role."""
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


def referenced_payloads(payload: Mapping[str, Any]) -> dict[str, int]:
    """Every content hash a manifest references, with the declared length: slots, steps, arm overrides."""
    hashes: dict[str, int] = {}

    def add(slot: Mapping[str, Any]) -> None:
        hashes[slot["contentHash"]] = slot["byteLength"]
        for step in slot.get("steps") or []:
            hashes[step["contentHash"]] = step["byteLength"]
        golden = slot.get("goldenSet")
        if golden:
            hashes[golden["contentHash"]] = golden["byteLength"]

    for slot in payload.get("slots", []):
        add(slot)
    experiment = payload.get("experiment")
    for arm in (experiment or {}).get("arms", []):
        for override in arm.get("overrides", []):
            add(override)
    return hashes


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
) -> Verdict:
    """M1–M12. ``payloads=None`` skips M9/M10 (verify the envelope before fetching)."""
    payload = manifest["payload"]
    root_signed = root["signed"]
    if not instant(root_signed["expires"]) > instant(now):
        return Verdict(False, "root_expired")
    try:
        major = int(str(payload["protocol"]).split(".")[0])
    except (ValueError, KeyError):
        return Verdict(False, "protocol_unsupported")
    if major not in SUPPORTED_PROTOCOL_MAJORS:
        return Verdict(False, "protocol_unsupported")

    targets = root_signed["roles"]["targets"]
    keys = root_signed["keys"]
    named = [s for s in manifest.get("signatures", []) if s.get("keyId") in targets["keyIds"] and s.get("keyId") in keys]
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

    if payloads is not None:
        for content_hash, byte_length in referenced_payloads(payload).items():
            data = payloads.get(content_hash)
            if data is None:
                return Verdict(False, "payload_missing")
            if len(data) != byte_length or sha256_prefixed(data) != content_hash:
                return Verdict(False, "payload_hash_mismatch")

    if payload.get("requireCountersign") or require_countersign:
        digests = {payload["releaseDigest"], *[arm["releaseDigest"] for arm in (payload.get("experiment") or {}).get("arms", [])]}
        role = (countersign_root or {}).get("signed", {}).get("roles", {}).get("targets", {"keyIds": [], "threshold": 1})
        cs_keys = (countersign_root or {}).get("signed", {}).get("keys", {})
        for digest in sorted(digests):
            candidates = [c for c in manifest.get("countersignatures") or [] if c.get("releaseDigest") == digest and c.get("keyId") in role["keyIds"] and c.get("keyId") in cs_keys]
            if not candidates:
                return Verdict(False, "countersign_missing")
            if _count_valid_signatures(digest.encode("utf-8"), candidates, list(role["keyIds"]), cs_keys) < role["threshold"]:
                return Verdict(False, "countersign_invalid")
    return Verdict(True, signing_key_id=usable[0]["keyId"], generation=payload["generation"])


def release_digest_input(slots: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The digest input: pins sorted by tag, projected to exactly the covered members (canonical-json.md)."""
    projected = []
    for slot in sorted(slots, key=lambda s: s["tag"].encode("utf-16-be", "surrogatepass")):
        entry: dict[str, Any] = {
            "tag": slot["tag"],
            "kind": slot["kind"],
            "artifactId": slot["artifactId"],
            "versionId": slot["versionId"],
            "versionOrdinal": slot.get("versionOrdinal"),
            "contentHash": slot["contentHash"],
            "byteLength": slot["byteLength"],
            "model": slot["model"],
            "variables": [{"name": v["name"], "required": v["required"], "trust": v["trust"]} for v in slot.get("variables", [])],
        }
        if slot.get("modelRequired") is True:
            entry["modelRequired"] = True
        if slot.get("outputChecks"):
            entry["outputChecks"] = list(slot["outputChecks"])
        golden = slot.get("goldenSet")
        if golden:
            entry["goldenSet"] = {"setId": golden["setId"], "cases": golden["cases"], "contentHash": golden["contentHash"], "byteLength": golden["byteLength"], "minPassBps": golden["minPassBps"]}
        if slot.get("steps") is not None:
            entry["steps"] = [
                {"stepId": s["stepId"], "ordinal": s["ordinal"], "promptArtifactId": s["promptArtifactId"], "promptVersionId": s["promptVersionId"], "contentHash": s["contentHash"], "byteLength": s["byteLength"]}
                for s in slot["steps"]
            ]
        projected.append(entry)
    return projected


def release_digest(slots: list[Mapping[str, Any]]) -> str:
    return sha256_prefixed(canonical_bytes(release_digest_input(slots)))
