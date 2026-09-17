/**
 * Error identity without `instanceof`.
 *
 * A lockfile can hold two copies of this package (a sibling package pinning
 * a different patch, a bundler duplicating a chunk). An error thrown by one
 * copy is not `instanceof` the class from the other, and a runtime that
 * branches on `instanceof` then misreports a store error as unknown or skips
 * a flush. Every SDK error sets `name` and carries a `code`; both survive
 * duplication, so identity is read from them. Nothing in this package may
 * use `instanceof` on an SDK class (pinned by `test/discriminants.test.ts`).
 *
 * @example
 * ```ts
 * try {
 *   store.activate();
 * } catch (error) {
 *   // True for a StoreError thrown by another copy of the package too; `instanceof StoreError` would say false.
 *   if (errorNamed(error, "StoreError") && error.code === "not_staged") return;
 *   throw error;
 * }
 * ```
 */

/** An error object whose `name` is `name` and which carries a string `code`. */
export function errorNamed<TCode extends string = string>(error: unknown, name: string): error is Error & { code: TCode } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === name && typeof candidate.code === "string";
}
