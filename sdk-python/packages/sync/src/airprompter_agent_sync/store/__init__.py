"""The encrypted, restart-safe slot store: the A/B store itself (``slot_store``), the key providers that wrap its
DEK (``key_provider``) and the per-payload AES-GCM (``payload_crypto``). The barrel exports nothing; import the
module you need.

Example::

    from airprompter_agent_sync.store.key_provider import file_key
    from airprompter_agent_sync.store.slot_store import SlotStore

    store = SlotStore.open(state_dir=state_dir, agent_id="agt_1", target="prod", key_provider=file_key(key_path))
"""
