"""The offline release artifact: ``.apbundle`` reading and writing (``apbundle``) and the HPKE primitives it is
sealed with (``hpke``). The barrel exports nothing; import the module you need.

Example::

    from airprompter_agent_core.bundle.apbundle import DistributionKey, open_bundle

    contents = open_bundle(bundle, {"agentId": "agt_1", "target": "prod"}, DistributionKey(private_key, public_raw))
"""
