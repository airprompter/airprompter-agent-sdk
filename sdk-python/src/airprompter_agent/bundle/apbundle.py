"""``.apbundle`` (``protocol/schemas/bundle.schema.json``): the OTA release,
serialized — manifest, every payload, the root document(s), a ``notAfter``.
Encrypted to the target's X25519 distribution key by default; plaintext
is a ``dev`` opt-in. ``open_bundle`` runs the identical verification the
sync path runs, so a bundle is never a way around the trust chain.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from .._util import b64url_decode, b64url_encode
from ..protocol.canonical_json import canonical_json
from .hpke import AEAD_AES_256_GCM, open_from, seal_to

APBUNDLE_INFO = "airprompter-apbundle-v1"


def distribution_key_id(public_raw: bytes) -> str:
    """RFC 7638 thumbprint of an OKP JWK: sha256 over canonical {crv, kty, x}, hex."""
    return hashlib.sha256(canonical_json({"crv": "X25519", "kty": "OKP", "x": b64url_encode(public_raw)}).encode("utf-8")).hexdigest()


def _bundle_aad(contents: Mapping[str, Any]) -> bytes:
    payload = contents["manifest"]["payload"]
    return f"{payload['agentId']}|{payload['target']}".encode("utf-8")


def create_plaintext_bundle(contents: Mapping[str, Any]) -> dict[str, Any]:
    return {"format": "apbundle", "version": 1, "protocol": contents["manifest"]["payload"]["protocol"], "encryption": {"scheme": "none", "contents": dict(contents)}}


def create_encrypted_bundle(contents: Mapping[str, Any], recipient_public_raw: bytes) -> dict[str, Any]:
    enc, ciphertext = seal_to(recipient_public_raw, APBUNDLE_INFO.encode("utf-8"), _bundle_aad(contents), canonical_json(contents).encode("utf-8"), AEAD_AES_256_GCM)
    return {
        "format": "apbundle",
        "version": 1,
        "protocol": contents["manifest"]["payload"]["protocol"],
        "encryption": {
            "scheme": "hpke-x25519-hkdf-sha256-aes-256-gcm",
            "recipientKeyId": distribution_key_id(recipient_public_raw),
            "enc": b64url_encode(enc),
            "info": APBUNDLE_INFO,
            "ciphertext": b64url_encode(ciphertext),
        },
    }


class BundleError(Exception):
    def __init__(self, code: str, message: str):  # "malformed" | "wrong_recipient" | "decrypt_failed" | "relabelled"
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class DistributionKey:
    private_key: X25519PrivateKey
    public_raw: bytes


def open_bundle(bundle: Mapping[str, Any], expected: Mapping[str, str], distribution_key: Optional[DistributionKey] = None) -> dict[str, Any]:
    """Decrypts (when sealed) and returns the contents. The AAD binds the bundle to the agent and target the caller expects,
    so a bundle cannot be relabelled for another target; signature and hash verification is the caller's (the same path as OTA)."""
    if bundle.get("format") != "apbundle" or bundle.get("version") != 1:
        raise BundleError("malformed", "not an apbundle v1")
    encryption = bundle.get("encryption") or {}
    if encryption.get("scheme") == "none":
        contents = encryption["contents"]
        payload = contents["manifest"]["payload"]
        if payload["agentId"] != expected["agentId"] or payload["target"] != expected["target"]:
            raise BundleError("relabelled", "bundle is for another agent or target")
        return contents
    if distribution_key is None:
        raise BundleError("wrong_recipient", "an encrypted bundle needs the target's distribution key")
    if encryption.get("recipientKeyId") != distribution_key_id(distribution_key.public_raw):
        raise BundleError("wrong_recipient", "bundle was sealed to another distribution key")
    try:
        plaintext = open_from(
            enc=b64url_decode(encryption["enc"]),
            recipient_private_key=distribution_key.private_key,
            recipient_public_raw=distribution_key.public_raw,
            info=(encryption.get("info") or APBUNDLE_INFO).encode("utf-8"),
            aad=f"{expected['agentId']}|{expected['target']}".encode("utf-8"),
            ciphertext=b64url_decode(encryption["ciphertext"]),
        )
    except Exception as error:  # noqa: BLE001 — a wrong AAD and a tampered ciphertext are indistinguishable by design
        raise BundleError("decrypt_failed", "bundle does not open for this agent and target") from error
    contents = json.loads(plaintext.decode("utf-8"))
    payload = contents["manifest"]["payload"]
    if payload["agentId"] != expected["agentId"] or payload["target"] != expected["target"]:
        raise BundleError("relabelled", "bundle is for another agent or target")
    return contents


def bundle_payload_bytes(contents: Mapping[str, Any]) -> dict[str, bytes]:
    return {entry["contentHash"]: b64url_decode(entry["bytes"]) for entry in contents.get("payloads", [])}
