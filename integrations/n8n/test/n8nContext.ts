/**
 * Minimal mocked n8n contexts (execute, poll, load options, credential test) — enough of `IExecuteFunctions` and
 * friends for the nodes under test, with static data that persists between calls like n8n's.
 */
import type { IDataObject, INode } from "n8n-workflow";

export interface MockWorkflow {
  staticGlobal: IDataObject;
  staticNode: IDataObject;
}

export function workflow(): MockWorkflow {
  return { staticGlobal: {}, staticNode: {} };
}

const NODE: INode = { id: "n1", name: "AirPrompter", type: "n8n-nodes-airprompter.airPrompter", typeVersion: 1, position: [0, 0], parameters: {} };

function getPath(params: Record<string, unknown>, name: string): unknown {
  return name.split(".").reduce<unknown>((value, part) => (value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined), params);
}

export function executeContext(input: { wf: MockWorkflow; credentials: IDataObject; params: Record<string, unknown> | Array<Record<string, unknown>>; items?: IDataObject[]; continueOnFail?: boolean }) {
  const items = (input.items ?? [{}]).map((json) => ({ json }));
  const paramsFor = (i: number) => (Array.isArray(input.params) ? input.params[i] ?? input.params[0]! : input.params);
  return {
    getInputData: () => items,
    getNodeParameter: (name: string, i: number, fallback?: unknown) => {
      const value = getPath(paramsFor(i), name);
      return value === undefined ? fallback : value;
    },
    getCredentials: async () => input.credentials,
    getWorkflowStaticData: (type: string) => (type === "node" ? input.wf.staticNode : input.wf.staticGlobal),
    getNode: () => NODE,
    continueOnFail: () => input.continueOnFail ?? false,
    getMode: () => "trigger",
    helpers: {},
    logger: console,
  };
}

export function loadOptionsContext(input: { wf: MockWorkflow; credentials: IDataObject; current: Record<string, unknown> }) {
  return {
    getCredentials: async () => input.credentials,
    getCurrentNodeParameter: (name: string) => input.current[name],
    getNodeParameter: (name: string) => input.current[name],
    getWorkflowStaticData: (type: string) => (type === "node" ? input.wf.staticNode : input.wf.staticGlobal),
    getNode: () => NODE,
    helpers: {},
  };
}

export function pollContext(input: { wf: MockWorkflow; credentials: IDataObject; params: Record<string, unknown>; mode?: "trigger" | "manual" }) {
  return {
    getCredentials: async () => input.credentials,
    getNodeParameter: (name: string, fallback?: unknown) => input.params[name] ?? fallback,
    getWorkflowStaticData: (type: string) => (type === "node" ? input.wf.staticNode : input.wf.staticGlobal),
    getNode: () => NODE,
    getMode: () => input.mode ?? "trigger",
    getActivationMode: () => "activate",
    helpers: {},
  };
}
