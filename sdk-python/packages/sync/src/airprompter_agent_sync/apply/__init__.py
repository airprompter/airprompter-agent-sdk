"""The apply policy's timing: the update window (``window``) inside which a release staged under
``unlock_required`` activates on its own. The barrel exports nothing; import the module you need.

Example::

    from airprompter_agent_sync.apply.window import parse_window, window_state

    state = window_state(parse_window("02:00-04:00 Europe/Berlin"), now_ms)   # state.open, state.opens_at_ms
"""
