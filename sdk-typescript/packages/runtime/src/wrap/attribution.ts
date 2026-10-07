/**
 * Which rendered prompt a provider call belongs to. A caller can supply an explicit async scope with
 * `ap.attribute(rendered, fn)`, or a wrapped provider can match request text against the bounded registry of recent
 * render hashes. A miss passes through without telemetry; ambiguous artifact/version/arm/audience identities require
 * explicit scope. Content is read only to hash it and is never retained. Repeated renders of the same durable identity
 * remain matchable when their minute changes.
 *
 * @example `registry.register(rendered.text, attribution); registry.match(requestTexts(params));`
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { ambiguousAudienceAttribution, type SlotInference } from "@airprompter/agent-core";
import { createHash } from "node:crypto";

export interface Attribution {
  audienceIds?: readonly string[];
  runMinute?: string;
  artifactId?: string;
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

/** Ambiguous cohorts require explicit attribution. */
export class RenderRegistry {
  private readonly entries = new Map<string, Attribution | null>();

  constructor(private readonly capacity = 256) {}

  register(text: string, attribution: Attribution): void {
    const key = hashText(text);
    const previous = this.entries.get(key);
    // Ambiguous text requires an explicit scope.
    const ambiguous = ambiguousAudienceAttribution(previous,attribution);
    this.entries.delete(key);
    this.entries.set(key, ambiguous ? null : attribution);
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

/** Finds candidate prompt strings in common provider request shapes. */
export function requestTexts(params: unknown): string[] {
  const out: string[] = [];
  if (typeof params !== "object" || params === null) return out;
  const collect = (value: unknown, depth: number): void => {
    // messages → message → content parts → text is the deepest documented shape; a bound also keeps a cyclic object from trapping the wrapper.
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
