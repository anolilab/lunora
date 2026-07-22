import { LunoraError } from "@lunora/errors";
import type { EmbeddingModel, LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import { resolveAiGateway } from "./gateway";
import type { AiBindingLike, AiGatewayOptions, EmbeddingModelInput, LunoraAi, LunoraAiOptions, ModelInput, WorkersAiProviderLike } from "./types";

/**
 * Resolve the effective Workers AI `gateway` option: an explicit
 * {@link LunoraAiOptions.gateway} always wins; otherwise, when `env` configures
 * a Cloudflare AI Gateway (`LUNORA_AI_GATEWAY_*`), route through it by its id so
 * the gateway computes token + dollar-cost telemetry. Returns `undefined` when
 * neither applies — the direct-to-Workers-AI path, unchanged.
 */
const resolveGatewayOption = (gateway: AiGatewayOptions | undefined, env: Record<string, unknown> | undefined): AiGatewayOptions | undefined => {
    if (gateway !== undefined) {
        return gateway;
    }

    if (env === undefined) {
        return undefined;
    }

    const resolved = resolveAiGateway(env);

    return resolved === undefined ? undefined : { id: resolved.gatewayId };
};

/**
 * Build the Workers AI provider from a binding, threading the optional AI
 * Gateway config through. Isolated so {@link createAi} can fall back to a
 * caller-supplied `provider` without duplicating the construction. `AiBindingLike`
 * is the structural subset of `createWorkersAI`'s binding that we actually call.
 */
const buildProvider = (binding: AiBindingLike, gateway?: LunoraAiOptions["gateway"]): WorkersAiProviderLike => createWorkersAI({ binding, gateway });

/**
 * Create the `ctx.ai` helper over a Workers `AI` binding.
 *
 * Workers AI is the zero-config default, but `@lunora/ai` is provider-agnostic:
 * every helper takes either a model id string (resolved against the Workers AI
 * provider) or any AI SDK {@link LanguageModel}/{@link EmbeddingModel} object
 * (`@ai-sdk/openai`, `@ai-sdk/anthropic`, OpenRouter, …), so apps are never
 * locked to Workers AI. Pair `embed` with `@lunora/bindings/vectors` for RAG.
 *
 * Combine with the re-exported `generateText`/`streamText`/`generateObject`/
 * `embed`/`tool` from this package:
 *
 * ```ts
 * import { streamText } from "@lunora/ai";
 *
 * const result = streamText({
 *   model: ctx.ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
 *   messages,
 * });
 * ```
 * @experimental
 */
const createAi = (options: LunoraAiOptions): LunoraAi => {
    const { binding, defaultEmbeddingModel, defaultModel, env, gateway, provider } = options;

    if (!provider && !binding) {
        throw new LunoraError("INTERNAL", "@lunora/ai: createAi requires a `binding` (env.AI) or a pre-built `provider`");
    }

    // A caller-supplied provider wins; otherwise construct one from the binding.
    // `binding` is present when `provider` is absent (guarded above). An explicit
    // `gateway` wins; else an env-configured AI Gateway routes Workers AI through
    // it (opt-in), so token + dollar-cost telemetry is computed by the gateway.
    // Resolved once so the raw `ai.run()` path below routes through the same gateway.
    const resolvedGateway = resolveGatewayOption(gateway, env);
    const workersai: WorkersAiProviderLike = provider ?? buildProvider(binding as AiBindingLike, resolvedGateway);

    const model = (input?: ModelInput): LanguageModel => {
        if (input === undefined) {
            if (!defaultModel) {
                throw new LunoraError("INTERNAL", "@lunora/ai: no model supplied and no `defaultModel` configured — pass a model id or an AI SDK model");
            }

            return workersai(defaultModel);
        }

        // A string is a Workers AI model id; anything else is an already-built
        // AI SDK model from some provider — pass it straight through.
        return typeof input === "string" ? workersai(input) : input;
    };

    const resolveEmbeddingModel = (modelId: string): EmbeddingModel => {
        const factory = workersai.textEmbeddingModel;

        if (typeof factory !== "function") {
            throw new LunoraError(
                "INTERNAL",
                "@lunora/ai: the Workers AI provider does not expose `textEmbeddingModel`; pass an AI SDK EmbeddingModel (e.g. from @ai-sdk/openai) to embed()",
            );
        }

        return factory.call(workersai, modelId);
    };

    // Both arms return `EmbeddingModel` (the passthrough is narrowed to it, and
    // resolveEmbeddingModel is annotated to it) — sonar's heuristic mis-reads the
    // parameter-passthrough vs computed-return as two types; the sibling `model`
    // has the same string→object shape and is not flagged.
    // eslint-disable-next-line sonarjs/function-return-type -- single return type (EmbeddingModel); heuristic false-positive
    const embeddingModel = (input?: EmbeddingModelInput): EmbeddingModel => {
        // A built EmbeddingModel (bring-your-own provider) passes straight
        // through; a string id (or the fallback) resolves against Workers AI.
        if (typeof input === "object") {
            return input;
        }

        const modelId = input ?? defaultEmbeddingModel;

        if (!modelId) {
            throw new LunoraError(
                "INTERNAL",
                "@lunora/ai: no embedding model supplied and no `defaultEmbeddingModel` configured — pass an embedding model id or an AI SDK EmbeddingModel",
            );
        }

        return resolveEmbeddingModel(modelId);
    };

    const run = async (modelId: string, inputs: Record<string, unknown>, runOptions?: Record<string, unknown>): Promise<unknown> => {
        if (!binding) {
            throw new LunoraError(
                "INTERNAL",
                "@lunora/ai: ai.run requires the `binding` (env.AI) — it is unavailable when only a custom `provider` was supplied",
            );
        }

        // Route raw `ai.run()` binding calls through the same resolved AI Gateway
        // (for token + dollar-cost telemetry) unless the caller set `gateway` — so
        // gateway routing isn't limited to the AI-SDK model path.
        const mergedOptions = resolvedGateway !== undefined && runOptions?.gateway === undefined ? { ...runOptions, gateway: resolvedGateway } : runOptions;

        return binding.run(modelId, inputs, mergedOptions);
    };

    return { embeddingModel, model, run, workersai };
};

export default createAi;
