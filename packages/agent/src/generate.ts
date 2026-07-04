import type { AiBindingLike } from "@lunora/ai";
import { createAi } from "@lunora/ai";
import { LunoraError } from "@lunora/errors";
import type { LanguageModel, LanguageModelUsage, ModelMessage, Tool } from "ai";
import { generateText, Output, tool as aiTool } from "ai";

import type { AgentDefinition, AgentGenerate, AgentModelInput, AgentUsage } from "./types";

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

/** Resolve the configured model against the Worker env (see `AgentModelInput`). */
// eslint-disable-next-line sonarjs/function-return-type -- single return type (LanguageModel); the string/object arms trip the heuristic, as in create-ai.ts
export const resolveAgentModel = (model: AgentModelInput, env: Record<string, unknown>): LanguageModel => {
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
export const createAgentGenerate = (agent: AgentDefinition, env: Record<string, unknown>): AgentGenerate => {
    const defaultModel = resolveAgentModel(agent.model, env);

    const tools: Record<string, Tool> = {};

    for (const [name, definition] of Object.entries(agent.tools ?? {})) {
        tools[name] = aiTool({ description: definition.description, inputSchema: definition.inputSchema });
    }

    const output = agent.output === undefined ? undefined : Output.object({ schema: agent.output });

    return async ({ activeTools, messages, model, toolChoice }) => {
        // `activeTools` restricts the exposed schema map — the model can only
        // pick from the filtered set (default: all tools).
        const exposed = activeTools === undefined ? tools : Object.fromEntries(Object.entries(tools).filter(([name]) => activeTools.includes(name)));

        const result = await generateText({
            messages: messages as ModelMessage[],
            model: model ?? defaultModel,
            ...(Object.keys(exposed).length > 0 ? { tools: exposed } : {}),
            ...(toolChoice === undefined ? {} : { toolChoice }),
            ...(agent.temperature === undefined ? {} : { temperature: agent.temperature }),
            ...(agent.maxOutputTokens === undefined ? {} : { maxOutputTokens: agent.maxOutputTokens }),
            ...(agent.telemetry === undefined ? {} : { experimental_telemetry: agent.telemetry }),
            ...(output === undefined ? {} : { output }),
        });

        const usage = toAgentUsage(result.usage);

        return {
            text: result.text,
            toolCalls: result.toolCalls.map((call) => {
                return { id: call.toolCallId, input: call.input as unknown, name: call.toolName };
            }),
            ...(usage === undefined ? {} : { usage }),
            ...(output === undefined ? {} : { output: result.output }),
        };
    };
};
