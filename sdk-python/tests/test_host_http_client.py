"""The HTTP client frames the request, never the SDK. Parity with ``sdk-typescript/test/hostHttpClient.test.ts``.

The telemetry POST used to set ``content-length`` itself. httpx derives it from ``content`` anyway, but a host's own
HTTP stack may refuse a caller-set framing header (a userland undici as Node's global dispatcher does, which is how the
TypeScript SDK broke under n8n). httpx never refused the old header, so the change here is parity, and the static guard
is the regression guard: no SDK source sets a header the HTTP client owns, with the detector proven on the line that
was fixed. The wire test is a conformance check (it passed before the change too): ``post_segment`` over httpx's real
transport against a listener on 127.0.0.1 lands the segment, and the one ``content-length`` on it is the client's.
"""
from __future__ import annotations

import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from airprompter_agent.core._util import iso_ms
from airprompter_agent.telemetry.uploader import UploadGrant, post_segment

CLIENT_OWNED = ["content-length", "host", "transfer-encoding", "connection", "keep-alive", "expect", "te", "trailer", "upgrade", "proxy-connection"]
_NAME = "[\"']?(" + "|".join(re.escape(n) for n in CLIENT_OWNED) + ")[\"']?"
# A headers dict literal: ``headers={``, ``headers = {``, ``self._headers(**{``, ``headers.update({``.
_OPENER = re.compile(r"headers\w*(?:\.update)?\s*(?:[:=]\s*|\(\s*(?:\*\*)?)\{", re.IGNORECASE)
_KEY = re.compile(r"(?:^|[{,\s])" + _NAME + r"\s*:", re.IGNORECASE | re.MULTILINE)
_INDEX_WRITE = re.compile(r"headers\w*\[\s*" + _NAME + r"\s*\]\s*=(?!=)", re.IGNORECASE)
# The hyphenated names mean nothing but a header, so anywhere as a quoted key or a ``(name, value)`` pair: a headers
# dict held in another variable, ``dict(**{…})``, a list of tuples.
_HYPHENATED = "|".join(re.escape(n) for n in CLIENT_OWNED if "-" in n)
_ANYWHERE = re.compile(r"[\"'](" + _HYPHENATED + r")[\"']\s*:|[\[(]\s*[\"'](" + _HYPHENATED + r")[\"']\s*,", re.IGNORECASE)


def client_owned_headers_set(source: str) -> list[str]:
    """Every client-owned header a source sets: a key in a headers dict literal, or an index write by name."""
    found: list[str] = []
    for opener in _OPENER.finditer(source):
        start = opener.end() - 1
        depth = 0
        end = start
        while end < len(source):
            if source[end] == "{":
                depth += 1
            elif source[end] == "}":
                depth -= 1
                if depth == 0:
                    break
            end += 1
        found += [m.group(1).lower() for m in _KEY.finditer(source[start : end + 1])]
    found += [m.group(1).lower() for m in _INDEX_WRITE.finditer(source)]
    found += [(m.group(1) or m.group(2)).lower() for m in _ANYWHERE.finditer(source)]
    return list(dict.fromkeys(found))


def test_post_segment_over_httpx_lands_and_the_client_frames_the_body():
    seen: list[dict] = []

    class Bucket(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 — the stdlib's name
            length = int(self.headers.get("content-length", "0"))
            body = self.rfile.read(length)
            seen.append({"content-length": self.headers.get_all("content-length"), "transfer-encoding": self.headers.get("transfer-encoding"), "body": body})
            self.send_response(204)
            self.end_headers()

        def log_message(self, *args):  # quiet
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Bucket)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/s3/agent-telemetry"
        grant = UploadGrant(grant_id="g", url=url, fields={"policy": "cG9saWN5"}, key_prefix="p/", expires_at=iso_ms(time.time() * 1000 + 600_000), max_object_bytes=1024 * 1024)
        data = b'{"type":"window"}\n'
        outcome = post_segment(grant=grant, segment="seg-i-x-1-0.ndjson", data=data, boundary="B")
        assert outcome.status == "ok", outcome
        assert outcome.key == "p/seg-i-x-1-0.ndjson"
        assert len(seen) == 1
        assert seen[0]["content-length"] == [str(len(seen[0]["body"]))], "one content-length, the client's, matching the body"
        assert seen[0]["transfer-encoding"] is None
        assert data in seen[0]["body"]
    finally:
        server.shutdown()
        server.server_close()


def test_the_detector_finds_the_fixed_line_and_the_other_ways_to_set_a_client_owned_header():
    assert client_owned_headers_set('response = http.post(grant.url, headers={"content-type": f"multipart/form-data; boundary={bnd}", "content-length": str(len(body))}, content=body)') == ["content-length"]
    assert client_owned_headers_set('headers = {"Host": "api.test", "Connection": "close"}') == ["host", "connection"]
    assert client_owned_headers_set('self._headers(**{"expect": "100-continue"})') == ["expect"]
    assert client_owned_headers_set('headers["Transfer-Encoding"] = "chunked"\nrequest_headers.update({"keep-alive": "1"})') == ["keep-alive", "transfer-encoding"]
    assert client_owned_headers_set('framing = {"Content-Length": n}\nhttp.post(u, headers=dict(**framing))\npairs = [("transfer-encoding", "chunked")]') == ["content-length", "transfer-encoding"]
    assert client_owned_headers_set('report = {"host": {"os": "linux"}, "connection": 1}\npolicy = ["content-length-range", 0, 1048576]') == [], "a heartbeat's host field and an S3 policy condition are not headers"


def test_no_source_in_any_python_package_sets_a_header_the_http_client_owns():
    packages = Path(__file__).resolve().parent.parent / "packages"
    offenders: list[str] = []
    scanned = 0
    for path in sorted(packages.glob("*/src/**/*.py")):
        scanned += 1
        offenders += [f"{path.relative_to(packages)}: {name}" for name in client_owned_headers_set(path.read_text("utf-8"))]
    assert scanned > 30, f"scanned {scanned} files"
    assert offenders == [], "httpx frames the request; a host's own HTTP stack may refuse a caller-set framing header"
