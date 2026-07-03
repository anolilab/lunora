import type { WorkflowDefinition } from "@lunora/workflow";
import { defineWorkflow } from "@lunora/workflow";

import { runAgentLoop } from "./agent-loop";
import { agentDefaultName } from "./define-agent";
import { createAgentGenerate } from "./generate";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "./paths";
import type { AgentDefinition, AgentFunctionPaths, AgentRunInput, AgentRunResult } from "./types";

/**
 * Compile a `defineAgent` definition into the workflow the generated
 * `&lt;Name>AgentWorkflow` entrypoint class runs. Codegen emits, per agent:
 *
 * ```ts
 * import LunoraWorkflow from "@lunora/workflow/do";
 * import { compileAgentWorkflow } from "@lunora/agent";
 * import { support } from "../agents.js";
 *
 * export class SupportAgentWorkflow extends LunoraWorkflow&lt;AgentRunInput, AgentRunResult> {
 *     public constructor(ctx: ConstructorParameters&lt;typeof LunoraWorkflow>[0], env: Record&lt;string, unknown>) {
 *         super(ctx, env, compileAgentWorkflow(support, "support"), "support");
 *     }
 * }
 * ```
 *
 * The workflow ctx supplies durability (`step.do`) and the Lunora dispatcher
 * (`run`); the loop supplies determinism (step naming + idempotent persists).
 */
const compileAgentWorkflow = (
    agent: AgentDefinition,
    exportName: string,
    options?: { paths?: AgentFunctionPaths },
): WorkflowDefinition<AgentRunInput, AgentRunResult> =>
    defineWorkflow<AgentRunInput, AgentRunResult>({
        handler: async (context) =>
            runAgentLoop({
                agent,
                env: context.env,
                exportName,
                generate: createAgentGenerate(agent, context.env),
                instanceId: context.event.instanceId,
                params: context.params,
                paths: options?.paths ?? DEFAULT_AGENT_FUNCTION_PATHS,
                run: context.run,
                step: context.step,
            }),
        name: agent.name ?? agentDefaultName(exportName),
    });

export default compileAgentWorkflow;
