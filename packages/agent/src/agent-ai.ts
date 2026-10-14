import type { AiBindingLike, LunoraAi } from "@lunora/ai";
import { createAi } from "@lunora/ai";

/**
 * The `ctx.ai` facade over the Worker's `AI` binding, or `undefined` when the
 * env has none — each caller decides what a missing binding means for it.
 * `env` is passed through so an opt-in AI Gateway (`LUNORA_AI_GATEWAY_*`) and
 * the default model ids apply.
 */
const resolveAgentAi = (env: Record<string, unknown>): LunoraAi | undefined => {
    const binding = env["AI"];

    return binding ? createAi({ binding: binding as AiBindingLike, env }) : undefined;
};

export default resolveAgentAi;
