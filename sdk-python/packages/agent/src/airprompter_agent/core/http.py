"""The SDK's own HTTP seam: every request the SDK makes goes through a ``Transport``, so no HTTP library's type is in a
public signature. ``transport=`` on the agent, the control-plane client, the uploader and the OTLP exporter takes any
callable from ``HttpRequest`` to ``HttpResponse``; with none, ``default_transport()`` serves it over httpx.

The contract a transport keeps:

- It sends the one request it is given and returns the answer. A 3xx is an answer: the SDK follows redirects itself,
  and drops ``authorization`` when a redirect leaves the origin, so a transport never sees a key on another host.
- It raises ``TimeoutError`` when the request timed out, and any other exception when it got no answer.
- It may be called from several threads at once (the sync loop and the uploader share one).

Example::

    from airprompter_agent.core import HttpRequest, HttpResponse, default_transport

    inner = default_transport()   # httpx, pooled; it reads the proxy settings from the environment

    def recorded(request: HttpRequest) -> HttpResponse:   # a log line, a header of your own, a test double
        print(request.method, request.url)
        return inner(request)

    ap = AirPrompterAgent.start(..., transport=recorded)
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Protocol
from urllib.parse import urljoin, urlsplit

import httpx

#: How many redirects ``send`` follows before it gives up.
MAX_REDIRECTS = 5


@dataclass(frozen=True)
class HttpRequest:
    """One request: an absolute URL (query included), the headers to send, the body, and how long to wait."""

    method: str
    url: str
    headers: Mapping[str, str] = field(default_factory=dict)
    content: bytes = b""
    timeout: float = 30.0


@dataclass(frozen=True)
class HttpResponse:
    """One answer: the status, the headers (read them with ``header``, in any case), and the body."""

    status: int
    headers: Mapping[str, str] = field(default_factory=dict)
    content: bytes = b""

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")

    def header(self, name: str) -> Optional[str]:
        """A header by name, whatever case the transport used."""
        wanted = name.lower()
        return next((value for key, value in self.headers.items() if key.lower() == wanted), None)


class Transport(Protocol):
    """What ``transport=`` takes: a request in, its answer out (see the module's contract)."""

    def __call__(self, request: HttpRequest, /) -> HttpResponse: ...


class _HttpxTransport:
    """The default: one pooled httpx client, opened on first use; closed for good by ``close``."""

    def __init__(self) -> None:
        self._client: Optional[httpx.Client] = None
        self._closed = False
        self._lock = threading.Lock()

    def __call__(self, request: HttpRequest, /) -> HttpResponse:
        with self._lock:
            if self._closed:
                raise ConnectionError("this transport is closed")
            if self._client is None:
                self._client = httpx.Client()
            client = self._client
        try:
            response = client.request(request.method, request.url, headers=dict(request.headers), content=request.content or None, timeout=request.timeout, follow_redirects=False)
        except httpx.TimeoutException as error:
            raise TimeoutError(str(error) or "timed out") from error
        except httpx.InvalidURL as error:
            raise ValueError(str(error)) from error
        except (httpx.HTTPError, httpx.StreamError) as error:
            raise ConnectionError(str(error) or type(error).__name__) from error
        return HttpResponse(response.status_code, {key: value for key, value in response.headers.items()}, response.content)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            client, self._client = self._client, None
        if client is not None:
            client.close()


def default_transport() -> Transport:
    """The transport the SDK uses when given none: httpx, pooled, with the environment's proxy settings. Wrap it to add
    a header or a log line; pass your own for anything else."""
    return _HttpxTransport()


def require_transport(transport: Any) -> Optional[Transport]:
    """``transport`` as given, refused at the door when it is not a callable: an ``httpx.BaseTransport`` from before
    the SDK owned this seam would otherwise fail on every request, quietly."""
    if transport is not None and not callable(transport):
        raise TypeError(f"transport= takes a callable HttpRequest -> HttpResponse (airprompter_agent.core.Transport), not {type(transport).__name__}")
    return transport


def send(transport: Transport, request: HttpRequest) -> HttpResponse:
    """``request`` on ``transport``, following redirects here: a 303 (and a 301 or 302 after a POST) becomes a GET, and
    ``authorization`` is dropped once a redirect leaves the origin."""
    for _ in range(MAX_REDIRECTS + 1):
        response = transport(request)
        location = response.header("location")
        if response.status not in (301, 302, 303, 307, 308) or not location:
            return response
        target = urljoin(request.url, location)
        headers = dict(request.headers)
        if urlsplit(target)[:2] != urlsplit(request.url)[:2]:
            headers = {key: value for key, value in headers.items() if key.lower() != "authorization"}
        if response.status == 303 or (response.status in (301, 302) and request.method == "POST"):
            request = HttpRequest("GET", target, {key: value for key, value in headers.items() if key.lower() not in ("content-type", "content-length")}, b"", request.timeout)
        else:
            request = HttpRequest(request.method, target, headers, request.content, request.timeout)
    raise ConnectionError(f"more than {MAX_REDIRECTS} redirects from {request.url}")


def send_once(transport: Optional[Transport], request: HttpRequest) -> HttpResponse:
    """One request (a redirect is the answer) on the caller's transport, or on a default one opened and closed for it."""
    own = require_transport(transport) or default_transport()
    try:
        return own(request)
    finally:
        if transport is None:
            close_transport(own)


def close_transport(transport: Any) -> None:
    """Close a transport the SDK opened itself; a caller's own transport is the caller's to close."""
    if isinstance(transport, _HttpxTransport):
        transport.close()
