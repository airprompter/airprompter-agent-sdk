/**
 * The Steps core's AutomationError (`@airprompter/agent-sdk/frameworks/steps`) → n8n's NodeOperationError, with a description that says what to do. Errors
 * that are not the core's pass through untouched (n8n reports them as they are).
 *
 * @example
 * ```ts
 * try { … } catch (error) { throw toNodeError(this.getNode(), error, itemIndex); }
 * ```
 */

import { NodeOperationError } from "n8n-workflow";
import type { INode } from "n8n-workflow";

import { isAutomationError } from "@airprompter/agent-sdk/frameworks/steps";

const DESCRIPTIONS: Record<string, string> = {
  unauthorized: "Open the AirPrompter Agent credential and check the Agent ID, the Environment and the Update Key.",
  nothing_promoted: "Approve and promote a version for this agent and environment in AirPrompter.",
  unknown_slot: "Pick the slot again: the list comes from the approved release.",
  invalid_input: "Check the step's fields.",
  unreachable: "AirPrompter could not be reached. Steps serve from the stored copy once one was fetched; a report is not recorded until AirPrompter answers — turn on Retry On Fail for Report Run.",
  refused: "The release did not verify, or the slot is disabled in AirPrompter. Nothing unverified is ever served.",
  lease_expired: "AirPrompter has been unreachable for longer than the release's lease, so the stored copy is no longer served. Check the network from n8n to AirPrompter.",
  root_not_pinned: "This version pins the Production and Dev roots only. For another deployment (such as Staging) or a local registry, paste its root public key into the credential (Root Public Key).",
  storage_unavailable: "The stored copy could not be read or written (the n8n user folder, or workflow static data).",
};

export function toNodeError(node: INode, error: unknown, itemIndex?: number): Error {
  if (!isAutomationError(error)) return error instanceof Error ? error : new Error(String(error));
  const description = `${DESCRIPTIONS[error.code] ?? ""}${error.retryable ? " Retrying may help." : ""}`.trim();
  return new NodeOperationError(node, error.message, { ...(itemIndex !== undefined ? { itemIndex } : {}), description });
}
