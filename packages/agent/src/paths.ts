import type { AgentFunctionPaths, AgentFunctionReference } from "./types";

/**
 * The namespace the agent runtime functions register under. Codegen
 * auto-registers `agentComponent().functions` here whenever `lunora/agents.ts`
 * declares an agent, so the loop's dispatch paths below hold by construction.
 * @experimental
 */
export const AGENT_MODULE = "agents";

/**
 * The namespace + name the batteries-included sandbox dispatcher registers
 * under. Codegen auto-registers `sandboxComponent().invoke` here whenever
 * `lunora/` imports a sandbox tool (`browserTool`/`containerTool`), so the
 * tools' `execute` can dispatch to it through the loop's `run` seam.
 * @experimental
 */
export const SANDBOX_MODULE = "sandbox";

/**
 * The dispatch path of the sandbox runtime action (an internal action).
 * @experimental
 */
export const SANDBOX_INVOKE_PATH: "sandbox:invoke" = `${SANDBOX_MODULE}:invoke`;

/**
 * Default dispatch paths of the agent runtime functions.
 * @experimental
 */
export const DEFAULT_AGENT_FUNCTION_PATHS: AgentFunctionPaths = {
    appendMessage: `${AGENT_MODULE}:agentAppendMessage`,
    ensureThread: `${AGENT_MODULE}:agentEnsureThread`,
    episodeRecall: `${AGENT_MODULE}:agentEpisodeRecall`,
    episodeUpsert: `${AGENT_MODULE}:agentEpisodeUpsert`,
    graphTraverse: `${AGENT_MODULE}:agentGraphTraverse`,
    graphUpsert: `${AGENT_MODULE}:agentGraphUpsert`,
    listMessages: `${AGENT_MODULE}:agentMessages`,
    patchThread: `${AGENT_MODULE}:agentPatchThread`,
    run: `${AGENT_MODULE}:agentRun`,
    setState: `${AGENT_MODULE}:agentSetState`,
    state: `${AGENT_MODULE}:agentState`,
};

/**
 * Mint a dispatchable function reference from a path (or pass one through).
 * @experimental
 */
export const toFunctionReference = (source: AgentFunctionReference | string): AgentFunctionReference => {
    if (typeof source === "string") {
        return { __lunoraRef: source };
    }

    return source;
};
