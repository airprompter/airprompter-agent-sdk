/**
 * The capabilities this SDK implements (`protocol/capabilities.md`): the only set a manifest's `requiredCapabilities`
 * and a slot's `requires` are checked against, and what the heartbeat lists. A later 3.x minor adds a feature by
 * adding a row to that table and a value here and in the Python twin; a test compares all three.
 *
 * @example
 * ```ts
 * const refused = (payload.requiredCapabilities ?? []).some((name) => !SUPPORTED_CAPABILITIES.has(name));
 * const heartbeat = { capabilities: [...SUPPORTED_CAPABILITIES] };
 * ```
 */
export const SUPPORTED_CAPABILITIES: ReadonlySet<string> = new Set<string>();
