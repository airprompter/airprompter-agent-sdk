/**
 * The AirPrompter node: one slot per step. **Get Prompt** returns the approved, signed version AirPrompter serves
 * for the slot — rendered with the step's variables, on the A/B arm the Subject lands on — with its pinned model and
 * inference settings, for an n8n model node to run. **Report Run** sends how that run went (tokens, error class,
 * thumbs or a 1–5 rating) against the run reference Get Prompt returned.
 *
 * Nothing about a rollout is editable here: versions, approvals, A/B arms, dial-up, rollback and the lease live in
 * AirPrompter. The release is kept on the n8n side (see the credential) so the step serves while AirPrompter is down.
 *
 * @example
 * ```text
 * Trigger → AirPrompter (Get Prompt: slot support.triage, Ticket = {{$json.body}}, Subject = {{$json.customerId}})
 *         → OpenAI (Message a model: model = {{$json.model}}, prompt = {{$json.prompt}})
 *         → AirPrompter (Report Run: Run Reference = {{$('AirPrompter').item.json.runRef}}, Token Usage = Detect)
 * ```
 */

import type {
  ICredentialsDecrypted,
  ICredentialTestFunctions,
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeCredentialTestResult,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  ResourceMapperFields,
} from "n8n-workflow";
import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";

import { MemoryKvStore, kvAutomationDatastore, usageFrom } from "@airprompter/agent-sdk/frameworks/steps";

import type { ReportRunInput } from "@airprompter/agent-sdk/frameworks/steps";
import { clientFor } from "../../src/n8n/connect";
import type { AirPrompterCredentials, N8nStorageContext } from "../../src/n8n/connect";
import { toNodeError } from "../../src/n8n/errors";

const CREDENTIAL = "airPrompterAgentApi";

async function credentialsOf(context: IExecuteFunctions | ILoadOptionsFunctions): Promise<AirPrompterCredentials> {
  return (await context.getCredentials(CREDENTIAL)) as unknown as AirPrompterCredentials;
}

function asNumber(value: unknown): number | undefined {
  if (value === "" || value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export class AirPrompter implements INodeType {
  description: INodeTypeDescription = {
    displayName: "AirPrompter",
    name: "airPrompter",
    icon: { light: "file:airprompter.svg", dark: "file:airprompter.dark.svg" },
    group: ["transform"],
    version: 1,
    subtitle: '={{ $parameter["operation"] === "reportRun" ? "Report run" : "Get prompt: " + $parameter["slot"] }}',
    description: "Get the approved prompt version for a slot from AirPrompter Agents, and report how the run went",
    defaults: { name: "AirPrompter" },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    credentials: [{ name: CREDENTIAL, required: true, testedBy: "airPrompterAgentApiTest" }],
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "getPrompt",
        options: [
          { name: "Get Prompt", value: "getPrompt", action: "Get the approved prompt for a slot", description: "Render the version AirPrompter serves for a slot, with its pinned model and settings" },
          { name: "Report Run", value: "reportRun", action: "Report how a run went", description: "Send token usage, an error and a rating for a Get Prompt run" },
        ],
      },
      // ── Get Prompt ──
      {
        displayName: "Slot Name or ID",
        name: "slot",
        type: "options",
        typeOptions: { loadOptionsMethod: "listSlots" },
        default: "",
        required: true,
        displayOptions: { show: { operation: ["getPrompt"] } },
        description: 'The slot from the approved release. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: "Variables",
        name: "variables",
        type: "resourceMapper",
        noDataExpression: true,
        default: { mappingMode: "defineBelow", value: null },
        required: true,
        typeOptions: {
          loadOptionsDependsOn: ["slot"],
          resourceMapper: {
            resourceMapperMethod: "getVariables",
            mode: "add",
            fieldWords: { singular: "variable", plural: "variables" },
            addAllFields: true,
            multiKeyMatch: false,
            supportAutoMap: true,
          },
        },
        displayOptions: { show: { operation: ["getPrompt"] } },
        description: "The slot's variables, as the approved version declares them",
      },
      {
        displayName: "Subject",
        name: "subject",
        type: "string",
        default: "",
        displayOptions: { show: { operation: ["getPrompt"] } },
        placeholder: "={{ $json.customerId }}",
        description: "Keeps one customer (or ticket, or user) on one A/B arm across runs. Empty: each run is assigned at random, by the weights set in AirPrompter. It is hashed locally and never sent.",
      },
      // ── Report Run ──
      {
        displayName: "Run Reference",
        name: "runRef",
        type: "string",
        default: "={{ $json.runRef }}",
        required: true,
        displayOptions: { show: { operation: ["reportRun"] } },
        description: 'The runRef from the Get Prompt step, e.g. {{ $(\'AirPrompter\').item.JSON.runRef }}',
      },
      {
        displayName: "Token Usage",
        name: "usageFrom",
        type: "options",
        default: "detect",
        displayOptions: { show: { operation: ["reportRun"] } },
        options: [
          { name: "Detect From Input Item", value: "detect", description: "Read usage from the model node's output (OpenAI, Anthropic, Gemini, LangChain, Bedrock shapes)" },
          { name: "Map Fields", value: "fields", description: "Map input and output tokens yourself" },
          { name: "Not Available", value: "none" },
        ],
      },
      {
        displayName: "Input Tokens",
        name: "inputTokens",
        type: "number",
        default: 0,
        displayOptions: { show: { operation: ["reportRun"], usageFrom: ["fields"] } },
        description: 'Prompt tokens the model reported, e.g. {{ $JSON.usage.prompt_tokens }}',
      },
      {
        displayName: "Output Tokens",
        name: "outputTokens",
        type: "number",
        default: 0,
        displayOptions: { show: { operation: ["reportRun"], usageFrom: ["fields"] } },
        description: 'Completion tokens the model reported, e.g. {{ $JSON.usage.completion_tokens }}',
      },
      {
        displayName: "Additional Fields",
        name: "additional",
        type: "collection",
        placeholder: "Add Field",
        default: {},
        displayOptions: { show: { operation: ["reportRun"] } },
        options: [
          { displayName: "Error", name: "error", type: "string", default: "", description: "The model call's error, if it failed. Only its class (rate limit, timeout, …) is sent." },
          { displayName: "Latency (Ms)", name: "latencyMs", type: "number", default: 0, description: "How long the model call took" },
          {
            displayName: "Rating",
            name: "rating",
            type: "options",
            default: "",
            options: [
              { name: "1", value: 1 },
              { name: "2", value: 2 },
              { name: "3", value: 3 },
              { name: "4", value: 4 },
              { name: "5", value: 5 },
              { name: "None", value: "" },
            ],
            description: "A 1–5 quality rating for this run",
          },
          {
            displayName: "Thumbs",
            name: "thumbs",
            type: "options",
            default: "",
            options: [
              { name: "Down", value: "down" },
              { name: "None", value: "" },
              { name: "Up", value: "up" },
            ],
          },
        ],
      },
    ],
  };

  methods = {
    loadOptions: {
      async listSlots(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        try {
          const slots = await (await clientFor(await credentialsOf(this), this as unknown as N8nStorageContext)).listSlots();
          return slots.map((slot) => ({
            name: slot.disabled ? `${slot.slot} (disabled)` : slot.slot,
            value: slot.slot,
            description: `${slot.model} · ${slot.versionId}${slot.experiment ? ` · A/B ${slot.experiment.arms.map((arm) => `${arm.arm} ${arm.weightBps / 100}%`).join(" / ")}` : ""}`,
          }));
        } catch (error) {
          throw toNodeError(this.getNode(), error);
        }
      },
    },
    resourceMapping: {
      async getVariables(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
        const slot = this.getCurrentNodeParameter("slot") as string | undefined;
        if (!slot) return { fields: [], emptyFieldsNotice: "Choose a slot first" };
        try {
          const variables = await (await clientFor(await credentialsOf(this), this as unknown as N8nStorageContext)).slotVariables(slot);
          return {
            fields: variables.map((variable) => ({
              id: variable.name,
              displayName: variable.trust === "end_user" ? `${variable.name} (end-user text)` : variable.name,
              required: variable.required,
              defaultMatch: false,
              canBeUsedToMatch: false,
              display: true,
              type: "string",
              ...(variable.default !== undefined ? { defaultValue: variable.default } : {}),
            })),
            emptyFieldsNotice: "This slot's approved version has no variables",
          };
        } catch (error) {
          throw toNodeError(this.getNode(), error);
        }
      },
    },
    credentialTest: {
      async airPrompterAgentApiTest(this: ICredentialTestFunctions, credential: ICredentialsDecrypted): Promise<INodeCredentialTestResult> {
        try {
          const data = credential.data as unknown as AirPrompterCredentials;
          // A throwaway store: testing a credential writes nothing the steps serve from.
          const client = await clientFor({ ...data, bundlePath: "" }, null, { datastore: kvAutomationDatastore(new MemoryKvStore()) });
          const result = await client.testConnection();
          return result.ok ? { status: "OK", message: `Verified the signed release for ${result.agentId} in ${result.environment}` } : { status: "Error", message: result.reason };
        } catch (error) {
          return { status: "Error", message: (error as Error).message };
        }
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const operation = this.getNodeParameter("operation", 0) as string;
    const credentials = await credentialsOf(this);
    const out: INodeExecutionData[] = [];
    const client = await clientFor(credentials, this as unknown as N8nStorageContext).catch((error: unknown) => {
      throw toNodeError(this.getNode(), error);
    });
    for (let i = 0; i < items.length; i += 1) {
        try {
          if (operation === "getPrompt") {
            const slot = this.getNodeParameter("slot", i) as string;
            const mapped = (this.getNodeParameter("variables.value", i, {}) as IDataObject | null) ?? {};
            const variables: Record<string, string> = {};
            for (const [name, value] of Object.entries(mapped)) if (value !== null && value !== undefined && value !== "") variables[name] = typeof value === "string" ? value : JSON.stringify(value);
            const subject = (this.getNodeParameter("subject", i, "") as string) || undefined;
            const result = await client.getPrompt({ slot, variables, ...(subject ? { subject } : {}) });
            out.push({ json: result as unknown as IDataObject, pairedItem: { item: i } });
          } else if (operation === "reportRun") {
            const runRef = this.getNodeParameter("runRef", i) as string;
            const mode = this.getNodeParameter("usageFrom", i, "detect") as string;
            const additional = this.getNodeParameter("additional", i, {}) as IDataObject;
            const input: ReportRunInput = { runRef };
            if (mode === "fields") {
              const inputTokens = asNumber(this.getNodeParameter("inputTokens", i, undefined));
              const outputTokens = asNumber(this.getNodeParameter("outputTokens", i, undefined));
              if (inputTokens !== undefined) input.inputTokens = inputTokens;
              if (outputTokens !== undefined) input.outputTokens = outputTokens;
            } else if (mode === "detect") {
              const usage = usageFrom(items[i]!.json);
              if (usage) Object.assign(input, usage);
            }
            if (typeof additional.error === "string" && additional.error) input.error = additional.error;
            const latencyMs = asNumber(additional.latencyMs);
            if (latencyMs) input.latencyMs = latencyMs;
            if (additional.rating !== undefined && additional.rating !== "") input.rating = Number(additional.rating) as ReportRunInput["rating"] & number;
            if (additional.thumbs === "up" || additional.thumbs === "down") input.thumbs = additional.thumbs;
            await client.reportRun(input);
            out.push({ json: { ...items[i]!.json, airprompter: { reported: true, runRef, inputTokens: input.inputTokens ?? null, outputTokens: input.outputTokens ?? null } }, pairedItem: { item: i } });
          } else {
            throw new NodeOperationError(this.getNode(), `Unknown operation ${operation}`);
          }
        } catch (error) {
          if (this.continueOnFail()) {
            out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
            continue;
          }
          throw toNodeError(this.getNode(), error, i);
        }
    }
    return [out];
  }
}
