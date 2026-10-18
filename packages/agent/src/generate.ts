import { jsonSchema } from "@ai-sdk/provider-utils";
import { LunoraError } from "@lunora/errors";
import type { LanguageModel, LanguageModelUsage, ModelMessage, Tool } from "ai";

import resolveAgentAi from "./agent-ai";
import { summarizeUsage } from "./telemetry/common";
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

/**
 * Project AI SDK's `LanguageModelUsage` onto the loop's `AgentUsage`. The breakdowns
 * come from the `*TokenDetails` objects through the projection the telemetry bridges
 * use, so a persisted total and a span agree on every bucket.
 */
const toAgentUsage = (usage: LanguageModelUsage | undefined): AgentUsage | undefined => summarizeUsage(usage);

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
        const ai = resolveAgentAi(env);

        if (!ai) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/agent: the agent model "${model}" is a Workers AI id but there is no \`AI\` binding on the workflow env — declare the ai binding in wrangler.jsonc`,
            );
        }

        // Pass `env` so an opt-in Cloudflare AI Gateway (LUNORA_AI_GATEWAY_*)
        // routes this Workers AI model, letting the gateway compute token +
        // dollar-cost telemetry. No gateway vars → unchanged (direct Workers AI).
        return ai.model(model);
    }

    return model;
};

type AiModule = typeof import("ai");

/**
 * The `ai` root is ~720 KB and builds schemas at module scope, so it loads on the
 * first model call, not at import. Known limit: `@lunora/ai`'s barrel re-exports
 * values from `ai`, so an agent definition still evaluates `ai` through
 * `agent-ai` -> `@lunora/ai`; this deferral pays off once that barrel is split.
 */
let aiPromise: Promise<AiModule> | undefined;
const loadAi = (): Promise<AiModule> => {
    // A rejected import is not memoised: the extractors call this directly and a durable step
    // retry must be able to load again.
    aiPromise ??= import("ai").catch((error: unknown) => {
        aiPromise = undefined;

        throw error;
    });

    return aiPromise;
};

/**
 * The per-agent turn preparation shared by the `generateText` and `streamText`
 * seams: the resolved default model, the schema-only tool map (NO `execute` —
 * execution happens back in the loop as named durable steps), the optional
 * structured-output spec, and the static generation settings pulled off the
 * config. Built once per seam; the per-turn overrides arrive on each call.
 */
const prepareAgentTurn = (ai: AiModule, agent: AgentDefinition, env: Record<string, unknown>) => {
    const defaultModel = resolveAgentModel(agent.model, env);

    const tools: Record<string, Tool> = {};

    for (const [name, definition] of Object.entries(agent.tools ?? {})) {
        tools[name] = ai.tool({ description: definition.description, inputSchema: definition.inputSchema });
    }

    const output = agent.output === undefined ? undefined : ai.Output.object({ schema: agent.output });

    const staticSettings = {
        ...(agent.temperature === undefined ? {} : { temperature: agent.temperature }),
        ...(agent.maxOutputTokens === undefined ? {} : { maxOutputTokens: agent.maxOutputTokens }),
        ...(agent.telemetry === undefined ? {} : { telemetry: agent.telemetry }),
        ...(agent.repairToolCall === undefined ? {} : { experimental_repairToolCall: agent.repairToolCall }),
    };

    return { defaultModel, output, staticSettings, tools };
};

/** Memoised per-seam turn preparation, built on the seam's first call once `ai` has loaded. */
const lazyTurn = (agent: AgentDefinition, env: Record<string, unknown>) => {
    let prepared: Promise<{ ai: AiModule; base: ReturnType<typeof prepareAgentTurn> }> | undefined;

    return () => {
        // A rejected preparation (a transient failure in a function-valued `model`, say) is not
        // memoised: the durable step retries through this seam and must call the factory again.
        prepared ??= loadAi()
            .then((ai) => {
                return { ai, base: prepareAgentTurn(ai, agent, env) };
            })
            .catch((error: unknown) => {
                prepared = undefined;

                throw error;
            });

        return prepared;
    };
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
 * The error an in-band `error` stream part fails the turn with. An `Error` is
 * rethrown as-is, exactly as a rejected stream would be; any other carried value
 * is wrapped so the durable step still fails with an `Error` that keeps the
 * original as its `cause`.
 */
const toStreamError = (error: unknown): Error => {
    if (error instanceof Error) {
        return error;
    }

    return new Error(`model stream failed: ${String(error)}`, { cause: error });
};

/** Key under which a failed turn's error carries the usage the provider billed for it. */
const FAILED_TURN_USAGE = Symbol("lunoraFailedTurnUsage");

/**
 * A provider's usage as a middleware receives it, before the AI SDK flattens it: each
 * count sits under `total`, with its breakdown beside it.
 */
interface ProviderUsage {
    inputTokens: { cacheRead?: number; cacheWrite?: number; total?: number };
    outputTokens: { reasoning?: number; total?: number };
}

/** The loop's usage from a provider's usage, the same projection the SDK applies to a finished turn. */
const providerUsageOf = (usage: ProviderUsage | undefined): AgentUsage | undefined => {
    if (usage === undefined) {
        return undefined;
    }

    const { inputTokens, outputTokens } = usage;
    const total = inputTokens.total === undefined || outputTokens.total === undefined ? undefined : inputTokens.total + outputTokens.total;

    return summarizeUsage({
        inputTokens: inputTokens.total,
        inputTokenDetails: { cacheReadTokens: inputTokens.cacheRead, cacheWriteTokens: inputTokens.cacheWrite },
        outputTokens: outputTokens.total,
        outputTokenDetails: { reasoningTokens: outputTokens.reasoning },
        totalTokens: total,
    });
};

/**
 * The error a provider's `error` finish reason fails the turn with. The provider's
 * raw reason rides in the message when it has one, and the whole finish reason is
 * kept as `cause` so a log reader sees exactly what the provider reported. The usage
 * the provider reported on that finish is kept too: the attempt was billed whether or
 * not it produced an answer, so the loop counts it (see {@link usageOfFailedTurn}).
 */
const finishErrorOf = (finishReason: { raw: string | undefined; unified: string }, usage: ProviderUsage | undefined): Error => {
    const error: Error & { [FAILED_TURN_USAGE]?: AgentUsage } = new Error(
        finishReason.raw === undefined ? "model finished with an error reason" : `model finished with an error reason (provider reason: ${finishReason.raw})`,
        { cause: finishReason },
    );
    const billed = providerUsageOf(usage);

    if (billed !== undefined) {
        error[FAILED_TURN_USAGE] = billed;
    }

    return error;
};

/**
 * The usage a failed model turn was billed before it failed, or `undefined` when the
 * error did not come from a turn or the provider reported none. A turn that is retried
 * by its durable step is counted once, by the attempt whose error reaches the loop.
 */
const usageOfFailedTurn = (error: unknown): AgentUsage | undefined => {
    if (typeof error !== "object" || error === null) {
        return undefined;
    }

    return (error as { [FAILED_TURN_USAGE]?: AgentUsage })[FAILED_TURN_USAGE];
};

/**
 * Wrap the turn's model so a provider turn that did not complete fails in-band.
 * Two shapes qualify. A stream that closes without its `finish` part is kept by
 * the AI SDK as a finished turn (`finishReason: "other"`), indistinguishable from
 * a provider that legitimately ends with `other`, so only the provider stream
 * tells them apart. A `finish` whose unified reason is `error` is the provider's
 * own report that it cut the generation short or failed it, so the partial text
 * must not be persisted as an answer. Any other reason, including `other`, is a
 * healthy finish.
 */
const failIncompleteTurn = (ai: AiModule, model: Exclude<LanguageModel, string>) =>
    ai.wrapLanguageModel({
        middleware: {
            wrapGenerate: async ({ doGenerate }) => {
                const result = await doGenerate();

                if (result.finishReason.unified === "error") {
                    throw finishErrorOf(result.finishReason, result.usage);
                }

                return result;
            },
            wrapStream: async ({ doStream }) => {
                const { stream, ...rest } = await doStream();
                let finished = false;

                return {
                    ...rest,
                    stream: stream.pipeThrough(
                        new TransformStream({
                            flush: (controller) => {
                                if (!finished) {
                                    controller.enqueue({ error: new Error("model stream ended without a finish part"), type: "error" });
                                }
                            },
                            transform: (part, controller) => {
                                if (part.type === "finish") {
                                    finished = true;

                                    // Swap the finish for an in-band error so the consumer fails the turn
                                    // through the same path as any other error part.
                                    if (part.finishReason.unified === "error") {
                                        controller.enqueue({ error: finishErrorOf(part.finishReason, part.usage), type: "error" });

                                        return;
                                    }
                                }

                                controller.enqueue(part);
                            },
                        }),
                    ),
                };
            },
        },
        model,
    });

/**
 * The turn's model with {@link failIncompleteTurn} applied. `resolveAgentModel`
 * always yields a model object; the string arm only narrows the AI SDK union.
 */
const guardTurnModel = (ai: AiModule, model: LanguageModel): LanguageModel => (typeof model === "string" ? model : failIncompleteTurn(ai, model));

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
    const getBase = lazyTurn(agent, env);

    return async (options) => {
        const { ai, base } = await getBase();
        const request = buildTurnRequest(base, options);
        const result = await ai.generateText({ ...request, model: guardTurnModel(ai, request.model) });

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
    const getBase = lazyTurn(agent, env);

    return async (options, onDelta) => {
        const { ai, base } = await getBase();
        const request = buildTurnRequest(base, options);
        const result = ai.streamText({ ...request, model: guardTurnModel(ai, request.model) });

        // Drain the full part stream, teeing each text delta to the live sink. This
        // both feeds the live channel and drives the call to completion, so the
        // settled promises below resolve to the final turn. `textStream` is not
        // used: it drops `error` parts, so a provider error that arrives in-band
        // after text would resolve as a successful, truncated turn.
        let streamed = "";

        try {
            for await (const part of result.stream) {
                if (part.type === "error") {
                    throw toStreamError(part.error);
                }

                if (part.type === "text-delta") {
                    streamed += part.text;
                    onDelta(part.text);
                }
            }
        } catch (error) {
            // Any failure that is not a barge-in abort is re-thrown below.
            if (!options.signal?.aborted) {
                throw error;
            }
        }

        // A barge-in aborts the turn. The delta stream may end by rejecting or by
        // closing cleanly; either way resolve to the text streamed so far (the
        // spoken prefix) rather than reading the settled promises, which reject
        // with the abort — the caller persists the prefix.
        if (options.signal?.aborted) {
            return { text: streamed, toolCalls: [] };
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
        const ai = await loadAi();
        const { output } = await ai.generateText({
            model: guardTurnModel(ai, resolveAgentModel(model, env)),
            output: ai.Output.object({ schema: GRAPH_EXTRACTION_SCHEMA }),
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
        const ai = await loadAi();
        const { text } = await ai.generateText({
            model: guardTurnModel(ai, resolveAgentModel(model, env)),
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
 * Appended to {@link COMPACTION_SYSTEM} on an incremental update, where the
 * conversation already carries a brief of the earlier turns. Without it the
 * summarizer may condense only the newly aged-out messages and overwrite the
 * stored brief, silently dropping facts from every earlier turn.
 */
const COMPACTION_MERGE_SYSTEM =
    " An existing brief of the earlier conversation is included above. UPDATE that brief: keep every still-relevant fact " +
    "from it and fold in the newly aged-out messages. Do not replace it with a summary of only the new messages.";

/**
 * Build the production history-compaction seam over AI SDK `generateText`: it
 * summarizes the older conversation messages under {@link COMPACTION_SYSTEM} and
 * returns the brief. Wired by `compileAgentWorkflow` and called inside the loop's
 * memoized `llm:turn:N` step so the summarization is replay-safe.
 */
const createCompact =
    (): AgentCompact =>
    async ({ env, messages, model, previousSummary }) => {
        const ai = await loadAi();
        const { text } = await ai.generateText({
            messages,
            model: guardTurnModel(ai, resolveAgentModel(model, env)),
            system: previousSummary === undefined ? COMPACTION_SYSTEM : `${COMPACTION_SYSTEM}${COMPACTION_MERGE_SYSTEM}`,
        });

        return text.trim();
    };

export { createAgentGenerate, createCompact, createEpisodeExtract, createGraphExtract, createStreamGenerate, resolveAgentModel, usageOfFailedTurn };
