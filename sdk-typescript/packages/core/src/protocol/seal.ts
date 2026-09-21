/**
 * The customer-store seal (`protocol/pins.md`): recompute what a customer-held copy of a release proves against
 * the pins it was sealed with, and the short id a release digest goes by in a pin. A faithful port of
 * `conformance/reference.mjs`'s `verifySeal` over this package's own canonical JSON and digest projection
 * (`releaseDigestInput` / `releaseDigest` in `./trust.js`) — never a re-derivation of the projection, so the two
 * never drift.
 *
 * @example
 * ```ts
 * const sealId = sealIdOf(release.payload.releaseDigest); // "a3a20ff4f7fb"
 * const { observedDigest, intact, changedTags } = verifySeal({ sealId, sealedPins: release.payload.slots, pins: mirror.pins, texts: mirror.texts });
 * if (!intact) report({ sealId, observedDigest, intact, checkedAt: now, changedTags });
 * ```
 */

import { canonicalJson, sha256Prefixed } from "./canonicalJson.js";
import { inferenceDigestInput, releaseDigest, releaseDigestInput } from "./trust.js";
import type { ManifestSlot, SlotStep } from "./types.js";

/** The first 12 hex characters after `sha256:` in a release digest (pins.md). Throws on anything that is not a `sha256:` + 64 hex digest. */
export function sealIdOf(releaseDigest: `sha256:${string}` | string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(releaseDigest)) throw new RangeError(`sealIdOf: not a release digest: ${releaseDigest}`);
  return releaseDigest.slice(7, 19);
}

export interface VerifySealInput {
  sealId: string;
  /** The pins as sealed — the release's own manifest slots, or the pinned envelope's. */
  sealedPins: readonly ManifestSlot[];
  /** The customer's own copy of those pins — time and hand-editing may have moved it out of step. */
  pins: readonly ManifestSlot[];
  /** contentHash → base64url text, for every text the customer's copy holds. */
  texts: Readonly<Record<string, string>>;
}

export interface VerifySealResult {
  observedDigest: `sha256:${string}`;
  intact: boolean;
  /** Sorted, deduped, never text: a slot by `tag`, or a workflow step by `<tag>#<ordinal>`. */
  changedTags: string[];
}

/**
 * Recompute the seal (pins.md › "Customer-store seal"): every pin's (and, for a workflow, every step's) text is
 * rehashed against `texts`; a missing or mismatching text substitutes the rehashed value before the digest is
 * recomputed. Per-tag attribution goes further than the text: every pin's and step's full digest projection
 * (`releaseDigestInput` — model, settings, variables, checks, golden set) is diffed between the sealed and the
 * (rehashed) observed copy, so a settings-only drift is named by its tag too, not just a text tamper.
 */
export function verifySeal(input: VerifySealInput): VerifySealResult {
  const { sealId, sealedPins, pins, texts } = input;
  const changed = new Set<string>();

  const rehash = (contentHash: string, tag: string): string => {
    const encoded = texts[contentHash];
    if (encoded === undefined) {
      changed.add(tag);
      return contentHash;
    }
    const bytes = Buffer.from(encoded, "base64url");
    const rehashed = sha256Prefixed(bytes);
    if (rehashed !== contentHash) {
      changed.add(tag);
      return rehashed;
    }
    return contentHash;
  };

  // (a) text missing or rehashes differently.
  const observedPins: ManifestSlot[] = pins.map((pin) => {
    const contentHash = rehash(pin.contentHash, pin.tag) as ManifestSlot["contentHash"];
    const steps: SlotStep[] | undefined = pin.steps
      ? pin.steps.map((step) => ({ ...step, contentHash: rehash(step.contentHash, step.stepId) as SlotStep["contentHash"] }))
      : undefined;
    return { ...pin, contentHash, ...(steps ? { steps } : {}) };
  });
  const observedDigest = releaseDigest(observedPins);

  const pinProjection = (pin: ManifestSlot): string => canonicalJson(releaseDigestInput([pin])[0]);
  const withoutSteps = (pin: ManifestSlot): ManifestSlot => {
    const { steps: _steps, ...rest } = pin;
    return rest;
  };

  const sealedByTag = new Map(sealedPins.map((p) => [p.tag, p]));
  const observedByTag = new Map(observedPins.map((p) => [p.tag, p]));
  const allTags = new Set<string>([...sealedByTag.keys(), ...observedByTag.keys()]);
  for (const tag of allTags) {
    const sealedPin = sealedByTag.get(tag);
    const observedPin = observedByTag.get(tag);
    // (d) a tag present on only one side.
    if (!sealedPin || !observedPin) {
      changed.add(tag);
      continue;
    }
    const isWorkflow = Array.isArray(sealedPin.steps) || Array.isArray(observedPin.steps);
    if (!isWorkflow) {
      // (b) a prompt pin: compare its full digest projection.
      if (pinProjection(sealedPin) !== pinProjection(observedPin)) changed.add(tag);
      continue;
    }
    // (c) a workflow pin: compare with steps removed, then each step by stepId.
    if (pinProjection(withoutSteps(sealedPin)) !== pinProjection(withoutSteps(observedPin))) changed.add(tag);
    const sealedSteps = new Map((sealedPin.steps ?? []).map((s) => [s.stepId, s]));
    const observedSteps = new Map((observedPin.steps ?? []).map((s) => [s.stepId, s]));
    const allStepIds = new Set<string>([...sealedSteps.keys(), ...observedSteps.keys()]);
    for (const stepId of allStepIds) {
      const sealedStep = sealedSteps.get(stepId);
      const observedStep = observedSteps.get(stepId);
      if (!sealedStep || !observedStep) {
        changed.add(stepId);
        continue;
      }
      if (canonicalJson(stepDigestProjection(sealedStep)) !== canonicalJson(stepDigestProjection(observedStep))) changed.add(stepId);
    }
  }

  const changedTags = [...changed].sort();
  const shortIdMatches = observedDigest.slice(7, 19) === sealId;
  const intact = changedTags.length === 0 && observedDigest === releaseDigest(sealedPins) && shortIdMatches;
  return { observedDigest, intact, changedTags };
}

/**
 * A workflow step's own digest projection — the same fields `releaseDigestInput`'s `steps` mapping builds inline
 * (trust.ts has no standalone export for one step, only for a whole slot's `steps` array), reusing its
 * `inferenceDigestInput` so a step's settings are never re-derived here.
 */
function stepDigestProjection(step: SlotStep): Record<string, unknown> {
  return {
    stepId: step.stepId,
    ordinal: step.ordinal,
    promptArtifactId: step.promptArtifactId,
    promptVersionId: step.promptVersionId,
    contentHash: step.contentHash,
    byteLength: step.byteLength,
    ...(step.inference ? { inference: inferenceDigestInput(step.inference) } : {}),
  };
}
