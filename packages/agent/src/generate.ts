import type { AiBindingLike } from "@lunora/ai";
import { createAi } from "@lunora/ai";
import { LunoraError } from "@lunora/errors";
import type { LanguageModel, LanguageModelUsage, ModelMessage, Tool } from "ai";
import { generateText, Output, streamText, tool as aiTool } from "ai";

import type { AgentDefinition, AgentGenerate, AgentGenerateOptions, AgentModelInput, AgentStreamGenerate, AgentToolCall, AgentUsage } from "./types";

/** Project AI SDK's `LanguageModelUsage` onto the loop's `AgentUsage` (defined fields only). */
const toAgentUsage = (usage: LanguageModelUsage | undefined): AgentUsage | undefined => {
    if (!usage) {
        return undefined;
    }

    const result: AgentUsage = {};

    if (usage.inputTokens !== undefined) {
        result.inputTokens = usage.inputTokens;
    }

    if (usage.outputTokens !== undefined) {
        result.outputTokens = usage.outputTokens;
    }

    if (usage.totalTokens !== undefined) {
        result.totalTokens = usage.totalTokens;
    }

    return Object.keys(result).length > 0 ? result : undefined;
};

/** Normalize a provider's tool-call list onto the loop's {@link AgentToolCall} shape. */
const mapToolCalls = (calls: ReadonlyArray<{ input: unknown; toolCallId: string; toolName: string }>): AgentToolCall[] =>
    calls.map((call) => {
        return { id: call.toolCallId, input: call.input, name: call.toolName };
    });

/** Resolve the configured model against the Worker env (see `AgentModelInput`). */
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

        return createAi({ binding: binding as AiBindingLike }).model(model);
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
        ...(agent.telemetry === undefined ? {} : { experimental_telemetry: agent.telemetry }),
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
const buildTurnRequest = (base: ReturnType<typeof prepareAgentTurn>, { activeTools, messages, model, toolChoice }: AgentGenerateOptions) => {
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
 */
const createStreamGenerate = (agent: AgentDefinition, env: Record<string, unknown>): AgentStreamGenerate => {
    const base = prepareAgentTurn(agent, env);

    return async (options, onDelta) => {
        const result = streamText(buildTurnRequest(base, options));

        // Drain the delta stream first, teeing each chunk to the live sink. This
        // both feeds the live channel and drives the call to completion, so the
        // settled promises below resolve to the final turn.
        for await (const delta of result.textStream) {
            onDelta(delta);
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

export { createAgentGenerate, createStreamGenerate, resolveAgentModel };
