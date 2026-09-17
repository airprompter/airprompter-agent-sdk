"""The control-plane HTTP client: edge pointer, manifest, payloads, heartbeat, upload grants — shared by sync and telemetry.

Example::

    from airprompter_agent_core.control.client import SyncClient

    client = SyncClient(base_url="https://api.airprompter.com", agent_id="agt_1", target="prod", api_key=agent_key)
    fetched = client.manifest(if_none_match=last_etag)   # "not_modified" costs no body
"""
