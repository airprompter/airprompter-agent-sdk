"""The protocol this SDK speaks. ``tools/build_all.py`` writes this file from ``protocol/VERSION``, the only
hand-edited protocol version: change that file, never this one.

Example::

    from airprompter_agent.core import PROTOCOL_VERSION

    heartbeat = {"protocol": PROTOCOL_VERSION}
"""

PROTOCOL_VERSION = "3.0.0"
