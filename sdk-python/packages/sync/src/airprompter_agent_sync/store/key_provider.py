"""Key providers hand the store its KEK — the key that wraps the per-store
DEK. What protects the KEK is what the store's confidentiality rests on,
and the heartbeat reports it (``storageProtection``) so a fleet view can
show a ``file_key`` host as a finding instead of hiding it (D15).

``file_key()`` ships here: a 0600 file beside the store. ``kms()`` (boto3),
``vault()`` (hvac) and ``os_keystore()`` (keyring) import their client
lazily so the SDK installs without them; ``custom()`` wraps anything that
can wrap and unwrap 32 bytes.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from typing import Callable, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from airprompter_agent_core._util import b64url_decode, b64url_encode

StorageProtection = str  # "os_keystore" | "kms" | "vault" | "custom" | "file_key"


@dataclass(frozen=True)
class KeyProvider:
    storage_protection: StorageProtection
    #: Wrap the DEK for storage in store.json.
    wrap: Callable[[bytes], bytes]
    #: Unwrap what ``wrap`` produced. Raises when the KEK cannot be obtained — the store then refuses to open.
    unwrap: Callable[[bytes], bytes]


def wrap_with_raw_key(kek: bytes, dek: bytes) -> bytes:
    """AES-256-GCM wrap with a raw 32-byte KEK: iv(12) ‖ tag(16) ‖ ciphertext."""
    iv = os.urandom(12)
    sealed = AESGCM(kek).encrypt(iv, dek, None)  # ciphertext ‖ tag
    return iv + sealed[-16:] + sealed[:-16]


def unwrap_with_raw_key(kek: bytes, wrapped: bytes) -> bytes:
    iv, tag, ciphertext = wrapped[:12], wrapped[12:28], wrapped[28:]
    return AESGCM(kek).decrypt(iv, ciphertext + tag, None)


def file_key(path: str) -> KeyProvider:
    """The fallback: a 32-byte KEK in a 0600 file. Defends the store against
    other users, backups and snapshots — not against a co-tenant process
    running as the same user. Reported, never silent."""

    def load() -> bytes:
        if not os.path.exists(path):
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, os.urandom(32))
            finally:
                os.close(fd)
            os.chmod(path, 0o600)
        with open(path, "rb") as f:
            kek = f.read()
        if len(kek) != 32:
            raise ValueError(f"{path} is not a 32-byte key file")
        return kek

    return KeyProvider("file_key", lambda dek: wrap_with_raw_key(load(), dek), lambda wrapped: unwrap_with_raw_key(load(), wrapped))


def custom_key_provider(*, wrap: Callable[[bytes], bytes], unwrap: Callable[[bytes], bytes], storage_protection: StorageProtection = "custom") -> KeyProvider:
    """Bring your own wrap/unwrap (a KMS call, a Vault transit key, an HSM)."""
    return KeyProvider(storage_protection, wrap, unwrap)


def kms(key_id: str, *, client: Optional[object] = None, region_name: Optional[str] = None) -> KeyProvider:
    """AWS KMS wraps the DEK (``Encrypt``/``Decrypt`` on a symmetric key). Needs ``boto3`` (``pip install airprompter-agent[kms]``)."""

    def get_client():
        if client is not None:
            return client
        import boto3  # type: ignore[import-not-found]

        return boto3.client("kms", region_name=region_name)

    context = {"airprompter": "store-dek"}
    return KeyProvider(
        "kms",
        lambda dek: get_client().encrypt(KeyId=key_id, Plaintext=dek, EncryptionContext=context)["CiphertextBlob"],
        lambda wrapped: get_client().decrypt(KeyId=key_id, CiphertextBlob=wrapped, EncryptionContext=context)["Plaintext"],
    )


def vault(transit_key: str, *, client: Optional[object] = None, mount_point: str = "transit") -> KeyProvider:
    """HashiCorp Vault's transit engine wraps the DEK. Needs ``hvac`` (``pip install airprompter-agent[vault]``)."""

    def get_client():
        if client is not None:
            return client
        import hvac  # type: ignore[import-not-found]

        return hvac.Client()

    def wrap(dek: bytes) -> bytes:
        response = get_client().secrets.transit.encrypt_data(name=transit_key, plaintext=base64.b64encode(dek).decode("ascii"), mount_point=mount_point)
        return response["data"]["ciphertext"].encode("utf-8")

    def unwrap(wrapped: bytes) -> bytes:
        response = get_client().secrets.transit.decrypt_data(name=transit_key, ciphertext=wrapped.decode("utf-8"), mount_point=mount_point)
        return base64.b64decode(response["data"]["plaintext"])

    return KeyProvider("vault", wrap, unwrap)


def os_keystore(service: str = "airprompter-agent", username: str = "store-kek") -> KeyProvider:
    """The OS keystore (macOS Keychain, Windows Credential Locker, Secret Service) holds a random KEK. Needs ``keyring`` (``pip install airprompter-agent[keyring]``)."""

    def load() -> bytes:
        import keyring  # type: ignore[import-not-found]

        stored = keyring.get_password(service, username)
        if stored is None:
            kek = os.urandom(32)
            keyring.set_password(service, username, b64url_encode(kek))
            return kek
        return b64url_decode(stored)

    return KeyProvider("os_keystore", lambda dek: wrap_with_raw_key(load(), dek), lambda wrapped: unwrap_with_raw_key(load(), wrapped))
