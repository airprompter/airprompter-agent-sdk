"""AirPrompter's hosted roots: the root public key each hosted environment's offline ceremony wrote.

The agent never trusts a key because it is here: it trusts the root its caller pins, and uses this table only to
recognise a pin as AirPrompter's (and so know where that environment's root document is). The table is read-only.

Example::

    hosted_environment_of_root(pinned)  # "prod" for AirPrompter's production root, None for any other key
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any, Mapping, Optional

from .trust import key_thumbprint

#: Exactly as the ceremonies wrote them (``infrastructure/trust/agent-root/{environment}/root-public.jwk.json`` in the
#: service repository); the same keys as TypeScript's ``HOSTED_ROOTS``. An environment with no ceremony has no entry:
#: ``staging`` has none.
HOSTED_ROOTS: Mapping[str, Mapping[str, str]] = MappingProxyType({
    # Ceremony of 2026-09-14 (AIR-1935); key id 86267aa3dc49005a0c1474d5c9c06bd7e1d0e835da715a864c1eca706545df91.
    "dev": MappingProxyType({"kty": "EC", "crv": "P-256", "x": "gAQGIbpqvkYwfGnz2yJjAFcMLZm43fsQ6zXF4CjImss", "y": "ImPVZkVwb3KC73p9T3EBtGzhm-s-vI6VVu0ovgka6ek"}),
    # Ceremony of 2026-11-27 (AIR-2214); key id 044af6e83353a2ea3758cc3feb3b1b7031c82bda5d6cd9287ba7730363e11793.
    "prod": MappingProxyType({"kty": "EC", "crv": "P-256", "x": "hYhEFO-xyNoWyt5x0BgshEmNXPN1_mzDLISlT4nTDzE", "y": "OTbj5sdj8qKiIPzCsrdD297_vlNqahPTZWGgoa9cOtE"}),
})

#: What ``hosted_environment_of_root`` recognises. The repository's tests replace this module attribute (a fake control
#: plane cannot sign as AirPrompter); that changes which pins count as AirPrompter's, never what a pinned agent trusts.
_RECOGNISED: Mapping[str, Mapping[str, str]] = HOSTED_ROOTS


def hosted_environment_of_root(pinned: Mapping[str, Any]) -> Optional[str]:
    """The hosted environment whose root this key is (by RFC 7638 thumbprint), or None for a key AirPrompter does not host."""
    try:
        key_id = key_thumbprint(pinned)
    except Exception:  # noqa: BLE001 — a malformed key is simply not a hosted one
        return None
    for environment, key in _RECOGNISED.items():
        if key_thumbprint(key) == key_id:
            return environment
    return None
