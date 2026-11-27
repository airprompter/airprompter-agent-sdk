/**
 * What the framework adapters share, for `frameworks/contract` alone: the
 * one file allowed to import this barrel (`scripts/lint-imports.mjs`). It is
 * not on `/runtime`, so none of it falls under the 1.0 promise until the
 * contract itself does.
 *
 * @example
 * ```ts
 * // frameworks/contract.ts
 * export { chooseModel, settingsFor, measureCall, beginMeasure, acquireRun, instrumentClient } from "../runtime/adapter/index.js";
 * ```
 */

export { acquireRun, applySettings, beginMeasure, chooseModel, measureCall, settingsFor } from "../wrap/adapt.js";
export type { ChooseModelInput, MappedSettings, MeasureOptions, Measurement, SettingsKeys } from "../wrap/adapt.js";
export { ADAPTER_EVENTS, type AdapterEvent } from "../wrap/events.js";
export { instrumentClient } from "../wrap/instrument.js";
export type { ApplyPlacement, ApprovedPlacement, InstrumentClientOptions, InstrumentRuntime } from "../wrap/instrument.js";
export type { ClientMethod, ClientMethods, Pending, StreamAccumulator } from "../wrap/proxy.js";
