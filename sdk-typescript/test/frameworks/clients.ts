/**
 * Clients shaped like the real `openai` and `@anthropic-ai/sdk` ones (recorded responses, streams, the `.stream()`
 * helpers, `withResponse()`), and an agent over the fake control plane that reads back the rows that would upload.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AirPrompterAgent } from "../../packages/sdk/src/agent.js";
import { publicJwkOf } from "../../packages/sdk/src/core/protocol/trust.js";
import { FakeControlPlane } from "../../packages/sdk/src/core/testing/index.js";
import type { ManifestSlot } from "../../packages/sdk/src/core/protocol/types.js";

export const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };

export type Row = { type: string; tag: string; arm: string; versionId: string; model: string; count: number; modelCalls?: number; agentRun?: number; status: string; errorClass: string | null; usageSource: string; tokens: { input: number; output: number; cachedInput?: number }; checks?: { passed: number; failed: number } };

/** An agent serving `slots(plane)`; `rows()` stops it and returns the window rows. */
export async function startAgent(slots: (plane: FakeControlPlane) => ManifestSlot[], events: Record<string, unknown>[] = []) {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-frameworks-"));
  const plane = new FakeControlPlane(scope);
  plane.promote(slots(plane));
  const ap = await AirPrompterAgent.start({
    ...scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(),
    telemetry: { sink: "memory" },
    logger: (event) => void events.push(event),
  });
  const rows = async () => {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
    return (ap.drainMemorySink() as Row[]).filter((row) => row.type === "window");
  };
  return { ap, plane, rows, events };
}

/** The standard pair: a triage slot on gpt-5 with a must-not-match check, a reply slot on claude-haiku-4-5. */
export const supportSlots = (plane: FakeControlPlane): ManifestSlot[] => [
  { ...plane.slot({ tag: "support.triage", text: "Triage for {{team}}.", variables: [{ name: "team", required: true, trust: "operator" }], model: "gpt-5" }), outputChecks: [{ kind: "must_not_match" as const, name: "no-guarantee", pattern: "refund guaranteed", flags: "i" as const }] },
  plane.slot({ tag: "support.reply", text: "Reply politely.", model: "claude-haiku-4-5" }),
];

export const byKey = (rows: Row[]) => [...rows].sort((a, b) => `${a.tag}${a.model}${a.status}${a.errorClass}`.localeCompare(`${b.tag}${b.model}${b.status}${b.errorClass}`));

/** An `APIPromise`: a promise with `withResponse()` (and a private field, to prove the proxy never stands in for `this`). */
export class ApiPromise<T> extends Promise<T> {
  #response = { status: 200 };
  withResponse(): Promise<{ data: T; response: { status: number } }> {
    return this.then((data) => ({ data, response: this.#response }));
  }
  static override get [Symbol.species]() {
    return Promise;
  }
}

/** An OpenAI `Stream`: async iterable with `tee()` and a controller. */
export function stream<T>(chunks: T[]) {
  return {
    controller: new AbortController(),
    tee() {
      return [stream(chunks), stream(chunks)];
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

export const usage = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } };
export const chatCompletion = (content: string, finish = "stop") => ({ id: "chatcmpl_1", choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content } }], usage });
export const chatChunks = (content: string, finish = "stop") => [
  { id: "chatcmpl_2", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
  ...content.split(" ").map((word, i) => ({ id: "chatcmpl_2", choices: [{ index: 0, delta: { content: (i ? " " : "") + word }, finish_reason: null }] })),
  { id: "chatcmpl_2", choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  { id: "chatcmpl_2", choices: [], usage },
];

export class FakeOpenAI {
  #calls = 0;
  readonly calls: unknown[] = [];
  fail: { status?: number; sync?: boolean } | null = null;
  readonly chat = {
    completions: {
      create: (params: Record<string, unknown>): unknown => {
        this.#calls += 1;
        this.calls.push(params);
        if (this.fail?.sync) throw Object.assign(new Error("bad request"), { status: 400 });
        if (this.fail) return new ApiPromise<never>((_, reject) => reject(Object.assign(new Error("rate limited"), { status: this.fail!.status })));
        const content = params.messages && Array.isArray(params.messages) ? `answer ${this.#calls}` : "answer";
        if (params.stream) return new ApiPromise((resolve) => resolve(stream(chatChunks(`streamed ${content} refund guaranteed`, "length"))));
        return new ApiPromise((resolve) => resolve(chatCompletion(`${content} refund guaranteed`)));
      },
      stream: (params: Record<string, unknown>) => {
        this.calls.push(params);
        const chunks = chatChunks("helper answer");
        return {
          async finalChatCompletion() {
            return chatCompletion("helper answer");
          },
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
          },
        };
      },
    },
  };
  readonly responses = {
    create: (params: Record<string, unknown>): unknown => {
      this.calls.push(params);
      const response = {
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "responses answer" }] }],
        usage: { input_tokens: 50, output_tokens: 10, input_tokens_details: { cached_tokens: 5 } },
      };
      if (params.stream) {
        return new ApiPromise((resolve) =>
          resolve(
            stream([
              { type: "response.created", response: { id: "resp_1" } },
              { type: "response.output_text.delta", delta: "responses " },
              { type: "response.output_text.delta", delta: "answer" },
              { type: "response.incomplete", response },
            ]),
          ),
        );
      }
      return new ApiPromise((resolve) => resolve({ ...response, output_text: "responses answer" }));
    },
  };
  countCalls() {
    return this.#calls;
  }
}

export const anthropicMessage = (text: string, stop = "end_turn") => ({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: stop, usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 8 } });
export const anthropicEvents = (text: string, stop = "end_turn") => [
  { type: "message_start", message: { id: "msg_2", role: "assistant", content: [], usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 8 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ...text.split(" ").map((word, i) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: (i ? " " : "") + word } })),
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } },
  { type: "message_stop" },
];

export class FakeAnthropic {
  readonly calls: unknown[] = [];
  readonly messages = {
    create: (params: Record<string, unknown>): unknown => {
      this.calls.push(params);
      if (params.stream) return new ApiPromise((resolve) => resolve(stream(anthropicEvents("streamed reply", "max_tokens"))));
      return new ApiPromise((resolve) => resolve(anthropicMessage("plain reply")));
    },
    stream: (params: Record<string, unknown>) => {
      this.calls.push(params);
      const events = anthropicEvents("helper reply");
      return {
        on() {
          return this;
        },
        async finalMessage() {
          return anthropicMessage("helper reply");
        },
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      };
    },
  };
}

