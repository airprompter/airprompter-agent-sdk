/**
 * Token usage from whatever a model step returned: automation platforms hand back the provider's own response shape
 * (or a framework's), so mapping usage by hand is where reports go wrong. This reads the common shapes and nothing
 * else — never text. Platform-agnostic: any Steps platform reads a model step's output with it.
 *
 * Shapes read, at the top level or under `response`, `output`, `message`, `data`, `json`, `llmOutput`,
 * `response_metadata` or `generationInfo`:
 * - OpenAI chat / responses: `usage.prompt_tokens` + `usage.completion_tokens`, `usage.input_tokens` + `usage.output_tokens`
 * - Anthropic: `usage.input_tokens` + `usage.output_tokens`
 * - LangChain: `tokenUsage.promptTokens` + `tokenUsage.completionTokens`, `usage_metadata.input_tokens` + `output_tokens`
 * - Gemini: `usageMetadata.promptTokenCount` + `usageMetadata.candidatesTokenCount`
 * - Bedrock: `usage.inputTokens` + `usage.outputTokens`
 *
 * @example
 * ```ts
 * import { usageFrom } from "@airprompter/agent-sdk/frameworks/steps";
 * usageFrom({ usage: { prompt_tokens: 812, completion_tokens: 96 } }); // → { inputTokens: 812, outputTokens: 96 }
 * usageFrom({ text: "hi" });                                            // → null
 * ```
 */

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined);
const obj = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

const PAIRS: Array<[container: string, input: string, output: string]> = [
  ["usage", "prompt_tokens", "completion_tokens"],
  ["usage", "input_tokens", "output_tokens"],
  ["usage", "inputTokens", "outputTokens"],
  ["usage", "promptTokens", "completionTokens"],
  ["tokenUsage", "promptTokens", "completionTokens"],
  ["token_usage", "prompt_tokens", "completion_tokens"],
  ["usage_metadata", "input_tokens", "output_tokens"],
  ["usageMetadata", "promptTokenCount", "candidatesTokenCount"],
  ["usageMetadata", "input_tokens", "output_tokens"],
  ["estimatedTokenUsage", "promptTokens", "completionTokens"],
];

const NESTS = ["response", "output", "message", "data", "json", "llmOutput", "response_metadata", "generationInfo", "body"];

export function usageFrom(value: unknown, depth = 0): { inputTokens: number; outputTokens: number } | null {
  const record = obj(value);
  if (!record || depth > 3) return null;
  for (const [container, input, output] of PAIRS) {
    const holder = obj(record[container]);
    const inputTokens = num(holder?.[input]);
    const outputTokens = num(holder?.[output]);
    if (inputTokens !== undefined && outputTokens !== undefined) return { inputTokens, outputTokens };
  }
  for (const nest of NESTS) {
    const inner = record[nest];
    const found = Array.isArray(inner) ? inner.map((entry) => usageFrom(entry, depth + 1)).find(Boolean) ?? null : usageFrom(inner, depth + 1);
    if (found) return found;
  }
  return null;
}
