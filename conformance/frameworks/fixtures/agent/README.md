# Agent fixtures

The SDK's own run API with no framework, per language (`../../drivers/agent.mjs`,
`examples/conformance-adapter/python/drivers/agent.py`), for where a run lives.
Both releases put the subject on an experiment's candidate, so a wrong
version or arm shows.

- `two-store-*`: a run on agent A; `feedback` on agent B over another store
  with the shared secret files on A's version, arm and model; on C after a
  rotation (A's secret among its previous ones) too; on D, with another
  secret, it is refused. `explain` the same way. B, C and D hold no release.
- `split-invocation-*`: the prompt renders on agent A; only its run
  reference crosses to agent B, which holds no release and reports the model
  step with `ap.reportRun` (TypeScript) / `ap.report_run` (Python, added for
  parity in AIR-2233): one run row on the version and arm A served, usage
  attached once, and A writes nothing.
