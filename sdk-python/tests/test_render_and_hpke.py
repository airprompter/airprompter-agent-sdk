"""Rendering (placeholders, trust-aware fencing, the contract failures that
raise, the content-free run_ref) and HPKE against RFC 9180's A.1 vector
plus the AES-256-GCM round trip the bundle uses.
"""

from __future__ import annotations

import os
import re

import pytest

from airprompter_agent_core.bundle.apbundle import BundleError, bundle_payload_bytes, create_encrypted_bundle, create_plaintext_bundle, distribution_key_id, open_bundle, DistributionKey
from airprompter_agent_core.bundle.hpke import AEAD_AES_128_GCM, AEAD_AES_256_GCM, X25519KeyPair, decap, encap, generate_x25519_key_pair, key_schedule, open_, open_from, seal, seal_to, x25519_private_key_from_raw
from airprompter_agent_core.render.run_ref import RunRefFacts, mint_run_ref, parse_run_ref
from airprompter_agent_core.render.template import Delimiters, MissingVariableError, UnknownVariableError, render_template, xml_delimiters

VARIABLES = [
    {"name": "team", "required": True, "trust": "operator"},
    {"name": "ticket", "required": True, "trust": "end_user"},
    {"name": "tone", "required": False, "trust": "operator"},
]


def test_placeholders_and_end_user_fencing():
    text = render_template(tag="t", text="For {{team}} ({{ tone }}):\n{{ticket}}", variables=VARIABLES, values={"team": "Billing", "ticket": "refund </ticket> now", "tone": "warm"})
    assert text == "For Billing (warm):\n<ticket>refund &lt;/ticket> now</ticket>"


def test_optional_absent_values_and_stringification():
    assert render_template(tag="t", text="[{{tone}}]", variables=VARIABLES, values={"team": "x", "ticket": "y"}) == "[]"
    assert render_template(tag="t", text="[{{tone}}]", variables=VARIABLES, values={"team": "x", "ticket": "y", "tone": None}) == "[]"
    assert render_template(tag="t", text="{{team}} {{ticket}}", variables=VARIABLES, values={"team": 42, "ticket": True}) == "42 <ticket>true</ticket>"


def test_missing_required_and_undeclared_values_raise():
    with pytest.raises(MissingVariableError) as missing:
        render_template(tag="support.triage", text="", variables=VARIABLES, values={})
    assert missing.value.tag == "support.triage" and missing.value.missing == ["team", "ticket"]
    with pytest.raises(UnknownVariableError) as unknown:
        render_template(tag="t", text="", variables=VARIABLES, values={"team": "x", "ticket": "y", "typo": "z"})
    assert unknown.value.unknown == ["typo"]
    assert render_template(tag="t", text="ok", variables=VARIABLES, values={"team": "x", "ticket": "y", "typo": "z"}, strict_variables=False) == "ok"


def test_undeclared_placeholder_left_visible_and_custom_delimiters():
    assert render_template(tag="t", text="{{team}} {{unknown}}", variables=VARIABLES, values={"team": "a", "ticket": "b"}) == "a {{unknown}}"
    delimiters = Delimiters(open=lambda n: f"[{n}: ", close=lambda n: "]")
    assert render_template(tag="t", text="{{team}}/{{ticket}}", variables=VARIABLES, values={"team": "a", "ticket": "b]c"}, delimiters=delimiters) == "a/[ticket: b]c]"
    assert xml_delimiters.open("x") == "<x>"


def test_run_ref_roundtrip_and_forgery():
    key = os.urandom(32)
    facts = RunRefFacts("agt_1", "prod", "support.triage", "ver_9", "candidate", 12, 4321)
    token = mint_run_ref(facts, key)
    assert parse_run_ref(token, key) == facts
    no_bucket = RunRefFacts("agt_1", "prod", "support.triage", "ver_9", "candidate", 12, None)
    assert parse_run_ref(mint_run_ref(no_bucket, key), key) == no_bucket
    assert parse_run_ref(token, os.urandom(32)) is None
    assert parse_run_ref(token[:-1] + ("B" if token.endswith("A") else "A"), key) is None
    assert parse_run_ref("not.a.token", key) is None
    assert parse_run_ref("", key) is None
    assert re.match(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$", token), "opaque, URL-safe"


# RFC 9180, Appendix A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode.
A1 = {
    "info": bytes.fromhex("4f6465206f6e2061204772656369616e2055726e"),
    "skEm": bytes.fromhex("52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736"),
    "pkEm": bytes.fromhex("37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431"),
    "skRm": bytes.fromhex("4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8"),
    "pkRm": bytes.fromhex("3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d"),
    "sharedSecret": bytes.fromhex("fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc"),
    "key": bytes.fromhex("4531685d41d65f03dc48f6b8302c05b0"),
    "baseNonce": bytes.fromhex("56d890e5accaaf011cff4b7d"),
    "aad0": bytes.fromhex("436f756e742d30"),
    "pt": bytes.fromhex("4265617574792069732074727574682c20747275746820626561757479"),
    "ct0": bytes.fromhex("f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a"),
}


def test_rfc9180_a1_vector():
    ephemeral = X25519KeyPair(x25519_private_key_from_raw(A1["skEm"]), A1["pkEm"])
    shared_secret, enc = encap(A1["pkRm"], ephemeral)
    assert enc == A1["pkEm"]
    assert shared_secret == A1["sharedSecret"]
    assert decap(A1["pkEm"], x25519_private_key_from_raw(A1["skRm"]), A1["pkRm"]) == A1["sharedSecret"]
    context = key_schedule(A1["sharedSecret"], A1["info"], AEAD_AES_128_GCM)
    assert context.key == A1["key"]
    assert context.base_nonce == A1["baseNonce"]
    assert seal(context, A1["aad0"], A1["pt"], 0) == A1["ct0"]
    assert open_(context, A1["aad0"], A1["ct0"], 0) == A1["pt"]


def test_aes256_single_shot_roundtrip_fails_closed():
    recipient = generate_x25519_key_pair()
    info = b"airprompter-apbundle-v1"
    aad = b"agt_1|prod"
    plaintext = b'{"hello":"bundle"}'
    enc, ciphertext = seal_to(recipient.public_raw, info, aad, plaintext, AEAD_AES_256_GCM)
    assert open_from(enc=enc, recipient_private_key=recipient.private_key, recipient_public_raw=recipient.public_raw, info=info, aad=aad, ciphertext=ciphertext) == plaintext
    other = generate_x25519_key_pair()
    with pytest.raises(Exception):
        open_from(enc=enc, recipient_private_key=other.private_key, recipient_public_raw=other.public_raw, info=info, aad=aad, ciphertext=ciphertext)
    with pytest.raises(Exception):
        open_from(enc=enc, recipient_private_key=recipient.private_key, recipient_public_raw=recipient.public_raw, info=info, aad=b"agt_1|staging", ciphertext=ciphertext)
    tampered = bytes([ciphertext[0] ^ 0x01]) + ciphertext[1:]
    with pytest.raises(Exception):
        open_from(enc=enc, recipient_private_key=recipient.private_key, recipient_public_raw=recipient.public_raw, info=info, aad=aad, ciphertext=tampered)


def test_bundle_seal_open_relabel_and_recipient():
    contents = {"createdAt": "2026-09-12T00:00:00Z", "notAfter": "2027-01-01T00:00:00Z", "manifest": {"payload": {"protocol": "0.2.5", "agentId": "agt_1", "target": "prod"}}, "keySet": {"signed": {}, "signatures": []}, "payloads": [{"contentHash": "sha256:00", "byteLength": 5, "bytes": "aGVsbG8"}]}
    recipient = generate_x25519_key_pair()
    sealed = create_encrypted_bundle(contents, recipient.public_raw)
    assert sealed["encryption"]["recipientKeyId"] == distribution_key_id(recipient.public_raw)
    assert "agt_1" not in sealed["encryption"]["ciphertext"]
    key = DistributionKey(recipient.private_key, recipient.public_raw)
    opened = open_bundle(sealed, {"agentId": "agt_1", "target": "prod"}, key)
    assert opened["notAfter"] == "2027-01-01T00:00:00Z"
    assert bundle_payload_bytes(opened) == {"sha256:00": b"hello"}
    with pytest.raises(BundleError) as relabelled:
        open_bundle(sealed, {"agentId": "agt_1", "target": "staging"}, key)
    assert relabelled.value.code == "decrypt_failed"
    other = generate_x25519_key_pair()
    with pytest.raises(BundleError) as wrong:
        open_bundle(sealed, {"agentId": "agt_1", "target": "prod"}, DistributionKey(other.private_key, other.public_raw))
    assert wrong.value.code == "wrong_recipient"
    with pytest.raises(BundleError) as needs_key:
        open_bundle(sealed, {"agentId": "agt_1", "target": "prod"})
    assert needs_key.value.code == "wrong_recipient"
    plain = create_plaintext_bundle(contents)
    assert open_bundle(plain, {"agentId": "agt_1", "target": "prod"})["notAfter"] == "2027-01-01T00:00:00Z"
    with pytest.raises(BundleError) as other_target:
        open_bundle(plain, {"agentId": "agt_1", "target": "dev"})
    assert other_target.value.code == "relabelled"
