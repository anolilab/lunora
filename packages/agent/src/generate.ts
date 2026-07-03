import type { AiBindingLike } from "@lunora/ai";
import { createAi } from "@lunora/ai";
import { LunoraError } from "@lunora/errors";
import type { LanguageModel, ModelMessage, Tool } from "ai";
import { generateText, tool as aiTool } from "ai";

import type { AgentDefinition, AgentGenerate, AgentModelInput } from "./types";

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
 */
export const createAgentGenerate = (agent: AgentDefinition, env: Record<string, unknown>): AgentGenerate => {
    const model = resolveAgentModel(agent.model, env);

    const tools: Record<string, Tool> = {};

    for (const [name, definition] of Object.entries(agent.tools ?? {})) {
        tools[name] = aiTool({ description: definition.description, inputSchema: definition.inputSchema });
    }

    return async ({ messages }) => {
        const result = await generateText({
            messages: messages as ModelMessage[],
            model,
            ...(Object.keys(tools).length > 0 ? { tools } : {}),
        });

        return {
            text: result.text,
            toolCalls: result.toolCalls.map((call) => {
                return { id: call.toolCallId, input: call.input as unknown, name: call.toolName };
            }),
        };
    };
};
