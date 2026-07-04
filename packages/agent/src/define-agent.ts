import { LunoraError } from "@lunora/errors";

import { agentAsTool } from "./as-tool";
import type { AgentConfig, AgentDefinition, AgentToolConfig, AgentToolDefinition } from "./types";

/** Tool names surface as model function names — keep them identifier-shaped. */
const TOOL_NAME_PATTERN = /^[a-zA-Z][\w-]*$/u;

/**
 * Declare a durable agent. The definition compiles onto a Cloudflare Workflow
 * (each LLM turn and each tool call a named durable step; thread messages
 * persisted idempotently in DO SQLite), invoked from mutations/actions via
 * `ctx.agents.NAME.run(...)` and observed live by subscribing to the
 * `agents:agentMessages` query.
 *
 * ```ts
 * // lunora/agents.ts
 * import { defineAgent, defineAgentTool } from "@lunora/agent";
 *
 * export const support = defineAgent({
 *     instructions: "You are a helpful support agent.",
 *     model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *     tools: {
 *         getWeather: defineAgentTool({
 *             description: "Look up the current weather for a city.",
 *             execute: async ({ city }, { run }) => run(api.weather.lookup, { city }),
 *             inputSchema: jsonSchema({ properties: { city: { type: "string" } }, required: ["city"], type: "object" }),
 *         }),
 *     },
 * });
 * ```
 *
 * Declaring an agent is enough — codegen auto-registers the `agents:*` runtime
 * functions (from `agentComponent()`) and the `ctx.agents` producer surface.
 */
const defineAgent = (config: AgentConfig): AgentDefinition => {
    // The type forbids it, but a plain-JS caller can still omit the model —
    // fail at declaration time, not at the first workflow run.
    const model = config.model as unknown;

    if (model === undefined || model === null || (typeof model === "string" && model.length === 0)) {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/agent: defineAgent requires a `model` (a Workers AI id, an AI SDK LanguageModel, or an (env) => model thunk)",
        );
    }

    if (config.maxTurns !== undefined && (!Number.isInteger(config.maxTurns) || config.maxTurns < 1)) {
        throw new LunoraError("INTERNAL", "@lunora/agent: `maxTurns` must be a positive integer");
    }

    for (const name of Object.keys(config.tools ?? {})) {
        if (!TOOL_NAME_PATTERN.test(name)) {
            throw new LunoraError("INTERNAL", `@lunora/agent: tool name "${name}" is not a valid identifier (letters, digits, _ or -, starting with a letter)`);
        }
    }

    // `asTool` ignores the parent config — it delegates by the child's export
    // name (its `AGENT_*` binding) — so a plain function works as the method.
    // It is runtime-only: codegen discovers agents by AST, never by evaluating
    // the object, so the extra property does not perturb emission.
    return { ...config, asTool: agentAsTool, isLunoraAgent: true };
};

/** Runtime brand check for a {@link AgentDefinition}. */
const isAgentDefinition = (value: unknown): value is AgentDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraAgent?: unknown }).isLunoraAgent === true;

/**
 * Declare an agent tool — see `AgentToolDefinition` for why `execute` runs in
 * the loop's durable step (with an `AgentToolContext`) rather than inside the
 * model call.
 */
const defineAgentTool = <Input, Output>(config: AgentToolConfig<Input, Output>): AgentToolDefinition<Input, Output> => {
    if (typeof config.execute !== "function") {
        throw new LunoraError("INTERNAL", "@lunora/agent: defineAgentTool requires an `execute` function");
    }

    if (typeof config.description !== "string" || config.description.length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/agent: defineAgentTool requires a non-empty `description` (the model decides from it)");
    }

    return { ...config, isLunoraAgentTool: true };
};

export { defineAgent, defineAgentTool, isAgentDefinition };
