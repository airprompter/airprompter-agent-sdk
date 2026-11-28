/**
 * The AirPrompter Agent credential: an agent's Update key (key kind "agent", bound to one agent and one environment),
 * the agent id, and the trust anchor every release is verified against. It is tested by the AirPrompter node's
 * `airPrompterAgentApiTest`, which fetches the signed manifest and verifies it (a plain HTTP check could not).
 *
 * Where the stored copy lives is chosen here too, so every node using the credential agrees: the n8n user folder,
 * shared by the instance, or the workflow's static data, in n8n's database (for queue mode or an external database
 * without a shared volume).
 *
 * @example
 * ```ts
 * const credentials = await this.getCredentials<AirPrompterCredentials>("airPrompterAgentApi");
 * ```
 */

import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from "n8n-workflow";

export class AirPrompterAgentApi implements ICredentialType {
  name = "airPrompterAgentApi";

  displayName = "AirPrompter Agent API";

  documentationUrl = "https://github.com/airprompter/airprompter-agent-sdk/tree/main/integrations/n8n#credentials";

  icon = { light: "file:../nodes/AirPrompter/airprompter.svg", dark: "file:../nodes/AirPrompter/airprompter.dark.svg" } as const;

  /** The Update key as a bearer token, for the HTTP fallback test below. */
  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: { headers: { Authorization: "=Bearer {{$credentials.updateKey}}" } },
  };

  /**
   * A reachability check only (the key reads the manifest). The AirPrompter node's `airPrompterAgentApiTest`, which
   * n8n prefers, also verifies the manifest's signature against the root key.
   */
  test: ICredentialTestRequest = {
    request: {
      baseURL: "={{$credentials.apiBaseUrl}}",
      url: "=/v1/agents/{{$credentials.agentId}}/targets/{{$credentials.environment}}/manifest",
    },
  };

  properties: INodeProperties[] = [
    {
      displayName: "Agent ID",
      name: "agentId",
      type: "string",
      default: "",
      required: true,
      placeholder: "agt_support",
      description: "The agent in AirPrompter that holds the slots this workflow uses",
    },
    // The Update key is a secret (it reads the agent's approved prompts); the rule only guesses from the field name.
    // eslint-disable-next-line @n8n/community-nodes/credential-unnecessary-password
    {
      displayName: "Update Key",
      name: "updateKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description: "The agent's Update key from AirPrompter (Agents › your agent › Keys). It reads approved releases for one environment; it cannot change anything.",
    },
    {
      displayName: "Environment",
      name: "environment",
      type: "string",
      default: "prod",
      description: "The agent environment the Update key is bound to, such as prod or staging",
    },
    {
      displayName: "Root Public Key",
      name: "rootKey",
      type: "string",
      typeOptions: { rows: 4 },
      default: "",
      placeholder: '{"kty":"EC","crv":"P-256","x":"…","y":"…"}',
      description: "Leave empty for AirPrompter Production and Dev: this version pins both roots. Only for Staging (ask AirPrompter for its root key; none is pinned) or a local airprompter dev registry (its root.pub.json): paste that root public key. A credential that holds the Production key from an earlier version keeps working; it is the same key. Every release is checked against the root before it is used or stored, and the credential test says when a root is missing.",
    },
    {
      displayName: "API Base URL",
      name: "apiBaseUrl",
      type: "string",
      default: "https://api.airprompter.com",
      description: "Production by default. Use your AirPrompter dev URL, or a local registry from `airprompter dev`, for testing.",
    },
    {
      displayName: "AirPrompter Deployment",
      name: "hostedEnvironment",
      type: "options",
      default: "prod",
      options: [
        { name: "Production", value: "prod" },
        { name: "Staging", value: "staging" },
        { name: "Dev", value: "dev" },
      ],
      description: "Which AirPrompter deployment signs the releases (the one the root key belongs to) — not the agent environment",
    },
    {
      displayName: "Root Document URL",
      name: "rootUrl",
      type: "string",
      default: "",
      placeholder: "https://api.airprompter.com/roots/prod/root.json",
      description: "Where the deployment's signing keys are published. Leave empty for API Base URL + /roots/<deployment>/root.json.",
    },
    {
      displayName: "Organization ID",
      name: "organizationId",
      type: "string",
      default: "",
      description: "Optional. Learned from the first release; set it to start serving from a stored copy or bundle before AirPrompter was ever reached.",
    },
    {
      displayName: "Keep the Stored Copy In",
      name: "storage",
      type: "options",
      default: "userFolder",
      options: [
        { name: "n8n User Folder", value: "userFolder", description: "~/.n8n/airprompter (or N8N_USER_FOLDER), shared by every workflow on the instance" },
        { name: "Workflow Static Data", value: "workflowStaticData", description: "Inside each workflow, in n8n's database; saved after production executions only" },
      ],
      description: "Where the signed releases are kept so steps keep serving while AirPrompter is unreachable",
    },
    {
      displayName: "Starting Bundle Path",
      name: "bundlePath",
      type: "string",
      default: "",
      placeholder: "/home/node/.n8n/airprompter/release.apbundle",
      displayOptions: { show: { storage: ["userFolder"] } },
      description: "Optional. A signed .apbundle (airprompter pull --plaintext, dev environment only, or sealed) to serve from when nothing was fetched yet — for installs without network access to AirPrompter.",
    },
  ];
}
