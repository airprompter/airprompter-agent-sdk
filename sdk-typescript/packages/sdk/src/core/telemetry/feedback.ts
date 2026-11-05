/**
 * The feedback catalogue (`protocol/schemas/feedback-signals.schema.json`)
 * normalised into window outcomes. Numbers, booleans and the declared enums
 * only; anything else — free text above all — is named in `rejected` and
 * never reaches the spool. `protocol/vectors/feedback.json` pins every rule.
 *
 * @example
 * ```ts
 * const { accepted, outcomes, rejected } = normalizeFeedback({ thumbs: "up", rating: 4, editDistanceRatio: 0.2, note: "great", custom: { upsold: true } });
 * // outcomes: { thumbs: true, rating: 4, editDistanceRatio: 0.2, upsold: true }
 * // rejected: { note: "unknown_signal" } — free text never becomes an outcome
 * if (accepted) writer.outcomes(dimensions, outcomes, Date.now());
 * ```
 */

export const BOOLEAN_SIGNALS = ["flagged", "accepted", "edited", "regenerated", "copied", "followUp", "escalated", "abandoned", "corrected", "resolved", "reopened", "converted", "refunded", "slaMet"] as const;
export const UNIT_SIGNALS = ["editDistanceRatio", "judgeScore"] as const;
export const COUNT_SIGNALS = ["regenerations", "timeToAcceptMs"] as const;
/** T34: written by the runtime on a window (a golden-set run), never accepted from `feedback()`; reserved so `custom` cannot shadow it. */
export const RUNTIME_SIGNALS = ["goldenPass"] as const;
export const CATALOGUE: ReadonlySet<string> = new Set(["thumbs", "rating", "correctedValue", "custom", ...BOOLEAN_SIGNALS, ...UNIT_SIGNALS, ...COUNT_SIGNALS, ...RUNTIME_SIGNALS]);
export const OUTCOME_NAME = /^[a-z][a-zA-Z0-9]{0,31}$/;

export type FeedbackRejection = "invalid_value" | "invalid_name" | "reserved_name" | "unknown_signal" | "needs_slot_enum";

export interface NormalizedFeedback {
  /** True when at least one signal became an outcome — the value `feedback()` returns. */
  accepted: boolean;
  outcomes: Record<string, number | boolean>;
  rejected: Record<string, FeedbackRejection>;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function normalizeFeedback(signals: Record<string, unknown>): NormalizedFeedback {
  const outcomes: Record<string, number | boolean> = {};
  const rejected: Record<string, FeedbackRejection> = {};
  for (const [name, value] of Object.entries(signals)) {
    if (name === "thumbs") {
      if (value === "up" || value === "down") outcomes.thumbs = value === "up";
      else rejected[name] = "invalid_value";
    } else if (name === "rating") {
      if (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5) outcomes.rating = value as number;
      else rejected[name] = "invalid_value";
    } else if ((BOOLEAN_SIGNALS as readonly string[]).includes(name)) {
      if (typeof value === "boolean") outcomes[name] = value;
      else rejected[name] = "invalid_value";
    } else if ((UNIT_SIGNALS as readonly string[]).includes(name)) {
      if (finite(value) && value >= 0 && value <= 1) outcomes[name] = value;
      else rejected[name] = "invalid_value";
    } else if ((COUNT_SIGNALS as readonly string[]).includes(name)) {
      if (Number.isInteger(value) && (value as number) >= 0) outcomes[name] = value as number;
      else rejected[name] = "invalid_value";
    } else if (name === "correctedValue") {
      // Aggregating per enum value needs the slot's declared output check, which this writer does not hold yet.
      rejected[name] = typeof value === "string" && value.length <= 64 ? "needs_slot_enum" : "invalid_value";
    } else if ((RUNTIME_SIGNALS as readonly string[]).includes(name)) {
      rejected[name] = "reserved_name";
    } else if (name === "custom") {
      // Eight custom names per call: outcomes become keys on a window row, and an unbounded set would let content in as names.
      if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length > 8) {
        rejected[name] = "invalid_value";
        continue;
      }
      for (const [customName, customValue] of Object.entries(value as Record<string, unknown>)) {
        if (!OUTCOME_NAME.test(customName)) rejected[`custom.${customName}`] = "invalid_name";
        else if (CATALOGUE.has(customName)) rejected[`custom.${customName}`] = "reserved_name";
        else if (typeof customValue === "boolean" || finite(customValue)) outcomes[customName] = customValue;
        else rejected[`custom.${customName}`] = "invalid_value";
      }
    } else rejected[name] = "unknown_signal";
  }
  return { accepted: Object.keys(outcomes).length > 0, outcomes, rejected };
}
