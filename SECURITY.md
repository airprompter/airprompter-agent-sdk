# Security

## Reporting a vulnerability

Email security@airprompter.com. Please do not open a public issue for
anything you believe is exploitable. We acknowledge within two business
days.

## Threat model, in one paragraph

This software verifies an offline root of trust, a manifest signature,
every payload hash and a monotonic generation before any release is
staged; it stores prompts encrypted at rest under a key the host obtains at
boot; and it activates a release only when the host's policy allows. It
does **not** defend against a process running as the same user, against
the memory of the rendering process, or against a host attacker who also
holds the key-encryption key — nothing on the vendor's side can protect
bytes from the process that renders them, and we do not claim otherwise.
Telemetry is content-free by schema. The full threat model, reproduced
verbatim from the AirPrompter Team Agents design with every claim mapped
to the row that bounds it and the vector that proves it, is
[docs/threat-model.md](docs/threat-model.md); the keys and their custody
are [docs/key-handling.md](docs/key-handling.md).
