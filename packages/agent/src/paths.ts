import type { AgentFunctionPaths, AgentFunctionReference } from "./types";

/**
 * The namespace the agent runtime functions register under. Codegen
 * auto-registers `agentComponent().functions` here whenever `lunora/agents.ts`
 * declares an agent, so the loop's dispatch paths below hold by construction.
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
