"""The capabilities this SDK implements (``protocol/capabilities.md``): the only set a manifest's ``requiredCapabilities``
and a slot's ``requires`` are checked against, and what the heartbeat lists. A later 3.x minor adds a feature by adding
a row to that table and a value here and in the TypeScript twin; a test compares all three.

Example::

    refused = any(name not in SUPPORTED_CAPABILITIES for name in payload.get("requiredCapabilities", []))
    heartbeat = {"capabilities": sorted(SUPPORTED_CAPABILITIES)}
"""

from __future__ import annotations

SUPPORTED_CAPABILITIES: frozenset[str] = frozenset()
