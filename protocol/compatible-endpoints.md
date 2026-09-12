# Provider-compatible endpoints — the mapping

A hosted (managed) environment can be called with the OpenAI or Anthropic
SDK you already use: change the base URL and the key, and name the prompt
as the model. Nothing else at the call site changes. This document is the
mapping — what a compatible body becomes, and what is refused — so that a
call through a compatible endpoint is exactly as governed as a call to
`/run` (design D64, §11.2; AIR-1962).

Status: **draft 1**. Breaking changes bump `protocol` major.

## Base URLs and paths

| SDK | `baseURL` | Path the SDK appends | Served |
| --- | --- | --- | --- |
| `openai` (any language) | `https://<run-domain>/v1/agents/{agentId}/openai` | `/chat/completions`, `/responses` | Chat Completions, Responses |
| `@anthropic-ai/sdk` / `anthropic` | `https://<run-domain>/v1/agents/{agentId}/anthropic` | `/v1/messages` | Messages |

The run domain is the environment's run URL (the same host `/run` uses —
the execution stack's function URL behind CloudFront). The **target is the
key's own**: a run key is bound to one environment, so the path carries no
`{target}`. The key goes where the SDK puts it — `Authorization: Bearer`
(OpenAI) or `x-api-key` (Anthropic); both reach the same run-key check.

```ts
const openai = new OpenAI({ baseURL: "https://run.airprompter.com/v1/agents/agt_…/openai", apiKey: process.env.AIRPROMPTER_RUN_KEY });
const completion = await openai.chat.completions.create({
  model: "slot:support.triage",
  messages: [{ role: "user", content: ticketText }],
  airprompter: { variables: { team: "Billing" } },   // the prompt's other declared variables
  user: "customer-42",                              // sticky assignment during a rollout, hashed here
});
completion.airprompter.runRef;                       // also in the X-AirPrompter-RunRef header
```

## The mapping

| Compatible field | Becomes | Rule |
| --- | --- | --- |
| `model` | the slot | must be `slot:<tag>`; a real model name is `model_not_a_slot` — the release pins the model, the caller never picks one |
| system prompt | **the release's** | a `system` or `developer` message (Chat), `instructions` (Responses) or `system` (Messages) is `system_message_not_allowed` — the sealed template is the system prompt, or the call is not governed |
| the one user turn | the prompt's **one `end_user` variable** | exactly one user turn of text (a string, or `text` / `input_text` parts); a second turn, an assistant turn, an image, audio or a tool result is `unsupported_messages`; a prompt that declares no (or several) end-user variables is `no_end_user_variable` — pass every value through `airprompter.variables` and send an empty user turn |
| `airprompter.variables` | the other declared variables | operator-trust values, a second end-user variable; unknown names are refused by the run (`render_unknown_variable`), missing required ones too (`render_missing_variable`) |
| `airprompter.subjectHash`, else `user` (OpenAI) / `metadata.user_id` (Anthropic) | `subjectHash` | sticky arm assignment during a rollout; the id is SHA-256'd on the way in and never stored |
| `max_completion_tokens` / `max_tokens` (Chat), `max_output_tokens` (Responses), `max_tokens` (Messages, **required**) | `maxOutputTokens` | above the ceiling is refused by the run (`invalid_request`) |
| `stream` | SSE in the provider's own event shape | see below |
| `airprompter.idempotencyKey` (or the `Idempotency-Key` header), `airprompter.stepId`, `airprompter.metadata` | as on `/run` | the same replay window, workflow step and echoed metadata |

**Accepted and ignored** (the release owns them): Chat `temperature`,
`top_p`, `stop`, `presence_penalty`, `frequency_penalty`, `seed`,
`logit_bias`, `store`, `stream_options`, `service_tier`, `reasoning_effort`,
`verbosity`, `parallel_tool_calls`, `prompt_cache_key`, `safety_identifier`,
`logprobs`, `top_logprobs`; Responses `temperature`, `top_p`, `store`,
`truncation`, `reasoning`, `service_tier`, `parallel_tool_calls`,
`prompt_cache_key`, `safety_identifier`, `include`, `text`; Messages
`temperature`, `top_p`, `top_k`, `stop_sequences`, `service_tier`,
`thinking`. They are named on the `agents.compat` log line.

**Refused by name** (`unsupported_parameter`, the name in `detail`): Chat
`tools`, `tool_choice`, `functions`, `function_call`, `response_format`,
`audio`, `modalities`, `prediction`, `web_search_options`, `n > 1`;
Responses `tools`, `tool_choice`, `previous_response_id`, `conversation`,
`background`, `prompt`; Messages `tools`, `tool_choice`, `mcp_servers`,
`container`. Tool and function calling beyond what the release renders is
out of scope; so is bring-your-own-key.

## The answer

The run is `/run`'s own — the same render, the same allowance admission,
the same model call through the organization's inference profile, the same
settle, record, retention and judge sample — re-shaped on the way out.
`X-AirPrompter-RunRef` and `x-agent-run-id` are on every JSON answer, and
an `airprompter: { runId, runRef }` field sits beside the standard fields
(on the JSON body, and on the final stream event: the usage chunk for Chat,
`response.completed` / `response.incomplete` for Responses, `message_stop`
for Messages). The `model` echoed is `slot:<tag>`.

| Run outcome | Chat | Responses | Messages |
| --- | --- | --- | --- |
| `end_turn` | `finish_reason: stop` | `status: completed` | `stop_reason: end_turn` |
| `max_tokens` | `finish_reason: length` | `status: incomplete`, `incomplete_details.reason: max_output_tokens` | `stop_reason: max_tokens` |
| usage | `prompt_tokens` = input + cached, `prompt_tokens_details.cached_tokens` | `input_tokens` = input + cached, `input_tokens_details.cached_tokens` | `input_tokens` (uncached), `cache_read_input_tokens` |

### Streams

- **Chat**: `data:` lines — a first chunk with the assistant role, one chunk
  per delta, a chunk with `finish_reason`, a chunk with `usage` (and the
  `airprompter` field), then `data: [DONE]`. Usage is always sent;
  `stream_options.include_usage` is not needed.
- **Responses**: `response.created`, `response.in_progress`,
  `response.output_item.added`, `response.content_part.added`, one
  `response.output_text.delta` per delta, `response.output_text.done`,
  `response.content_part.done`, `response.output_item.done`, then
  `response.completed` (or `response.incomplete`) carrying the full
  response; `sequence_number` on every event. The SDK's `responses.stream()`
  helper assembles it.
- **Messages**: `message_start` (usage zeros — counts are known at the end),
  `content_block_start`, one `content_block_delta` (`text_delta`) per delta,
  `content_block_stop`, `message_delta` (the stop reason and the usage),
  `message_stop`. The SDK's `messages.stream()` helper assembles it.

A refusal after the stream began (a model failure mid-run) is the
provider's error event on the open stream: a `data: {"error": …}` line
then `[DONE]` (Chat), an `error` event (Responses, Messages).

## Errors

Every refusal — the mapping's own and every `/run` refusal behind it — is
the provider's error shape with the status `/run` would answer, and the
AirPrompter code beside it:

```json
{ "error": { "message": "…", "type": "invalid_request_error", "param": null, "code": "model_not_a_slot" }, "airprompter": { "code": "model_not_a_slot", "detail": "gpt-5" } }
{ "type": "error", "error": { "type": "invalid_request_error", "message": "…" }, "airprompter": { "code": "system_message_not_allowed" } }
```

| Code | Status | Meaning |
| --- | --- | --- |
| `model_not_a_slot` | 400 | `model` is not `slot:<tag>` |
| `system_message_not_allowed` | 400 | a system / developer message, `instructions` or `system` |
| `unsupported_messages` | 400 | more than one turn, an assistant turn, a non-text part, a tool result |
| `unsupported_parameter` | 400 | a refused parameter (named in `detail`), or a malformed `airprompter` extension |
| `no_end_user_variable` | 400 | the prompt declares no single end-user variable for the user turn |
| `max_tokens_required` | 400 | Messages only |
| the `/run` codes | as `/run` | `slot_not_found` 404, `render_missing_variable` 400, `allowance_exhausted` 402, `rate_limited` 429 (+ `Retry-After`), `model_unavailable` 503, … |

OpenAI's `error.type` is `authentication_error` (401), `permission_error`
(403), `not_found_error` (404), `insufficient_quota` (402),
`rate_limit_error` (429), `server_error` (5xx), else
`invalid_request_error`; Anthropic's `error.type` follows its own set the
same way (`overloaded_error` for 503, `billing_error` for 402).

## What never changes

The system prompt is the sealed release's. A compatible call cannot add
instructions, add tools, pick a model, or reach a prompt the key's
environment has not promoted. It meters on the organization's allowance
exactly as `/run`, leaves the same content-free run record, keeps content
only under the same retention policy, and is sampled for the judge at the
same rate. The `runRef` it returns is the same token `/run` mints:
`ap.feedback(runRef, …)` and `POST …/feedback` work unchanged.

## Conformance

The official `openai` and `@anthropic-ai/sdk` clients, pointed at the
endpoint with their own `fetch`, complete a chat, a streamed chat, a
Responses call (plain and through `responses.stream()`), a Messages call
and a `messages.stream()` in the platform's test suite; a compatible run
and a `/run` of the same request leave identical records (usage, price,
prompt hash). The refusals above are exercised in both error shapes.
