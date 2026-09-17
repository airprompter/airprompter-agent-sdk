/**
 * Canonical JSON per `protocol/canonical-json.md`: the bytes under every digest and signature. Keys sorted, no
 * whitespace, integers only (a float, `NaN`, `undefined`, a class instance or a cycle is refused with a
 * `CanonicalJsonError` naming the path), so two SDKs hash the same document to the same bytes.
 *
 * @example
 * ```ts
 * const bytes = canonicalBytes(manifest.payload); // what the signature covers
 * const digest = sha256Prefixed(bytes); // "sha256:<hex>"
 * canonicalJson({ b: 1, a: [true, null] }); // '{"a":[true,null],"b":1}'
 * ```
 */

import { createHash } from "node:crypto";

export type CanonicalJsonRefusal = "undefined_value" | "non_integer_number" | "non_finite_number" | "unsafe_integer" | "unsupported_type" | "cycle";

export class CanonicalJsonError extends Error {
  constructor(
    readonly reason: CanonicalJsonRefusal,
    readonly path: string,
  ) {
    super(`${reason} at ${path}`);
    this.name = "CanonicalJsonError";
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, "$", new Set());
}

function encode(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("non_finite_number", path);
      if (!Number.isInteger(value)) throw new CanonicalJsonError("non_integer_number", path);
      if (Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new CanonicalJsonError("unsafe_integer", path);
      return Object.is(value, -0) ? "0" : String(value);
    case "undefined":
      throw new CanonicalJsonError("undefined_value", path);
    case "object":
      break;
    default:
      throw new CanonicalJsonError("unsupported_type", path);
  }
  const object = value as object;
  if (stack.has(object)) throw new CanonicalJsonError("cycle", path);
  if (Array.isArray(object)) {
    stack.add(object);
    const parts = object.map((item, index) => encode(item, `${path}[${index}]`, stack));
    stack.delete(object);
    return `[${parts.join(",")}]`;
  }
  const proto = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError("unsupported_type", path);
  stack.add(object);
  const parts: string[] = [];
  for (const key of Object.keys(object).sort()) {
    parts.push(`${JSON.stringify(key)}:${encode((object as Record<string, unknown>)[key], `${path}.${key}`, stack)}`);
  }
  stack.delete(object);
  return `{${parts.join(",")}}`;
}

export function sha256Prefixed(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}
