"""AirPrompter's hosted roots: the root public key each hosted environment's offline ceremony wrote, and the URL its
root document (the signing keys under that root) is served at.

A key here is never trusted because it is here: a runtime trusts the root its caller pins. This table only says where
a pinned hosted root's document lives, so an agent started with ``root={"pinned": ...}`` alone can learn the signing
keys. Whatever that URL returns must still verify against the pinned key (R1–R5) before it is used.

Example::

    environment = hosted_environment_of_root(pinned)  # "prod" for AirPrompter's production root, None for any other key
    root_url = HOSTED_ROOT_URLS.get(environment) if environment else None
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any, Mapping, Optional, Union

from .trust import HostedEnvironment, key_thumbprint

#: Exactly as the ceremonies wrote them (``infrastructure/trust/agent-root/{environment}/root-public.jwk.json`` in the
#: service repository); the same keys as TypeScript's ``HOSTED_ROOTS``. An environment with no ceremony has no entry:
#: ``staging`` has none.
HOSTED_ROOTS: dict[str, dict[str, str]] = {
    # Ceremony of 2026-09-14 (AIR-1935); key id 86267aa3dc49005a0c1474d5c9c06bd7e1d0e835da715a864c1eca706545df91.
    "dev": {"kty": "EC", "crv": "P-256", "x": "gAQGIbpqvkYwfGnz2yJjAFcMLZm43fsQ6zXF4CjImss", "y": "ImPVZkVwb3KC73p9T3EBtGzhm-s-vI6VVu0ovgka6ek"},
    # Ceremony of 2026-11-27 (AIR-2214); key id 044af6e83353a2ea3758cc3feb3b1b7031c82bda5d6cd9287ba7730363e11793.
    "prod": {"kty": "EC", "crv": "P-256", "x": "hYhEFO-xyNoWyt5x0BgshEmNXPN1_mzDLISlT4nTDzE", "y": "OTbj5sdj8qKiIPzCsrdD297_vlNqahPTZWGgoa9cOtE"},
}

#: Where each hosted environment's API serves its root document (``GET <api>/roots/<environment>/root.json``).
HOSTED_ROOT_URLS: Mapping[str, str] = MappingProxyType({
    "dev": "https://api.airprompter.dev/roots/dev/root.json",
    "prod": "https://api.airprompter.com/roots/prod/root.json",
})


def hosted_environment_of_root(pinned: Mapping[str, Any]) -> Optional[str]:
    """The hosted environment whose root this key is (by RFC 7638 thumbprint), or None for a key AirPrompter does not host."""
    try:
        key_id = key_thumbprint(pinned)
    except Exception:  # noqa: BLE001 — a malformed key is simply not a hosted one
        return None
    for environment, key in HOSTED_ROOTS.items():
        if key_thumbprint(key) == key_id:
            return environment
    return None


def root_url_for(*, root_url: Optional[str], pinned: Optional[Mapping[str, Any]], hosted_environment: Optional[HostedEnvironment], syncs: bool) -> Union[tuple[Optional[str], Optional[str]], str]:
    """Where a runtime reads its root document, decided once at start: ``(url, default_for)``, or the refusal to raise.

    An explicit ``root_url`` wins. A runtime that never syncs, and one handed a full root document (``pinned`` None),
    needs none. A pinned AirPrompter root gets its environment's URL; any other pinned root has no default, so a
    runtime that would sync with it is refused with the line to add, rather than started to never verify a release.
    The URL only says where to look: what it serves is accepted only if it verifies against the pinned key."""
    if root_url:
        return (root_url, None)
    if pinned is None or not syncs:
        return (None, None)
    environment = hosted_environment or "prod"
    named = hosted_environment_of_root(pinned)
    url = HOSTED_ROOT_URLS.get(environment) if named == environment else None
    if url:
        return (url, environment)
    if named is not None:
        default = " (the default)" if hosted_environment is None else ""
        return f'root["pinned"] is AirPrompter\'s {named} root, but root["hosted_environment"] is "{environment}"{default}. Add "hosted_environment": "{named}" to root, or pin the {environment} root.'
    return f'root["pinned"] is not one of AirPrompter\'s hosted roots, so the SDK cannot know where its root document is, and without it no release verifies. Add sync={{"root_url": "https://<your service>/roots/{environment}/root.json"}}, the root document of the service that signs your releases.'
