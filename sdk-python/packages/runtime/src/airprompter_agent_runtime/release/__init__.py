"""The runtime over a verified release.

Example::

    from airprompter_agent_runtime.release.resolver import ReleaseResolver

    resolver = ReleaseResolver(release=reader.current(), run_ref_key=key, agent_id="agt_1", target="prod", instance_id="host-1", now_ms=now_ms)
    rendered = resolver.render(resolver.resolve("support.reply", "user-42").slot, {"customer_name": "Ada"})
"""
