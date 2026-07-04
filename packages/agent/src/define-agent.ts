import { LunoraError } from "@lunora/errors";

import { agentAsTool } from "./as-tool";
import type {
    AgentConfig,
    AgentDefinition,
    AgentInstructionsContext,
    AgentMemorySource,
    AgentToolConfig,
    AgentToolDefinition,
    AnyAgentTool,
    SkillDefinition,
} from "./types";

/** Tool names surface as model function names — keep them identifier-shaped. */
const TOOL_NAME_PATTERN = /^[a-zA-Z][\w-]*$/u;

/**
 * Fold each skill's tools into the agent's own, producing the flat model-facing
 * namespace. A name collision — with the agent's own tools or another skill's —
 * throws (the strict cousin of `mcpTools`' prefix): the agent owns a single
 * namespace, so two tools cannot share a name.
 */
const mergeSkillTools = (config: AgentConfig, skills: ReadonlyArray<SkillDefinition>): Record<string, AnyAgentTool> => {
    const tools: Record<string, AnyAgentTool> = { ...config.tools };

    for (const skill of skills) {
        for (const [toolName, tool] of Object.entries(skill.tools ?? {})) {
            if (Object.hasOwn(tools, toolName)) {
                throw new LunoraError(
                    "INTERNAL",
                    `@lunora/agent: skill "${skill.name}" tool "${toolName}" collides with an existing tool — rename one (the agent's tool namespace is flat)`,
                );
            }

            tools[toolName] = tool;
        }
    }

    return tools;
};

/**
 * Compose the agent's own instruction fragment with each skill's, in array
 * order. One fragment stays as-is (a string or a thunk); several collapse to a
 * single PURE thunk resolved once at run start — replay-stable, since the same
 * context yields the same joined prompt on a resume. Returns `undefined` when
 * nothing contributes instructions.
 */
// eslint-disable-next-line sonarjs/function-return-type -- returns AgentConfig.instructions' own union (string | thunk | undefined) by design
const composeInstructions = (config: AgentConfig, skills: ReadonlyArray<SkillDefinition>): AgentConfig["instructions"] => {
    const fragments: NonNullable<AgentConfig["instructions"]>[] = [];

    for (const fragment of [config.instructions, ...skills.map((skill) => skill.instructions)]) {
        if (fragment) {
            fragments.push(fragment);
        }
    }

    if (fragments.length <= 1) {
        return fragments[0];
    }

    return (context: AgentInstructionsContext): string =>
        fragments
            .map((fragment) => (typeof fragment === "function" ? fragment(context) : fragment))
            .filter((text) => text.length > 0)
            .join("\n\n");
};

/**
 * Collect the keyed memory sources the loop dispatches per run: the config's
 * `memory` as the default source (its step name stays `"memory:retrieve"`),
 * then each skill's `knowledge` keyed by the skill name.
 */
const collectMemorySources = (config: AgentConfig, skills: ReadonlyArray<SkillDefinition>): AgentMemorySource[] => {
    const sources: AgentMemorySource[] = [];

    if (config.memory) {
        sources.push({ key: "default", ...config.memory });
    }

    for (const skill of skills) {
        if (skill.knowledge) {
            sources.push({ key: skill.name, ...skill.knowledge });
        }
    }

    return sources;
};

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

    const skills = config.skills ?? [];

    // Skill names must be unique: each skill's `knowledge` becomes a memory
    // source keyed by the skill name (durable step `memory:retrieve:<name>`), so
    // two skills sharing a name collide on a single step name — the SECOND
    // retrieval silently returns the FIRST's memoized output. Throw the strict
    // cousin of `mergeSkillTools`' tool-name collision so the step-name namespace
    // is guaranteed unique.
    const seenSkillNames = new Set<string>();

    for (const skill of skills) {
        if (seenSkillNames.has(skill.name)) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/agent: skill name "${skill.name}" is used by more than one skill — rename one (a skill name keys its knowledge memory source, which must be unique)`,
            );
        }

        seenSkillNames.add(skill.name);
    }

    const tools = mergeSkillTools(config, skills);

    // Validate the MERGED namespace so a skill-contributed name is checked too.
    for (const name of Object.keys(tools)) {
        if (!TOOL_NAME_PATTERN.test(name)) {
            throw new LunoraError("INTERNAL", `@lunora/agent: tool name "${name}" is not a valid identifier (letters, digits, _ or -, starting with a letter)`);
        }
    }

    const memorySources = collectMemorySources(config, skills);
    const composedInstructions = composeInstructions(config, skills);

    // `asTool` ignores the parent config — it delegates by the child's export
    // name (its `AGENT_*` binding) — so a plain function works as the method.
    // It is runtime-only: codegen discovers agents by AST, never by evaluating
    // the object, so the extra property does not perturb emission. Each override
    // only replaces `...config` when a skill actually changed it, so an agent
    // with no skills is byte-identical to before.
    return {
        ...config,
        asTool: agentAsTool,
        isLunoraAgent: true,
        ...(skills.some((skill) => Boolean(skill.instructions)) ? { instructions: composedInstructions } : {}),
        ...(memorySources.length > 0 ? { memorySources } : {}),
        ...(skills.length > 0 ? { tools } : {}),
    };
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
