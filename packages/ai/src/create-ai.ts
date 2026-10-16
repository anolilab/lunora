import { LunoraError } from "@lunora/errors";
import type { EmbeddingModel, ImageModel, LanguageModel } from "ai";
import type { createWorkersAI } from "workers-ai-provider";

import { fromBase64, toBase64 } from "../../../shared/base64";
import { isPrivateHost } from "../../../shared/ssrf-host";
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
    resolveAiGateway,
    warnIgnoredBindingToken,
} from "./gateway";
import instrumentModel from "./telemetry";
import type {
    AiGatewayOptions,
    AiImage,
    AiImageGenerateInput,
    AiImageGenerateResult,
    AiMarkdownDocument,
    AiModelOptions,
    AiRunOptions,
    AiToMarkdownInput,
    AiToMarkdownOptions,
    AiToMarkdownResult,
    AiWebSearchOptions,
    AiWebSearchResult,
    EmbeddingModelInput,
    LunoraAi,
    LunoraAiOptions,
    ModelInput,
    WorkersAiProviderLike,
} from "./types";
import { recordImageUsage } from "./usage";

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: "v4" }>;
type EmbeddingModelV4 = Extract<EmbeddingModel, { specificationVersion: "v4" }>;

/**
 * Wire-format plugins for AI Gateway catalog models, plus `createOpenAI` for the
 * proxy path. `openai` parses every OpenAI-compatible provider (OpenAI, Google and
 * xAI on the run path, Groq, DeepSeek, Mistral, …) and dynamic routes; `anthropic`
 * is needed because the gateway passes Anthropic through in its native format.
 *
 * They pull ~590 KB of provider code and ~40 zod schemas, so they load on the first
 * gateway/proxy model rather than at module load: a Worker that only runs `@cf/…`
 * models never evaluates them.
 */
let gatewayProviders: Promise<{ createOpenAI: typeof import("@ai-sdk/openai").createOpenAI; plugins: unknown[] }> | undefined;

const loadGatewayProviders = (): NonNullable<typeof gatewayProviders> => {
    gatewayProviders ??= Promise.all([import("@ai-sdk/openai"), import("workers-ai-provider/openai"), import("workers-ai-provider/anthropic")]).then(
        ([sdk, { openai }, { anthropic }]) => {
            return { createOpenAI: sdk.createOpenAI, plugins: [openai, anthropic] };
        },
        (error: unknown) => {
            // A failed import (a flaky chunk fetch) must not poison the isolate.
            gatewayProviders = undefined;

            throw error;
        },
    );

    return gatewayProviders;
};

/**
 * A model that is not built yet: `model()` is synchronous but the provider that
 * builds it is still importing, so each call awaits `resolve()` and delegates.
 */
const lazyLanguageModel = (modelId: string, provider: string, resolve: () => Promise<LanguageModelV4>): LanguageModelV4 => {
    return {
        doGenerate: async (options) => resolve().then((model) => model.doGenerate(options)),
        doStream: async (options) => resolve().then((model) => model.doStream(options)),
        modelId,
        provider,
        specificationVersion: "v4",
        get supportedUrls() {
            return resolve().then((model) => model.supportedUrls);
        },
    };
};

/** What a Workers AI embedding model reports, so `embedMany` can chunk without loading the provider. */
const WORKERS_AI_EMBEDDING_LIMITS = { maxEmbeddingsPerCall: 3000, supportsParallelCalls: true };

const lazyEmbeddingModel = (
    modelId: string,
    provider: string,
    resolve: () => Promise<EmbeddingModelV4>,
    limits?: typeof WORKERS_AI_EMBEDDING_LIMITS,
): EmbeddingModelV4 => {
    return {
        doEmbed: async (options) => resolve().then((model) => model.doEmbed(options)),
        get maxEmbeddingsPerCall() {
            return limits?.maxEmbeddingsPerCall ?? resolve().then((model) => model.maxEmbeddingsPerCall);
        },
        modelId,
        provider,
        specificationVersion: "v4",
        get supportsParallelCalls() {
            return limits?.supportsParallelCalls ?? resolve().then((model) => model.supportsParallelCalls);
        },
    };
};

/**
 * `workers-ai-provider` imports the whole `ai` root (~1.7 MB), so it loads on the first
 * Workers AI model call rather than with this module: `@lunora/ai/create` stays a leaf.
 */
let workersAiModule: Promise<{ createWorkersAI: typeof createWorkersAI }> | undefined;

const loadWorkersAi = (): NonNullable<typeof workersAiModule> => {
    workersAiModule ??= import("workers-ai-provider").catch((error: unknown) => {
        workersAiModule = undefined;

        throw error;
    });

    return workersAiModule;
};

/**
 * A `"<provider>/<model>"` catalog slug or a `dynamic/<route>` — anything slashed
 * that is not a Workers AI id (`@cf/…`, `@hf/…`). Mirrors `workers-ai-provider`'s
 * own routing test, which is what actually sends these through AI Gateway.
 */
const isGatewayModelId = (modelId: string): boolean => !modelId.startsWith("@") && modelId.includes("/");

/**
 * The binding-backed provider as synchronous V4 delegates. `modelId`, `provider` and the
 * Workers AI embedding limits match what `createWorkersAI(…)` reports, so nothing needs the
 * import until a model is actually called. `resolve` picks the instance per model id:
 * gateway slugs need the one carrying the wire-format plugins.
 */
const lazyWorkersAi = (resolve: (modelId: string) => Promise<WorkersAiProviderLike>): WorkersAiProviderLike => {
    const provider = (modelId: string, settings?: Record<string, unknown>): LanguageModel =>
        lazyLanguageModel(modelId, "workersai.chat", async () => resolve(modelId).then((real) => real(modelId, settings) as LanguageModelV4));

    // Gateway slugs keep promise-valued limits resolved from the real model.
    provider.textEmbeddingModel = (modelId: string): EmbeddingModel =>
        lazyEmbeddingModel(
            modelId,
            "workersai.embedding",
            async () => resolve(modelId).then((real) => real.textEmbeddingModel?.(modelId) as EmbeddingModelV4),
            isGatewayModelId(modelId) ? undefined : WORKERS_AI_EMBEDDING_LIMITS,
        );

    return provider;
};

/** The one error for every call that needs the Workers `AI` binding and has none. */
const bindingRequired = (subject: string): never => {
    throw new LunoraError(
        "INTERNAL",
        `@lunora/ai: ${subject} needs the \`AI\` binding (env.AI). In dev, Lunora leaves it out when there is no Cloudflare login: run \`wrangler login\` or set CLOUDFLARE_API_TOKEN. Elsewhere, add an \`ai\` binding to wrangler.jsonc. Or set ${AI_PROXY_URL_ENV} to an OpenAI-compatible proxy for "<provider>/<model>" slugs.`,
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

/**
 * 401 / 403 / 404 are the deployment's configuration (credentials, gateway),
 * so they keep their own codes and reach the developer; any other 4xx is the
 * request itself. 408 (a timeout), 429 and 5xx are retryable.
 */
const WEBSEARCH_STATUS_CODES: ReadonlyMap<number, "FORBIDDEN" | "NOT_FOUND" | "RATE_LIMITED" | "SERVICE_UNAVAILABLE" | "UNAUTHORIZED"> = new Map([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [408, "SERVICE_UNAVAILABLE"],
    [429, "RATE_LIMITED"],
]);

const upstreamErrorCode = (status: number): string =>
    WEBSEARCH_STATUS_CODES.get(status) ?? (status >= 400 && status < 500 ? "BAD_REQUEST" : "SERVICE_UNAVAILABLE");

/** Upstream error bodies can be whole HTML pages; a `LunoraError` message reaches the client unredacted. */
const UPSTREAM_DETAIL_MAX_LENGTH = 300;

/** A proxy host a bearer token may reach over plain HTTP: this machine only. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

interface ProxyProvider {
    chat: (modelId: string) => LanguageModel;
    embedding: (modelId: string) => EmbeddingModel;
    image: (modelId: string) => Promise<ImageModel>;
}

/**
 * Why the proxy config would leak its token, or `undefined` when it is safe to
 * use. Shared by every proxy call (chat, embedding, image) so none can skip it.
 */
const proxyRefusal = (proxyURL: string, token: string | undefined): string | undefined => {
    const url = URL.canParse(proxyURL) ? new URL(proxyURL) : undefined;

    if (url === undefined) {
        return `${AI_PROXY_URL_ENV} is not a valid URL`;
    }

    if (token !== undefined && url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
        return `${AI_PROXY_URL_ENV} (${url.origin}) is not HTTPS, so ${AI_PROXY_TOKEN_ENV} would travel in cleartext — use an https:// URL`;
    }

    return undefined;
};

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
    const refusal = proxyRefusal(proxyURL, token);

    if (refusal !== undefined) {
        const refuse = (): never => {
            throw new LunoraError("INTERNAL", `@lunora/ai: ${refusal}`);
        };

        return { chat: refuse, embedding: refuse, image: refuse };
    }

    // The OpenAI-compatible provider the proxy builds; each model kind is taken off it below.
    type OpenAIProvider = ReturnType<typeof import("@ai-sdk/openai").createOpenAI>;
    let proxy: Promise<OpenAIProvider> | undefined;

    const load = (): Promise<OpenAIProvider> => {
        proxy ??= loadGatewayProviders().then(
            ({ createOpenAI }) => createOpenAI({ apiKey: token ?? "", baseURL: proxyURL, name: "lunora-proxy" }),
            (error: unknown) => {
                proxy = undefined;

                throw error;
            },
        );

        return proxy;
    };

    return {
        chat: (modelId) => lazyLanguageModel(modelId, "lunora-proxy", async () => load().then((openai) => openai.chat(modelId))),
        embedding: (modelId) => lazyEmbeddingModel(modelId, "lunora-proxy", async () => load().then((openai) => openai.embedding(modelId))),
        image: async (modelId) => load().then((openai) => openai.image(modelId) as ImageModel),
    };
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
 * The AI SDK provider factories the image path needs, loaded on the first
 * `images.generate` for an `"openai/…"` or `"google/…"` slug. Same lazy,
 * self-clearing memo as {@link loadGatewayProviders}: a Worker that never
 * generates images never evaluates them.
 */
let imageProviders:
    Promise<{ createGoogle: typeof import("@ai-sdk/google").createGoogle; createOpenAI: typeof import("@ai-sdk/openai").createOpenAI }> | undefined;

const loadImageProviders = (): NonNullable<typeof imageProviders> => {
    imageProviders ??= Promise.all([import("@ai-sdk/openai"), import("@ai-sdk/google")]).then(
        ([openai, google]) => {
            return { createGoogle: google.createGoogle, createOpenAI: openai.createOpenAI };
        },
        (error: unknown) => {
            // A failed import (a flaky chunk fetch) must not poison the isolate.
            imageProviders = undefined;

            throw error;
        },
    );

    return imageProviders;
};

/** Most images one `images.generate` call may produce; each is a separate billed call. */
const AI_IMAGE_MAX_COUNT = 8;

/** A size as `"<width>x<height>"` with positive integers; the type alone does not stop a runtime string. */
const IMAGE_SIZE = /^[1-9]\d*x[1-9]\d*$/u;

/** Byte cap for a `URL`/raw document handed to `ai.toMarkdown`, so an accidental huge download cannot reach the binding. */
const AI_MARKDOWN_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The provider SDKs refuse to build without an API key, so the gateway path passes
 * this placeholder. {@link withoutProviderAuth} strips it before the request leaves,
 * so the gateway's stored key or Unified Billing authenticates, not a fake key.
 */
const GATEWAY_KEY_PLACEHOLDER = "unused";

const withoutProviderAuth = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);

    headers.delete("authorization");
    headers.delete("x-goog-api-key");

    return fetch(input, { ...init, headers });
};

/** The URL's last path segment, or `"document"` — the name the binding echoes back on its result. */
const documentNameFromUrl = (url: URL): string => {
    const last = url.pathname.split("/").findLast((segment) => segment.length > 0);

    return last === undefined || last === "" ? "document" : last;
};

/** Reject a document larger than `maxBytes` before it is handed to the binding. */
const assertMarkdownSize = (size: number, maxBytes: number): void => {
    if (size > maxBytes) {
        throw new LunoraError(
            "PAYLOAD_TOO_LARGE",
            `@lunora/ai: toMarkdown document is ${String(size)} bytes, over the ${String(maxBytes)}-byte limit — raise \`maxBytes\` to convert it`,
        );
    }
};

/**
 * Read a response body, failing as soon as it passes `maxBytes`, so a missing or
 * wrong Content-Length cannot let an oversized body reach memory.
 */
const readCappedBytes = async (response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> => {
    if (response.body === null) {
        return new Uint8Array();
    }

    let received = 0;
    const capped = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                received += chunk.byteLength;

                if (received > maxBytes) {
                    controller.error(
                        new LunoraError(
                            "PAYLOAD_TOO_LARGE",
                            `@lunora/ai: toMarkdown document is over the ${String(maxBytes)}-byte limit — raise \`maxBytes\` to convert it`,
                        ),
                    );

                    return;
                }

                controller.enqueue(chunk);
            },
        }),
    );

    return new Uint8Array(await new Response(capped).arrayBuffer());
};

/**
 * Refuse a URL the Worker should not fetch: a non-web scheme, or a host that names
 * this machine or a private network. A plain string check, not a DNS lookup, so a
 * public name that resolves to a private address is not caught here; pass the bytes
 * or a Blob for a private source.
 */
const assertFetchableUrl = (url: URL): void => {
    if ((url.protocol !== "https:" && url.protocol !== "http:") || isPrivateHost(url.hostname)) {
        throw new LunoraError("BAD_REQUEST", `@lunora/ai: toMarkdown will not fetch ${url.href} — only public http(s) hosts; pass its bytes or a Blob instead`);
    }
};

/** The raw-bytes arm of {@link resolveMarkdownDocument}: an `ArrayBuffer` or `Uint8Array` only. */
const bytesDocument = (input: AiToMarkdownInput, options: AiToMarkdownOptions | undefined, maxBytes: number): AiMarkdownDocument => {
    // Anything else is untyped at runtime: `new Uint8Array("abc")` or `new Uint8Array(null)`
    // would silently become an empty document, so refuse it instead.
    if (!(input instanceof ArrayBuffer) && !(input instanceof Uint8Array)) {
        throw new LunoraError("BAD_REQUEST", "@lunora/ai: toMarkdown input must be a URL, Blob, ArrayBuffer or Uint8Array");
    }

    const view = input instanceof Uint8Array ? input : new Uint8Array(input);

    // Check the size before copying, so an oversized view is never duplicated.
    assertMarkdownSize(view.byteLength, maxBytes);

    // The copy is a fresh ArrayBuffer-backed view: `Blob` accepts `Uint8Array<ArrayBuffer>`,
    // not a `SharedArrayBuffer`-backed view a caller may hold.
    const bytes = new Uint8Array(view);
    const mimeType = options?.mimeType;

    return { blob: new Blob([bytes], mimeType === undefined ? undefined : { type: mimeType }), name: options?.name ?? "document" };
};

/** Normalise any accepted input to the binding's `{ name, blob }` document. */
const resolveMarkdownDocument = async (input: AiToMarkdownInput, options: AiToMarkdownOptions | undefined, maxBytes: number): Promise<AiMarkdownDocument> => {
    if (input instanceof URL) {
        assertFetchableUrl(input);

        // Redirects are not followed: a 3xx would otherwise reach a host that was
        // never checked. The caller passes the final URL instead.
        const response = await fetch(input, { redirect: "manual" });

        if (!response.ok) {
            const redirect = response.status >= 300 && response.status < 400 ? "; redirects are not followed, so pass the final URL" : "";

            throw new LunoraError("BAD_REQUEST", `@lunora/ai: toMarkdown could not fetch ${input.href} (HTTP ${String(response.status)})${redirect}`);
        }

        // Refuse on the declared length before reading; a missing or non-numeric one
        // is caught by the streaming cap below.
        const declared = Number(response.headers.get("content-length"));

        if (response.headers.has("content-length") && Number.isFinite(declared)) {
            assertMarkdownSize(declared, maxBytes);
        }

        const bytes = await readCappedBytes(response, maxBytes);
        const contentType = response.headers.get("content-type");

        return {
            blob: new Blob([bytes], contentType === null || contentType === "" ? undefined : { type: contentType }),
            name: options?.name ?? documentNameFromUrl(input),
        };
    }

    if (input instanceof Blob) {
        assertMarkdownSize(input.size, maxBytes);

        return { blob: input, name: options?.name ?? "document" };
    }

    return bytesDocument(input, options, maxBytes);
};

const toInteger = (value: string | undefined): number | undefined => {
    if (value === undefined || value === "") {
        return undefined;
    }

    const parsed = Number(value);

    return Number.isInteger(parsed) ? parsed : undefined;
};

/** `"1024x1024"` → `{ width, height }`, matching the Workers AI image inputs. The size is validated before this runs. */
const parseImageSize = (size: string | undefined): { height?: number; width?: number } => {
    if (size === undefined) {
        return {};
    }

    const [width, height] = size.split("x");

    return { height: toInteger(height), width: toInteger(width) };
};

/** The format a leading-bytes signature names, or `undefined` when none matches. */
const sniffImageMimeType = (bytes: Uint8Array): string | undefined => {
    const startsWith = (signature: ReadonlyArray<number>, offset = 0): boolean => signature.every((byte, index) => bytes[offset + index] === byte);

    if (startsWith([0x89, 0x50, 0x4e, 0x47])) {
        return "image/png";
    }

    if (startsWith([0xff, 0xd8, 0xff])) {
        return "image/jpeg";
    }

    if (startsWith([0x47, 0x49, 0x46, 0x38])) {
        return "image/gif";
    }

    return startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8) ? "image/webp" : undefined;
};

/** The first 12 bytes of a base64 string: enough for every signature above, without decoding the image. */
const base64Prefix = (base64: string): Uint8Array => {
    try {
        return fromBase64(base64.slice(0, 16));
    } catch {
        return new Uint8Array();
    }
};

const withMimeType = (base64: string, mimeType: string | undefined): AiImage => (mimeType === undefined ? { base64 } : { base64, mimeType });

/**
 * Normalise the shapes a Workers AI image model returns from `binding.run`:
 * base64 in `{ image }`, raw bytes, a `Response`, or a `ReadableStream`. Returns
 * `undefined` for a shape that carries no image, so the caller throws a directed
 * error rather than handing back `{ base64: undefined }`. The MIME type is sniffed
 * from the bytes, since the binding does not say which format a model returned;
 * it is left unset when the bytes match no known format.
 */
const toAiImage = async (output: unknown): Promise<AiImage | undefined> => {
    if (typeof output === "string") {
        return withMimeType(output, sniffImageMimeType(base64Prefix(output)));
    }

    if (output instanceof Uint8Array) {
        return withMimeType(toBase64(output), sniffImageMimeType(output));
    }

    if (output instanceof ArrayBuffer) {
        const bytes = new Uint8Array(output);

        return withMimeType(toBase64(bytes), sniffImageMimeType(bytes));
    }

    if (output instanceof Response) {
        if (!output.ok) {
            const text = await output.text().catch(() => "");
            const detail = text.slice(0, UPSTREAM_DETAIL_MAX_LENGTH);

            throw new LunoraError(
                upstreamErrorCode(output.status),
                `@lunora/ai: image generation failed with HTTP ${String(output.status)}${detail === "" ? "" : `: ${detail}`}`,
            );
        }

        const bytes = new Uint8Array(await output.arrayBuffer());

        return withMimeType(toBase64(bytes), sniffImageMimeType(bytes));
    }

    if (output instanceof ReadableStream) {
        const bytes = new Uint8Array(await new Response(output).arrayBuffer());

        return withMimeType(toBase64(bytes), sniffImageMimeType(bytes));
    }

    if (typeof output === "object" && output !== null && "image" in output) {
        return toAiImage(output.image);
    }

    return undefined;
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
    // A failed import must not poison the facade: each memo clears itself on rejection.
    let bindingWorkersAi: Promise<WorkersAiProviderLike> | undefined;

    const loadBindingWorkersAi = (): Promise<WorkersAiProviderLike> => {
        bindingWorkersAi ??= loadWorkersAi()
            .then(({ createWorkersAI: create }) => create({ binding, gateway: resolvedGateway }) as WorkersAiProviderLike)
            .catch((error: unknown) => {
                bindingWorkersAi = undefined;

                throw error;
            });

        return bindingWorkersAi;
    };

    // Gateway slugs need the wire-format plugins, so they go through a second
    // instance built once the plugins have loaded; `@cf/…` ids never wait on it.
    let gatewayWorkersAi: Promise<WorkersAiProviderLike> | undefined;

    const loadGatewayWorkersAi = (): Promise<WorkersAiProviderLike> => {
        gatewayWorkersAi ??= Promise.all([loadWorkersAi(), loadGatewayProviders()])
            .then(
                ([{ createWorkersAI: create }, { plugins }]) =>
                    create({ binding, gateway: resolvedGateway, providers: plugins as never }) as WorkersAiProviderLike,
            )
            .catch((error: unknown) => {
                gatewayWorkersAi = undefined;

                throw error;
            });

        return gatewayWorkersAi;
    };

    const workersai: WorkersAiProviderLike =
        provider ??
        (binding ? lazyWorkersAi(async (modelId) => (isGatewayModelId(modelId) ? loadGatewayWorkersAi() : loadBindingWorkersAi())) : workersAiUnavailable);

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
        const { gatewayId, ...request } = searchOptions ?? {};
        const response = await binding.websearch({ ...request, gatewayId: gatewayId ?? resolvedGateway?.id ?? DEFAULT_GATEWAY_ID, query });

        if (!response.ok) {
            const text = await response.text().catch(() => "");
            const detail = text.slice(0, UPSTREAM_DETAIL_MAX_LENGTH);

            throw new LunoraError(
                upstreamErrorCode(response.status),
                `@lunora/ai: web search failed with HTTP ${String(response.status)}${detail === "" ? "" : `: ${detail}`}`,
            );
        }

        const body = (await response.json().catch(() => undefined)) as Partial<AiWebSearchResult> | null | undefined;

        // Fail loudly on a shape change during the beta rather than hand the
        // caller a result whose `items` is not there.
        if (!Array.isArray(body?.items)) {
            throw new LunoraError("INTERNAL", "@lunora/ai: web search returned a body that is not JSON with an `items` array");
        }

        return body as AiWebSearchResult;
    };

    const toMarkdown = async (input: AiToMarkdownInput, markdownOptions?: AiToMarkdownOptions): Promise<AiToMarkdownResult> => {
        if (!binding) {
            return bindingRequired("ai.toMarkdown");
        }

        if (typeof binding.toMarkdown !== "function") {
            throw new LunoraError(
                "NOT_IMPLEMENTED",
                "@lunora/ai: this Workers runtime's `AI` binding has no toMarkdown() — update wrangler / @cloudflare/vite-plugin to a release that ships the Markdown Conversion API",
            );
        }

        // NaN or a negative cap makes every size comparison false, so it would admit any document.
        const maxBytes = markdownOptions?.maxBytes ?? AI_MARKDOWN_MAX_BYTES;

        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
            throw new LunoraError("BAD_REQUEST", "@lunora/ai: toMarkdown maxBytes must be a positive number of bytes");
        }

        const { blob, name } = await resolveMarkdownDocument(input, markdownOptions, maxBytes);
        const result = await binding.toMarkdown({ blob, name }, markdownOptions?.conversionOptions);
        // The binding returns a single result for a single document, but accepts
        // (and returns) an array, so unwrap either shape.
        const conversion = Array.isArray(result) ? result[0] : result;

        if (conversion === undefined) {
            throw new LunoraError("INTERNAL", "@lunora/ai: toMarkdown returned no conversion result");
        }

        if (conversion.format === "error") {
            throw new LunoraError("BAD_REQUEST", `@lunora/ai: toMarkdown could not convert "${name}": ${conversion.error ?? "unknown error"}`);
        }

        if (typeof conversion.data !== "string") {
            throw new LunoraError("INTERNAL", `@lunora/ai: toMarkdown returned a "${conversion.format}" result with no data`);
        }

        return {
            markdown: conversion.data,
            ...(conversion.mimetype === undefined ? {} : { mimeType: conversion.mimetype }),
            ...(conversion.pages === undefined ? {} : { pages: conversion.pages }),
            ...(conversion.tokens === undefined ? {} : { tokens: conversion.tokens }),
        };
    };

    const generateWorkersAiImage = async (input: AiImageGenerateInput): Promise<AiImageGenerateResult> => {
        if (!binding) {
            return bindingRequired("ai.images.generate");
        }

        const { height, width } = parseImageSize(input.size);
        const payloadFor = (index: number): Record<string, unknown> => {
            return {
                prompt: input.prompt,
                ...(height === undefined ? {} : { height }),
                ...(width === undefined ? {} : { width }),
                // One seed for every image would return identical, separately billed images:
                // offset it per image, so a seeded batch is reproducible and still distinct.
                ...(input.seed === undefined ? {} : { seed: input.seed + index }),
            };
        };

        // Workers AI image models generate one image per call, so a `count` over
        // one is a sequence rather than a binding option. Sequential on purpose:
        // each image is a separate billed call, and firing them in parallel invites
        // the 3040 capacity rejection. Recursion keeps each await out of a loop.
        const generateFrom = async (index: number, images: AiImage[]): Promise<AiImage[]> => {
            if (index >= (input.count ?? 1)) {
                return images;
            }

            const image = await toAiImage(await run(input.model, payloadFor(index)));

            if (image === undefined || image.base64 === "") {
                throw new LunoraError("INTERNAL", `@lunora/ai: ${input.model} returned no image data`);
            }

            // Counted per image as it is billed, so a later failure in the batch
            // still leaves the images already generated on the usage metric.
            recordImageUsage(input.model, 1, telemetry?.metrics);

            return generateFrom(index + 1, [...images, image]);
        };

        return { images: await generateFrom(0, []), model: input.model };
    };

    const generateProviderImage = async (imageProvider: "google" | "openai", modelId: string, input: AiImageGenerateInput): Promise<AiImageGenerateResult> => {
        const { createGoogle, createOpenAI } = await loadImageProviders();
        // The gateway `createAi` resolved, so an explicit `gateway` option routes images
        // too, not just the env-configured one.
        const imageGateway = resolvedGateway === undefined ? undefined : resolveAiGateway({ ...env, [AI_GATEWAY_ID_ENV]: resolvedGateway.id });
        let imageModel;

        if (imageProvider === "openai") {
            // An OpenAI-compatible proxy (`LUNORA_AI_PROXY_URL`) wins, then the AI
            // Gateway; with neither, the provider's own env key (if any) applies.
            // The proxy takes the full slug, as chat does, and its HTTPS-for-token
            // rule is already applied by `proxy`.
            if (proxy !== undefined) {
                imageModel = await proxy.image(input.model);
            } else if (imageGateway === undefined) {
                imageModel = createOpenAI().image(modelId);
            } else {
                // The SDK appends `/images/generations` to this base, and the gateway
                // routes `<gateway>/openai/<path>` to OpenAI's `<path>`.
                imageModel = createOpenAI({
                    apiKey: GATEWAY_KEY_PLACEHOLDER,
                    baseURL: `${imageGateway.baseURL}/openai`,
                    fetch: withoutProviderAuth,
                    headers: imageGateway.headers,
                }).image(modelId);
            }
        } else if (imageGateway === undefined) {
            imageModel = createGoogle().image(modelId);
        } else {
            // Google's SDK base is `…/v1beta`; the gateway's Google AI Studio route
            // mirrors that path, so the version segment must be part of the base.
            imageModel = createGoogle({
                apiKey: GATEWAY_KEY_PLACEHOLDER,
                baseURL: `${imageGateway.baseURL}/google-ai-studio/v1beta`,
                fetch: withoutProviderAuth,
                headers: imageGateway.headers,
            }).image(modelId);
        }

        const { generateImage } = await import("ai");
        const result = await generateImage({
            model: imageModel,
            prompt: input.prompt,
            ...(input.count === undefined ? {} : { n: input.count }),
            ...(input.seed === undefined ? {} : { seed: input.seed }),
            ...(input.size === undefined ? {} : { size: input.size }),
        });

        const images = result.images.map((image) => {
            return { base64: image.base64, mimeType: image.mediaType };
        });

        recordImageUsage(input.model, images.length, telemetry?.metrics);

        return { images, model: input.model };
    };

    const generateForModel = async (requestedModel: string, input: AiImageGenerateInput): Promise<AiImageGenerateResult> => {
        if (requestedModel.startsWith("@")) {
            return generateWorkersAiImage(input);
        }

        const slash = requestedModel.indexOf("/");
        const providerPrefix = slash === -1 ? "" : requestedModel.slice(0, slash);
        const modelId = slash === -1 ? "" : requestedModel.slice(slash + 1);

        if ((providerPrefix === "openai" || providerPrefix === "google") && modelId.length > 0) {
            return generateProviderImage(providerPrefix, modelId, input);
        }

        throw new LunoraError(
            "AI_UNKNOWN_IMAGE_MODEL",
            `@lunora/ai: no image provider for "${requestedModel}" — pass a Workers AI image id (@cf/…), or an "openai/<model>" or "google/<model>" slug`,
        );
    };

    const generateImageForModel = async (input: AiImageGenerateInput): Promise<AiImageGenerateResult> => {
        const requestedModel = input.model;
        const count = input.count ?? 1;

        // Every image is a separate billed call, so an unbounded `count` is a cost
        // amplifier; bound it once here for both the Workers AI and provider paths.
        if (!Number.isInteger(count) || count < 1 || count > AI_IMAGE_MAX_COUNT) {
            throw new LunoraError("BAD_REQUEST", `@lunora/ai: count must be an integer from 1 to ${String(AI_IMAGE_MAX_COUNT)}`, { status: 400 });
        }

        // The size is forwarded to both paths, so one check here covers each.
        if (input.size !== undefined && !IMAGE_SIZE.test(input.size)) {
            throw new LunoraError("BAD_REQUEST", `@lunora/ai: size must be "<width>x<height>" with positive integers, e.g. "1024x1024" (got "${input.size}")`);
        }

        // A `@cf/…` (or `@hf/…`) id is a Workers AI model; everything else is a
        // `"<provider>/<model>"` slug, of which only openai and google have an
        // image endpoint wired here.
        return generateForModel(requestedModel, input);
    };

    return { embeddingModel, images: { generate: generateImageForModel }, model, run, toMarkdown, websearch, workersai };
};

export default createAi;
