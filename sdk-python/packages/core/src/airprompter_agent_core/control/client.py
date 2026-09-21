"""The three reads a runtime makes, over outbound HTTPS with the Agent key:
the edge pointer (no key), the manifest (ETag / 304), and payloads by
content hash (inline or a presigned redirect, which the client follows).
Nothing here decides anything; the trust chain runs on what comes back.

Example::

    client = SyncClient(base_url="https://api.airprompter.com", agent_id="agt_1", target="prod", api_key=agent_key)
    fetched = client.manifest(if_none_match=last_etag)   # status: ok | not_modified | not_found | unauthorized | forbidden | error
    if fetched.status == "ok":
        data = client.payload(fetched.manifest["payload"]["slots"][0]["contentHash"])   # bytes, or None for a 404
    client.close()
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import quote

import httpx

#: 0.3.5: the five refusal codes a ``?release=`` read can answer (pins.md); a runtime asking without ``release`` never sees this variant.
SEAL_REFUSAL_CODES = frozenset({"seal_invalid", "release_unknown", "release_ambiguous", "release_not_promoted_here", "wait_with_release"})


@dataclass
class ManifestFetch:
    status: str  # "ok" | "not_modified" | "not_found" | "unauthorized" | "forbidden" | "refused_seal" | "error"
    manifest: Optional[dict[str, Any]] = None
    etag: Optional[str] = None
    generation: Optional[int] = None
    code: Optional[str] = None
    http_status: Optional[int] = None
    #: The edge pointer this target's answers name (``x-agent-edge-pointer-url``); None on a deployment without an edge.
    edge_pointer_url: Optional[str] = None
    #: ``status == "refused_seal"`` and ``code == "release_ambiguous"`` only: the seal ids a short prefix matched.
    matches: Optional[list[str]] = None


@dataclass
class EdgePointerFetch:
    status: str  # "ok" | "not_modified" | "unavailable"
    pointer: Optional[dict[str, Any]] = None
    etag: Optional[str] = None


@dataclass
class HeartbeatResult:
    status: str  # "ok" | "refused" | "error"
    response: Optional[dict[str, Any]] = None
    http_status: Optional[int] = None
    code: Optional[str] = None


def _refusal_code(text: str) -> Optional[str]:
    try:
        details = json.loads(text).get("details") or {}
        code = details.get("code")
        return str(code) if code is not None else None
    except (ValueError, AttributeError):
        return None


class SyncClient:
    def __init__(self, *, base_url: str, agent_id: str, target: str, api_key: str, transport: Optional[httpx.BaseTransport] = None, user_agent: str = "airprompter-agent-sdk-python", timeout: float = 30.0):
        self._base_url = base_url.rstrip("/")
        self._agent_id = agent_id
        self._target = target
        self._api_key = api_key
        self._user_agent = user_agent
        self._client = httpx.Client(transport=transport, timeout=timeout, follow_redirects=True)

    def close(self) -> None:
        self._client.close()

    def _headers(self, **extra: str) -> dict[str, str]:
        return {"authorization": f"Bearer {self._api_key}", "user-agent": self._user_agent, **extra}

    def edge_pointer(self, url: str, etag: Optional[str]) -> EdgePointerFetch:
        headers = {"user-agent": self._user_agent}
        if etag:
            headers["if-none-match"] = etag
        response = self._client.get(url, headers=headers)
        if response.status_code == 304:
            return EdgePointerFetch("not_modified")
        if response.status_code != 200:
            return EdgePointerFetch("unavailable")
        return EdgePointerFetch("ok", pointer=json.loads(response.text), etag=response.headers.get("etag"))

    def manifest(self, *, if_none_match: Optional[str] = None, wait: Optional[int] = None, release: Optional[str] = None) -> ManifestFetch:
        # pins.md: `?release=` never long-polls — the release it names does not move by definition — and the platform
        # refuses the combination too (`wait_with_release`); refusing it here saves the round trip.
        if wait and release:
            raise ValueError("manifest: release cannot be combined with wait")
        url = f"{self._base_url}/v1/agents/{quote(self._agent_id, safe='')}/targets/{self._target}/manifest"
        params: dict[str, str] = {}
        if wait:
            params["wait"] = str(wait)
        if release:
            params["release"] = release
        headers = self._headers(**({"if-none-match": if_none_match} if if_none_match else {}))
        response = self._client.get(url, headers=headers, params=params or None)
        status = response.status_code
        edge_pointer_url = response.headers.get("x-agent-edge-pointer-url")
        if status == 304:
            return ManifestFetch("not_modified", edge_pointer_url=edge_pointer_url)
        # 0.3.5: a pinned read's 400/404/409 may be one of the five seal refusals (pins.md) — read the body before
        # falling back to the unpinned mapping below, so an unrelated 400/404/409 is never silently swallowed as a
        # seal refusal.
        if release and status in (400, 404, 409):
            if status == 409:
                # The 409 body is shaped `{ error, matches }` (openapi.yaml), not the common `{ error, details }`
                # refusal — `matches` lives at the top, so it is read here rather than through `_refusal_code`.
                matches: Optional[list[str]] = None
                try:
                    parsed = json.loads(response.text)
                    raw_matches = parsed.get("matches")
                    if isinstance(raw_matches, list):
                        matches = [m for m in raw_matches if isinstance(m, str)]
                except (ValueError, AttributeError):
                    matches = None
                return ManifestFetch("refused_seal", code="release_ambiguous", matches=matches)
            code = _refusal_code(response.text)
            if code in SEAL_REFUSAL_CODES:
                return ManifestFetch("refused_seal", code=code)
        if status == 404:
            return ManifestFetch("not_found")
        if status == 401:
            return ManifestFetch("unauthorized")
        if status == 403:
            return ManifestFetch("forbidden", code=_refusal_code(response.text))
        if status != 200:
            return ManifestFetch("error", http_status=status)
        generation = response.headers.get("x-agent-generation")
        return ManifestFetch("ok", manifest=json.loads(response.text), etag=response.headers.get("etag"), generation=int(generation) if generation else None, edge_pointer_url=edge_pointer_url)

    def heartbeat(self, body: dict[str, Any]) -> HeartbeatResult:
        """T9: the heartbeat. Content-free by schema; the response carries the cadence, the expiry and (T12) the upload grant."""
        url = f"{self._base_url}/v1/agents/{quote(self._agent_id, safe='')}/targets/{self._target}/heartbeat"
        response = self._client.post(url, headers=self._headers(**{"content-type": "application/json"}), content=json.dumps(body).encode("utf-8"))
        status = response.status_code
        if status == 200:
            return HeartbeatResult("ok", response=json.loads(response.text))
        if status in (400, 401, 403, 429):
            return HeartbeatResult("refused", http_status=status, code=_refusal_code(response.text))
        return HeartbeatResult("error", http_status=status)

    def payload(self, content_hash: str) -> Optional[bytes]:
        url = f"{self._base_url}/v1/agents/{quote(self._agent_id, safe='')}/payloads/{content_hash}"
        response = self._client.get(url, headers=self._headers())
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise RuntimeError(f"payload {content_hash}: HTTP {response.status_code}")
        return response.content
