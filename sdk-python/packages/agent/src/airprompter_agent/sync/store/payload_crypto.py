"""Each payload is encrypted with AES-256-GCM under the store's DEK. The AAD
is ``agentId ‖ target ‖ generation ‖ contentHash`` joined by NUL bytes
(U+0000 — the TypeScript SDK's exact bytes; the interop test pins it), so a ciphertext cannot
be moved between slots or targets and swapping the A and B directories on
disk cannot roll the store back: decryption fails, the slot is corrupt,
and the fallback chain runs.

Example::

    aad = payload_aad(agent_id="agt_1", target="prod", generation=12, content_hash="sha256:…")
    sealed = encrypt_payload(dek, plaintext, aad)   # iv ‖ tag ‖ ciphertext
    decrypt_payload(dek, sealed, aad)               # the bytes back
    decrypt_payload(dek, sealed, payload_aad(agent_id="agt_1", target="staging", generation=12, content_hash="sha256:…"))   # PayloadDecryptError: moved between targets
"""

from __future__ import annotations

import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def payload_aad(*, agent_id: str, target: str, generation: int, content_hash: str) -> bytes:
    return f"{agent_id}\x00{target}\x00{generation}\x00{content_hash}".encode("utf-8")


def encrypt_payload(dek: bytes, plaintext: bytes, aad: bytes) -> bytes:
    """iv(12) ‖ tag(16) ‖ ciphertext"""
    iv = os.urandom(12)
    sealed = AESGCM(dek).encrypt(iv, plaintext, aad)
    return iv + sealed[-16:] + sealed[:-16]


class PayloadDecryptError(Exception):
    def __init__(self) -> None:
        super().__init__("payload does not decrypt under this store's key and slot (moved, swapped, or tampered)")


def decrypt_payload(dek: bytes, sealed: bytes, aad: bytes) -> bytes:
    if len(sealed) < 28:
        raise PayloadDecryptError()
    try:
        return AESGCM(dek).decrypt(sealed[:12], sealed[28:] + sealed[12:28], aad)
    except (InvalidTag, ValueError) as error:
        raise PayloadDecryptError() from error
