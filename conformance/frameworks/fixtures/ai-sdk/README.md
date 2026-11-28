# Vercel AI SDK fixtures

A real `wrapLanguageModel` with `airprompterMiddleware` over the AI SDK's own
mock language model (`ai/test`, ai 7.0.162), driven by `generateText` and
`streamText`, which run the tool loop themselves (`../../drivers/ai-sdk.mjs`).
The mock keeps what each model received; `modelFor` answers one of the
driver's mock models by id. The AI SDK also owes `late-tag`.

Each fixture is a developer's program (`agent.clients`, `agent.steps`, read by
`drivers/program.mjs`): one instrumented client per slot, each step called
until the model stops asking for tools, inside `ap.run` unless `"scope":
"none"`. `modelFor` maps the release's model id to the id the client sends; a
`null` declines. `"baseline": true` runs the same program on a bare client
too, so a passthrough proves its request left as written: the same URL,
method, headers (a fresh idempotency key aside) and body (`untouched`).
`agent.feedback` files signals on the run's last reference afterwards. A
call's `settings`, when named, must match exactly.

What these encode (decided on AIR-2233):

- `generateText` runs the tools, but the middleware wraps the model, not the
  tools, so a tool loop's row counts no tools (`toolsReported` false).
- With no `modelFor`, a caller model with another id than the release's
  declines the slot (AIR-2231's contract), as for the direct clients.
- The mock's `inputTokens.total` counts cached tokens, as OpenAI's do, so a
  row's `tokens.input` is `noCache`.
