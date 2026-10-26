/** camelCase boundary, for deriving SNAKE / kebab names from an export name. */
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/gu;

/**
 * `support` → `SupportAgentWorkflow` — the generated WorkflowEntrypoint class name,
 * and the agent's key at runtime: `ctx.exports.SupportAgentWorkflow` on Cloudflare.
 * @experimental
 */
const agentClassName = (exportName: string): string => `${exportName.charAt(0).toUpperCase()}${exportName.slice(1)}AgentWorkflow`;

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

/**
 * Every runtime function `agentComponent()` registers, with its visibility —
 * `"internal"` for the ones the durable loop dispatches by path, `"public"` for
 * the client-facing queries and mutations.
 *
 * A static table so codegen can auto-register the functions without importing
 * `@lunora/agent/component`, whose module graph (`@lunora/server`, the shard
 * engine, drizzle, hono) every codegen process would otherwise load, agents or
 * not. `__tests__/component.test.ts` fails when it drifts from the component.
 * @experimental
 */
const AGENT_RUNTIME_FUNCTIONS: Readonly<Record<string, "internal" | "public">> = {
    agentAppendMessage: "internal",
    agentApprovalGranted: "internal",
    agentApprovalGrants: "public",
    agentCompleteRun: "internal",
    agentDeclineSecret: "public",
    agentDeleteMessage: "internal",
    agentDiscardSecret: "internal",
    agentEnsureThread: "internal",
    agentEpisodeRecall: "internal",
    agentEpisodeUpsert: "internal",
    agentGraphTraverse: "internal",
    agentGraphUpsert: "internal",
    agentHistory: "internal",
    agentMessages: "public",
    agentOpenSecretRequest: "internal",
    agentPatchThread: "internal",
    agentPendingApprovals: "public",
    agentResolveApproval: "public",
    agentRevokeApprovalGrant: "public",
    agentRun: "public",
    agentSecretRequests: "public",
    agentSetState: "internal",
    agentSettleSecretRequest: "internal",
    agentState: "public",
    agentSupplySecret: "public",
    agentTakeSecret: "internal",
    agentThread: "public",
};

export { AGENT_RUNTIME_FUNCTIONS, agentClassName, agentDefaultName, voiceBindingName, voiceClassName };
