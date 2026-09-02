import { LunoraError } from "@lunora/errors";

import { collectAgenticMemoryTools } from "./agentic-memory";
import { agentAsTool } from "./as-tool";
import { isInjectedMemorySource } from "./memory";
import isPositiveInteger from "./positive-integer";
import { RESERVED_SKILL_NAME, SKILL_NAME_PATTERN } from "./skill";
import type {
    AgentConfig,
    AgentDefinition,
    AgentInstructionsContext,
    AgentMemoryOptions,
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
 * Collect the keyed memory sources the loop AUTO-INJECTS per run: the config's
 * `memory` as the default source (its step name stays `"memory:retrieve"` /
 * `"memory:traverse"` for graph), then each skill's `knowledge` keyed by the
 * skill name. See {@link isInjectedMemorySource} for what is and isn't collected.
 */
const collectMemorySources = (config: AgentConfig, skills: ReadonlyArray<SkillDefinition>): AgentMemorySource[] => {
    const sources: AgentMemorySource[] = [];

    if (config.memory && isInjectedMemorySource(config.memory)) {
        sources.push({ key: "default", ...config.memory });
    }

    for (const skill of skills) {
        if (skill.knowledge && isInjectedMemorySource(skill.knowledge)) {
            sources.push({ key: skill.name, ...skill.knowledge });
        }
    }

    return sources;
};

/**
 * Validate the skill-name namespace before it is used to key memory sources.
 * A skill built via `defineSkill` is already checked, but the config type
 * accepts any `SkillDefinition`-shaped object, so a plain-JS caller can hand one
 * in unchecked. Each name keys a `memory:retrieve:NAME` durable step, so it
 * must be a valid identifier, must not be the reserved `"default"` key (which
 * names the agent's own `memory` source / the historic `"memory:retrieve"`
 * step), and must be unique — otherwise the step-name namespace collides and the
 * SECOND retrieval silently returns the FIRST's memoized output. Extracted from
 * `defineAgent` to keep its cognitive complexity in check.
 */
const assertValidSkillNames = (skills: ReadonlyArray<SkillDefinition>): void => {
    const seen = new Set<string>();

    for (const skill of skills) {
        if (typeof skill.name !== "string" || !SKILL_NAME_PATTERN.test(skill.name)) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/agent: skill \`name\` must be a valid identifier (letters, digits, _ or -, starting with a letter), got ${JSON.stringify(skill.name)}`,
            );
        }

        if (skill.name === RESERVED_SKILL_NAME) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/agent: skill name "${RESERVED_SKILL_NAME}" is reserved (it keys the agent's own \`memory\` source / the \`memory:retrieve\` step) — choose another name`,
            );
        }

        if (seen.has(skill.name)) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/agent: skill name "${skill.name}" is used by more than one skill — rename one (a skill name keys its knowledge memory source, which must be unique)`,
            );
        }

        seen.add(skill.name);
    }
};

/**
 * If an author pins `activeTools`, every minted agentic-memory tool must appear
 * in it — otherwise the tool is enabled but the model can never call it, so
 * retrieval silently never happens. Fail loud at declaration time rather than
 * hide the tool (the plan's documented silent-hide foot-gun), so the
 * misconfiguration surfaces here, not as a mysterious no-retrieval run. A no-op
 * when `activeTools` is unset or no agentic-memory tools were minted.
 */
const assertActiveToolsExposeMemory = (activeTools: ReadonlyArray<string> | undefined, agenticMemoryTools: Record<string, AnyAgentTool>): void => {
    if (activeTools === undefined) {
        return;
    }

    const unreachable = Object.keys(agenticMemoryTools).filter((name) => !activeTools.includes(name));

    if (unreachable.length > 0) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/agent: \`activeTools\` omits the agentic-memory tool(s) ${unreachable.map((name) => `"${name}"`).join(", ")} — ` +
                `the model could never call them; add them to \`activeTools\` (or drop \`activeTools\` to expose every tool)`,
        );
    }
};

/**
 * A `"semantic"` memory source (the default kind) MUST carry a `source` action —
 * the RAG endpoint the loop dispatches. A `"graph"` source ignores `source` (it
 * dispatches the built-in `agentGraphTraverse` function), so it may omit it.
 * Validate the agent's own `memory` and every skill's `knowledge` at declaration
 * time, before a run reaches the would-be missing-source dispatch.
 */
const assertMemorySourcesConfigured = (config: AgentConfig, skills: ReadonlyArray<SkillDefinition>): void => {
    const requireSource = (memory: AgentMemoryOptions | undefined, label: string): void => {
        if (memory && memory.kind !== "graph" && memory.kind !== "episodic" && memory.source === undefined) {
            throw new LunoraError("INTERNAL", `@lunora/agent: ${label} requires a \`source\` action unless \`kind: "graph"\` or \`kind: "episodic"\``);
        }
    };

    requireSource(config.memory, "`memory`");

    for (const skill of skills) {
        requireSource(skill.knowledge, `skill "${skill.name}" \`knowledge\``);
    }
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
 * @experimental
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

    if (config.maxTurns !== undefined && !isPositiveInteger(config.maxTurns)) {
        throw new LunoraError("INTERNAL", "@lunora/agent: `maxTurns` must be a positive integer");
    }

    // Same policy as `maxTurns`: `voice.maxTurns: 0` used to fall back to the
    // 100-turn default silently, while `maxTurns: 0` threw.
    if (config.voice?.maxTurns !== undefined && !isPositiveInteger(config.voice.maxTurns)) {
        throw new LunoraError("INTERNAL", "@lunora/agent: `voice.maxTurns` must be a positive integer");
    }

    const skills = config.skills ?? [];

    // Skill names key each skill's `knowledge` memory source (durable step
    // `memory:retrieve:<name>`); validate identifier shape, the reserved
    // `"default"` key, and uniqueness before they are used (see the helper).
    assertValidSkillNames(skills);

    // A semantic source needs its RAG `source`; a graph source may omit it.
    assertMemorySourcesConfigured(config, skills);

    const tools = mergeSkillTools(config, skills);

    // Fold the tools minted for `mode: "agentic"` memory sources into the same
    // flat namespace, with the same collision-throw policy — an author naming a
    // real tool `searchMemory` (or a skill tool `search_<name>`) is an error.
    const agenticMemoryTools = collectAgenticMemoryTools(config, skills);

    for (const [toolName, tool] of Object.entries(agenticMemoryTools)) {
        if (Object.hasOwn(tools, toolName)) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/agent: agentic-memory tool "${toolName}" collides with an existing tool — rename one (the agent's tool namespace is flat)`,
            );
        }

        tools[toolName] = tool;
    }

    const hasAgenticTools = Object.keys(agenticMemoryTools).length > 0;

    // A pinned `activeTools` that omits a minted memory tool makes it unreachable.
    assertActiveToolsExposeMemory(config.activeTools, agenticMemoryTools);

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
        ...(skills.length > 0 || hasAgenticTools ? { tools } : {}),
    };
};

/**
 * Runtime brand check for a {@link AgentDefinition}.
 * @experimental
 */
const isAgentDefinition = (value: unknown): value is AgentDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraAgent?: unknown }).isLunoraAgent === true;

/**
 * Declare an agent tool — see `AgentToolDefinition` for why `execute` runs in
 * the loop's durable step (with an `AgentToolContext`) rather than inside the
 * model call.
 * @experimental
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
