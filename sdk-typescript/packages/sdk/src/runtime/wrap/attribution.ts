/**
 * Which rendered prompt a direct provider call belongs to when the caller placed the text itself: the explicit async
 * scope `ap.attribute(rendered, fn)` sets. A call outside any scope and with no slot is not observed: nothing here
 * guesses from request text.
 *
 * @example `withAttribution(attribution, () => openai.chat.completions.create(params)); // currentAttribution() inside is attribution`
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { SlotInference } from "../../core/index.js";

export interface Attribution {
  audienceIds?: readonly string[];
  runMinute?: string;
  artifactId: string;
  tag: string;
  /** A workflow step's id. `tag` stays the slot's. */
  step?: string;
  versionId: string;
  arm: string;
  model: string;
  /** The slot's inference settings, applied to the wrapped call (`inference.ts`). */
  inference?: SlotInference;
}

/**
 * One scope per process, kept on `globalThis`: an application whose ESM code calls `ap.attribute` while a CommonJS
 * dependency makes the call loads two copies of this module, and a module-local store would leave the second blind.
 * The key carries the major version: every 1.x copy shares it, so a field a minor adds to `Attribution` is optional and
 * a reader tolerates its absence. The key changes only with a major, and a 2.x scope is invisible to a 1.x adapter.
 */
const SCOPE: unique symbol = Symbol.for("airprompter.agent-sdk.attribution.v1");
const scope: AsyncLocalStorage<Attribution> = ((globalThis as { [SCOPE]?: AsyncLocalStorage<Attribution> })[SCOPE] ??= new AsyncLocalStorage<Attribution>());

/** The attribution an enclosing `ap.attribute()` scope set, if any. */
export function currentAttribution(): Attribution | undefined {
  return scope.getStore();
}

/** Run `fn` with every wrapped call inside it attributed to `attribution`. */
export function withAttribution<T>(attribution: Attribution, fn: () => T): T {
  return scope.run(attribution, fn);
}
