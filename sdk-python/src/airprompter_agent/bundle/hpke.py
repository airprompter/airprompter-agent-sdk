"""HPKE base mode (RFC 9180) with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and
AES-GCM, on ``cryptography``'s primitives alone. The offline bundle
(``.apbundle``) is sealed to the target's X25519 distribution key with
AES-256-GCM; AES-128-GCM is here only so the implementation can be checked
against RFC 9180's A.1 test vector, which uses that AEAD with the same KEM
and KDF.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from typing import Optional

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KEM_X25519 = 0x0020
KDF_HKDF_SHA256 = 0x0001
AEAD_AES_128_GCM = 0x0001
AEAD_AES_256_GCM = 0x0002
_NSECRET = 32
_NN = 12


def _i2osp2(value: int) -> bytes:
    return bytes([(value >> 8) & 0xFF, value & 0xFF])


_KEM_SUITE_ID = b"KEM" + _i2osp2(KEM_X25519)


def _hpke_suite_id(aead: int) -> bytes:
    return b"HPKE" + _i2osp2(KEM_X25519) + _i2osp2(KDF_HKDF_SHA256) + _i2osp2(aead)


def _hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    return hmac.new(salt if salt else bytes(32), ikm, hashlib.sha256).digest()


def _hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    out = b""
    previous = b""
    counter = 1
    while len(out) < length:
        previous = hmac.new(prk, previous + info + bytes([counter]), hashlib.sha256).digest()
        out += previous
        counter += 1
    return out[:length]


def _labeled_extract(suite_id: bytes, salt: bytes, label: str, ikm: bytes) -> bytes:
    return _hkdf_extract(salt, b"HPKE-v1" + suite_id + label.encode("ascii") + ikm)


def _labeled_expand(suite_id: bytes, prk: bytes, label: str, info: bytes, length: int) -> bytes:
    return _hkdf_expand(prk, _i2osp2(length) + b"HPKE-v1" + suite_id + label.encode("ascii") + info, length)


def x25519_public_key_from_raw(raw: bytes) -> X25519PublicKey:
    return X25519PublicKey.from_public_bytes(raw)


def x25519_private_key_from_raw(raw: bytes) -> X25519PrivateKey:
    return X25519PrivateKey.from_private_bytes(raw)


def raw_public(key: X25519PublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


@dataclass(frozen=True)
class X25519KeyPair:
    private_key: X25519PrivateKey
    public_raw: bytes


def generate_x25519_key_pair() -> X25519KeyPair:
    private = X25519PrivateKey.generate()
    return X25519KeyPair(private, raw_public(private.public_key()))


def _extract_and_expand(dh: bytes, kem_context: bytes) -> bytes:
    eae_prk = _labeled_extract(_KEM_SUITE_ID, b"", "eae_prk", dh)
    return _labeled_expand(_KEM_SUITE_ID, eae_prk, "shared_secret", kem_context, _NSECRET)


def encap(recipient_public_raw: bytes, ephemeral: Optional[X25519KeyPair] = None) -> tuple[bytes, bytes]:
    """Returns ``(shared_secret, enc)``."""
    e = ephemeral or generate_x25519_key_pair()
    dh = e.private_key.exchange(x25519_public_key_from_raw(recipient_public_raw))
    enc = e.public_raw
    return _extract_and_expand(dh, enc + recipient_public_raw), enc


def decap(enc: bytes, recipient_private_key: X25519PrivateKey, recipient_public_raw: bytes) -> bytes:
    dh = recipient_private_key.exchange(x25519_public_key_from_raw(enc))
    return _extract_and_expand(dh, enc + recipient_public_raw)


@dataclass(frozen=True)
class HpkeContext:
    key: bytes
    base_nonce: bytes
    aead: int


def key_schedule(shared_secret: bytes, info: bytes, aead: int) -> HpkeContext:
    suite = _hpke_suite_id(aead)
    psk_id_hash = _labeled_extract(suite, b"", "psk_id_hash", b"")
    info_hash = _labeled_extract(suite, b"", "info_hash", info)
    context = b"\x00" + psk_id_hash + info_hash
    secret = _labeled_extract(suite, shared_secret, "secret", b"")
    nk = 32 if aead == AEAD_AES_256_GCM else 16
    return HpkeContext(_labeled_expand(suite, secret, "key", context, nk), _labeled_expand(suite, secret, "base_nonce", context, _NN), aead)


def _nonce_for(context: HpkeContext, seq: int) -> bytes:
    nonce = bytearray(context.base_nonce)
    remaining = seq
    index = len(nonce) - 1
    while index >= 0 and remaining > 0:
        nonce[index] ^= remaining & 0xFF
        remaining //= 256
        index -= 1
    return bytes(nonce)


def seal(context: HpkeContext, aad: bytes, plaintext: bytes, seq: int = 0) -> bytes:
    """ct ‖ tag(16), as HPKE's AEAD.Seal returns it."""
    return AESGCM(context.key).encrypt(_nonce_for(context, seq), plaintext, aad)


def open_(context: HpkeContext, aad: bytes, ciphertext: bytes, seq: int = 0) -> bytes:
    return AESGCM(context.key).decrypt(_nonce_for(context, seq), ciphertext, aad)


def seal_to(recipient_public_raw: bytes, info: bytes, aad: bytes, plaintext: bytes, aead: int = AEAD_AES_256_GCM) -> tuple[bytes, bytes]:
    """Single-shot base-mode seal: returns ``(enc, ciphertext)``."""
    shared_secret, enc = encap(recipient_public_raw)
    return enc, seal(key_schedule(shared_secret, info, aead), aad, plaintext)


def open_from(*, enc: bytes, recipient_private_key: X25519PrivateKey, recipient_public_raw: bytes, info: bytes, aad: bytes, ciphertext: bytes, aead: int = AEAD_AES_256_GCM) -> bytes:
    shared_secret = decap(enc, recipient_private_key, recipient_public_raw)
    return open_(key_schedule(shared_secret, info, aead), aad, ciphertext)


__all__ = [
    "AEAD_AES_128_GCM",
    "AEAD_AES_256_GCM",
    "HpkeContext",
    "X25519KeyPair",
    "decap",
    "encap",
    "generate_x25519_key_pair",
    "key_schedule",
    "open_",
    "open_from",
    "raw_public",
    "seal",
    "seal_to",
    "x25519_private_key_from_raw",
    "x25519_public_key_from_raw",
]
