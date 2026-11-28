// Recorded provider transports for the TypeScript drivers: a `fetch` that
// answers each request with the fixture's next turn in the provider's own wire
// shape, and keeps what the provider saw (model, system text, settings) for the
// harness. No request leaves the process. Provider-level only: nothing here
// knows AirPrompter.
//
//   const provider = openAIChat(fixture.recorded.turns);
//   new ChatOpenAI({ model, apiKey: "test-only", configuration: { fetch: provider.fetch } });
//   provider.calls; // [{ system: [...], model, settings: { temperature, ... } }, …]
//
// A turn: { content?, toolCalls?: [name…], usage?: { prompt_tokens, completion_tokens, prompt_tokens_details? }, finish?, fail?: httpStatus }.

const textOf = (content) => (Array.isArray(content) ? content.map((block) => block.text ?? "").join("") : String(content ?? ""));

/** The OpenAI Chat Completions API (`POST /chat/completions`), non-streaming. */
export function openAIChat(turns) {
  const calls = [];
  let next = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    const settings = Object.fromEntries(["temperature", "top_p", "max_tokens", "max_completion_tokens", "stop", "reasoning_effort"].filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
    calls.push({ url: String(url), model: body.model, system: body.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)), settings, body });
    const turn = turns[Math.min(next, turns.length - 1)];
    next += 1;
    if (turn.fail) return new Response(JSON.stringify({ error: { message: "failed", type: "server" } }), { status: turn.fail, headers: { "content-type": "application/json" } });
    const toolCalls = (turn.toolCalls ?? []).map((name, index) => ({ id: `call_${next}_${index}`, type: "function", function: { name, arguments: "{}" } }));
    return new Response(JSON.stringify({
      id: `chatcmpl-${next}`, object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: turn.finish ?? (toolCalls.length ? "tool_calls" : "stop"), message: { role: "assistant", content: turn.content ?? "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
      usage: { ...(turn.usage ?? { prompt_tokens: 3, completion_tokens: 2 }), total_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  /** What the harness reads: the body itself stays here (it holds the conversation). */
  const seen = () => calls.map(({ model, system, settings }) => ({ model, system, settings }));
  return { fetch, calls, seen };
}
