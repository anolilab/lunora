import type { AgentFunctionPaths, AgentFunctionReference } from "./types";

/**
 * The `lunora/` module the agent runtime functions live in. Apps re-export
 * `agentComponent().functions` from `lunora/agents.ts` (the same file that
 * declares the agents), so codegen registers them under this namespace and
 * the loop's dispatch paths below hold by construction.
 */
export const AGENT_MODULE = "agents";

/** Default dispatch paths of the agent runtime functions. */
export const DEFAULT_AGENT_FUNCTION_PATHS: AgentFunctionPaths = {
    appendMessage: `${AGENT_MODULE}:agentAppendMessage`,
    ensureThread: `${AGENT_MODULE}:agentEnsureThread`,
    listMessages: `${AGENT_MODULE}:agentMessages`,
    patchThread: `${AGENT_MODULE}:agentPatchThread`,
};

/** Mint a dispatchable function reference from a path (or pass one through). */
export const toFunctionReference = (source: AgentFunctionReference | string): AgentFunctionReference => {
    if (typeof source === "string") {
        return { __lunoraRef: source };
    }

    return source;
};
