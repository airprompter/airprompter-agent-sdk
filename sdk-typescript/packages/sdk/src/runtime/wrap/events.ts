/**
 * The log events every adapter writes, in both SDKs: one vocabulary, so the
 * conformance suite and a customer's alerting can name them. Every event
 * carries `adapter` (the framework, as its subpath names it) and, where there
 * is one, `slot` and `method` (the client method's dotted path). None carries
 * a prompt, an output or a value.
 *
 * @example
 * ```ts
 * ap.log({ event: ADAPTER_EVENTS.modelUnresolved, adapter: "openai", slot: "support.reply", method: "chat.completions.create", model: "gpt-5" });
 * ```
 */

export const ADAPTER_EVENTS = {
  /** No slot and no `ap.attribute` scope: the call passed through unobserved. Once per method. */
  unattributed: "adapter_unattributed",
  /** A `.stream()` helper on a slot-bound client passed through unmeasured. Once per method. */
  streamHelperUnmeasured: "adapter_stream_helper_unmeasured",
  /** The release's model could not be served: the slot declined for the run. Once per method and model. Not `adapter_`: it is the decline's own reason, and LangChain logs it too. */
  modelUnresolved: "model_unresolved",
  /** Placement threw: the caller's request went out unchanged. */
  placementFailed: "adapter_placement_failed",
  /** The call site set a sealed setting to another value: the release's replaced it (`parameters`). */
  inferenceOverridden: "adapter_inference_overridden",
  /** A sealed setting the call cannot carry was not sent (`settings`: `{ setting, reason }[]`). */
  inferenceUnsupported: "adapter_inference_unsupported",
  /** Watching the response failed: the call's own result came back, measured with what was seen. */
  tapFailed: "adapter_tap_failed",
  /** Reading the `ap.attribute` scope failed: the call passed through unobserved. */
  attributionFailed: "adapter_attribution_failed",
  /** A call's record arrived after its run ended (a logger that runs late, as LiteLLM's does): dropped, never counted twice. */
  lateRecord: "adapter_late_record",
} as const;

export type AdapterEvent = (typeof ADAPTER_EVENTS)[keyof typeof ADAPTER_EVENTS];
