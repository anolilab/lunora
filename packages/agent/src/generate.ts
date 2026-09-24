import type { AiBindingLike } from "@lunora/ai";
import { createAi } from "@lunora/ai";
import { LunoraError } from "@lunora/errors";
import type { LanguageModel, LanguageModelUsage, ModelMessage, Tool } from "ai";
import { generateText, jsonSchema, Output, streamText, tool as aiTool } from "ai";

import type {
    AgentCompact,
    AgentDefinition,
    AgentEpisodeExtract,
    AgentGenerate,
    AgentGenerateOptions,
    AgentGraphExtract,
    AgentGraphExtraction,
    AgentModelInput,
    AgentStreamGenerate,
    AgentToolCall,
    AgentUsage,
} from "./types";

/** Project AI SDK's `LanguageModelUsage` onto the loop's `AgentUsage` (defined fields only). */
const toAgentUsage = (usage: LanguageModelUsage | undefined): AgentUsage | undefined => {
    if (!usage) {
        return undefined;
    }

    const result: AgentUsage = {};

    for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
        const value = usage[key];

        if (value !== undefined) {
            result[key] = value;
        }
    }

    return Object.keys(result).length > 0 ? result : undefined;
};

/**
 * Normalize a provider's tool-call list onto the loop's {@link AgentToolCall} shape.
 *
 * The `invalid` flag has to survive the mapping. When the model's arguments fail
 * a tool's input schema — or do not parse as JSON at all — the AI SDK marks the
 * call `invalid: true`, refuses to execute it itself, and still lists it in
 * `result.toolCalls` with `input` set to the RAW value it could not validate.
 * Dropping the flag here made the loop run `tool.execute` on that raw value: a
 * wrong-typed object, or the unparsed string spread into `{ 0: "{", 1: '"' … }`.
 */
const mapToolCalls = (calls: ReadonlyArray<{ error?: unknown; input: unknown; invalid?: boolean; toolCallId: string; toolName: string }>): AgentToolCall[] =>
    calls.map((call) => {
        const base = { id: call.toolCallId, input: call.input, name: call.toolName };

        if (call.invalid !== true) {
            return base;
        }

        return { ...base, invalid: call.error instanceof Error ? call.error.message : String(call.error) };
    });

/**
 * Resolve the configured model against the Worker env (see `AgentModelInput`).
 * @experimental
 */
// eslint-disable-next-line sonarjs/function-return-type -- single return type (LanguageModel); the string/object arms trip the heuristic, as in create-ai.ts
const resolveAgentModel = (model: AgentModelInput, env: Record<string, unknown>): LanguageModel => {
    if (typeof model === "function") {
        return model(env);
    }

    if (typeof model === "string") {
        const binding = env["AI"];

        if (!binding) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/agent: the agent model "${model}" is a Workers AI id but there is no \`AI\` binding on the workflow env — declare the ai binding in wrangler.jsonc`,
            );
        }

        // Pass `env` so an opt-in Cloudflare AI Gateway (LUNORA_AI_GATEWAY_*)
        // routes this Workers AI model, letting the gateway compute token +
        // dollar-cost telemetry. No gateway vars → unchanged (direct Workers AI).
        return createAi({ binding: binding as AiBindingLike, env }).model(model);
    }

    return model;
};

/**
 * The per-agent turn preparation shared by the `generateText` and `streamText`
 * seams: the resolved default model, the schema-only tool map (NO `execute` —
 * execution happens back in the loop as named durable steps), the optional
 * structured-output spec, and the static generation settings pulled off the
 * config. Built once per seam; the per-turn overrides arrive on each call.
 */
const prepareAgentTurn = (agent: AgentDefinition, env: Record<string, unknown>) => {
    const defaultModel = resolveAgentModel(agent.model, env);

    const tools: Record<string, Tool> = {};

    for (const [name, definition] of Object.entries(agent.tools ?? {})) {
        tools[name] = aiTool({ description: definition.description, inputSchema: definition.inputSchema });
    }

    const output = agent.output === undefined ? undefined : Output.object({ schema: agent.output });

    const staticSettings = {
        ...(agent.temperature === undefined ? {} : { temperature: agent.temperature }),
        ...(agent.maxOutputTokens === undefined ? {} : { maxOutputTokens: agent.maxOutputTokens }),
        ...(agent.telemetry === undefined ? {} : { telemetry: agent.telemetry }),
        ...(agent.repairToolCall === undefined ? {} : { experimental_repairToolCall: agent.repairToolCall }),
    };

    return { defaultModel, output, staticSettings, tools };
};

/**
 * Assemble the AI SDK call options for one turn: the assembled messages, the
 * per-turn model / tool-choice overrides (from `prepareStep`), and the exposed
 * tool schema map restricted by `activeTools`. Shared verbatim by `generateText`
 * and `streamText` — both accept the same option shape — so the memoized turn is
 * identical whether it streamed or not.
 */
const buildTurnRequest = (base: ReturnType<typeof prepareAgentTurn>, { activeTools, messages, model, signal, toolChoice }: AgentGenerateOptions) => {
    const { defaultModel, output, staticSettings, tools } = base;

    // `activeTools` restricts the exposed schema map — the model can only pick
    // from the filtered set (default: all tools).
    const exposed = activeTools === undefined ? tools : Object.fromEntries(Object.entries(tools).filter(([name]) => activeTools.includes(name)));

    return {
        messages: messages as ModelMessage[],
        model: model ?? defaultModel,
        ...staticSettings,
        ...(Object.keys(exposed).length > 0 ? { tools: exposed } : {}),
        ...(toolChoice === undefined ? {} : { toolChoice }),
        ...(output === undefined ? {} : { output }),
        // A voice barge-in aborts the turn mid-stream; the durable loop never
        // sets it. Harmless on `generateText` (which accepts the same option).
        ...(signal === undefined ? {} : { abortSignal: signal }),
    };
};

/**
 * Build the production LLM-turn seam over AI SDK `generateText`. The agent's
 * tools are exposed to the model schema-only (NO `execute`) — the model can
 * decide to call them, but execution happens back in the loop as named
 * durable steps, never inside the model call.
 *
 * The static generation settings (`temperature`, `maxOutputTokens`,
 * `toolChoice`, `output`, `telemetry`) come off the agent config; the per-turn
 * `activeTools` / `toolChoice` / `model` overrides (from `prepareStep`) arrive
 * on each call. When `output` is set the model runs with `Output.object` and
 * the parsed answer is returned alongside the text.
 * @experimental
 */
const createAgentGenerate = (agent: AgentDefinition, env: Record<string, unknown>): AgentGenerate => {
    const base = prepareAgentTurn(agent, env);

    return async (options) => {
        const result = await generateText(buildTurnRequest(base, options));

        const usage = toAgentUsage(result.usage);

        return {
            text: result.text,
            toolCalls: mapToolCalls(result.toolCalls),
            ...(usage === undefined ? {} : { usage }),
            ...(base.output === undefined ? {} : { output: result.output }),
        };
    };
};

/**
 * The streaming counterpart of {@link createAgentGenerate} over AI SDK
 * `streamText`. It tees each text delta to `onDelta` as the model produces it,
 * then resolves the SAME {@link AgentGenerate} result the non-streaming seam
 * returns — identical `{ text, toolCalls, usage, output }` — so the value the
 * durable `llm:turn:N` step memoizes (and persists) is byte-for-byte unchanged
 * whether the turn streamed or not.
 *
 * Deltas are live-only: the seam runs inside the turn's durable step, so a
 * workflow replay serves the memoized final value without re-invoking it — no
 * delta is ever re-emitted. The persisted assistant message stays the single
 * source of truth.
 * @experimental
 */
const createStreamGenerate = (agent: AgentDefinition, env: Record<string, unknown>): AgentStreamGenerate => {
    const base = prepareAgentTurn(agent, env);

    return async (options, onDelta) => {
        const result = streamText(buildTurnRequest(base, options));

        // Drain the delta stream first, teeing each chunk to the live sink. This
        // both feeds the live channel and drives the call to completion, so the
        // settled promises below resolve to the final turn.
        let streamed = "";

        try {
            for await (const delta of result.textStream) {
                streamed += delta;
                onDelta(delta);
            }
        } catch (error) {
            // A barge-in aborts the turn: `streamText` rejects the stream once
            // its `abortSignal` fires. Resolve to the text streamed so far (the
            // spoken prefix) rather than propagating — the caller persists it.
            // Any non-abort failure is re-thrown.
            if (options.signal?.aborted) {
                return { text: streamed, toolCalls: [] };
            }

            throw error;
        }

        // `output` is only awaited when the agent declared a structured schema —
        // reading `result.output` otherwise would reject.
        const [text, toolCalls, usage, output] = await Promise.all([
            result.text,
            result.toolCalls,
            result.usage,
            base.output === undefined ? Promise.resolve(undefined) : result.output,
        ]);

        const agentUsage = toAgentUsage(usage);

        return {
            text,
            toolCalls: mapToolCalls(toolCalls),
            ...(agentUsage === undefined ? {} : { usage: agentUsage }),
            ...(base.output === undefined ? {} : { output }),
        };
    };
};

/** JSON schema the extraction model fills — a compact entity/relation graph of the exchange. */
const GRAPH_EXTRACTION_SCHEMA = jsonSchema<AgentGraphExtraction>({
    additionalProperties: false,
    properties: {
        entities: {
            description: "The distinct entities (people, orgs, places, things, concepts) named in the exchange.",
            items: {
                additionalProperties: false,
                properties: {
                    name: { description: "The entity's canonical name.", type: "string" },
                    type: { description: "An optional coarse type, e.g. person, org, place, product.", type: "string" },
                },
                required: ["name"],
                type: "object",
            },
            type: "array",
        },
        relations: {
            description: "The directed relationships between the entities, as (src)-[label]->(dst) triples.",
            items: {
                additionalProperties: false,
                properties: {
                    confidence: { description: "Confidence in the relation, 0..1.", type: "number" },
                    dst: { description: "The destination entity name (must appear in `entities`).", type: "string" },
                    label: { description: "The relationship, a short snake_case verb phrase, e.g. works_at.", type: "string" },
                    src: { description: "The source entity name (must appear in `entities`).", type: "string" },
                },
                required: ["src", "dst", "label"],
                type: "object",
            },
            type: "array",
        },
    },
    required: ["entities", "relations"],
    type: "object",
});

/** Build the extraction prompt from the run's exchange (user input + final answer). */
const buildExtractionPrompt = (userInput: string, assistantText: string): string =>
    [
        "Extract a knowledge graph of the durable facts stated in the following exchange.",
        "Return the distinct entities and the directed relationships between them.",
        "Only include facts actually stated — do not invent entities or relations. Prefer few, high-signal triples.",
        "",
        `User: ${userInput}`,
        "",
        `Assistant: ${assistantText}`,
    ].join("\n");

/**
 * Build the production run-end graph-extraction seam over AI SDK `generateText`
 * with an `Output.object` setting (the non-deprecated replacement for
 * `generateObject`, and the same structured-output path the turn seams use). It
 * resolves the (optionally cheaper) extraction model against the env, runs the
 * model over {@link GRAPH_EXTRACTION_SCHEMA}, and returns the parsed
 * `{ entities, relations }`. Wired by `compileAgentWorkflow` and called inside
 * the loop's memoized `memory:extract` step.
 * @experimental
 */
const createGraphExtract =
    (): AgentGraphExtract =>
    async ({ assistantText, env, model, userInput }) => {
        const { output } = await generateText({
            model: resolveAgentModel(model, env),
            output: Output.object({ schema: GRAPH_EXTRACTION_SCHEMA }),
            prompt: buildExtractionPrompt(userInput, assistantText),
        });

        return output;
    };

/** Prompt the run-end episode summarizer to condense the exchange into one memory-log sentence. */
const buildEpisodePrompt = (userInput: string, assistantText: string): string =>
    [
        "Summarize the following exchange as ONE concise past-tense sentence for a long-term memory log.",
        "Capture what the user wanted and what was done or decided — a durable fact worth recalling in a later conversation.",
        "No preamble and no quotes: return only the sentence.",
        "",
        `User: ${userInput}`,
        "",
        `Assistant: ${assistantText}`,
    ].join("\n");

/**
 * Build the production run-end episode-extraction seam over AI SDK `generateText`.
 * Unlike the graph extractor this needs no structured schema — an episode is a
 * single natural-language summary — so it returns the trimmed model text. Wired
 * by `compileAgentWorkflow` and called inside the loop's memoized
 * `memory:episode` step.
 * @experimental
 */
const createEpisodeExtract =
    (): AgentEpisodeExtract =>
    async ({ assistantText, env, model, userInput }) => {
        const { text } = await generateText({
            model: resolveAgentModel(model, env),
            prompt: buildEpisodePrompt(userInput, assistantText),
        });

        return { summary: text.trim() };
    };

/** System prompt steering the history-compaction summarizer. */
const COMPACTION_SYSTEM =
    "You are compacting an ongoing conversation. Summarize the messages so far into a concise brief that preserves " +
    "decisions made, facts established, open questions, and current task state — everything the assistant needs to continue " +
    "coherently. Write it as notes for the assistant, not a reply to the user. No preamble.";

/**
 * Build the production history-compaction seam over AI SDK `generateText`: it
 * summarizes the older conversation messages under {@link COMPACTION_SYSTEM} and
 * returns the brief. Wired by `compileAgentWorkflow` and called inside the loop's
 * memoized `llm:turn:N` step so the summarization is replay-safe.
 */
const createCompact =
    (): AgentCompact =>
    async ({ env, messages, model }) => {
        const { text } = await generateText({
            messages,
            model: resolveAgentModel(model, env),
            system: COMPACTION_SYSTEM,
        });

        return text.trim();
    };

export { createAgentGenerate, createCompact, createEpisodeExtract, createGraphExtract, createStreamGenerate, resolveAgentModel };
