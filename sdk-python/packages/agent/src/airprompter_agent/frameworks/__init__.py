"""``airprompter_agent.frameworks``: one adapter per framework, each on the one contract in
``airprompter_agent.frameworks.contract``. Import the adapter you use; this package imports none of them, and no adapter
imports its framework until you call it, so each framework stays an optional extra.

Example::

    from airprompter_agent.frameworks.openai import instrument

    openai = instrument(OpenAI(), ap, slot="support.reply")   # the approved text, model and settings on every call
"""
