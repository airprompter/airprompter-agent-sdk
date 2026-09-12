"""Generate protocol/examples/*.json with digests computed by the independent
Python canonical encoder, so every example manifest carries a releaseDigest
that the vectors' rules would reproduce. Signatures are structurally valid
placeholders: real signing vectors arrive with the trust-chain ticket."""
import base64
import hashlib
import json
import os
import sys

PROTOCOL = "0.2.0"

def canonical(v) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def sha256_prefixed(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()

def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")

def digest_input(slots):
    out = []
    for s in sorted(slots, key=lambda s: s["tag"]):
        p = {k: s[k] for k in ("tag", "kind", "artifactId", "versionId", "versionOrdinal", "contentHash", "byteLength", "model")}
        p["variables"] = [{"name": v["name"], "required": v["required"], "trust": v["trust"]} for v in s["variables"]]
        if "steps" in s:
            p["steps"] = [{k: st[k] for k in ("stepId", "ordinal", "promptArtifactId", "promptVersionId", "contentHash", "byteLength")} for st in s["steps"]]
        out.append(p)
    return out

def release_digest(slots):
    return sha256_prefixed(canonical(digest_input(slots)).encode("utf-8"))

placeholder_sig = b64url(bytes(range(64)))          # 86 chars, structurally valid, NOT a real signature
key_platform = "sha256-9f2c1e7a4b0d5c3e8a1f6b2d7c4e9a0b"
key_root = "root-2026-09-prod"
key_customer = "acme-release-2026"

triage_text = b"You are a support triage assistant.\nClassify the ticket below.\n<ticket>{{ticket_body}}</ticket>\n"
reply_text = b"Draft a reply for {{customer_name}} about {{topic}}.\n"
step1_text = b"Summarise: {{document}}\n"
step2_text = b"Translate the summary to {{language}}.\n"
workflow_text = b"summarise -> translate\n"

slots = [
    {
        "tag": "support.triage",
        "kind": "prompt",
        "artifactId": "prm_8b2f3c1d9e4a",
        "versionId": "ver_01j9x4k2m7q8",
        "versionOrdinal": 7,
        "contentHash": sha256_prefixed(triage_text),
        "byteLength": len(triage_text),
        "model": "claude-sonnet-5",
        "variables": [{"name": "ticket_body", "required": True, "trust": "end_user"}],
    },
    {
        "tag": "support.reply",
        "kind": "prompt",
        "artifactId": "prm_1c4d5e6f7a8b",
        "versionId": "ver_01j9x4k2n0aa",
        "versionOrdinal": 3,
        "contentHash": sha256_prefixed(reply_text),
        "byteLength": len(reply_text),
        "model": "gpt-5",
        "variables": [
            {"name": "customer_name", "required": True, "trust": "operator"},
            {"name": "topic", "required": False, "trust": "operator"},
        ],
    },
    {
        "tag": "docs.summarise-translate",
        "kind": "workflow",
        "artifactId": "wfl_a1b2c3d4e5f6",
        "versionId": "ver_01j9x4k2p1bb",
        "versionOrdinal": 2,
        "contentHash": sha256_prefixed(workflow_text),
        "byteLength": len(workflow_text),
        "model": "claude-sonnet-5",
        "variables": [
            {"name": "document", "required": True, "trust": "end_user"},
            {"name": "language", "required": True, "trust": "operator"},
        ],
        "steps": [
            {"stepId": "docs.summarise-translate#1", "ordinal": 1, "promptArtifactId": "prm_step1", "promptVersionId": "ver_step1", "contentHash": sha256_prefixed(step1_text), "byteLength": len(step1_text)},
            {"stepId": "docs.summarise-translate#2", "ordinal": 2, "promptArtifactId": "prm_step2", "promptVersionId": "ver_step2", "contentHash": sha256_prefixed(step2_text), "byteLength": len(step2_text)},
        ],
    },
]
slots.sort(key=lambda s: s["tag"])
digest = release_digest(slots)

candidate_triage = dict(slots[1] if slots[1]["tag"] == "support.triage" else next(s for s in slots if s["tag"] == "support.triage"))
candidate_triage = {**candidate_triage, "versionId": "ver_01j9x4k2m7q9", "versionOrdinal": 8, "contentHash": sha256_prefixed(triage_text + b"Be concise.\n"), "byteLength": len(triage_text) + 12}
candidate_slots = [candidate_triage if s["tag"] == "support.triage" else s for s in slots]
candidate_digest = release_digest(candidate_slots)

manifest_payload = {
    "protocol": PROTOCOL,
    "organizationId": "org_7d3f9a2b",
    "agentId": "agt_4e8c1b6d",
    "target": "prod",
    "generation": 42,
    "releaseDigest": digest,
    "previousReleaseDigest": "sha256:" + "a" * 64,
    "issuedAt": "2026-09-12T10:00:00Z",
    "leaseSeconds": 3600,
    "onLeaseExpiry": "degrade",
    "applyPolicy": "unlock_required",
    "requireCountersign": True,
    "slots": slots,
    "experiment": {
        "experimentId": "exp_2f9c0a1b",
        "salt": b64url(bytes(range(16))),
        "subjectKey": "request",
        "arms": [
            {"arm": "control", "weightBps": 9000, "releaseDigest": digest, "overrides": []},
            {"arm": "candidate", "weightBps": 1000, "releaseDigest": candidate_digest, "overrides": [candidate_triage]},
        ],
    },
    "directives": [
        {"kind": "request_unlock", "releaseDigest": digest, "requestedBy": "usr_9b1c2d3e", "requestedAt": "2026-09-12T10:00:00Z", "expiresAt": "2026-09-13T10:00:00Z", "note": "Roll during tonight's window."}
    ],
}
manifest = {
    "payload": manifest_payload,
    "signatures": [{"keyId": key_platform, "alg": "ES256", "sig": placeholder_sig}],
    "countersignatures": [
        {"keyId": key_customer, "alg": "ES256", "releaseDigest": digest, "sig": placeholder_sig, "signedAt": "2026-09-12T09:30:00Z"},
        {"keyId": key_customer, "alg": "ES256", "releaseDigest": candidate_digest, "sig": placeholder_sig, "signedAt": "2026-09-12T09:31:00Z"},
    ],
}

jwk = {"kty": "EC", "crv": "P-256", "x": b64url(bytes([1] * 32)), "y": b64url(bytes([2] * 32))}
key_set = {
    "signed": {
        "type": "root",
        "protocol": PROTOCOL,
        "purpose": "platform",
        "environment": "prod",
        "version": 3,
        "expires": "2026-12-11T00:00:00Z",
        "keys": {
            key_root: {"keyType": "ecdsa-p256", "scheme": "ES256", "publicKey": jwk},
            key_platform: {"keyType": "ecdsa-p256", "scheme": "ES256", "publicKey": {**jwk, "x": b64url(bytes([3] * 32))}, "notBefore": "2026-09-01T00:00:00Z"},
            "sha256-0ld1e7a4b0d5c3e8a1f6b2d7c4e9a0b1": {"keyType": "ecdsa-p256", "scheme": "ES256", "publicKey": {**jwk, "x": b64url(bytes([4] * 32))}, "notAfter": "2026-10-01T00:00:00Z"},
        },
        "roles": {
            "root": {"keyIds": [key_root], "threshold": 1},
            "targets": {"keyIds": [key_platform, "sha256-0ld1e7a4b0d5c3e8a1f6b2d7c4e9a0b1"], "threshold": 1},
        },
    },
    "signatures": [{"keyId": key_root, "alg": "ES256", "sig": placeholder_sig}],
}

payload_bytes = {}
for s in slots:
    payload_bytes[s["contentHash"]] = {"support.triage": triage_text, "support.reply": reply_text, "docs.summarise-translate": workflow_text}[s["tag"]]
payload_bytes[sha256_prefixed(step1_text)] = step1_text
payload_bytes[sha256_prefixed(step2_text)] = step2_text
payload_bytes[candidate_triage["contentHash"]] = triage_text + b"Be concise.\n"

bundle_plain = {
    "format": "apbundle",
    "version": 1,
    "protocol": PROTOCOL,
    "encryption": {
        "scheme": "none",
        "contents": {
            "createdAt": "2026-09-12T10:05:00Z",
            "notAfter": "2026-10-12T10:05:00Z",
            "manifest": manifest,
            "keySet": key_set,
            "payloads": [{"contentHash": h, "byteLength": len(b), "bytes": b64url(b)} for h, b in sorted(payload_bytes.items())],
        },
    },
}
bundle_encrypted = {
    "format": "apbundle",
    "version": 1,
    "protocol": PROTOCOL,
    "encryption": {
        "scheme": "hpke-x25519-hkdf-sha256-aes-256-gcm",
        "recipientKeyId": "dist-acme-prod-2026",
        "enc": b64url(bytes([7] * 32)),
        "info": "airprompter-apbundle-v1",
        "ciphertext": b64url(bytes([9] * 96)),
    },
}

heartbeat_request = {
    "protocol": PROTOCOL,
    "instanceId": "inst_5f3c9a2b7e1d4c08",
    "sdk": {"name": "airprompterd", "version": "0.1.0", "protocolRange": ">=0.1.0 <1.0.0"},
    "host": {"os": "linux", "arch": "arm64", "runtime": "node/22.11.0"},
    "syncMode": "resident",
    "generation": {"active": 41, "staged": 42},
    "activeReleaseDigest": "sha256:" + "a" * 64,
    "stagedReleaseDigest": digest,
    "applyState": "awaiting_unlock",
    "signingKeyId": key_platform,
    "storageProtection": "kms",
    "catalog": {"models": ["claude-sonnet-5", "gpt-5"], "reportedAt": "2026-09-12T10:04:00Z"},
    "lease": {"expiresAt": "2026-09-12T11:00:00Z", "expired": False},
    "localRollback": {"active": False, "forced": False},
    "spool": {"depthSegments": 3, "depthBytes": 41210, "droppedSegments": 0, "quarantinedSegments": 0, "lastUploadAt": "2026-09-12T10:03:30Z"},
}
heartbeat_response = {
    "uploadGrant": {
        "grantId": "grt_0c1d2e3f4a5b6c7d",
        "url": "https://telemetry-ingest.s3.eu-central-1.amazonaws.com/",
        "fields": {
            "key": "org/org_7d3f9a2b/agent/agt_4e8c1b6d/prod/inst_5f3c9a2b7e1d4c08/${filename}",
            "policy": "eyJleHBpcmF0aW9uIjoi...",
            "x-amz-signature": "3f1e...",
            "x-amz-meta-grant-id": "grt_0c1d2e3f4a5b6c7d",
            "x-amz-server-side-encryption": "aws:kms",
        },
        "keyPrefix": "org/org_7d3f9a2b/agent/agt_4e8c1b6d/prod/inst_5f3c9a2b7e1d4c08/",
        "expiresAt": "2026-09-12T10:19:00Z",
        "maxObjectBytes": 1048576,
        "contentType": "application/x-ndjson",
    },
    "uploadIntervalSeconds": 60,
    "pollSeconds": 30,
    "edgePointerUrl": "https://edge.airprompter.com/g/" + b64url(bytes([5] * 32)) + "/generation.json",
}
heartbeat_throttled = {"pollSeconds": 120, "uploadIntervalSeconds": 600, "retryAfterSeconds": 300}
edge_pointer = {"generation": 42, "releaseDigest": digest, "leaseSeconds": 3600, "issuedAt": "2026-09-12T10:00:00Z"}

# Refused examples: structurally wrong documents the schema must reject.
refused = {
    "manifest.prompt-slot-with-steps.json": {"schema": "manifest", "reason": "workflow slots carry steps; prompt slots never do", "document": {**manifest, "payload": {**manifest_payload, "slots": [{**slots[0], "kind": "prompt", "steps": slots[0].get("steps", [{"stepId": "x#1", "ordinal": 1, "promptArtifactId": "a", "promptVersionId": "b", "contentHash": "sha256:" + "0" * 64, "byteLength": 1}])}]}}},
    "manifest.prompt-text-inside.json": {"schema": "manifest", "reason": "no prompt text is ever inside a manifest (additionalProperties: false)", "document": {**manifest, "payload": {**manifest_payload, "slots": [{**slots[0], "text": "You are..."}]}}},
    "manifest.unknown-directive.json": {"schema": "manifest", "reason": "directive kinds are a closed set", "document": {**manifest, "payload": {**manifest_payload, "directives": [{"kind": "reboot", "issuedAt": "2026-09-12T10:00:00Z"}]}}},
    "manifest.no-signature.json": {"schema": "manifest", "reason": "an unsigned envelope is not a manifest", "document": {**manifest, "signatures": []}},
    "manifest.generation-zero.json": {"schema": "manifest", "reason": "generation starts at 1", "document": {**manifest, "payload": {**manifest_payload, "generation": 0}}},
    "manifest.uppercase-tag.json": {"schema": "manifest", "reason": "slot tags follow the tag grammar", "document": {**manifest, "payload": {**manifest_payload, "slots": [{**slots[0], "tag": "Support.Triage"}]}}},
    "manifest.slot-disable-without-tag.json": {"schema": "manifest", "reason": "a slot-scoped disable names the slot", "document": {**manifest, "payload": {**manifest_payload, "directives": [{"kind": "disable", "scope": "slot", "issuedAt": "2026-09-12T10:00:00Z"}]}}},
    "key-set.wrong-curve.json": {"schema": "key-set", "reason": "only P-256 keys in this protocol major", "document": {**key_set, "signed": {**key_set["signed"], "keys": {key_root: {"keyType": "ecdsa-p256", "scheme": "ES256", "publicKey": {**jwk, "crv": "P-384"}}}}}},
    "key-set.missing-targets-role.json": {"schema": "key-set", "reason": "root metadata always names the targets role", "document": {**key_set, "signed": {**key_set["signed"], "roles": {"root": key_set["signed"]["roles"]["root"]}}}},
    "bundle.unknown-scheme.json": {"schema": "bundle", "reason": "encryption schemes are a closed set", "document": {**bundle_encrypted, "encryption": {**bundle_encrypted["encryption"], "scheme": "aes-128-cbc"}}},
    "bundle.plaintext-without-contents.json": {"schema": "bundle", "reason": "a plaintext bundle carries its contents", "document": {**bundle_plain, "encryption": {"scheme": "none"}}},
    "heartbeat.request.with-prompt-text.json": {"schema": "heartbeat-request", "reason": "content-free by schema: no free-form members", "document": {**heartbeat_request, "lastPrompt": "You are..."}},
    "heartbeat.request.hostname-instance.json": {"schema": "heartbeat-request", "reason": "instanceId is random and opaque, never a hostname", "document": {**heartbeat_request, "instanceId": "web-01.acme.internal"}},
    "heartbeat.response.grant-too-large.json": {"schema": "heartbeat-response", "reason": "a grant never allows objects above 1 MiB", "document": {**heartbeat_response, "uploadGrant": {**heartbeat_response["uploadGrant"], "maxObjectBytes": 10485760}}},
    "heartbeat.response.http-grant.json": {"schema": "heartbeat-response", "reason": "grants are https only", "document": {**heartbeat_response, "uploadGrant": {**heartbeat_response["uploadGrant"], "url": "http://telemetry-ingest.example/"}}},
    "edge-pointer.generation-zero.json": {"schema": "edge-pointer", "reason": "the pointer exists only after the first promotion", "document": {**edge_pointer, "generation": 0}},
}

root = sys.argv[1]
os.makedirs(os.path.join(root, "refused"), exist_ok=True)
def write(name, doc):
    with open(os.path.join(root, name), "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
write("manifest.json", manifest)
write("key-set.json", key_set)
write("bundle.plaintext.json", bundle_plain)
write("bundle.encrypted.json", bundle_encrypted)
write("heartbeat.request.json", heartbeat_request)
write("heartbeat.response.json", heartbeat_response)
write("heartbeat.response.throttled.json", heartbeat_throttled)
write("edge-pointer.json", edge_pointer)
for name, entry in refused.items():
    write(os.path.join("refused", name), entry)
print("releaseDigest", digest)
print("candidateDigest", candidate_digest)
