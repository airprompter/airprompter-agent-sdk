/**
 * The protocol this SDK speaks and this package's own version: the manifest carries the first, the heartbeat reports
 * both. `protocol/VERSION` and `packages/sdk/package.json` are the only hand-edited versions; `scripts/build.mjs` writes
 * both constants here.
 *
 * @example
 * ```ts
 * const body = { protocol: PROTOCOL_VERSION, sdk: { name: "agent-sdk-typescript", version: SDK_VERSION } };
 * ```
 */
export const PROTOCOL_VERSION = "3.0.0";
/** The package's own version, as the heartbeat and store.json (S8: the writer) record it. Generated; never edit it. */
export const SDK_VERSION = "0.6.0";
