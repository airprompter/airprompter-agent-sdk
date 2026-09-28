"""Getting a release onto the host: the sync pass and its loop (``loop``), the store-free puller that hands back an
``.apbundle`` (``pull_bundle``), and the puller that writes each release to the customer's datastore
(``pull_to_datastore``). The barrel exports nothing; import the module you need.

Example::

    from airprompter_agent_sync.sync.loop import sync_once, jittered_delay_ms

    delay_ms = jittered_delay_ms(30)   # the resident loop's next pass, with jitter
"""
