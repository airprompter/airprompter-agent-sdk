# Capabilities · protocol 3.x

A capability names a feature a reader must understand. Protocol 3.x adds features in minors without a new major: a reader checks the major and the capabilities it is asked for, and never compares minors.

A manifest asks for a capability in one of two places:

- Top-level `requiredCapabilities`: a reader missing any value refuses the whole manifest with `protocol_unsupported`.
- `slot.requires`: a reader missing any value treats that slot as absent and loads everything else, including disables (`trust-chain.md` › Slots a reader cannot serve).

An arm override carrying `requires` follows the same rule, with one difference. If an arm loses the override for the experiment's own tag, or the experiment's `subjectKey` is one the reader does not know, the host sits out that whole experiment: base text, arm `none`, bucket null. A host that sits out still stops when every arm of that experiment is disabled, for runs in its audience; an audience it cannot read matches nothing. If it loses only an override of another tag, that entry goes and the experiment and its other overrides stay. What a host cannot read never counts as evidence.

A pull path carries a release for runtimes that may know more than it does. Its check skips the capability refusal and the servable filter, it fetches every `{contentHash, byteLength}` pair anywhere under the payload (`slot.variants[*].pin` included), and the runtime verifies the bundle again at apply. Only a pull path does this; a runtime never does.

A manifest refused for a capability is refused after its signature, scope and generation verify. Its `disable` directives apply, on a sync pass, a bundle or a datastore read, on top of the active release's own directives, and a newer signed manifest decides: the next refused manifest replaces them. A host keeps the active release's own disables until a newer signed manifest it can read replaces them. A rollback target's disables do not apply: it is older than the active release, so it must not reduce it.

An SDK lists the capabilities it implements on every heartbeat (`capabilities`), so a service can warn at promote when a fleet cannot read a release.

## Naming

`snake_case`, one noun phrase per feature, no prefixes (for example `rubric_slots`, `variant_rules`). The pattern is `^[a-z][a-z0-9_]{0,63}$`.

## Registry

This table, `SUPPORTED_CAPABILITIES` in the TypeScript SDK (`core/protocol/capabilities.ts`) and `SUPPORTED_CAPABILITIES` in the Python SDK (`protocol/capabilities.py`) hold the same values. A test in each SDK compares its set with this table, so a capability that is added in one place and not the others fails.

| Name | Added in | What a reader must do |
| -- | -- | -- |

3.0.0 ships the registry empty: every 3.0.0 SDK speaks everything 3.0.0 defines, so nothing needs asking for.
