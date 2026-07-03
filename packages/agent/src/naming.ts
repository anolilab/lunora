/** camelCase boundary, for deriving SNAKE / kebab names from an export name. */
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/gu;

/** `support` → `SupportAgentWorkflow` — the generated WorkflowEntrypoint class name. */
const agentClassName = (exportName: string): string => `${exportName.charAt(0).toUpperCase()}${exportName.slice(1)}AgentWorkflow`;

/** `support` → `AGENT_SUPPORT` — the Cloudflare Workflows binding name. */
const agentBindingName = (exportName: string): string => `AGENT_${exportName.replaceAll(CAMEL_BOUNDARY, "$1_$2").toUpperCase()}`;

/** `supportBot` → `agent-support-bot` — the default deployed workflow name. */
const agentDefaultName = (exportName: string): string => `agent-${exportName.replaceAll(CAMEL_BOUNDARY, "$1-$2").toLowerCase()}`;

export { agentBindingName, agentClassName, agentDefaultName };
