"""Rendering: a slot's text with its declared variables (``template``), and the content-free run reference a
render carries (``run_ref``). The barrel exports nothing; import the module you need.

Example::

    from airprompter_agent_core.render.template import render_template

    text = render_template(tag="support.reply", text=slot_text, variables=slot["variables"], values={"customer_name": "Ada"})
"""
