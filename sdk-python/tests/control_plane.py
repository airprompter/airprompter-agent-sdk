"""A fake control plane for SDK tests: an offline root ceremony, a signing
key, sealed manifests per generation, payloads by hash, an edge pointer —
served through an ``httpx.MockTransport`` the SDK takes as an option. Signs
exactly as the hosted service does (canonical payload bytes, ES256, P1363).
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Optional

import httpx

from airprompter_agent._util import iso_ms, now_ms
from airprompter_agent.protocol.canonical_json import canonical_bytes, sha256_prefixed
from airprompter_agent.protocol.trust import generate_p256_jwk, key_thumbprint, public_jwk_of, release_digest, sign_bytes

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
    def __init__(self, scope: dict[str, str], api_key: str = "apa_live_testkey"):
        self.scope = scope
        self.api_key = api_key
        self.root_key = new_key()
        self.signing_key = new_key()
        self.root = root_document(root_key=self.root_key, signing_keys=[self.signing_key], environment=scope["target"])
        self.payloads: dict[str, bytes] = {}
        self.requests: list[str] = []
        self._current: Optional[dict[str, Any]] = None
        self.generation = 0
        self.edge_etag = 0
        self.require_countersign = False
        # T9: every heartbeat body the fake accepted, and what it answers (a test may change the cadence).
        self.heartbeats: list[dict[str, Any]] = []
        #: S3: the generation a pinned pointer keeps answering with (None: the pointer follows promotions).
        self.pinned_pointer: Optional[int] = None
        #: S3: whether the heartbeat answer names the origin's generation (an older service does not).
        self.heartbeat_latest_generation = True
        self.heartbeat_interval_seconds = 300
        self.heartbeat_refusal: Optional[dict[str, Any]] = None

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
                slot["steps"].append({"stepId": f"{tag}#{index + 1}", "ordinal": index + 1, "promptArtifactId": f"art_{tag}_{index + 1}", "promptVersionId": step.get("versionId") or f"ver_{tag}_step{index + 1}", "contentHash": step_hash, "byteLength": len(step_bytes)})
        return slot

    def promote(self, slots: list[dict[str, Any]], *, apply_policy: str = "auto", lease_seconds: int = 3600, experiment: Optional[dict] = None, directives: Optional[list] = None, on_lease_expiry: str = "degrade", unlock_window: Optional[dict] = None, sign_with: Optional[dict] = None, generation: Optional[int] = None) -> dict[str, Any]:
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
                allowed = {"protocol", "instanceId", "instanceClass", "sdk", "host", "syncMode", "heartbeatIntervalSeconds", "generation", "activeReleaseDigest", "stagedReleaseDigest", "applyState", "refusal", "signingKeyId", "storageProtection", "catalog", "lease", "localRollback", "spool", "unlockRequestsSeen", "disabled"}
                for key in body:
                    if key not in allowed:
                        return httpx.Response(400, json={"error": f"heartbeat: unknown {key}"})
                self.heartbeats.append(body)
                answer: dict = {"pollSeconds": 30, "uploadIntervalSeconds": 300, "heartbeatIntervalSeconds": self.heartbeat_interval_seconds, "expiresAt": iso_ms(now_ms() + self.heartbeat_interval_seconds * 3000)}
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
                if request.headers.get("if-none-match") == self._current["etag"]:
                    return httpx.Response(304, headers={"etag": self._current["etag"]})
                return httpx.Response(200, content=self._current["bytes"], headers={"etag": self._current["etag"], "x-agent-generation": str(self._current["manifest"]["payload"]["generation"]), "content-type": "application/json"})
            payload_match = re.match(r"^/v1/agents/([^/]+)/payloads/(sha256:[0-9a-f]{64})$", path)
            if payload_match:
                data = self.payloads.get(payload_match.group(2))
                return httpx.Response(200, content=data) if data is not None else httpx.Response(404, json={"error": "Not found"})
            return httpx.Response(404, json={"error": "Not found"})

        return httpx.MockTransport(handler)
