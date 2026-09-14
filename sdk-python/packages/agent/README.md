# airprompter-agent

One install, today's `AirPrompterAgent`: the facade over
`airprompter-agent-core`, `-sync`, `-runtime` and `-telemetry` — signed
pull-only updates, the encrypted restart-safe slot store, offline
operation, rendering with trust-aware variables, `ap.wrap()` for the
openai and anthropic clients (and a LiteLLM callback), content-free
telemetry. Every public name of the four distributions is re-exported.

```python
from airprompter_agent import AirPrompterAgent

ap = AirPrompterAgent.start(organization_id="org_…", agent_id="agt_…", target="prod", api_key=os.environ["AIRPROMPTER_AGENT_KEY"], root={"pinned": PINNED_ROOT_JWK})
rendered = ap.prompt("support.triage").render(team="Billing", ticket=ticket_text)
completion = ap.observe(rendered, lambda: client.chat.completions.create(model=rendered.model, messages=[...]))
ap.feedback(rendered.run_ref, thumbs="up")
```

One of five distributions released in lockstep — `airprompter-agent-core`,
`-sync`, `-runtime`, `-telemetry` and the facade `airprompter-agent` — one
version, exact-pinned siblings, mirroring the TypeScript packages one for
one. The full README and the parity matrix are in
[`sdk-python/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-python);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
