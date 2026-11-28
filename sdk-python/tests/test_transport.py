"""The SDK's HTTP seam (``airprompter_agent.core.http``): what ``transport=`` takes, the default that serves it, and the
redirects the SDK follows itself.

The default runs against a real local server here, so the weekly httpx canary (``wrap-latest.yml``) runs these against
the newest httpx: a change in httpx shows as a red test on the default transport, never in a customer's signature.
"""

from __future__ import annotations

import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterator

import pytest

import airprompter_agent.core.http as http
from airprompter_agent import AirPrompterAgent
from airprompter_agent.core import HttpRequest, HttpResponse, SyncClient, default_transport
from airprompter_agent.core.http import close_transport, send, send_once
from airprompter_agent.telemetry import AirPrompterUploadSink
from airprompter_agent.core.protocol.trust import public_jwk_of
from airprompter_agent_otel.exporter import http_json_exporter

from .control_plane import new_key


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:  # quiet
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/slow":
            time.sleep(1.0)
        if self.path == "/moved":
            self.send_response(302)
            self.send_header("Location", "/here")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = f"{self.path} {self.headers.get('X-Probe')}".encode()
        self.send_response(200)
        self.send_header("ETag", '"v1"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(201)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body[::-1])


@pytest.fixture()
def server() -> Iterator[str]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_the_default_transport_sends_one_request_and_answers_in_the_sdks_own_types(server: str):
    transport = default_transport()
    try:
        got = transport(HttpRequest("GET", f"{server}/a?b=1", {"x-probe": "yes"}))
        assert isinstance(got, HttpResponse)
        assert (got.status, got.text) == (200, "/a?b=1 yes")
        assert got.header("ETAG") == '"v1"', "a header reads in any case"
        posted = transport(HttpRequest("POST", f"{server}/p", {"content-type": "application/octet-stream"}, b"abc"))
        assert (posted.status, posted.content) == (201, b"cba")
        assert transport(HttpRequest("GET", f"{server}/moved")).status == 302, "a redirect is an answer: the SDK follows it, not the transport"
        assert send(transport, HttpRequest("GET", f"{server}/moved")).text == "/here None"
    finally:
        close_transport(transport)
    with pytest.raises(ConnectionError, match="closed"):
        transport(HttpRequest("GET", f"{server}/a"))


def test_a_timeout_is_timeout_error_no_answer_is_connection_error_and_a_bad_url_is_value_error(server: str):
    transport = default_transport()
    try:
        with pytest.raises(TimeoutError):
            transport(HttpRequest("GET", f"{server}/slow", timeout=0.2))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            closed = probe.getsockname()[1]
        with pytest.raises(ConnectionError):
            transport(HttpRequest("GET", f"http://127.0.0.1:{closed}/", timeout=2.0))
        with pytest.raises(ValueError):
            transport(HttpRequest("GET", "http://[::1"))
    finally:
        close_transport(transport)


def test_redirects_are_followed_by_the_sdk_and_the_key_never_leaves_the_origin():
    seen: list[HttpRequest] = []

    def hops(request: HttpRequest) -> HttpResponse:
        seen.append(request)
        if request.url == "https://api.test/v1/x":
            return HttpResponse(302, {"Location": "/v1/y"})
        if request.url == "https://api.test/v1/y":
            return HttpResponse(307, {"location": "https://bucket.test/presigned?sig=1"})
        if request.url == "https://api.test/v1/post":
            return HttpResponse(303, {"location": "https://api.test/v1/done"})
        return HttpResponse(200, {}, b"ok")

    assert send(hops, HttpRequest("GET", "https://api.test/v1/x", {"authorization": "Bearer k", "user-agent": "u"})).text == "ok"
    assert [request.url for request in seen] == ["https://api.test/v1/x", "https://api.test/v1/y", "https://bucket.test/presigned?sig=1"]
    assert seen[1].headers["authorization"] == "Bearer k", "the same origin keeps the key"
    assert "authorization" not in seen[2].headers and seen[2].headers["user-agent"] == "u", "another origin never sees it"
    seen.clear()
    send(hops, HttpRequest("POST", "https://api.test/v1/post", {"content-type": "application/json"}, b"{}"))
    assert (seen[1].method, seen[1].content, "content-type" in seen[1].headers) == ("GET", b"", False), "a 303 is a GET"
    seen.clear()

    def downgrade(request: HttpRequest) -> HttpResponse:
        seen.append(request)
        return HttpResponse(307, {"location": "http://api.test/v1/x"}) if request.url.startswith("https:") else HttpResponse(200)

    send(downgrade, HttpRequest("GET", "https://api.test/v1/x", {"authorization": "Bearer k"}))
    assert "authorization" not in seen[1].headers, "the origin is scheme and host: https to http on one host drops the key"
    hops_made: list[str] = []

    def loop(request: HttpRequest) -> HttpResponse:
        hops_made.append(request.url)
        return HttpResponse(302, {"location": request.url})

    with pytest.raises(ConnectionError, match="redirects"):
        send(loop, HttpRequest("GET", "https://api.test/loop"))
    assert len(hops_made) == http.MAX_REDIRECTS + 1, "the first request and five redirects, then it stops"


def test_any_callable_is_a_transport_and_the_sdk_never_closes_one_it_did_not_open():
    seen: list[HttpRequest] = []

    class Recording:
        closed = False

        def __call__(self, request: HttpRequest) -> HttpResponse:
            seen.append(request)
            return HttpResponse(404)

        def close(self) -> None:
            self.closed = True

    recording = Recording()
    client = SyncClient(base_url="https://api.test/", agent_id="agt 1", target="prod", api_key="k", transport=recording, user_agent="probe/1")
    assert client.payload("sha256:" + "0" * 64) is None
    assert client.manifest(wait=20).status == "not_found"
    client.close()
    assert not recording.closed, "the caller's transport is the caller's to close"
    assert seen[0].url == "https://api.test/v1/agents/agt%201/payloads/sha256:" + "0" * 64
    assert seen[1].url.endswith("/v1/agents/agt%201/targets/prod/manifest?wait=20")
    assert seen[0].headers["authorization"] == "Bearer k" and seen[0].headers["user-agent"] == "probe/1"
    assert send_once(recording, HttpRequest("GET", "https://api.test/x")).status == 404 and not recording.closed


def test_send_once_closes_the_default_it_opened(monkeypatch):
    opened: list[object] = []

    class Default:
        def __call__(self, request: HttpRequest) -> HttpResponse:
            return HttpResponse(204)

    real_close = http.close_transport
    monkeypatch.setattr(http, "default_transport", lambda: opened.append(Default()) or opened[-1])
    closed: list[object] = []
    monkeypatch.setattr(http, "close_transport", lambda transport: closed.append(transport) or real_close(transport))
    assert send_once(None, HttpRequest("GET", "https://api.test/x")).status == 204
    assert closed == opened and len(opened) == 1


def test_an_httpx_transport_from_before_is_refused_at_the_door(tmp_path):
    import httpx

    old = httpx.MockTransport(lambda request: httpx.Response(200))
    with pytest.raises(TypeError, match="transport= takes a callable"):
        SyncClient(base_url="https://api.test", agent_id="agt_1", target="prod", api_key="k", transport=old)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="transport= takes a callable"):
        AirPrompterAgent.start(organization_id="org_1", agent_id="agt_1", target="prod", api_key="k", base_url="https://api.test", state_dir=str(tmp_path), root={"pinned": public_jwk_of(new_key())}, transport=old)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="transport= takes a callable"):
        AirPrompterAgent.start(organization_id="org_1", agent_id="agt_1", target="prod", state_dir=str(tmp_path / "offline"), root={"pinned": public_jwk_of(new_key())}, sync={"mode": "offline"}, transport=old)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="transport= takes a callable"):
        AirPrompterUploadSink(grant_for=lambda **_: None, transport=old)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="transport= takes a callable"):
        http_json_exporter(endpoint="http://collector.test/v1/metrics", transport=old)  # type: ignore[arg-type]


def test_the_exporter_closes_the_default_transport_it_opens_for_an_export(monkeypatch):
    import airprompter_agent_otel.exporter as exporter

    opened: list[object] = []

    class Default:
        closed = False

        def __call__(self, request: HttpRequest) -> HttpResponse:
            return HttpResponse(200)

        def close(self) -> None:
            self.closed = True

    monkeypatch.setattr(exporter, "default_transport", lambda: opened.append(Default()) or opened[-1])
    export = http_json_exporter(endpoint="http://collector.test/v1/metrics")
    assert export({"resourceMetrics": []}).ok and export({"resourceMetrics": []}).ok
    assert len(opened) == 2 and all(transport.closed for transport in opened), "one per export, closed after it"


def test_the_exporter_reads_a_timeout_as_network_timeout():
    def slow(request: HttpRequest) -> HttpResponse:
        raise TimeoutError("slow collector")

    result = http_json_exporter(endpoint="http://collector.test/v1/metrics", transport=slow)({"resourceMetrics": []})
    assert result is not None and (result.ok, result.reason) == (False, "network:timeout")
