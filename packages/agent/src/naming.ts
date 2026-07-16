/** camelCase boundary, for deriving SNAKE / kebab names from an export name. */
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/gu;

/**
 * `support` → `SupportAgentWorkflow` — the generated WorkflowEntrypoint class name.
 * @experimental
 */
const agentClassName = (exportName: string): string => `${exportName.charAt(0).toUpperCase()}${exportName.slice(1)}AgentWorkflow`;

/**
 * `support` → `AGENT_SUPPORT` — the Cloudflare Workflows binding name.
 * @experimental
 */
const agentBindingName = (exportName: string): string => `AGENT_${exportName.replaceAll(CAMEL_BOUNDARY, "$1_$2").toUpperCase()}`;

/**
 * `supportBot` → `agent-support-bot` — the default deployed workflow name.
 * @experimental
 */
const agentDefaultName = (exportName: string): string => `agent-${exportName.replaceAll(CAMEL_BOUNDARY, "$1-$2").toLowerCase()}`;

/**
 * `support` → `SupportVoiceDO` — the generated voice-session Durable Object
 * class name (a subclass of `VoiceSessionDO`). Distinct from the agent's
 * `WorkflowEntrypoint` (`SupportAgentWorkflow`): the voice path is a
 * hibernatable-WebSocket DO that runs the per-turn STT→LLM→TTS pipeline in-DO,
 * NOT the replay-durable Workflow.
 * @experimental
 */
const voiceClassName = (exportName: string): string => `${exportName.charAt(0).toUpperCase()}${exportName.slice(1)}VoiceDO`;

/**
 * `support` → `VOICE_SUPPORT` — the Cloudflare Durable Object binding name for the voice session.
 * @experimental
 */
const voiceBindingName = (exportName: string): string => `VOICE_${exportName.replaceAll(CAMEL_BOUNDARY, "$1_$2").toUpperCase()}`;

export { agentBindingName, agentClassName, agentDefaultName, voiceBindingName, voiceClassName };
