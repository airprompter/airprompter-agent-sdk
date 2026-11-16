/**
 * The trigger's poll state, kept in the node's static data: the core's rollout cursor and the event ids already
 * emitted. n8n's rule for polling triggers: the first poll of an active workflow records the baseline and emits
 * nothing (the core reports the baseline as `current` events; they are dropped here). A manual test emits the current
 * state of each slot so there is data to map. Event ids are the core's `slot:digest:state` (the digest covers the
 * generation, so a rollback to a version served before is a new id); an id seen before never fires again, even if a
 * poll is replayed from an older cursor.
 *
 * @example
 * ```ts
 * const events = await pollRollout({ state: this.getWorkflowStaticData("node"), manual: false, states: [], slots: [], read: (c) => client.rolloutEvents(c) });
 * ```
 */

import type { RolloutCursor, RolloutEvent } from "@airprompter/agent-sdk/frameworks/steps";

const SEEN_LIMIT = 500;

export interface PollInput {
  state: Record<string, unknown>;
  manual: boolean;
  /** Event states to keep (`new_version`, `rolled_back`, `ab_started`, `ab_ended`, `dial`, `disabled`, `enabled`, `removed`); empty: all. */
  states: readonly string[];
  slots: readonly string[];
  read: (previous: RolloutCursor | null) => Promise<{ events: RolloutEvent[]; cursor: RolloutCursor }>;
}

const kindOf = (event: RolloutEvent): string => (event.state.startsWith("dial:") ? "dial" : event.state);

export async function pollRollout(input: PollInput): Promise<RolloutEvent[]> {
  const previous = (input.state.cursor as RolloutCursor | undefined) ?? null;
  const seen = Array.isArray(input.state.seen) ? (input.state.seen as string[]) : [];
  const seenSet = new Set(seen);
  // A manual test reads from nothing, so the core answers with the current state of every slot.
  const { events, cursor } = await input.read(input.manual ? null : previous);
  const inScope = (event: RolloutEvent) => input.slots.length === 0 || input.slots.includes(event.slot);
  if (input.manual) return events.filter(inScope);
  input.state.cursor = cursor;
  if (!previous) return [];
  const fresh = events.filter((event) => event.state !== "current" && !seenSet.has(event.id));
  input.state.seen = [...seen, ...fresh.map((event) => event.id)].slice(-SEEN_LIMIT);
  return fresh.filter((event) => inScope(event) && (input.states.length === 0 || input.states.includes(kindOf(event))));
}
