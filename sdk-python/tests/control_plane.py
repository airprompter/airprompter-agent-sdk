"""A fake control plane for SDK tests: an offline root ceremony, a signing
key, sealed manifests per generation, payloads by hash, an edge pointer —
served through an ``httpx.MockTransport`` the SDK takes as an option. Signs
exactly as the hosted service does (canonical payload bytes, ES256, P1363).
"""

from __future__ import annotations

import base64
import json
import os
import re
from typing import Any, Callable, Optional

import httpx

from airprompter_agent_core._util import instant, iso_ms, now_ms
from airprompter_agent_core.protocol.canonical_json import canonical_bytes, sha256_prefixed
from airprompter_agent_core.protocol.trust import experiments_of, generate_p256_jwk, key_thumbprint, public_jwk_of, release_digest, sign_bytes

#: The protocol version this checkout of the repository declares; manifests the fake signs carry it.
with open(os.path.join(os.path.dirname(__file__), "..", "..", "protocol", "VERSION"), encoding="utf-8") as _f:
    PROTOCOL = _f.read().strip()

new_key = generate_p256_jwk


def root_document(*, root_key: dict, signing_keys: list[dict], environment: str, version: int = 1, expires: str = "2027-12-11T00:00:00Z", purpose: str = "platform") -> dict[str, Any]:
    keys: dict[str, Any] = {}
    root_id = key_thumbprint(root_key)
    keys[root_id] = {"keyType": "ecdsa-p256", "scheme": "ES256", "publicKey": public_jwk_of(root_key)}
    target_ids = []
    for key in signing_keys:
        key_id = key_thumbprint(key)
        keys[key_id] = {"keyType": "ecdsa-p256", "scheme": "ES256", "publicKey": public_jwk_of(key)}
        target_ids.append(key_id)
    signed = {
        "type": "root",
        "protocol": PROTOCOL,
        "purpose": purpose,
        "environment": environment,
        "version": version,
        "expires": expires,
        "keys": keys,
        "roles": {"root": {"keyIds": [root_id], "threshold": 1}, "targets": {"keyIds": target_ids, "threshold": 1}},
    }
    return {"signed": signed, "signatures": [{"keyId": root_id, "alg": "ES256", "sig": sign_bytes(canonical_bytes(signed), root_key)}]}


class FakeControlPlane:
    def __init__(self, scope: dict[str, str], api_key: str = "apa_live_testkey", hosted_environment: Optional[str] = None):
        self.scope = scope
        self.api_key = api_key
        self.root_key = new_key()
        self.signing_key = new_key()
        self.root = root_document(root_key=self.root_key, signing_keys=[self.signing_key], environment=hosted_environment or scope["target"])
        self.payloads: dict[str, bytes] = {}
        self.requests: list[str] = []
        self._current: Optional[dict[str, Any]] = None
        self.generation = 0
        self.edge_etag = 0
        #: The pointer URL the manifest answer names; None = a deployment with no edge.
        self.edge_pointer_url: Optional[str] = "https://edge.test/g/target-token/generation.json"
        self.require_countersign = False
        # T9: every heartbeat body the fake accepted, and what it answers (a test may change the cadence).
        self.heartbeats: list[dict[str, Any]] = []
        #: S3: the generation a pinned pointer keeps answering with (None: the pointer follows promotions).
        self.pinned_pointer: Optional[int] = None
        #: S3: whether the heartbeat answer names the origin's generation (an older service does not).
        self.heartbeat_latest_generation = True
        self.heartbeat_interval_seconds = 300
        self.heartbeat_refusal: Optional[dict[str, Any]] = None
        # T26 / S5: the grant issuer and a fake S3 behind it. With ``grant_base_url`` set, every accepted heartbeat answers an
        # ``uploadGrant`` for the body's instance prefix (or ``retryAfterSeconds`` while ``grant_hold`` is set); the POST endpoint
        # at ``<grant_base_url>/s3/agent-telemetry`` checks the policy the way the bucket would and keeps the objects by key.
        self.grant_base_url: Optional[str] = None
        self.grant_ttl_ms = 15 * 60 * 1000
        self.grant_hold: Optional[dict[str, int]] = None
        self.grants: list[dict[str, str]] = []
        self.uploads: list[str] = []
        self.objects: dict[str, bytes] = {}
        self.fail_next_uploads = 0
        #: The issuer's and the bucket's clock (grant expiry, policy expiry); a test drives it beside the runtime's.
        self.now: Callable[[], float] = lambda: float(now_ms())
        self._grant_seq = 0

    def _issue_grant(self, instance_id: str, now: float) -> dict[str, Any]:
        self._grant_seq += 1
        grant_id = re.sub(r"[^A-Za-z0-9_-]", "_", f"grant_{self._grant_seq:04d}_{instance_id[:8]}").ljust(16, "0")
        key_prefix = f"org/{self.scope['organizationId']}/agent/{self.scope['agentId']}/{self.scope['target']}/{instance_id}/"
        expires_at = iso_ms(now + self.grant_ttl_ms)
        policy = base64.b64encode(json.dumps({"expiration": expires_at, "conditions": [["starts-with", "$key", key_prefix], ["content-length-range", 0, 1048576], {"Content-Type": "application/x-ndjson"}, {"x-amz-meta-grant-id": grant_id}]}).encode("utf-8")).decode("ascii")
        self.grants.append({"grantId": grant_id, "instanceId": instance_id, "keyPrefix": key_prefix, "expiresAt": expires_at})
        return {
            "grantId": grant_id,
            "url": f"{self.grant_base_url}/s3/agent-telemetry",
            "fields": {"policy": policy, "x-amz-algorithm": "AWS4-HMAC-SHA256", "x-amz-credential": "AKIAFAKE/20260912/eu-west-1/s3/aws4_request", "x-amz-date": "20260912T000000Z", "x-amz-signature": "fake", "x-amz-server-side-encryption": "aws:kms", "x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:eu-west-1:000000000000:key/fake", "x-amz-meta-grant-id": grant_id},
            "keyPrefix": key_prefix,
            "expiresAt": expires_at,
            "maxObjectBytes": 1048576,
            "contentType": "application/x-ndjson",
        }

    def _accept_upload(self, request: httpx.Request, now: float) -> httpx.Response:
        content_type = request.headers.get("content-type", "")
        match = re.search(r"boundary=([^;]+)", content_type)
        if not match:
            return httpx.Response(400, text="<Error><Code>MalformedPOSTRequest</Code></Error>")
        boundary = match.group(1).encode("utf-8")
        fields: dict[str, bytes] = {}
        file_bytes: Optional[bytes] = None
        for part in request.content.split(b"--" + boundary):
            if not part or part.startswith(b"--"):
                continue
            head, sep, body = part.partition(b"\r\n\r\n")
            if not sep:
                continue
            body = body[:-2] if body.endswith(b"\r\n") else body
            name_match = re.search(rb'name="([^"]+)"', head)
            if not name_match:
                continue
            name = name_match.group(1).decode("utf-8")
            if name == "file":
                file_bytes = body
            else:
                fields[name] = body
        key = fields.get("key", b"").decode("utf-8")
        grant_id = fields.get("x-amz-meta-grant-id", b"").decode("utf-8")
        grant = next((g for g in self.grants if g["grantId"] == grant_id), None)
        if grant is None or not key.startswith(grant["keyPrefix"]):
            return httpx.Response(403, text="<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: Policy Condition failed: [\"starts-with\", \"$key\", ...]</Message></Error>")
        if now >= float(instant(grant["expiresAt"])):
            return httpx.Response(403, text="<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: Policy expired.</Message></Error>")
        if fields.get("Content-Type", b"").decode("utf-8") != "application/x-ndjson":
            return httpx.Response(403, text="<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: Policy Condition failed: [\"eq\", \"$Content-Type\", ...]</Message></Error>")
        if file_bytes is None or len(file_bytes) > 1048576:
            return httpx.Response(400, text="<Error><Code>EntityTooLarge</Code></Error>")
        if self.fail_next_uploads > 0:
            self.fail_next_uploads -= 1
            return httpx.Response(500, text="<Error><Code>InternalError</Code></Error>")
        self.uploads.append(key)
        self.objects[key] = file_bytes
        return httpx.Response(204)

    def slot(self, *, tag: str, text: str, model: str = "claude-sonnet-5", variables: Optional[list] = None, version_id: Optional[str] = None, steps: Optional[list[dict]] = None) -> dict[str, Any]:
        data = text.encode("utf-8")
        content_hash = sha256_prefixed(data)
        self.payloads[content_hash] = data
        slot: dict[str, Any] = {
            "tag": tag,
            "kind": "workflow" if steps else "prompt",
            "artifactId": f"art_{tag}",
            "versionId": version_id or f"ver_{tag}_1",
            "versionOrdinal": 1,
            "contentHash": content_hash,
            "byteLength": len(data),
            "model": model,
            "variables": variables or [],
        }
        if steps:
            slot["steps"] = []
            for index, step in enumerate(steps):
                step_bytes = step["text"].encode("utf-8")
                step_hash = sha256_prefixed(step_bytes)
                self.payloads[step_hash] = step_bytes
                slot["steps"].append({"stepId": f"{tag}#{index + 1}", "ordinal": index + 1, "promptArtifactId": f"art_{tag}_{index + 1}", "promptVersionId": step.get("versionId") or f"ver_{tag}_step{index + 1}", "contentHash": step_hash, "byteLength": len(step_bytes), **({"inference": step["inference"]} if step.get("inference") else {})})
        return slot

    def promote(self, slots: list[dict[str, Any]], *, apply_policy: str = "auto", lease_seconds: int = 3600, experiment: Optional[dict] = None, experiments: Optional[list[dict]] = None, directives: Optional[list] = None, on_lease_expiry: str = "degrade", unlock_window: Optional[dict] = None, sign_with: Optional[dict] = None, generation: Optional[int] = None) -> dict[str, Any]:
        """Seal and promote: generation + 1, signed with the signing key."""
        ordered = sorted(slots, key=lambda s: s["tag"])
        self.generation = generation if generation is not None else self.generation + 1
        payload: dict[str, Any] = {
            "protocol": PROTOCOL,
            **self.scope,
            "generation": self.generation,
            "releaseDigest": release_digest(ordered),
            "issuedAt": iso_ms(now_ms()),
            "leaseSeconds": lease_seconds,
            "onLeaseExpiry": on_lease_expiry,
            "applyPolicy": apply_policy,
            "requireCountersign": self.require_countersign,
            "slots": ordered,
            "directives": directives or [],
        }
        if unlock_window:
            payload["unlockWindow"] = unlock_window
        if experiment:
            payload["experiment"] = experiment
        if experiments:
            payload["experiments"] = experiments
        signer = sign_with or self.signing_key
        manifest = {"payload": payload, "signatures": [{"keyId": key_thumbprint(signer), "alg": "ES256", "sig": sign_bytes(canonical_bytes(payload), signer)}], "countersignatures": []}
        data = json.dumps(manifest).encode("utf-8")
        self._current = {"manifest": manifest, "bytes": data, "etag": sha256_prefixed(data)}
        self.edge_etag += 1
        return manifest

    @property
    def manifest(self) -> Optional[dict[str, Any]]:
        return self._current["manifest"] if self._current else None

    def transport(self) -> httpx.MockTransport:
        """The transport the SDK sees."""

        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            self.requests.append(url)
            path = request.url.path
            auth = request.headers.get("authorization")
            if self.grant_base_url and url.startswith(self.grant_base_url) and path.endswith("/s3/agent-telemetry") and request.method == "POST":
                return self._accept_upload(request, self.now())
            if path.endswith("/generation.json"):
                if not self._current:
                    return httpx.Response(404)
                payload = self._current["manifest"]["payload"]
                if self.pinned_pointer is not None:
                    # S3: a party between the fleet and the edge pins the pointer — the same stale answer, the same ETag, forever.
                    pinned_etag = f'"edge-pinned-{self.pinned_pointer}"'
                    if request.headers.get("if-none-match") == pinned_etag:
                        return httpx.Response(304)
                    return httpx.Response(200, json={"generation": self.pinned_pointer, "releaseDigest": payload["releaseDigest"], "leaseSeconds": payload["leaseSeconds"]}, headers={"etag": pinned_etag})
                etag = f'"edge-{self.edge_etag}"'
                if request.headers.get("if-none-match") == etag:
                    return httpx.Response(304)
                return httpx.Response(200, json={"generation": payload["generation"], "releaseDigest": payload["releaseDigest"], "leaseSeconds": payload["leaseSeconds"]}, headers={"etag": etag})
            if path.endswith("/root.json"):
                return httpx.Response(200, json=self.root)
            if auth != f"Bearer {self.api_key}":
                return httpx.Response(401, json={"error": "Unauthorized"})
            slots_match = re.match(r"^/v1/agents/([^/]+)/targets/([^/]+)/slots$", path)
            if slots_match:
                if slots_match.group(1) != self.scope["agentId"] or slots_match.group(2) != self.scope["target"]:
                    return httpx.Response(403, json={"error": "Forbidden", "code": "forbidden", "detail": "agent_mismatch" if slots_match.group(1) != self.scope["agentId"] else "target_mismatch"})
                if not self._current:
                    return httpx.Response(404, json={"error": "nothing is promoted to this environment", "code": "nothing_promoted"})
                payload = self._current["manifest"]["payload"]
                catalogue = {
                    "agentId": payload["agentId"],
                    "target": payload["target"],
                    "generation": payload["generation"],
                    "releaseDigest": payload["releaseDigest"],
                    "slots": [{"tag": p["tag"], "kind": p["kind"], "model": p["model"], "variables": p["variables"], "steps": [{"stepId": s["stepId"]} for s in p["steps"]] if p.get("steps") else None} for p in payload["slots"]],
                    "experiment": {"salt": payload["experiment"]["salt"], "subjectKey": payload["experiment"]["subjectKey"], "arms": [a["arm"] for a in payload["experiment"]["arms"]]} if payload.get("experiment") else None,
                    "experiments": [{"experimentId": e["experimentId"], "tag": e.get("tag"), "salt": e["salt"], "subjectKey": e["subjectKey"], "arms": [a["arm"] for a in e["arms"]]} for e in experiments_of(payload)],
                }
                return httpx.Response(200, json=catalogue, headers={"x-agent-generation": str(payload["generation"])})
            heartbeat_match = re.match(r"^/v1/agents/([^/]+)/targets/([^/]+)/heartbeat$", path)
            if heartbeat_match:
                if heartbeat_match.group(1) != self.scope["agentId"] or heartbeat_match.group(2) != self.scope["target"]:
                    return httpx.Response(403, json={"error": "x", "details": {"code": "agent_mismatch" if heartbeat_match.group(1) != self.scope["agentId"] else "target_mismatch"}})
                if self.heartbeat_refusal:
                    return httpx.Response(self.heartbeat_refusal["status"], json={"error": "x", "details": {"code": self.heartbeat_refusal["code"]}})
                body = json.loads(request.content or b"{}")
                for key in ("protocol", "instanceId", "sdk", "syncMode", "generation", "applyState", "storageProtection", "catalog", "lease", "spool"):
                    if key not in body:
                        return httpx.Response(400, json={"error": f"heartbeat: missing {key}"})
                allowed = {"protocol", "instanceId", "instanceClass", "sdk", "host", "syncMode", "heartbeatIntervalSeconds", "generation", "activeReleaseDigest", "stagedReleaseDigest", "applyState", "refusal", "signingKeyId", "storageProtection", "catalog", "lease", "localRollback", "spool", "unlockRequestsSeen", "disabled", "applyPolicy"}
                for key in body:
                    if key not in allowed:
                        return httpx.Response(400, json={"error": f"heartbeat: unknown {key}"})
                self.heartbeats.append(body)
                answer: dict = {"pollSeconds": 30, "uploadIntervalSeconds": 300, "heartbeatIntervalSeconds": self.heartbeat_interval_seconds, "expiresAt": iso_ms(now_ms() + self.heartbeat_interval_seconds * 3000)}
                if self.grant_base_url:
                    if self.grant_hold:
                        answer["retryAfterSeconds"] = self.grant_hold["retryAfterSeconds"]
                    else:
                        answer["uploadGrant"] = self._issue_grant(str(body["instanceId"]), self.now())
                # S3: the authenticated answer names the origin's generation; a runtime whose pointer says less goes to the manifest.
                if self.heartbeat_latest_generation:
                    answer["latestGeneration"] = self._current["manifest"]["payload"]["generation"] if self._current else 0
                return httpx.Response(200, json=answer)
            manifest_match = re.match(r"^/v1/agents/([^/]+)/targets/([^/]+)/manifest$", path)
            if manifest_match:
                if manifest_match.group(1) != self.scope["agentId"]:
                    return httpx.Response(403, json={"error": "x", "details": {"code": "agent_mismatch"}})
                if manifest_match.group(2) != self.scope["target"]:
                    return httpx.Response(403, json={"error": "x", "details": {"code": "target_mismatch"}})
                if not self._current:
                    return httpx.Response(404, json={"error": "Not found"})
                # The answer names the edge pointer, as the service does (a deployment without an edge omits the header).
                pointer_header = {"x-agent-edge-pointer-url": self.edge_pointer_url} if self.edge_pointer_url else {}
                if request.headers.get("if-none-match") == self._current["etag"]:
                    return httpx.Response(304, headers={"etag": self._current["etag"], **pointer_header})
                return httpx.Response(200, content=self._current["bytes"], headers={"etag": self._current["etag"], "x-agent-generation": str(self._current["manifest"]["payload"]["generation"]), "content-type": "application/json", **pointer_header})
            payload_match = re.match(r"^/v1/agents/([^/]+)/payloads/(sha256:[0-9a-f]{64})$", path)
            if payload_match:
                data = self.payloads.get(payload_match.group(2))
                return httpx.Response(200, content=data) if data is not None else httpx.Response(404, json={"error": "Not found"})
            return httpx.Response(404, json={"error": "Not found"})

        return httpx.MockTransport(handler)
