# LiteLLM fixtures

The real `litellm.completion` (1.111.0) with its own `mock_response`, and the
AirPrompter callback in `litellm.callbacks`
(`examples/conformance-adapter/python/drivers/litellm.py`), written as the
adapter's docs say: inside `ap.run`, `**litellm_params(placed)` on the call
(which puts the release's model and settings on it) with the approved text
first, measured with `measure_call` at the call site. LiteLLM has no client
object, so the text, `modelFor` and a decline are the application's own;
`model-caller-loses-py.json` proves `litellm_params` puts the release's model
over the caller's.

- `streaming-in-run-py.json`: a sync `stream=True` call inside `ap.run`,
  marked with `litellm_metadata((run, slot))`. LiteLLM logs it after the
  stream ends, on a worker thread without the caller's context; the callback
  finds the run by its reference, so it is that run's one model call. A
  mocked stream is logged only from a text mock, so its usage is LiteLLM's
  own count of the text, pinned with LiteLLM.
- `streaming-no-run-py.json`: a prompt rendered outside any run, marked with
  `litellm_metadata(rendered)`: one one-call row.
- `model-mismatch-stream-py.json`: a call marked as the run's but sent under
  another model is not counted.
- LiteLLM owes no `handoff` (the ticket's list); `model-another-declines`
  does not apply (no client to decline).
- `settings-py.json` runs on gpt-4.1: LiteLLM refuses `top_p` and `stop` for
  gpt-5 as unsupported by the model. The driver sets
  `LITELLM_LOCAL_MODEL_COST_MAP`, so that map is the pinned LiteLLM's, never
  fetched.
- One callback is registered for the process: LiteLLM copies
  `litellm.callbacks` into its own lists the first time it sees them, so a
  callback swapped in later is never called.
- The driver imports `measure_call` from `frameworks.contract`, the one
  import a developer's code makes outside the LiteLLM subpath today
  (AIR-2545, `instrument(litellm)`, moves it; the driver scan names it as
  that known gap).
