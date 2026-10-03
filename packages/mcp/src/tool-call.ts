/** The MCP method that invokes a tool — the only method the price and step-up gates apply to. */
const CALL_TOOL_METHOD = "tools/call";

/**
 * The tool name a JSON-RPC message targets, if it is a `tools/call`. Returns
 * `undefined` for any other method or a malformed message — those are never
 * gated (only a `tools/call` naming a gated tool is).
 */
const callToolName = (message: unknown): string | undefined => {
    if (typeof message !== "object" || message === null) {
        return undefined;
    }

    const { method, params } = message as { method?: unknown; params?: unknown };

    if (method !== CALL_TOOL_METHOD || typeof params !== "object" || params === null) {
        return undefined;
    }

    const { name } = params as { name?: unknown };

    return typeof name === "string" ? name : undefined;
};

export default callToolName;
