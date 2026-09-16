/**
 * Which rendered prompt a provider call belongs to (T33, D65). A wrapped
 * client sees only the call's parameters; three things can name the slot:
 *
 *   1. an explicit scope — `ap.attribute(rendered, () => openai.chat.completions.create(...))`
 *      (`AsyncLocalStorage`, so it follows the call through awaits);
 *   2. the rendered text itself — every `render()` registers the SHA-256 of
 *      its text; a request whose system / instructions / message text is
 *      exactly one of the last renders is that render's call;
 *   3. nothing — the call is passed through untouched and never guessed at.
 *
 * Content is read here only to be hashed: the registry keeps hashes and
 * dimension names, never a prompt.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { SlotInference } from "@airprompter/agent-core";
import { createHash } from "node:crypto";

export interface Attribution {
  tag: string;
  versionId: string;
  arm: string;
  model: string;
  /** 0.3.1: the slot's inference settings, applied to the wrapped call (`inference.ts`). */
  inference?: SlotInference;
}

const scope = new AsyncLocalStorage<Attribution>();

/** The attribution an enclosing `ap.attribute()` scope set, if any. */
export function currentAttribution(): Attribution | undefined {
  return scope.getStore();
}

/** Run `fn` with every wrapped call inside it attributed to `attribution`. */
export function withAttribution<T>(attribution: Attribution, fn: () => T): T {
  return scope.run(attribution, fn);
}

export const hashText = (text: string): string => createHash("sha256").update(text, "utf8").digest("base64url");

/** The last `capacity` renders by text hash; the newest wins a collision. */
export class RenderRegistry {
  private readonly entries = new Map<string, Attribution>();

  constructor(private readonly capacity = 256) {}

  register(text: string, attribution: Attribution): void {
    const key = hashText(text);
    this.entries.delete(key);
    this.entries.set(key, attribution);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as string);
  }

  /** The first text that is a registered render, in the order given. */
  match(texts: Iterable<string>): Attribution | undefined {
    for (const text of texts) {
      const hit = this.entries.get(hashText(text));
      if (hit) return hit;
    }
    return undefined;
  }

  get size(): number {
    return this.entries.size;
  }
}

const REQUEST_TEXT_FIELDS = ["system", "instructions", "messages", "input", "prompt"] as const;

/**
 * Every string a request carries where a rendered prompt could be, most
 * likely first: `system` / `instructions` (Anthropic, Responses), then the
 * messages (`messages`, Responses `input`, AI SDK `prompt`) in order — a
 * string, or the `text` of content parts. Never throws on an odd shape.
 */
export function requestTexts(params: unknown): string[] {
  const out: string[] = [];
  if (typeof params !== "object" || params === null) return out;
  const collect = (value: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof value === "string") {
      if (value.length > 0) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      if (record.content !== undefined) collect(record.content, depth + 1);
      else if (typeof record.text === "string") collect(record.text, depth + 1);
    }
  };
  for (const field of REQUEST_TEXT_FIELDS) collect((params as Record<string, unknown>)[field], 0);
  return out;
}
