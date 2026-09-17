"""The telemetry row schemas and the feedback catalogue — pure, shared by the spool writer and the wrappers.

Example::

    from airprompter_agent_core.telemetry.feedback import normalize_feedback
    from airprompter_agent_core.telemetry.rows import Observation

    normalize_feedback({"thumbs": "up", "note": "great"}).rejected   # {"note": "unknown_signal"}: free text never reaches the spool
"""
