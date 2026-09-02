import { LunoraError } from "@lunora/errors";
import { asSchema, jsonSchema } from "ai";

import isPositiveInteger from "./positive-integer";
import { capToolOutputText, MAX_TOOL_OUTPUT_CHARS } from "./tool-output";
import type { AgentToolContext, AgentToolDefinition, AnyAgentTool } from "./types";

/** Default cap on script steps so one code call can't fan out unboundedly. */
const DEFAULT_MAX_STEPS = 16;

/**
 * Cap a step output for the RETURNED result: a small value passes through
 * unchanged; a large one is truncated to a string (with an ellipsis) so a script
 * chaining big-output tools can't balloon the persisted, re-injected tool message.
 * The full output is still available to later `$from` refs (kept separately).
 *
 * The limit and the marker come from `tool-output.ts`, shared with the loop's
 * top-level tool dispatch — the two paths persist into the same thread, so one
 * capping and the other not just moved the overflow.
 */
const capOutput = (output: unknown): unknown => {
    if (output === undefined) {
        return output;
    }

    const serialized = typeof output === "string" ? output : JSON.stringify(output);

    return serialized.length <= MAX_TOOL_OUTPUT_CHARS ? output : capToolOutputText(serialized);
};

/**
 * One step of a tool-composition script — call `tool` with `input`, bind the result to `id`.
 * @experimental
 */
interface ToolScriptStep {
    /** A stable name later steps reference the output by. */
    id: string;
    /** The tool's input; values may embed `{ "$from": "<stepId>", "$path": "a.b" }` refs. */
    input?: Record<string, unknown>;
    /** The tool to call — one of the tools handed to {@link codeTool}. */
    tool: string;
}

/**
 * The model-provided input to a {@link codeTool} call.
 * @experimental
 */
interface ToolScript {
    steps: ToolScriptStep[];
}

/**
 * The result of running a {@link ToolScript}: each step's output plus the last one.
 * @experimental
 */
interface ToolScriptResult {
    final: unknown;
    results: ReadonlyArray<{ id: string; output: unknown }>;
}

/**
 * Author-supplied config for {@link codeTool}.
 * @experimental
 */
interface CodeToolOptions {
    /** Override the model-facing description (the default lists the available tools). */
    description?: string;
    /** Max steps per script (default 16). */
    maxSteps?: number;

    /**
     * Gate a whole script behind a human approval. Default: unattended. Note the
     * COMPOSED tools cannot carry their own approval gate — `codeTool` rejects any
     * tool with a `needsApproval`, because a code-mode script runs its steps in one
     * shot and can't pause mid-script to hibernate for HITL. Gate the whole script
     * here instead. Evaluated from replay-stable input, so keep it deterministic.
     */
    needsApproval?: ((input: ToolScript) => boolean) | boolean;
}

/**
 * Read a dot-path (`"a.b.0.c"`) out of a value; `undefined` for a miss. Only
 * OWN enumerable properties are traversed — a model-supplied `$path` of
 * `__proto__` / `constructor` / `prototype` (or any inherited key) resolves to
 * `undefined`, so untrusted input can't walk the prototype chain into internals.
 */
const getPath = (value: unknown, path: string): unknown => {
    let current = value;

    for (const key of path.split(".")) {
        if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
            return undefined;
        }

        current = (current as Record<string, unknown>)[key];
    }

    return current;
};

/**
 * Resolve `{ "$from": "<stepId>", "$path"?: "a.b" }` references in a step's input
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
        // A model-supplied `__proto__` own key (own after JSON.parse) is the one
        // name that does not create an own property here: it hits
        // `Object.prototype`'s setter and swaps the accumulator's prototype, so
        // a composed tool would read attacker-chosen inherited properties.
        // ONLY that name is skipped — `constructor` and `prototype` are plain
        // own keys on an object literal (assigning them shadows nothing and
        // pollutes nothing), so skipping those would buy no safety and would
        // silently drop a tool argument legitimately called `constructor`.
        if (key === "__proto__") {
            continue;
        }

        resolved[key] = resolveReferences(nested, results);
    }

    return resolved;
};

/**
 * Validate a resolved step input against the composed tool's own `inputSchema`.
 *
 * The model-facing schema declares a step's `input` as
 * `{ additionalProperties: true }` — it cannot describe every composed tool's
 * shape — so a script step could hand a `defineAgentTool` anything: wrong types,
 * extra keys, a `$from` that resolved to a scalar. Nothing between
 * `resolveReferences` and `tool.execute` looked at the schema, while a
 * TOP-LEVEL call to the same tool goes through the AI SDK's validation first.
 *
 * `asSchema(...).validate` is exactly what the SDK uses for that top-level
 * check, so the two paths accept and reject the same inputs — including the case
 * of a bare `jsonSchema(...)` with no validator, which neither path can check.
 */
const validatedStepInput = async (step: ToolScriptStep, tool: AnyAgentTool, input: unknown): Promise<unknown> => {
    const { validate } = asSchema(tool.inputSchema);

    if (validate === undefined) {
        return input;
    }

    const result = await validate(input);

    if (result.success) {
        return result.value;
    }

    throw new LunoraError("BAD_REQUEST", `@lunora/agent: code step "${step.id}" input is invalid for tool "${step.tool}": ${result.error.message}`);
};

/**
 * Interpret a {@link ToolScript}: run each step in order, dispatching its `tool`
 * through the same {@link AgentToolContext} the loop hands a normal tool call
 * (so a composed tool inherits the durable step and RLS — but NOT its own
 * approval gate: a script cannot hibernate mid-way, so a tool declaring
 * `needsApproval` is refused at construction instead), and bind the output to
 * the step `id` for later `$from` references. Safe by
 * construction — this is data-flow between whitelisted tool calls, NOT arbitrary
 * code, so there is no `eval`/isolate and it runs natively in workerd.
 */
const runToolScript = async (
    script: ToolScript,
    tools: Record<string, AnyAgentTool>,
    context: AgentToolContext,
    maxSteps: number,
): Promise<ToolScriptResult> => {
    const steps = Array.isArray(script.steps) ? script.steps : [];

    // Refuse an over-long script rather than running its prefix. Slicing to
    // `maxSteps` dropped the trailing steps — typically the writes the earlier
    // reads were gathered for — and still reported success, so the model saw a
    // completed script and moved on. Failing hands the cap back to the model,
    // which can split the work across turns.
    if (steps.length > maxSteps) {
        throw new LunoraError(
            "BAD_REQUEST",
            `@lunora/agent: code_tool_too_many_steps — the script has ${String(steps.length)} steps, over the cap of ${String(maxSteps)}. Split it across several code calls.`,
        );
    }
    const byId: Record<string, unknown> = {};
    const results: { id: string; output: unknown }[] = [];

    // Reject duplicate step ids UP FRONT, before any tool runs: two steps sharing
    // an id would derive the same per-step idempotency key (a side-effecting call
    // could be skipped as a replay) and the later output would clobber the earlier
    // in `byId` (shifting `$from` semantics). Fail fast with no partial side effects.
    const seenIds = new Set<string>();

    for (const step of steps) {
        if (seenIds.has(step.id)) {
            throw new LunoraError(
                "BAD_REQUEST",
                `@lunora/agent: duplicate code step id "${step.id}" — each step id must be unique (later steps reference an output by id via $from)`,
            );
        }

        seenIds.add(step.id);
    }

    for (const step of steps) {
        const tool = tools[step.tool];

        if (!tool) {
            throw new LunoraError("BAD_REQUEST", `@lunora/agent: code step calls unknown tool "${step.tool}" (available: ${Object.keys(tools).join(", ")})`);
        }

        // eslint-disable-next-line no-await-in-loop -- same sequential loop as the dispatch below: a later step's input can reference an earlier output
        const input = await validatedStepInput(step, tool, resolveReferences(step.input ?? {}, byId));
        // Give each sub-call its OWN idempotency key / tool-call id (derived from
        // the code tool's, suffixed by the step id) so two side-effecting sub-calls
        // in one script don't collide on a shared key when they dedupe on it.
        const stepContext: AgentToolContext = {
            ...context,
            idempotencyKey: `${context.idempotencyKey}:${step.id}`,
            toolCallId: `${context.toolCallId}:${step.id}`,
        };

        const runStep = (): Promise<unknown> => Promise.resolve(tool.execute(input, stepContext));

        // Give each script step its OWN nested durable boundary — named from
        // the per-step key just derived above — instead of running inside only
        // the ENCLOSING codeTool call's step.do. Without this a failure at step
        // 3 retried the whole script, re-running steps 1 and 2's already-
        // committed side effects (the idempotency keys they mint were derived
        // correctly but nothing durable was actually keyed on them). Cloudflare
        // Workflows supports a step.do nested inside another step.do's callback
        // (the codeTool call's own enclosing step), so this nests cleanly.
        // `context.step` is REQUIRED — there is no un-durable fallback, because
        // one would silently drop replay safety exactly when the invariant broke.
        //
        // NOTE: the output therefore crosses a durable-step boundary and is
        // SERIALIZED by the workflow host before it lands in `byId` — see the
        // step-output contract on `codeTool` below.
        // eslint-disable-next-line no-await-in-loop -- steps are sequential by design: a later input can reference an earlier output
        const output: unknown = await context.step.do(stepContext.idempotencyKey, runStep);

        // `byId` keeps the FULL output for later `$from` refs; the RETURNED results
        // (persisted as the tool message and re-injected every turn) get each output
        // capped so a multi-step script chaining large outputs can't balloon it.
        byId[step.id] = output;
        results.push({ id: step.id, output: capOutput(output) });
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
 * gets (inheriting RLS), with a per-step idempotency key. A code-mode script runs
 * its steps in one shot and CANNOT pause mid-script for a human approval, so
 * `codeTool` REJECTS at construction any tool carrying a `needsApproval` gate —
 * keep approval-gated tools as normal top-level tools. Gate the whole script via
 * `opts.needsApproval` instead.
 *
 * STEP-OUTPUT CONTRACT — **every step's output must be JSON-serializable.** Each
 * step runs inside its own durable `step.do`, so the workflow host serializes
 * the returned value before the next step (or the tool result) ever sees it. A
 * `Date` comes back as an ISO string, a `Map`/`Set` as `{}`, `undefined` as
 * `null` or a dropped key, and a `bigint` throws outright. That applies to the
 * value a later step reads through `{ "$from": … }` just as much as to the
 * returned `results` — the hand-off is durable state, not an in-memory one. A
 * composed tool that wants to pass a rich value should return its JSON form
 * (`date.toISOString()`, `[...map]`) and let the consuming step rebuild it.
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
 * @experimental
 */
const codeTool = (tools: Record<string, AnyAgentTool>, options: CodeToolOptions = {}): AgentToolDefinition<ToolScript, ToolScriptResult> => {
    // Widen for the plain-JS guard — the type forbids it, but a caller can still
    // pass null/undefined or an empty map, which would mint an uncallable tool.
    const provided = tools as Record<string, AnyAgentTool> | null | undefined;

    if (!provided || typeof provided !== "object" || Object.keys(provided).length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/agent: codeTool requires a non-empty map of tools to compose");
    }

    // Fail closed on approval-gated tools: a script runs its steps in one shot
    // and can't hibernate for HITL, so composing a `needsApproval` tool would
    // silently bypass its gate. Reject it at declaration time.
    for (const [name, tool] of Object.entries(provided)) {
        if (tool.needsApproval !== undefined && tool.needsApproval !== false) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/agent: codeTool cannot compose "${name}" — it has a \`needsApproval\` gate a code-mode script can't pause for. Expose it as a normal top-level tool, or gate the whole script via codeTool's \`needsApproval\`.`,
            );
        }
    }

    if (options.maxSteps !== undefined && !isPositiveInteger(options.maxSteps)) {
        // `slice(0, maxSteps)` swallows every bad value silently: `0`, `0.5` and
        // `NaN` run NO step and still report success, `-1` drops the LAST step —
        // a script that looks like it committed its final side effect and did
        // not. Fail at declaration time, like `defineAgent`'s `maxTurns`.
        throw new LunoraError("INTERNAL", "@lunora/agent: codeTool `maxSteps` must be a positive integer");
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
