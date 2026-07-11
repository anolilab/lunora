import { LunoraError } from "@lunora/errors";
import { jsonSchema } from "ai";

import type { AgentToolContext, AgentToolDefinition, AnyAgentTool } from "./types";

/** Default cap on script steps so one code call can't fan out unboundedly. */
const DEFAULT_MAX_STEPS = 16;

/** One step of a tool-composition script — call `tool` with `input`, bind the result to `id`. */
interface ToolScriptStep {
    /** A stable name later steps reference the output by. */
    id: string;
    /** The tool's input; values may embed `{ "$from": "&lt;stepId>", "$path": "a.b" }` refs. */
    input?: Record<string, unknown>;
    /** The tool to call — one of the tools handed to {@link codeTool}. */
    tool: string;
}

/** The model-provided input to a {@link codeTool} call. */
interface ToolScript {
    steps: ToolScriptStep[];
}

/** The result of running a {@link ToolScript}: each step's output plus the last one. */
interface ToolScriptResult {
    final: unknown;
    results: ReadonlyArray<{ id: string; output: unknown }>;
}

/** Author-supplied config for {@link codeTool}. */
interface CodeToolOptions {
    /** Override the model-facing description (the default lists the available tools). */
    description?: string;
    /** Max steps per script (default 16). */
    maxSteps?: number;

    /**
     * Gate a whole script behind a human approval. Default: unattended (the
     * composed tools keep their OWN gates — a script can't bypass a sub-tool's
     * `needsApproval`, which the loop still enforces per call). Evaluated from
     * replay-stable input, so keep it deterministic.
     */
    needsApproval?: ((input: ToolScript) => boolean) | boolean;
}

/** Read a dot-path (`"a.b.0.c"`) out of a value; `undefined` for a miss. */
const getPath = (value: unknown, path: string): unknown => {
    let current = value;

    for (const key of path.split(".")) {
        if (current === null || typeof current !== "object") {
            return undefined;
        }

        current = (current as Record<string, unknown>)[key];
    }

    return current;
};

/**
 * Resolve `{ "$from": "&lt;stepId>", "$path"?: "a.b" }` references in a step's input
 * against earlier step results, recursing through nested objects and arrays. An
 * unknown `$from` throws — a forward/typo reference is a hard error, not a silent
 * `undefined`. Pure and deterministic (no I/O), so it's unit-testable alone.
 */
const resolveReferences = (value: unknown, results: Record<string, unknown>): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => resolveReferences(item, results));
    }

    if (value === null || typeof value !== "object") {
        return value;
    }

    const object = value as Record<string, unknown>;

    if (typeof object["$from"] === "string") {
        const from = object["$from"];

        if (!(from in results)) {
            throw new LunoraError("BAD_REQUEST", `@lunora/agent: code step references unknown result "${from}" (define it in an earlier step)`);
        }

        return typeof object["$path"] === "string" ? getPath(results[from], object["$path"]) : results[from];
    }

    const resolved: Record<string, unknown> = {};

    for (const [key, nested] of Object.entries(object)) {
        resolved[key] = resolveReferences(nested, results);
    }

    return resolved;
};

/**
 * Interpret a {@link ToolScript}: run each step in order, dispatching its `tool`
 * through the same {@link AgentToolContext} the loop hands a normal tool call
 * (so a composed tool inherits the durable step, RLS, and its own approval gate),
 * and bind the output to the step `id` for later `$from` references. Safe by
 * construction — this is data-flow between whitelisted tool calls, NOT arbitrary
 * code, so there is no `eval`/isolate and it runs natively in workerd.
 */
const runToolScript = async (
    script: ToolScript,
    tools: Record<string, AnyAgentTool>,
    context: AgentToolContext,
    maxSteps: number,
): Promise<ToolScriptResult> => {
    const steps = Array.isArray(script.steps) ? script.steps.slice(0, maxSteps) : [];
    const byId: Record<string, unknown> = {};
    const results: { id: string; output: unknown }[] = [];

    for (const step of steps) {
        const tool = tools[step.tool];

        if (!tool) {
            throw new LunoraError("BAD_REQUEST", `@lunora/agent: code step calls unknown tool "${step.tool}" (available: ${Object.keys(tools).join(", ")})`);
        }

        const input = resolveReferences(step.input ?? {}, byId);
        // eslint-disable-next-line no-await-in-loop -- steps are sequential by design: a later input can reference an earlier output
        const output: unknown = await tool.execute(input, context);

        byId[step.id] = output;
        results.push({ id: step.id, output });
    }

    return { final: results.at(-1)?.output, results };
};

/** Build the default description — lists the composable tools so the model knows what it can call. */
const buildCodeDescription = (tools: Record<string, AnyAgentTool>): string =>
    "Compose MULTIPLE tool calls in one turn as a script, instead of one call per turn. Provide `steps`: an ordered array of " +
    '`{ id, tool, input }`. A later step\'s `input` may reference an earlier step\'s output with `{ "$from": "<stepId>", "$path": "optional.dot.path" }`. ' +
    `Available tools: ${Object.entries(tools)
        .map(([name, tool]) => `"${name}" — ${tool.description}`)
        .join("; ")}.`;

const CODE_TOOL_SCHEMA = jsonSchema<ToolScript>({
    properties: {
        steps: {
            description: "Ordered tool calls; a later input may reference an earlier output via { $from, $path }.",
            items: {
                additionalProperties: false,
                properties: {
                    id: { description: "A name later steps reference this output by.", type: "string" },
                    input: { additionalProperties: true, description: "The tool input (may embed $from refs).", type: "object" },
                    tool: { description: "The tool to call.", type: "string" },
                },
                required: ["id", "tool"],
                type: "object",
            },
            type: "array",
        },
    },
    required: ["steps"],
    type: "object",
});

/**
 * A "code mode" tool: instead of the model calling one tool per turn, it writes a
 * SCRIPT that composes several of the tools you hand `codeTool` — chaining a
 * later call's input to an earlier call's output — and the whole thing runs in a
 * single turn. This is a SAFE interpreted data-flow between whitelisted tools
 * (no `eval`, no isolate), so it runs natively in workerd; arbitrary-code
 * execution (the Cloudflare Worker Loader path) is a separate future mode.
 *
 * Each composed tool dispatches through the same durable context a normal call
 * gets, so it keeps its RLS and its own `needsApproval` gate — a script can't
 * smuggle a call past a sub-tool's approval.
 *
 * ```ts
 * import { codeTool, defineAgent, functionTool } from "@lunora/agent";
 *
 * export const analyst = defineAgent({
 *     model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *     tools: {
 *         run: codeTool({
 *             findUser: functionTool("users:byEmail", { description: "Look up a user by email.", inputSchema }),
 *             recentOrders: functionTool("orders:recent", { description: "List a user's recent orders.", inputSchema }),
 *         }),
 *     },
 * });
 * // The model can now, in one turn, `findUser` then feed `{ "$from": "u", "$path": "id" }` into `recentOrders`.
 * ```
 */
const codeTool = (tools: Record<string, AnyAgentTool>, options: CodeToolOptions = {}): AgentToolDefinition<ToolScript, ToolScriptResult> => {
    // Widen for the plain-JS guard — the type forbids it, but a caller can still
    // pass null/undefined or an empty map, which would mint an uncallable tool.
    const provided = tools as Record<string, AnyAgentTool> | null | undefined;

    if (!provided || typeof provided !== "object" || Object.keys(provided).length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/agent: codeTool requires a non-empty map of tools to compose");
    }

    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

    return {
        description: options.description ?? buildCodeDescription(tools),
        execute: (script, context: AgentToolContext) => runToolScript(script, tools, context, maxSteps),
        inputSchema: CODE_TOOL_SCHEMA,
        isLunoraAgentTool: true,
        ...(options.needsApproval === undefined ? {} : { needsApproval: options.needsApproval }),
    };
};

export type { CodeToolOptions, ToolScript, ToolScriptResult, ToolScriptStep };
export { codeTool, resolveReferences, runToolScript };
