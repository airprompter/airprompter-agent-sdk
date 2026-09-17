"""The spool: minute windows accumulated per dimension set and written as append-only NDJSON segments (``writer``).
The barrel exports nothing; import the module you need.

Example::

    from airprompter_agent_telemetry.spool.writer import MemorySink, SpoolWriter, WriterIdentity

    writer = SpoolWriter(MemorySink(), WriterIdentity("i-lambda0000001", "ephemeral", "acme/1.0"))   # serverless: drain at invocation end
"""
