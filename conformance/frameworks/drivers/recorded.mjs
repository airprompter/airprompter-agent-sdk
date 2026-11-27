// Recorded provider transports for the TypeScript drivers: a `fetch` that
// answers each request with the fixture's next turn in the provider's own wire
// shape (JSON, or server-sent events when the request streams), moves the
// fake clock by the turn's latency, and keeps what the provider saw. No
// request leaves the process. Provider-level only: nothing here knows
// AirPrompter.
//
//   const provider = openAIChat(fixture.recorded.turns, { clock });
//   new OpenAI({ apiKey: "test-only", fetch: provider.fetch, maxRetries: 0 });
//   provider.seen(); // [{ model, system: [...], settings: { temperature, … } }, …]
//
// A turn: { content?, toolCalls?: [name | { name, arguments }…], usage?: { input, output, cachedInput? }, finish?, latencyMs? }.
// S0's LangChain fixture keeps OpenAI's own usage keys (`prompt_tokens`, `completion_tokens`), which are read too.

const textOf = (content) => (Array.isArray(content) ? content.map((block) => block.text ?? "").join("") : String(content ?? ""));
const usageOf = (turn) => ({ input: turn.usage?.input ?? turn.usage?.prompt_tokens ?? 3, output: turn.usage?.output ?? turn.usage?.completion_tokens ?? 2, cachedInput: turn.usage?.cachedInput ?? turn.usage?.prompt_tokens_details?.cached_tokens ?? 0 });
const sse = (events, done) => new Response(events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { status: 200, headers: { "content-type": "text/event-stream" } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pick = (body, keys) => Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
/** A turn's tool calls as `{ name, arguments }` (arguments as JSON text): a bare name asks with none. */
export const toolCallsOf = (turn) => (turn.toolCalls ?? []).map((call) => (typeof call === "string" ? { name: call, arguments: "{}" } : { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }));
/** Headers that differ between two identical calls by design (a fresh idempotency key), left out of `untouched`. */
const VOLATILE_HEADERS = new Set(["idempotency-key"]);
const requestOf = (url, init, raw) => JSON.stringify({ url: String(url), method: init?.method ?? "GET", headers: [...new Headers(init?.headers ?? {})].filter(([name]) => !VOLATILE_HEADERS.has(name)).sort(), body: raw });

function recorder(turns, clock, answer, readSystem, settingsKeys) {
  const calls = [];
  let next = 0;
  const fetch = async (url, init) => {
    const raw = String(init?.body ?? "");
    const body = JSON.parse(raw || "{}");
    // `request`: the whole request (URL, method, headers, body), so a passthrough proves it left as the bare client sends it.
    calls.push({ url: String(url), raw, request: requestOf(url, init, raw), model: body.model, system: readSystem(body), settings: pick(body, settingsKeys), stream: body.stream === true });
    const turn = turns[Math.min(next, turns.length - 1)];
    next += 1;
    if (clock) clock.ms += turn.latencyMs ?? 100;
    if (turn.fail) return json({ error: { message: "failed", type: "server_error" } }, turn.fail);
    return answer(turn, body, next);
  };
  /** What the harness reads; the conversation itself stays here. */
  const seen = () => calls.map(({ model, system, settings, stream }) => ({ model, system, settings, stream }));
  return { fetch, calls, seen };
}

/** The OpenAI Chat Completions API (`POST /chat/completions`), plain or streamed. */
export function openAIChat(turns, { clock } = {}) {
  return recorder(turns, clock, (turn, body, n) => {
    const usage = usageOf(turn);
    const wireUsage = { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, prompt_tokens_details: { cached_tokens: usage.cachedInput } };
    const toolCalls = toolCallsOf(turn).map((call, index) => ({ id: `call_${n}_${index}`, type: "function", function: call }));
    const finish = turn.finish ?? (toolCalls.length ? "tool_calls" : "stop");
    if (body.stream) {
      const chunk = (delta, finishReason = null) => ({ data: { id: `chatcmpl-${n}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] } });
      const events = [chunk({ role: "assistant", content: "" })];
      if (turn.content) for (const piece of turn.content.match(/.{1,6}/gs) ?? []) events.push(chunk({ content: piece }));
      toolCalls.forEach((call, index) => events.push(chunk({ tool_calls: [{ index, ...call }] })));
      events.push(chunk({}, finish));
      if (body.stream_options?.include_usage) events.push({ data: { id: `chatcmpl-${n}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage: wireUsage } });
      return sse(events, true);
    }
    return json({ id: `chatcmpl-${n}`, object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: turn.content ?? "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }], usage: wireUsage });
  }, (body) => (body.messages ?? []).filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)), ["temperature", "top_p", "max_tokens", "max_completion_tokens", "stop", "reasoning_effort"]);
}

/** The OpenAI Responses API (`POST /responses`), plain. The system text is `instructions`. */
export function openAIResponses(turns, { clock } = {}) {
  return recorder(turns, clock, (turn, body, n) => {
    const usage = usageOf(turn);
    const output = [
      ...toolCallsOf(turn).map((call, index) => ({ type: "function_call", id: `fc_${n}_${index}`, call_id: `call_${n}_${index}`, name: call.name, arguments: call.arguments, status: "completed" })),
      ...(turn.content ? [{ type: "message", id: `msg_${n}`, status: "completed", role: "assistant", content: [{ type: "output_text", text: turn.content, annotations: [] }] }] : []),
    ];
    return json({ id: `resp_${n}`, object: "response", created_at: 1, status: "completed", model: body.model, output, usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output, input_tokens_details: { cached_tokens: usage.cachedInput }, output_tokens_details: { reasoning_tokens: 0 } } });
  }, (body) => (body.instructions === undefined ? [] : [textOf(body.instructions)]), ["temperature", "top_p", "max_output_tokens", "reasoning"]);
}

/** The Anthropic Messages API (`POST /v1/messages`), plain or streamed. */
export function anthropicMessages(turns, { clock } = {}) {
  return recorder(turns, clock, (turn, body, n) => {
    const usage = usageOf(turn);
    const content = [...(turn.content ? [{ type: "text", text: turn.content }] : []), ...toolCallsOf(turn).map((call, index) => ({ type: "tool_use", id: `toolu_${n}_${index}`, name: call.name, input: JSON.parse(call.arguments) }))];
    const stop = turn.finish ?? (turn.toolCalls?.length ? "tool_use" : "end_turn");
    const message = { id: `msg_${n}`, type: "message", role: "assistant", model: body.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cachedInput, cache_creation_input_tokens: 0 } };
    if (!body.stream) return json(message);
    const events = [{ event: "message_start", data: { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } } } }];
    content.forEach((block, index) => {
      events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } } });
      if (block.type === "text") for (const piece of block.text.match(/.{1,6}/gs) ?? []) events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } } });
      else events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{}" } } });
      events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    });
    events.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output } } });
    events.push({ event: "message_stop", data: { type: "message_stop" } });
    return sse(events, false);
  }, (body) => (body.system === undefined ? [] : [textOf(body.system)]), ["temperature", "top_p", "top_k", "max_tokens", "stop_sequences"]);
}
