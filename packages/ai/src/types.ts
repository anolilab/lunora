import type { EmbeddingModel, LanguageModel } from "ai";

/**
 * Structural projection of the Cloudflare Workers `AI` binding (`env.AI`).
 * Declared locally so unit tests can pass a plain-object double and the real
 * binding satisfies the same shape without importing `@cloudflare/workers-types`
 * into the public surface. Mirrors the `run` method documented at
 * https://developers.cloudflare.com/workers-ai/.
 */
export interface AiBindingLike {
    run: (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
}

/**
 * A Workers AI provider instance — the value returned by `createWorkersAI(...)`.
 * Calling it with a model id yields an AI SDK {@link LanguageModel}; the
 * optional `textEmbeddingModel` factory yields an {@link EmbeddingModel}.
 * Typed structurally so `@cirrus/ai` neither re-declares the provider's full
 * surface nor hard-pins its exact type across minor releases.
 */
export interface WorkersAiProviderLike {
    (modelId: string, settings?: Record<string, unknown>): LanguageModel;
    textEmbeddingModel?: (modelId: string) => EmbeddingModel;
}

/**
 * AI Gateway options forwarded to `createWorkersAI`. Lets inference route
 * through a Cloudflare AI Gateway for caching, rate-limiting, and observability.
 */
export interface AiGatewayOptions {
    [key: string]: unknown;
    id: string;
}

export interface CirrusAiOptions {
    /**
     * The Workers `AI` binding (`env.AI`). Required for the zero-config Workers
     * AI default and for the raw `ai.run(...)` passthrough. May be omitted when
     * a pre-built `provider` is supplied (e.g. in tests or a custom setup).
     */
    binding?: AiBindingLike;

    /**
     * Default Workers AI model id used by `model()` / `embeddingModel()` when no
     * explicit model is passed. Has no effect on bring-your-own providers.
     */
    defaultModel?: string;
    /** Route Workers AI inference through a Cloudflare AI Gateway. */
    gateway?: AiGatewayOptions;

    /**
     * Pre-built Workers AI provider. When omitted, one is constructed from
     * `binding` via `createWorkersAI`. Supplying it directly is the seam used by
     * tests and advanced setups; it also lets callers configure the provider
     * (e.g. `safePrompt`) before handing it to `@cirrus/ai`.
     */
    provider?: WorkersAiProviderLike;
}

/**
 * A model to run against. The AI SDK's {@link LanguageModel} already admits a
 * bare `string`, so this alias covers both arms of the provider-agnostic seam:
 * a string id is the Workers AI convenience path (resolved by `ctx.ai.model`),
 * a built model object is bring-your-own (`@ai-sdk/openai`, `@ai-sdk/anthropic`,
 * `@ai-sdk/google`, OpenRouter, …).
 */
export type ModelInput = LanguageModel;

/**
 * Likewise for embeddings: a Workers AI embedding model id (e.g.
 * `@cf/baai/bge-base-en-v1.5`) or any AI SDK {@link EmbeddingModel}.
 */
export type EmbeddingModelInput = EmbeddingModel | string;

/**
 * The `ctx.ai` surface. `model`/`embeddingModel` resolve a Workers AI model from
 * a string (the default provider) and pass any non-string model straight through,
 * so both accept Workers AI and bring-your-own providers. Feed the resolved model
 * to the AI SDK functions re-exported from `@cirrus/ai` (`generateText`,
 * `streamText`, `generateObject`, `embed`, …); `run` is the raw binding escape
 * hatch, and `workersai` is the underlying provider for direct model access.
 */
export interface CirrusAi {
    /** Resolve an {@link EmbeddingModel}: a string → Workers AI, an object → passthrough. */
    embeddingModel: (model?: EmbeddingModelInput) => EmbeddingModel;
    /** Resolve a {@link LanguageModel}: a string → Workers AI, an object → passthrough. */
    model: (model?: ModelInput) => LanguageModel;

    /**
     * Raw Workers AI binding passthrough (void-style `ai.run`). Bypasses the AI
     * SDK entirely — useful for Workers-AI-only model families (image, ASR,
     * translation) not surfaced through the provider. Throws if no binding was
     * supplied.
     */
    run: (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
    /** The underlying Workers AI provider — `ai.workersai("@cf/...")` for a raw model. */
    workersai: WorkersAiProviderLike;
}
