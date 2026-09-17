"""Getting a release onto the host: the sync pass and its loop (``loop``), the daemon client (``daemon``), and the
store-free puller that hands back an ``.apbundle`` (``pull_bundle``). The barrel exports nothing; import the module
you need.

Example::

    from airprompter_agent_sync.sync.daemon import DaemonClient, daemon_socket_path

    socket_path = daemon_socket_path(state_dir=state_dir, agent_id="agt_1", target="prod")
    client = DaemonClient.connect(socket_path=socket_path, agent_id="agt_1", target="prod", sdk="acme/1.0")   # None: no daemon here
"""
