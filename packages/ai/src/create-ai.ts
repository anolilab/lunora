import { createOpenAI } from "@ai-sdk/openai";
import { LunoraError } from "@lunora/errors";
import type { EmbeddingModel, LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { anthropic } from "workers-ai-provider/anthropic";
import { openai } from "workers-ai-provider/openai";

import type { AiGatewayMetadata } from "./gateway";
import {
    AI_DEFAULT_EMBEDDING_MODEL_ENV,
    AI_DEFAULT_MODEL_ENV,
    AI_GATEWAY_ID_ENV,
    AI_PROXY_TOKEN_ENV,
    AI_PROXY_URL_ENV,
    buildAiGatewayMetadataFields,
    readAiGatewayEnvTags,
    readEnv,
    warnIgnoredBindingToken,
} from "./gateway";
import instrumentModel from "./telemetry";
import type {
    AiGatewayOptions,
    AiModelOptions,
    AiRunOptions,
    AiWebSearchOptions,
    AiWebSearchResult,
    EmbeddingModelInput,
    LunoraAi,
    LunoraAiOptions,
    ModelInput,
    WorkersAiProviderLike,
} from "./types";

/**
 * Wire-format plugins for AI Gateway catalog models. `openai` parses every
 * OpenAI-compatible provider (OpenAI, Google and xAI on the run path, Groq,
 * DeepSeek, Mistral, …) and dynamic routes; `anthropic` is needed because the
 * gateway passes Anthropic through in its native format.
 */
const GATEWAY_PROVIDER_PLUGINS = [openai, anthropic];

/**
 * A `"<provider>/<model>"` catalog slug or a `dynamic/<route>` — anything slashed
 * that is not a Workers AI id (`@cf/…`, `@hf/…`). Mirrors `workers-ai-provider`'s
 * own routing test, which is what actually sends these through AI Gateway.
 */
const isGatewayModelId = (modelId: string): boolean => !modelId.startsWith("@") && modelId.includes("/");

/** The one error for every call that needs the Workers `AI` binding and has none. */
const bindingRequired = (subject: string): never => {
    throw new LunoraError(
        "INTERNAL",
        `@lunora/ai: ${subject} needs the \`AI\` binding (env.AI). Add an \`ai\` binding to wrangler.jsonc, or set ${AI_PROXY_URL_ENV} to an OpenAI-compatible proxy for "<provider>/<model>" slugs.`,
    );
};

/** Stands in for the Workers AI provider when there is no binding (a proxy-only host such as celld, or nothing configured). */
const workersAiUnavailable = (): never => bindingRequired("this model id");

workersAiUnavailable.textEmbeddingModel = (): never => bindingRequired("this embedding model id");

/**
 * Workers AI error `3040` ("Capacity temporarily exceeded") — what a
 * `rejectIfBusy` call rejects with. The binding throws a plain `Error` whose
 * message carries the code (`"3040: …"`, sometimes prefixed with the error
 * name), or a numeric `code` property.
 */
const CAPACITY_EXCEEDED_CODE = 3040;

/** The code leads the message (after an optional error name), so "line 3040: …" elsewhere never matches. */
const CAPACITY_EXCEEDED_MESSAGE = /^(?:[A-Z]\w*:\s*)?3040\s*:/iu;

const isCapacityExceeded = (error: unknown): boolean =>
    (error as { code?: unknown } | null)?.code === CAPACITY_EXCEEDED_CODE || (error instanceof Error && CAPACITY_EXCEEDED_MESSAGE.test(error.message));

/** The AI Gateway every Cloudflare account has, which `workers-ai-provider` also falls back to for catalog slugs. */
const DEFAULT_GATEWAY_ID = "default";

/** 4xx is the caller's request (bad query, unknown provider, gateway missing); 429 and 5xx are retryable. */
const websearchErrorCode = (status: number): "BAD_REQUEST" | "RATE_LIMITED" | "SERVICE_UNAVAILABLE" => {
    if (status === 429) {
        return "RATE_LIMITED";
    }

    return status >= 400 && status < 500 ? "BAD_REQUEST" : "SERVICE_UNAVAILABLE";
};

/** A proxy host a bearer token may reach over plain HTTP: this machine only. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

interface ProxyProvider {
    chat: (modelId: string) => LanguageModel;
    embedding: (modelId: string) => EmbeddingModel;
}

/**
 * The self-hosted OpenAI-compatible proxy named by {@link AI_PROXY_URL_ENV}, which
 * takes `"<provider>/<model>"` slugs instead of AI Gateway (the slug is forwarded
 * unchanged as the request's model), or `undefined` when none is configured.
 *
 * A token is never sent in cleartext: with {@link AI_PROXY_TOKEN_ENV} set, a
 * non-HTTPS URL off loopback yields a provider whose every call throws — lazily,
 * so an action that never touches `ctx.ai` is unaffected.
 */
const resolveProxy = (env: Record<string, unknown> | undefined): ProxyProvider | undefined => {
    const proxyURL = readEnv(env, AI_PROXY_URL_ENV);

    if (proxyURL === undefined) {
        return undefined;
    }

    const token = readEnv(env, AI_PROXY_TOKEN_ENV);
    const url = URL.canParse(proxyURL) ? new URL(proxyURL) : undefined;
    let refusal: string | undefined;

    if (url === undefined) {
        refusal = `${AI_PROXY_URL_ENV} is not a valid URL`;
    } else if (token !== undefined && url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
        refusal = `${AI_PROXY_URL_ENV} (${url.origin}) is not HTTPS, so ${AI_PROXY_TOKEN_ENV} would travel in cleartext — use an https:// URL`;
    }

    if (refusal !== undefined) {
        const refuse = (): never => {
            throw new LunoraError("INTERNAL", `@lunora/ai: ${refusal}`);
        };

        return { chat: refuse, embedding: refuse };
    }

    return createOpenAI({ apiKey: token ?? "", baseURL: proxyURL, name: "lunora-proxy" });
};

/**
 * Deployment-scoped tags (`LUNORA_AI_GATEWAY_TAGS`) sit UNDER any per-call
 * tags, which sit under the built-in correlation fields: the more specific the
 * source, the later it wins.
 */
const withEnvironmentTags = (env: Record<string, unknown> | undefined, metadata: AiGatewayMetadata | undefined): AiGatewayMetadata | undefined => {
    const environmentTags = env === undefined ? undefined : readAiGatewayEnvTags(env);

    return environmentTags === undefined ? metadata : { ...metadata, tags: { ...environmentTags, ...metadata?.tags } };
};

/**
 * Resolve the effective Workers AI `gateway` option: an explicit
 * {@link LunoraAiOptions.gateway} always wins; otherwise, when `env` configures
 * a Cloudflare AI Gateway (`LUNORA_AI_GATEWAY_*`), route through it by its id so
 * the gateway computes token + dollar-cost telemetry. Returns `undefined` when
 * neither applies — the direct-to-Workers-AI path, unchanged.
 *
 * When correlation `metadata` (`{ functionPath, traceId }`) is supplied and a
 * gateway is active, its defined fields are folded into the gateway option's
 * native `metadata` so the AI Gateway log ties back to the Lunora trace. It is
 * never added to an explicit gateway that already carries its own `metadata`,
 * and is a no-op when no gateway resolves — additive and backward-compatible.
 */
const resolveGatewayOption = (
    gateway: AiGatewayOptions | undefined,
    env: Record<string, unknown> | undefined,
    metadata: AiGatewayMetadata | undefined,
): AiGatewayOptions | undefined => {
    const metadataFields = buildAiGatewayMetadataFields(metadata);

    if (gateway !== undefined) {
        return metadataFields !== undefined && gateway.metadata === undefined ? { ...gateway, metadata: metadataFields } : gateway;
    }

    if (env === undefined) {
        return undefined;
    }

    // The binding routes with the account's own credentials, so the gateway id
    // alone selects the gateway; the account id only builds a bring-your-own
    // provider's `baseURL` (`resolveAiGateway`). Its native `gateway` option has
    // no authorization field, so a configured token is warned about, not sent.
    const gatewayId = readEnv(env, AI_GATEWAY_ID_ENV);

    if (gatewayId === undefined) {
        return undefined;
    }

    warnIgnoredBindingToken(env);

    return metadataFields === undefined ? { id: gatewayId } : { id: gatewayId, metadata: metadataFields };
};

/**
 * Create the `ctx.ai` helper over a Workers `AI` binding.
 *
 * Workers AI is the zero-config default, but `@lunora/ai` is provider-agnostic:
 * every helper takes either a model id string (resolved against the Workers AI
 * provider) or any AI SDK {@link LanguageModel}/{@link EmbeddingModel} object
 * (`@ai-sdk/openai`, `@ai-sdk/anthropic`, OpenRouter, …), so apps are never
 * locked to Workers AI. Pair `embed` with `@lunora/bindings/vectors` for RAG.
 *
 * Without a binding, a string id resolves only as a `"<provider>/<model>"` slug
 * through {@link AI_PROXY_URL_ENV}; everything else that needs the binding
 * throws a directed error when called, never at construction — so the
 * generated `ctx.ai` is always this facade.
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
    const { binding, defaultEmbeddingModel, defaultModel, env, gateway, metadata, provider, telemetry } = options;

    const proxy = resolveProxy(env);

    // A caller-supplied provider wins; otherwise construct one from the binding,
    // and with neither every Workers AI call throws a directed error. An explicit
    // `gateway` wins; else an env-configured AI Gateway routes Workers AI through
    // it (opt-in), so token + dollar-cost telemetry is computed by the gateway.
    // Resolved once so the raw `ai.run()` path below routes through the same gateway.
    const effectiveMetadata = withEnvironmentTags(env, metadata);
    const resolvedGateway = resolveGatewayOption(gateway, env, effectiveMetadata);
    // Catalog slugs carry the correlation fields per call, so a slug routed to the
    // account's `default` gateway (no `LUNORA_AI_GATEWAY_ID`) is still attributed
    // to its function and trace in the AI Gateway logs. Not on top of an explicit
    // gateway's own `metadata`: the provider merges the two, which could push the
    // object past AI Gateway's key limit and get it rejected whole.
    const gatewayMetadataFields = gateway?.metadata === undefined ? buildAiGatewayMetadataFields(effectiveMetadata) : undefined;

    // The model defaults come from `env` when the caller did not pass them, for
    // the same reason the gateway does: the generated shard builds this facade as
    // `createAi({ binding, env, metadata })` with those three fields fixed, so
    // `env` is the ONLY seam an app can reach. Without this, `defaultModel` /
    // `defaultEmbeddingModel` were unsettable by any Lunora app and the no-argument
    // `ctx.ai.model()` / `ctx.ai.embeddingModel()` always threw — including through
    // `defineRag`, whose `embeddingModel` is documented as optional. An explicit
    // option still wins.
    const effectiveDefaultModel = defaultModel ?? readEnv(env, AI_DEFAULT_MODEL_ENV);
    const effectiveDefaultEmbeddingModel = defaultEmbeddingModel ?? readEnv(env, AI_DEFAULT_EMBEDDING_MODEL_ENV);
    // `providers` routes `"<provider>/<model>"` slugs through AI Gateway over the
    // same binding (Unified Billing for unified-catalog providers, a key stored on
    // the gateway for gateway-path-only ones), defaulting to
    // the account's `default` gateway when none is configured. `@cf/…` ids are
    // unaffected.
    const workersai: WorkersAiProviderLike =
        provider ?? (binding ? createWorkersAI({ binding, gateway: resolvedGateway, providers: GATEWAY_PROVIDER_PLUGINS }) : workersAiUnavailable);

    const resolveModelId = (modelId: string, modelOptions: AiModelOptions | undefined): LanguageModel => {
        if (!isGatewayModelId(modelId)) {
            // Unlisted provider settings are forwarded to `binding.run`'s options.
            return modelOptions?.rejectIfBusy === undefined ? workersai(modelId) : workersai(modelId, { rejectIfBusy: modelOptions.rejectIfBusy });
        }

        if (proxy !== undefined) {
            return proxy.chat(modelId);
        }

        return gatewayMetadataFields === undefined ? workersai(modelId) : workersai(modelId, { metadata: gatewayMetadataFields });
    };

    const model = (input?: ModelInput, modelOptions?: AiModelOptions): LanguageModel => {
        const requestedId = input ?? effectiveDefaultModel;

        if (requestedId === undefined || requestedId === "") {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/ai: no model supplied and no default configured — pass a model id, or set ${AI_DEFAULT_MODEL_ENV} in the Worker env (wrangler \`vars\` / \`.dev.vars\`)`,
            );
        }

        // A string is a model id (Workers AI, or a gateway slug); anything else is
        // an already-built AI SDK model from some provider — passed straight through.
        if (typeof requestedId === "string") {
            return instrumentModel(resolveModelId(requestedId, modelOptions), telemetry, requestedId);
        }

        return instrumentModel(requestedId, telemetry);
    };

    const resolveEmbeddingModel = (modelId: string): EmbeddingModel => {
        if (proxy !== undefined && isGatewayModelId(modelId)) {
            return proxy.embedding(modelId);
        }

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

        const modelId = input ?? effectiveDefaultEmbeddingModel;

        if (!modelId) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/ai: no embedding model supplied and no default configured — pass an embedding model id or an AI SDK EmbeddingModel, or set ${AI_DEFAULT_EMBEDDING_MODEL_ENV} in the Worker env (wrangler \`vars\` / \`.dev.vars\`)`,
            );
        }

        return resolveEmbeddingModel(modelId);
    };

    const run = async (modelId: string, inputs: Record<string, unknown>, runOptions?: AiRunOptions): Promise<unknown> => {
        if (!binding) {
            return bindingRequired("ai.run");
        }

        // Route raw `ai.run()` binding calls through the same resolved AI Gateway
        // (for token + dollar-cost telemetry) unless the caller set `gateway` — so
        // gateway routing isn't limited to the AI-SDK model path.
        const mergedOptions = resolvedGateway !== undefined && runOptions?.gateway === undefined ? { ...runOptions, gateway: resolvedGateway } : runOptions;

        try {
            return await binding.run(modelId, inputs, mergedOptions);
        } catch (error) {
            if (isCapacityExceeded(error)) {
                throw new LunoraError("RATE_LIMITED", `@lunora/ai: Workers AI has no free capacity for ${modelId} (error 3040) — retry later`, {
                    cause: error,
                });
            }

            throw error;
        }
    };

    const websearch = async (query: string, searchOptions?: AiWebSearchOptions): Promise<AiWebSearchResult> => {
        if (!binding) {
            return bindingRequired("ai.websearch");
        }

        if (typeof binding.websearch !== "function") {
            throw new LunoraError(
                "NOT_IMPLEMENTED",
                "@lunora/ai: this Workers runtime's `AI` binding has no websearch() — update wrangler / @cloudflare/vite-plugin to a release that ships the Web Search API",
            );
        }

        // The search is brokered and billed by an AI Gateway, which the binding
        // requires by id. The gateway inference already routes through is the
        // natural default, then the account's `default` gateway — the same one an
        // unconfigured catalog slug lands on.
        const response = await binding.websearch({
            ...(searchOptions?.byokAlias === undefined ? {} : { byokAlias: searchOptions.byokAlias }),
            gatewayId: searchOptions?.gatewayId ?? resolvedGateway?.id ?? DEFAULT_GATEWAY_ID,
            ...(searchOptions?.limit === undefined ? {} : { limit: searchOptions.limit }),
            ...(searchOptions?.provider === undefined ? {} : { provider: searchOptions.provider }),
            query,
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => "");

            throw new LunoraError(
                websearchErrorCode(response.status),
                `@lunora/ai: web search failed with HTTP ${String(response.status)}${detail === "" ? "" : `: ${detail}`}`,
            );
        }

        const body = (await response.json()) as Partial<AiWebSearchResult> | null;

        // Fail loudly on a shape change during the beta rather than hand the
        // caller a result whose `items` is not there.
        if (!Array.isArray(body?.items)) {
            throw new LunoraError("INTERNAL", "@lunora/ai: web search returned a body without an `items` array");
        }

        return body as AiWebSearchResult;
    };

    return { embeddingModel, model, run, websearch, workersai };
};

export default createAi;
