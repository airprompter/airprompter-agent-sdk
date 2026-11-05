# airprompter-agent

One install for `AirPrompterAgent`: signed pull-only updates, the encrypted
restart-safe slot store, offline operation, rendering with trust-aware
variables, `ap.wrap()` for the openai and anthropic clients (and a LiteLLM
callback), and content-free telemetry.

```python
from airprompter_agent import AirPrompterAgent

ap = AirPrompterAgent.start(organization_id="org_…", agent_id="agt_…", target="prod", api_key=os.environ["AIRPROMPTER_AGENT_KEY"], root={"pinned": PINNED_ROOT_JWK})
rendered = ap.prompt("support.triage").render(team="Billing", ticket=ticket_text)
completion = ap.observe(rendered, lambda: client.chat.completions.create(model=rendered.model, messages=[...]))
ap.feedback(rendered.run_ref, thumbs="up")
```

The parts are subpackages: `airprompter_agent.core` (the protocol with no I/O),
`.sync` (pull and verify, the encrypted slot store, the apply policy), `.runtime`
(render and assign over a release you hold, the provider wrappers) and
`.telemetry` (the spool and its uploader). Extras: `[kms]`, `[vault]`, `[keyring]`,
`[openai]`, `[anthropic]`, `[litellm]`.

Separate distributions exist only for dependency footprint and pin this one to
the same version: `airprompter-agent-otel`, `airprompter-datastore-s3`, `-postgres`
and `-redis`. The full README and the parity matrix are in
[`sdk-python/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-python);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
