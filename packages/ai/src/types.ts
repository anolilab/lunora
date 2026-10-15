import type { EmbeddingModel, LanguageModel } from "ai";

import type { AiGatewayMetadata } from "./gateway";

/**
 * Structural projection of the Cloudflare Workers `AI` binding (`env.AI`).
 * Declared locally so unit tests can pass a plain-object double and the real
 * binding satisfies the same shape without importing `@cloudflare/workers-types`
 * into the public surface. Mirrors the `run` method documented at
 * https://developers.cloudflare.com/workers-ai/.
 * @experimental
 */
export interface AiBindingLike {
    run: (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;

    /**
     * Markdown Conversion API (beta) — converts a document (PDF, Office file,
     * HTML, image) to Markdown. Optional because runtimes and test doubles that
     * predate it have no such method; `ctx.ai.toMarkdown` reports that instead
     * of a bare `TypeError`. Mirrors `env.AI.toMarkdown(files, options)` at
     * https://developers.cloudflare.com/workers-ai/features/markdown-conversion/.
     */
    toMarkdown?: (
        files: AiMarkdownDocument | AiMarkdownDocument[],
        options?: Record<string, unknown>,
    ) => Promise<AiMarkdownConversionResult | AiMarkdownConversionResult[]>;

    /**
     * Web Search API (beta). Optional because runtimes and test doubles that
     * predate it have no such method; `ctx.ai.websearch` reports that instead of
     * a bare `TypeError`.
     */
    websearch?: (input: Omit<AiWebSearchOptions, "gatewayId"> & { gatewayId: string; query: string }) => Promise<Response>;
}

/**
 * One document handed to `ctx.ai.toMarkdown(...)`: the Workers AI
 * `MarkdownDocument` shape (a name plus a Blob carrying the bytes).
 * @experimental
 */
export interface AiMarkdownDocument {
    blob: Blob;
    name: string;
}

/**
 * One Workers AI `ConversionResult`. `data` and `tokens` are present only when
 * `format` is `"markdown"` (or `"text"`); an `"error"` result carries `error`
 * instead. `pages` is not in the current binding contract — carried here so a
 * binding that starts reporting it passes through unchanged.
 * @experimental
 */
export interface AiMarkdownConversionResult {
    data?: string;
    error?: string;
    format: "error" | "markdown" | "text";
    id?: string;
    /** The detected document mime type (spelled `mimetype` by the binding). */
    mimetype?: string;
    name?: string;
    /** Page count, when the binding reports it. */
    pages?: number;
    tokens?: number;
}

/**
 * What `ctx.ai.toMarkdown(...)` accepts: a `Blob`, raw bytes, or a `URL` that
 * is fetched first.
 * @experimental
 */
export type AiToMarkdownInput = ArrayBuffer | Blob | Uint8Array | URL;

/**
 * Options for `ctx.ai.toMarkdown(...)`.
 * @experimental
 */
export interface AiToMarkdownOptions {
    /** Conversion options forwarded verbatim to the binding's `toMarkdown(files, options)`. */
    conversionOptions?: Record<string, unknown>;

    /**
     * Byte cap for a `URL`/raw-bytes input, guarding against an accidental huge
     * download. Defaults to 20 MiB. A `Blob` is checked against the same cap.
     */
    maxBytes?: number;

    /** MIME type for a raw `ArrayBuffer`/`Uint8Array` input (a `Blob`/`URL` carries its own). */
    mimeType?: string;

    /** Document name sent to the binding; defaults to the URL's last path segment, else `"document"`. */
    name?: string;
}

/**
 * What `ctx.ai.toMarkdown(...)` resolves to — the first (and only) converted
 * document, normalised across the binding's single/array return.
 * @experimental
 */
export interface AiToMarkdownResult {
    markdown: string;
    /** The detected mime type of the source document, when the binding reports it. */
    mimeType?: string;
    /** Page count, when the binding reports it. */
    pages?: number;
    /** The binding's estimated token count for the converted Markdown, when reported. */
    tokens?: number;
}

/**
 * One generated image: base64 bytes (`base64`), a URL, or the provider's media
 * type. Which fields are present depends on the provider.
 * @experimental
 */
export interface AiImage {
    base64?: string;
    mimeType?: string;
    url?: string;
}

/**
 * Input for `ctx.ai.images.generate(...)`.
 * @experimental
 */
export interface AiImageGenerateInput {
    /** How many images to generate. Defaults to 1. */
    count?: number;

    /**
     * A model id: a Workers AI image model (`@cf/black-forest-labs/flux-1-schnell`),
     * or an `"openai/<model>"` / `"google/<model>"` slug routed through the AI
     * Gateway. Any other slug throws `AI_UNKNOWN_IMAGE_MODEL`.
     */
    model: string;
    prompt: string;
    /** Seed for reproducible generation, for providers that support it. */
    seed?: number;
    /** Image size as `"<width>x<height>"`, e.g. `"1024x1024"`. */
    size?: `${number}x${number}`;
}

/**
 * What `ctx.ai.images.generate(...)` resolves to.
 * @experimental
 */
export interface AiImageGenerateResult {
    images: AiImage[];
    /** The model id the caller asked for (the unmodified `input.model`). */
    model: string;
}

/**
 * A Workers AI provider instance — the value returned by `createWorkersAI(...)`.
 * Calling it with a model id yields an AI SDK {@link LanguageModel}; the
 * optional `textEmbeddingModel` factory yields an {@link EmbeddingModel}.
 * Typed structurally so `@lunora/ai` neither re-declares the provider's full
 * surface nor hard-pins its exact type across minor releases. It is the shape of
 * the lazy delegate `ctx.ai.workersai` exposes, so only the callable factory and
 * `textEmbeddingModel` are part of it.
 * @experimental
 */
export interface WorkersAiProviderLike {
    (modelId: string, settings?: Record<string, unknown>): LanguageModel;
    textEmbeddingModel?: (modelId: string) => EmbeddingModel;
}

/**
 * AI Gateway options forwarded to `createWorkersAI`. Lets inference route
 * through a Cloudflare AI Gateway for caching, rate-limiting, and observability.
 * @experimental
 */
export interface AiGatewayOptions {
    [key: string]: unknown;
    id: string;

    /**
     * Custom correlation metadata surfaced in the AI Gateway logs (Cloudflare's
     * native `gateway.metadata`). `@lunora/ai` folds `{ functionPath, traceId }`
     * here from {@link LunoraAiOptions.metadata} when a gateway is configured.
     */
    metadata?: Record<string, string>;
}

/**
 * Options for the raw `ctx.ai.run(...)` passthrough — the Workers AI binding's
 * third argument. Unlisted keys are forwarded to the binding unchanged.
 * @experimental
 */
export interface AiRunOptions {
    [key: string]: unknown;
    /** Route this call through a Cloudflare AI Gateway. Defaults to the gateway `createAi` resolved. */
    gateway?: AiGatewayOptions;

    /**
     * Fail at once instead of waiting in the Workers AI capacity queue when no
     * capacity is free. The rejection surfaces as a `LunoraError` with code
     * `RATE_LIMITED` (Workers AI error `3040`, HTTP 429).
     */
    rejectIfBusy?: boolean;
}

/**
 * Per-call settings for `ctx.ai.model(...)`. Applied to Workers AI model ids
 * (`@cf/…`) only; a gateway slug or a bring-your-own model ignores them.
 * @experimental
 */
export interface AiModelOptions {
    /**
     * Fail at once instead of waiting in the Workers AI capacity queue. The
     * provider reports the rejection as an AI SDK `APICallError` with
     * `statusCode: 429`, which the AI SDK retries unless the call sets
     * `maxRetries: 0`.
     */
    rejectIfBusy?: boolean;
}

/**
 * Structural slice of the span handle `ctx.trace` hands its body — enough to
 * attach a model call's usage once it is known. Declared here rather than
 * imported so `@lunora/ai` takes no dependency on `@lunora/server`; the real
 * handle is assignable to it.
 * @experimental
 */
export interface AiSpan {
    setAttribute: (key: string, value: unknown) => void;
    setAttributes: (fields: Record<string, unknown>) => void;
}

/**
 * Structural slice of `ctx.trace` (the server `LunoraTracer`): runs `function_`
 * inside a named span and hands it the span's {@link AiSpan}.
 * @experimental
 */
export type AiTracer = <T>(name: string, function_: (trace: AiTracer, span: AiSpan) => Promise<T> | T, attributes?: Record<string, unknown>) => Promise<T>;

/**
 * Structural slice of `ctx.metrics` (the server `LunoraMetrics`) — only the
 * counter, which is what usage accounting needs.
 * @experimental
 */
export interface AiMetrics {
    count: (name: string, value?: number, attributes?: Record<string, unknown>) => void;
}

/**
 * Where `ctx.ai` reports model usage. The generated `ctx.ai` passes the
 * function's own `ctx.trace` / `ctx.metrics`, so every call made through
 * `ctx.ai.model(...)` gets an `ai.generate` / `ai.stream` span and
 * `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` /
 * `gen_ai.usage.cost` counters attributed to that function.
 * @experimental
 */
export interface AiTelemetry {
    metrics?: AiMetrics;
    trace?: AiTracer;
}

/**
 * `LunoraAiOptions` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface LunoraAiOptions {
    /**
     * The Workers `AI` binding (`env.AI`). Required for the zero-config Workers
     * AI default and for the raw `ai.run(...)` passthrough. May be omitted when
     * a pre-built `provider` is supplied (e.g. in tests or a custom setup).
     */
    binding?: AiBindingLike;

    /**
     * Default Workers AI **embedding** model id used by `embeddingModel()` when no
     * explicit model is passed (e.g. `@cf/baai/bge-base-en-v1.5`). Kept separate
     * from `defaultModel` because a language-model id and an embedding-model
     * id belong to different Workers AI families and are never interchangeable —
     * reusing the language-model default here would defer a wrong-family error to
     * inference time. Has no effect on bring-your-own providers.
     *
     * Falls back to `LUNORA_AI_DEFAULT_EMBEDDING_MODEL` in {@link LunoraAiOptions.env}
     * — which is how an app sets it, since the generated `ctx.ai` is constructed
     * with a fixed `{ binding, env, metadata }`.
     */
    defaultEmbeddingModel?: string;

    /**
     * Default Workers AI **language** model id used by `model()` when no explicit
     * model is passed. For embeddings, set `defaultEmbeddingModel` instead.
     * Has no effect on bring-your-own providers.
     *
     * Falls back to `LUNORA_AI_DEFAULT_MODEL` in {@link LunoraAiOptions.env} — the
     * seam a Lunora app actually has (see `defaultEmbeddingModel`).
     */
    defaultModel?: string;

    /**
     * The Worker `env`, read for opt-in Cloudflare AI Gateway routing (the
     * `LUNORA_AI_GATEWAY_*` vars, via `resolveAiGateway`) and for the default
     * model ids (`LUNORA_AI_DEFAULT_MODEL` / `LUNORA_AI_DEFAULT_EMBEDDING_MODEL`).
     * When it configures a gateway and no explicit {@link LunoraAiOptions.gateway}
     * is given, the Workers AI provider is routed through that gateway so token +
     * dollar-cost telemetry is computed on the app's behalf. Unset, or with no
     * gateway vars, behavior is unchanged (calls go straight to Workers AI).
     */
    env?: Record<string, unknown>;

    /**
     * Route Workers AI inference through a Cloudflare AI Gateway. An explicit
     * value wins over anything derived from {@link LunoraAiOptions.env}.
     */
    gateway?: AiGatewayOptions;

    /**
     * Correlation metadata folded into the active gateway call (the Workers AI
     * binding's native `gateway.metadata`) so an AI Gateway log entry ties back
     * to the Lunora function + trace that made it. Only applied when a gateway is
     * actually configured (explicit or env-derived) and only its defined fields
     * are sent — absent otherwise, so behavior is unchanged. The generated
     * `ctx.ai` facade threads `{ functionPath, traceId }` here automatically.
     */
    metadata?: AiGatewayMetadata;

    /**
     * Pre-built Workers AI provider. When omitted, one is constructed from
     * `binding` via `createWorkersAI`. Supplying it directly is the seam used by
     * tests and advanced setups; it also lets callers configure the provider
     * (e.g. `safePrompt`) before handing it to `@lunora/ai`.
     */
    provider?: WorkersAiProviderLike;

    /**
     * Record every language-model call resolved by `model()` — a span plus
     * token and cost counters (see {@link AiTelemetry}). Omitted, models are
     * returned unwrapped.
     */
    telemetry?: AiTelemetry;
}

/**
 * A search provider the Web Search API brokers. Each one runs under Cloudflare's
 * Zero Data Retention terms. A search bills a provider key stored on the gateway
 * when there is one (the `default` alias unless `byokAlias` names another),
 * otherwise AI Gateway credits at list price.
 * @experimental
 */
export type AiWebSearchProvider = "ceramic" | "exa" | "linkup";

/**
 * Options for `ctx.ai.websearch(...)`.
 * @experimental
 */
export interface AiWebSearchOptions {
    /** Alias of a provider key stored on the gateway to bill instead of the `default` alias. Without a stored key, gateway credits pay. */
    byokAlias?: string;

    /**
     * The AI Gateway that brokers and bills the search. Defaults to the gateway
     * `ctx.ai` routes inference through (`LUNORA_AI_GATEWAY_ID`), else the
     * account's `default` gateway.
     */
    gatewayId?: string;
    /** Maximum results, 1–10. Defaults to 10. */
    limit?: number;
    /** Defaults to `"ceramic"`. */
    provider?: AiWebSearchProvider;
}

/**
 * One result. Web search is discovery only: a result describes a page, and
 * reading the page is a separate `fetch` of its `url`. The optional fields are
 * present only when the provider returns them.
 * @experimental
 */
export interface AiWebSearchItem {
    description?: string;
    faviconUrl?: string;
    imageUrl?: string;
    /** Naive (no timezone) ISO-8601 datetime, e.g. `"2025-11-30T04:39:48"`. */
    lastModifiedDate?: string;
    title: string;
    url: string;
}

/**
 * What `ctx.ai.websearch(...)` resolves to.
 * @experimental
 */
export interface AiWebSearchResult {
    items: AiWebSearchItem[];
    metadata: { latencyMs: number; query: string; requestId: string };
}

/**
 * A model to run against. The AI SDK's {@link LanguageModel} already admits a
 * bare `string`, so this alias covers both arms of the provider-agnostic seam:
 * a string id is resolved by `ctx.ai.model` — a Workers AI id (`@cf/…`), a
 * `"<provider>/<model>"` slug (`anthropic/claude-sonnet-5`, `openai/gpt-5`, …)
 * routed through Cloudflare AI Gateway, or a gateway dynamic route
 * (`dynamic/<route>`); a built model object is bring-your-own (`@ai-sdk/openai`,
 * `@ai-sdk/anthropic`, `@ai-sdk/google`, OpenRouter, …).
 * @experimental
 */
export type ModelInput = LanguageModel;

/**
 * Likewise for embeddings: a Workers AI embedding model id (e.g.
 * `@cf/baai/bge-base-en-v1.5`) or any AI SDK {@link EmbeddingModel}.
 * @experimental
 */
export type EmbeddingModelInput = EmbeddingModel | string;

/**
 * The `ctx.ai` surface. `model`/`embeddingModel` resolve a Workers AI model from
 * a string (the default provider) and pass any non-string model straight through,
 * so both accept Workers AI and bring-your-own providers. Feed the resolved model
 * to the AI SDK functions re-exported from `@lunora/ai` (`generateText`,
 * `streamText`, `generateObject`, `embed`, …); `run` is the raw binding escape
 * hatch, and `workersai` is the lazy provider delegate for direct model access.
 * @experimental
 */
export interface LunoraAi {
    /** Resolve an {@link EmbeddingModel}: a string → Workers AI, an object → passthrough. */
    embeddingModel: (model?: EmbeddingModelInput) => EmbeddingModel;

    /**
     * Generate images. A Workers AI image model id (`@cf/…`) runs through the
     * binding (and the AI Gateway when configured); an `"openai/<model>"` or
     * `"google/<model>"` slug routes to that provider's image endpoint through
     * the AI Gateway. Any other slug throws `AI_UNKNOWN_IMAGE_MODEL`; a
     * Workers AI id without a binding throws the same directed error `run` does.
     */
    images: {
        generate: (input: AiImageGenerateInput) => Promise<AiImageGenerateResult>;
    };

    /**
     * Resolve a {@link LanguageModel}: a `@cf/…` id → Workers AI, a
     * `"<provider>/<model>"` slug or `dynamic/<route>` → Cloudflare AI Gateway
     * over the same binding (Unified Billing or the gateway's stored keys — no
     * provider key in the app) or, with `LUNORA_AI_PROXY_URL` set, to that
     * OpenAI-compatible proxy; an object → passthrough.
     */
    model: (model?: ModelInput, options?: AiModelOptions) => LanguageModel;

    /**
     * Raw Workers AI binding passthrough (void-style `ai.run`). Bypasses the AI
     * SDK entirely — useful for Workers-AI-only model families (image, ASR,
     * translation) not surfaced through the provider. Throws if no binding was
     * supplied.
     */
    run: (model: string, inputs: Record<string, unknown>, options?: AiRunOptions) => Promise<unknown>;

    /**
     * Convert a document (PDF, Office file, HTML, image) to Markdown through the
     * binding's Markdown Conversion API (beta). Accepts a `Blob`, raw bytes or a
     * `URL` (fetched first). Throws if no binding was supplied, or if the
     * runtime's binding has no `toMarkdown()`.
     */
    toMarkdown: (input: AiToMarkdownInput, options?: AiToMarkdownOptions) => Promise<AiToMarkdownResult>;

    /**
     * Search the web through the binding's Web Search API (beta) to ground a
     * response in live information. Billed to a stored provider key or AI Gateway
     * credits (see {@link AiWebSearchProvider}). Throws if no
     * binding was supplied, or if the runtime's binding has no `websearch()`.
     */
    websearch: (query: string, options?: AiWebSearchOptions) => Promise<AiWebSearchResult>;

    /**
     * A lazy delegate to the Workers AI provider: call it as
     * `ai.workersai("@cf/…")` for a raw language model, or use
     * `ai.workersai.textEmbeddingModel("@cf/…")` for embeddings. The provider
     * module loads on first use, so only the callable factory and
     * `textEmbeddingModel` are exposed — the rest of the `createWorkersAI`
     * factories (image, transcription, speech, …) are not part of this surface.
     */
    workersai: WorkersAiProviderLike;
}
