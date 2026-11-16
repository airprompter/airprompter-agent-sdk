/**
 * AirPrompter Trigger (polling): one item per slot rollout change AirPrompter makes for the agent — a new version
 * approved, an A/B test started or ended, a dial-up (or dial-down) step on the signed ramp, a rollback, a slot
 * disabled or enabled. Each change fires once: the poll state keeps the last rollout and the ids already emitted
 * (`slot:digest:state`), in this node's static data.
 *
 * The first poll of an active workflow records the current rollout and emits nothing. A manual test emits the
 * current state of each slot (state `current`), so there is sample data to map. Each item carries `state`
 * (`new_version`, `rolled_back`, `ab_started`, `ab_ended`, `dial:<weights>`, `disabled`, `enabled`, `removed`) and a
 * one-line `summary`.
 *
 * @example
 * ```text
 * AirPrompter Trigger (every minute, events: Rollback, A/B Test Started) → Slack (post "{{$json.summary}}")
 * ```
 */

import type { IDataObject, ILoadOptionsFunctions, INodeExecutionData, INodePropertyOptions, INodeType, INodeTypeDescription, IPollFunctions } from "n8n-workflow";
import { NodeConnectionTypes } from "n8n-workflow";

import type { RolloutCursor } from "../../src/core";
import { clientFor } from "../../src/n8n/connect";
import type { AirPrompterCredentials, N8nStorageContext } from "../../src/n8n/connect";
import { toNodeError } from "../../src/n8n/errors";
import { pollRollout } from "../../src/n8n/pollState";

const STATES: INodePropertyOptions[] = [
  { name: "A/B Test Ended", value: "ab_ended" },
  { name: "A/B Test Started", value: "ab_started" },
  { name: "Dial-Up or Dial-Down Step", value: "dial" },
  { name: "New Version Approved", value: "new_version" },
  { name: "Rollback", value: "rolled_back" },
  { name: "Slot Disabled", value: "disabled" },
  { name: "Slot Enabled", value: "enabled" },
  { name: "Slot Removed", value: "removed" },
];

export class AirPrompterTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "AirPrompter Trigger",
    name: "airPrompterTrigger",
    icon: { light: "file:airprompter.svg", dark: "file:airprompter.dark.svg" },
    group: ["trigger"],
    version: 1,
    subtitle: "On rollout changes",
    description: "Starts the workflow when AirPrompter changes what a slot serves: a new version, an A/B step, a rollback",
    defaults: { name: "AirPrompter Trigger" },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    polling: true,
    credentials: [{ name: "airPrompterAgentApi", required: true }],
    properties: [
      {
        displayName: "Events",
        name: "events",
        type: "multiOptions",
        options: STATES,
        default: [],
        description: "The changes to start on. None selected: every change.",
      },
      {
        displayName: "Slot Names or IDs",
        name: "slots",
        type: "multiOptions",
        typeOptions: { loadOptionsMethod: "listSlots" },
        default: [],
        description: 'Only these slots. None selected: every slot. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
    ],
  };

  methods = {
    loadOptions: {
      async listSlots(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        try {
          const credentials = (await this.getCredentials("airPrompterAgentApi")) as unknown as AirPrompterCredentials;
          const slots = await (await clientFor(credentials, this as unknown as N8nStorageContext)).listSlots();
          return slots.map((slot) => ({ name: slot.slot, value: slot.slot }));
        } catch (error) {
          throw toNodeError(this.getNode(), error);
        }
      },
    },
  };

  async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
    const credentials = (await this.getCredentials("airPrompterAgentApi")) as unknown as AirPrompterCredentials;
    const states = this.getNodeParameter("events", []) as string[];
    const slots = this.getNodeParameter("slots", []) as string[];
    const manual = this.getMode() === "manual";
    const state = this.getWorkflowStaticData("node");
    try {
      const client = await clientFor(credentials, this as unknown as N8nStorageContext);
      const events = await pollRollout({ state, manual, states, slots, read: (previous: RolloutCursor | null) => client.rolloutEvents(previous) });
      if (events.length === 0) return null;
      return [events.map((event) => ({ json: event as unknown as IDataObject }))];
    } catch (error) {
      throw toNodeError(this.getNode(), error);
    }
  }
}
