# OpenAI fixtures

The real `openai` client, TypeScript (`../../drivers/openai.mjs`, openai 7.50.0)
and Python (`examples/conformance-adapter/python/drivers/openai.py`, openai 3.60.0),
over a recorded transport: Chat Completions, plain and streamed, and the
Responses API (`tool-loop-responses-*`). `streaming-no-usage-*` holds what a
plain `stream: true` with no `stream_options` gets: the call counts, its usage
is unavailable.

Each fixture is a developer's program (`agent.clients`, `agent.steps`, read by
`drivers/program.mjs` and `drivers/program.py`): one instrumented client per slot, each step called
until the model stops asking for tools, inside `ap.run` unless `"scope":
"none"`. `modelFor` maps the release's model id to the id the client sends; a
`null` declines. `"baseline": true` runs the same program on a bare client
too, so a passthrough proves its request left as written: the same URL,
method, headers (a fresh idempotency key aside) and body (`untouched`).
`agent.feedback` files signals on the run's last reference afterwards. A
call's `settings`, when named, must match exactly.

What these encode, from AIR-2231's contract (decided on AIR-2233):

- A direct client sees the application's tool loop as model calls only, so a
  tool loop's row counts no tools (`toolsReported` false).
- With no `modelFor`, a caller asking for another model than the release's
  declines the slot (`model_unresolved`): approved text never runs on a model
  the release did not pin. The cases that prove the text and the model reach
  the wire pass `modelFor` as the identity; `model-same-id` names the
  release's model itself.
- A row's `tokens.input` is the uncached count: OpenAI's `prompt_tokens`
  include the cached ones and are split; Anthropic's `input_tokens` do not.
  A turn's `usage.input` is the provider's own field.
