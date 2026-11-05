"""``airprompter_agent_otel`` is the OpenTelemetry package of the AirPrompter agent SDK: a separate distribution because
a collector is an optional destination. ``airprompter_agent_otel.exporter`` sends the telemetry spool to the collector
you already run, as OTLP metrics, with no AirPrompter grant. Import from that module; this file exports nothing, so a
later module joins it without a name moving.

Example::

    from airprompter_agent_otel.exporter import OtlpUploadSink

    sink = OtlpUploadSink(endpoint="http://localhost:4318/v1/metrics")
"""
