/**
 * The Zapier steps: **Get prompt** and **Report run** (actions), **Rollout changed** (a polling trigger) and the hidden
 * slot list behind the slot dropdown. Each is a few lines over the platform-agnostic client; field schemas, the
 * trigger's cursor and error mapping are the only Zapier logic.
 *
 * A step picks one slot, fills its variables and may name a Subject. Everything about the rollout — versions,
 * approvals, A/B arms, dial-up, rollback, the lease — is decided in AirPrompter; there are no fields for it here.
 *
 * @example
 * ```ts
 * // A Zap: Trigger → AirPrompter "Get prompt" (slot support.triage) → AI by Zapier (prompt = {{prompt}},
 * // model = {{model}}) → AirPrompter "Report run" (run reference = {{run_ref}}, tokens from the AI step).
 * const app = { creates: { get_prompt: getPrompt, report_run: reportRun }, triggers: { slot_list: slotList, rollout_changed: rolloutChanged } };
 * ```
 */

import type { Bundle, ZObject } from "zapier-platform-core";
import type { GetPromptResult, RolloutCursor } from "../core/index.js";
import { clientFor, withClient, zapierError } from "./connection.js";

/** Variable fields are prefixed so a variable called `slot` or `subject` cannot shadow the step's own fields. */
export const VARIABLE_PREFIX = "var__";

const flatten = (result: GetPromptResult) => ({
  id: result.runRef,
  prompt: result.prompt,
  model: result.model,
  temperature: result.inference.temperature ?? null,
  top_p: result.inference.topP ?? null,
  max_output_tokens: result.inference.maxOutputTokens ?? null,
  stop_sequences: result.inference.stopSequences ?? [],
  reasoning_effort: result.inference.reasoningEffort ?? null,
  slot: result.slot,
  version_id: result.versionId,
  arm: result.arm,
  generation: result.generation,
  run_ref: result.runRef,
  served_from: result.servedFrom,
  lease_expires_at: result.leaseExpiresAt,
});

export const slotList = {
  key: "slot_list",
  noun: "Slot",
  display: { label: "List Slots", description: "The prompt slots of the release serving this agent (feeds the slot dropdown).", hidden: true },
  operation: {
    perform: async (z: ZObject, bundle: Bundle) =>
      withClient(z, bundle, async (client) =>
        (await client.listSlots()).map((slot) => ({
          id: slot.slot,
          name: `${slot.slot} — ${slot.versionId}${slot.experiment ? ` (A/B: ${slot.experiment.arms.map((a) => `${a.arm} ${a.weightBps / 100}%`).join(", ")})` : ""}${slot.disabled ? " (disabled)" : ""}`,
        })),
      ),
  },
};

export const getPrompt = {
  key: "get_prompt",
  noun: "Prompt",
  display: {
    label: "Get Prompt",
    description: "Serves the approved version of one prompt slot from AirPrompter, rendered with your variables, ready for an AI step. A/B splits and dial-up are applied as approved in AirPrompter.",
  },
  operation: {
    inputFields: [
      { key: "slot", label: "Slot", required: true, dynamic: "slot_list.id.name", altersDynamicFields: true, helpText: "The prompt slot this step serves. One slot per step; versions and rollouts are managed in AirPrompter." },
      async (z: ZObject, bundle: Bundle) => {
        const slot = String((bundle.inputData as Record<string, unknown>).slot ?? "");
        if (!slot) return [];
        const variables = await withClient(z, bundle, (client) => client.slotVariables(slot));
        return variables.map((variable) => ({
          key: `${VARIABLE_PREFIX}${variable.name}`,
          label: variable.name,
          required: variable.required,
          type: "text",
          ...(variable.default !== undefined ? { placeholder: variable.default } : {}),
          helpText: variable.trust === "end_user" ? "Text from the person this step serves; AirPrompter fences it when rendering." : variable.default !== undefined ? `Optional; \`${variable.default}\` when left empty.` : "A variable of this prompt.",
        }));
      },
      { key: "subject", label: "Subject", required: false, type: "string", helpText: "Optional. The same subject (a customer or ticket id) always gets the same A/B arm. Leave empty for a random arm on every run, split by the approved weights." },
    ],
    perform: async (z: ZObject, bundle: Bundle) => {
      const input = bundle.inputData as Record<string, unknown>;
      const variables: Record<string, string> = {};
      for (const [key, value] of Object.entries(input)) {
        if (key.startsWith(VARIABLE_PREFIX) && value !== undefined && value !== null) variables[key.slice(VARIABLE_PREFIX.length)] = String(value);
      }
      const subject = typeof input.subject === "string" ? input.subject : input.subject === undefined || input.subject === null ? undefined : String(input.subject);
      const result = await withClient(z, bundle, (client) => client.getPrompt({ slot: String(input.slot ?? ""), variables, ...(subject !== undefined ? { subject } : {}) }));
      return flatten(result);
    },
    sample: { id: "rr_sample", prompt: "Classify this ticket for the Billing team: …", model: "claude-sonnet-5", temperature: 0.2, top_p: null, max_output_tokens: 1024, stop_sequences: [], reasoning_effort: null, slot: "support.triage", version_id: "ver_triage_7", arm: "none", generation: 12, run_ref: "rr_sample", served_from: "network", lease_expires_at: "2026-11-16T13:00:00.000Z" },
    outputFields: [
      { key: "prompt", label: "Prompt" },
      { key: "model", label: "Model" },
      { key: "temperature", label: "Temperature", type: "number" },
      { key: "top_p", label: "Top P", type: "number" },
      { key: "max_output_tokens", label: "Max Output Tokens", type: "integer" },
      { key: "reasoning_effort", label: "Reasoning Effort" },
      { key: "slot", label: "Slot" },
      { key: "version_id", label: "Version ID" },
      { key: "arm", label: "A/B Arm" },
      { key: "generation", label: "Release Generation", type: "integer" },
      { key: "run_ref", label: "Run Reference" },
      { key: "served_from", label: "Served From" },
      { key: "lease_expires_at", label: "Stored Copy Valid Until", type: "datetime" },
    ],
  },
};

export const reportRun = {
  key: "report_run",
  noun: "Run",
  display: {
    label: "Report Run",
    description: "Reports the tokens, any error and an optional quality rating for a run served by Get Prompt, so AirPrompter can compare versions and A/B arms.",
  },
  operation: {
    inputFields: [
      { key: "run_ref", label: "Run Reference", required: true, type: "string", helpText: "Map the Run Reference from the Get Prompt step." },
      { key: "input_tokens", label: "Input Tokens", required: false, type: "integer" },
      { key: "output_tokens", label: "Output Tokens", required: false, type: "integer" },
      { key: "latency_ms", label: "Duration (ms)", required: false, type: "integer", helpText: "How long the AI step took, if you have it." },
      { key: "error", label: "Error", required: false, type: "string", helpText: "The AI step's error, if it failed. Only its kind (timeout, rate limit, …) is sent, never the text." },
      { key: "thumbs", label: "Thumbs", required: false, choices: { up: "Up", down: "Down" } },
      { key: "rating", label: "Rating (1–5)", required: false, choices: { "1": "1", "2": "2", "3": "3", "4": "4", "5": "5" } },
    ],
    perform: async (z: ZObject, bundle: Bundle) => {
      const input = bundle.inputData as Record<string, unknown>;
      const int = (value: unknown): number | undefined => (value === undefined || value === null || value === "" ? undefined : Number(value));
      const rating = int(input.rating);
      const runRef = String(input.run_ref ?? "");
      await withClient(z, bundle, (client) =>
        client.reportRun({
          runRef,
          ...(int(input.input_tokens) !== undefined ? { inputTokens: int(input.input_tokens)! } : {}),
          ...(int(input.output_tokens) !== undefined ? { outputTokens: int(input.output_tokens)! } : {}),
          ...(int(input.latency_ms) !== undefined ? { latencyMs: int(input.latency_ms)! } : {}),
          ...(typeof input.error === "string" && input.error.trim() ? { error: input.error } : {}),
          ...(input.thumbs === "up" || input.thumbs === "down" ? { thumbs: input.thumbs } : {}),
          ...(rating !== undefined ? { rating: rating as 1 | 2 | 3 | 4 | 5 } : {}),
        }),
      );
      return { id: runRef, run_ref: runRef, reported: true };
    },
    sample: { id: "rr_sample", run_ref: "rr_sample", reported: true },
    outputFields: [{ key: "run_ref", label: "Run Reference" }, { key: "reported", label: "Reported", type: "boolean" }],
  },
};

/** The trigger's memory between polls, per Zap, in `z.cache` (a `z.cursor` lasts about an hour; this must last between rollouts). */
const cursorKey = (bundle: Bundle) => {
  const meta = (bundle as unknown as { meta?: { zap?: { id?: string | number } } }).meta;
  return `ap:rollout-cursor:${meta?.zap?.id ?? "default"}`;
};

export const rolloutChanged = {
  key: "rollout_changed",
  noun: "Rollout Change",
  display: {
    label: "Rollout Changed",
    description: "Triggers when a slot's rollout changes in AirPrompter: a new version approved, a dial-up step, an A/B test started or ended, a rollback, a slot disabled.",
  },
  operation: {
    type: "polling" as const,
    perform: async (z: ZObject, bundle: Bundle) => {
      const meta = (bundle as unknown as { meta?: { isLoadingSample?: boolean } }).meta;
      let previous: RolloutCursor | null = null;
      try {
        const stored = await z.cache.get(cursorKey(bundle));
        previous = stored && typeof stored === "object" ? (stored as RolloutCursor) : null;
      } catch {
        previous = null;
      }
      let result;
      try {
        result = await clientFor(z, bundle).rolloutEvents(previous);
      } catch (error) {
        throw zapierError(z, error);
      }
      // Loading a sample in the editor must not move the live Zap's memory.
      if (!meta?.isLoadingSample) await (z.cache as unknown as { set: (k: string, v: unknown, ttl: number | null, scope: string[]) => Promise<unknown> }).set(cursorKey(bundle), result.cursor, null, ["auth"]);
      return result.events.map((event) => ({
        id: event.id,
        slot: event.slot,
        change: event.state,
        summary: event.summary,
        generation: event.generation,
        version_id: event.versionId,
        previous_version_id: event.previousVersionId,
        ab_arms: event.experiment ? event.experiment.arms.map((arm) => `${arm.arm}:${arm.versionId}:${arm.weightBps / 100}%`).join(", ") : null,
        at: event.at,
      }));
    },
    sample: { id: "support.triage:3f1c2a9b0d4e:new_version", slot: "support.triage", change: "new_version", summary: "support.triage: ver_triage_6 → ver_triage_7 approved", generation: 12, version_id: "ver_triage_7", previous_version_id: "ver_triage_6", ab_arms: null, at: "2026-11-16T12:00:00.000Z" },
    outputFields: [
      { key: "slot", label: "Slot" },
      { key: "change", label: "Change" },
      { key: "summary", label: "Summary" },
      { key: "generation", label: "Release Generation", type: "integer" },
      { key: "version_id", label: "Version ID" },
      { key: "previous_version_id", label: "Previous Version ID" },
      { key: "ab_arms", label: "A/B Arms" },
      { key: "at", label: "Seen At", type: "datetime" },
    ],
  },
};
