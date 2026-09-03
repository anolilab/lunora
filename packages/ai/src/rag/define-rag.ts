import { isLunoraError, LunoraError } from "@lunora/errors";
import type { EmbeddingModel } from "ai";
import { embed as aiEmbed, embedMany as aiEmbedMany, jsonSchema, tool } from "ai";

// Repo-root inlined helper (see shared/stable-key.ts) — the canonical
// code-point-stable, recursively-sorted encoder, used here to give a source's
// `metadata` one canonical form to hash (see `sourceIdentity`).
import { stableStringify } from "../../../../shared/stable-key";
import { estimateModelCost } from "../pricing";
import fixedWindowChunks from "./chunk";
import { concurrentMap, INDEX_CONCURRENCY } from "./concurrent";
import { contentHash } from "./helpers";
import hybridRank from "./hybrid-rank";
import type {
    IndexInput,
    IndexResult,
    Rag,
    RagConfig,
    RagContext,
    RagSource,
    RagToolOptions,
    RemoveInput,
    RetrievedChunk,
    RetrieveOptions,
    RetrieveResult,
} from "./types";
import type { RagVectorStore } from "./vector-store";
import { VECTORIZE_CAPABILITIES, vectorizeStore } from "./vector-store";

const DEFAULT_CHUNK_SIZE = 1000;

const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_TOP_K = 5;

/**
 * Default candidate-pool multiplier when fusion or reranking is active:
 * retrieve `topK * 4` per leg, reorder, keep `topK`. Reordering can only work
 * with what retrieval already found, so a pool no deeper than `topK` gives it
 * nothing to do.
 */
const CANDIDATE_POOL_FACTOR = 4;

/**
 * Vectorize's per-vector metadata ceiling, in bytes — used only for the
 * define-time `chunkSize` sanity check, which runs before any context (and so
 * any store) exists. The check that actually holds reads the bound store's own
 * `maxMetadataBytes`, and is skipped entirely when a custom `store` is
 * configured, since its budget is unknown until then.
 */
const VECTORIZE_METADATA_BYTES = VECTORIZE_CAPABILITIES.maxMetadataBytes === false ? Number.POSITIVE_INFINITY : VECTORIZE_CAPABILITIES.maxMetadataBytes;

/**
 * Room held back from {@link VECTORIZE_METADATA_BYTES} for everything in the
 * metadata object that is not chunk text: the source id, the chunk index,
 * chunk #0's hash / count / model tag, and whatever `metadata` the caller
 * attaches per source.
 *
 * A guess, and deliberately a generous one — the caller's `metadata` is not
 * known when the RAG is defined, so no exact figure exists to check against.
 * The point is only that spending the entire ceiling on text is provably wrong:
 * the bookkeeping is never zero bytes.
 */
const METADATA_OVERHEAD_RESERVE = 2 * 1024;

/** Metadata key holding each chunk's index within its source. */
const CHUNK_INDEX_KEY = "__ragChunk";
/** Metadata key holding the owning source id. */
const SOURCE_KEY = "__ragSource";
/** Metadata key holding the chunk text (metadata mode only). */
const TEXT_KEY = "__ragText";
/** Metadata key (chunk #0 only) holding the source's content hash. */
const HASH_KEY = "__ragHash";
/** Metadata key (chunk #0 only) holding the source's total chunk count. */
const COUNT_KEY = "__ragChunks";
/** Metadata key holding the source's importance weight, when one was set. */
const IMPORTANCE_KEY = "__ragImportance";
/** Metadata key (chunk #0 only) recording the embedding-model version tag, when one was set. */
const MODEL_KEY = "__ragModel";

const INTERNAL_KEYS = new Set([CHUNK_INDEX_KEY, COUNT_KEY, HASH_KEY, IMPORTANCE_KEY, MODEL_KEY, SOURCE_KEY, TEXT_KEY]);

/**
 * Refuse a metadata object over Vectorize's ceiling, naming what breached it.
 *
 * The config-time `chunkSize` check is a fast fail on the one input known when
 * the RAG is defined; this is the one that actually holds. Two things get past
 * the former by construction: `chunkSize` counts CHARACTERS while the ceiling
 * counts BYTES, so ~3.4k characters of CJK already exceed 10 KiB at a
 * `chunkSize` the config check waves through — and the caller's `metadata` is
 * not known until index time, so {@link METADATA_OVERHEAD_RESERVE} can only
 * guess at it.
 *
 * Measured on the serialized form because that is what Vectorize stores and
 * counts. Without this the upsert fails at the far side with nothing naming the
 * cause, which is the failure this whole check exists to replace.
 */
const assertMetadataFits = (metadata: Record<string, unknown>, chunkIndex: number, sourceId: string, budget: number | false): void => {
    if (budget === false) {
        return;
    }

    const bytes = new TextEncoder().encode(JSON.stringify(metadata)).length;

    if (bytes <= budget) {
        return;
    }

    const textBytes = typeof metadata[TEXT_KEY] === "string" ? new TextEncoder().encode(metadata[TEXT_KEY]).length : 0;
    const remedy =
        textBytes * 2 > bytes
            ? "lower `chunkSize` (it counts characters, not bytes — multibyte text costs up to 3 bytes each), or supply `textStore` to move chunk text out of metadata entirely"
            : "attach less per-source `metadata`";

    throw new LunoraError(
        "BAD_REQUEST",
        `@lunora/ai/rag: chunk ${String(chunkIndex)} of "${sourceId}" carries ${String(bytes)} bytes of metadata, over the store's ${String(budget)}-byte per-vector ceiling — ${remedy}`,
    );
};

/**
 * Refuse a chunk id over the store's per-id ceiling, naming what it is made of.
 *
 * The sibling of {@link assertMetadataFits}, and reachable the same way: a chunk
 * id is `${namespace}#${sourceId}#${index}`, and a caller who passes a bucket
 * key as the source id (which `defineRagSource` does by construction) has an id
 * whose length they never chose. Vectorize rejects the upsert at the far side
 * with nothing naming the cause.
 */
const assertIdFits = (id: string, sourceId: string, budget: number | false): void => {
    if (budget === false) {
        return;
    }

    const bytes = new TextEncoder().encode(id).length;

    if (bytes <= budget) {
        return;
    }

    throw new LunoraError(
        "BAD_REQUEST",
        `@lunora/ai/rag: chunk id "${id}" for source "${sourceId}" is ${String(bytes)} bytes, over the store's ${String(budget)}-byte per-vector id ceiling — ` +
            "shorten the source id (hash long keys before indexing them) or shorten the `namespace`, which is prefixed onto every chunk id",
    );
};

/** Allowed shape of {@link RagConfig.embeddingModelVersion} — safe in a Vectorize namespace + chunk-id prefix. */
const MODEL_VERSION_PATTERN = /^[\w.-]{1,40}$/;

/**
 * The namespace segment prepended to every chunk id. Vectorize ids are index-
 * global — a namespace is only a query filter, not a separate id space — so two
 * tenants that share a `sourceId` would otherwise collide on the same id and
 * clobber/leak each other's chunks. `encodeURIComponent` guarantees the segment
 * contains no `#`, so the FIRST `#` unambiguously delimits it from the source id.
 * A namespace-less (single-tenant) index keeps the bare `${sourceId}#${index}`.
 */
const namespacePrefix = (namespace: string | undefined): string => (namespace === undefined ? "" : `${encodeURIComponent(namespace)}#`);

const chunkVectorId = (namespace: string | undefined, sourceId: string, chunkIndex: number): string =>
    `${namespacePrefix(namespace)}${sourceId}#${String(chunkIndex)}`;

/**
 * Invert {@link chunkVectorId}. The (caller-known) namespace prefix is stripped
 * first; the chunk suffix is then the LAST `#` segment, so source ids may contain
 * `#`.
 */
const parseChunkVectorId = (id: string, namespace: string | undefined): { chunkIndex: number; sourceId: string } => {
    const prefix = namespacePrefix(namespace);
    const body = prefix !== "" && id.startsWith(prefix) ? id.slice(prefix.length) : id;
    const separator = body.lastIndexOf("#");
    const chunkIndex = separator === -1 ? Number.NaN : Number(body.slice(separator + 1));

    if (separator === -1 || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
        return { chunkIndex: 0, sourceId: body };
    }

    return { chunkIndex, sourceId: body.slice(0, separator) };
};

const sha256Hex = async (text: string): Promise<string> => contentHash(new TextEncoder().encode(text));

/**
 * The canonical encoding of everything an `index()` call writes onto a source's
 * vectors — its body, its `metadata`, and its `importance`.
 *
 * The re-index short-circuit compares a hash of this, not of `text` alone.
 * `metadata` is what scopes a document: `rlsFilter` and `metadataFilter` both
 * evaluate against it, so hashing the body only made a tenant move over an
 * unchanged body (`{ orgId: "org-a" }` → `{ orgId: "org-b" }`) report
 * `{ unchanged: true }` while every vector kept the OLD `orgId` — the previous
 * tenant kept retrieving the document forever and the new one never saw it.
 * `importance` is written onto every chunk and multiplied into its score, so it
 * belongs here for the same reason.
 *
 * `stableStringify` sorts object keys at every depth, so re-syncing the same
 * metadata written in a different key order is still the cheap no-op it was. It
 * throws on a value it cannot faithfully encode (a `Date`, a `bigint`, a cycle);
 * that is not a reason to refuse the index, so it returns `undefined` and the
 * caller skips the short-circuit — the source re-indexes, exactly as it would
 * under `reindex: true`.
 */
const sourceIdentity = (input: IndexInput): string | undefined => {
    try {
        // An array, not an object: `stableStringify` skips `undefined` object
        // fields (so an absent `metadata` would collide with a present one) but
        // encodes it positionally inside an array.
        return stableStringify([input.text, input.metadata, input.importance]);
    } catch {
        return undefined;
    }
};

/** Keep only chunks scoring at or above `minScore`. */
const aboveScore = (chunks: ReadonlyArray<RetrievedChunk>, minScore: number): RetrievedChunk[] => chunks.filter((chunk) => chunk.score >= minScore);

/** Split stored metadata into the caller's fields (internal `__rag*` keys stripped). */
const userMetadataOf = (metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!metadata) {
        return undefined;
    }

    const entries = Object.entries(metadata).filter(([key]) => !INTERNAL_KEYS.has(key));

    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

/**
 * Index names already warned about (used without a namespace). One-time-per-
 * process dev signal, deduped by index name — mirrors the equivalent warning in
 * `@lunora/bindings/vectors`' sync hook.
 */
const sharedNamespaceWarned = new Set<string>();

const warnSharedNamespace = (indexName: string): void => {
    if (sharedNamespaceWarned.has(indexName)) {
        return;
    }

    sharedNamespaceWarned.add(indexName);

    // eslint-disable-next-line no-console
    console.warn(
        `[@lunora/ai/rag] index "${indexName}" is used without a namespace — in a multi-tenant/sharded\n` +
            "app this shares one tenant's chunks (text included) with every other tenant, since\n" +
            "Vectorize indexes are account-global. Pass `namespace` (the shard/tenant key) on both\n" +
            "index() and retrieve(). Single-tenant apps suppress this via { allowSharedNamespace: true }.",
    );
};

/**
 * Assemble ranked chunks into one prompt-ready context string, delimited by a
 * source header so the model (and a human reader) can attribute each passage.
 */
const assembleContext = (chunks: ReadonlyArray<RetrievedChunk>): string =>
    chunks.map((chunk) => `[source:${chunk.sourceId}#${String(chunk.chunkIndex)}]\n${chunk.text}`).join("\n\n");

/**
 * Resolve the embedding model for a bound context. A direct AI SDK
 * `EmbeddingModel` object is used as-is and NEVER touches `ctx.ai` — so a
 * bring-your-own-embeddings RAG (e.g. `@ai-sdk/openai`) needs no `ctx.ai` and no
 * `env.AI` binding. A model-id string (or an omitted model, which defers to
 * `ctx.ai`'s default) resolves through `ctx.ai`, which requires the Workers AI
 * binding; a missing `ctx.ai` throws a directed error rather than a bare
 * "cannot read `embeddingModel` of undefined".
 */
// eslint-disable-next-line sonarjs/function-return-type -- single return type (EmbeddingModel); the object-passthrough vs computed-return trips sonar's heuristic (same as create-ai.ts)
const resolveEmbeddingModel = (input: RagConfig["embeddingModel"], ai: RagContext["ai"]): EmbeddingModel => {
    if (typeof input === "object") {
        return input;
    }

    if (ai === undefined) {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/ai/rag: `embeddingModel` is a Workers AI model id (or omitted) but the bound context has no `ai` (env.AI). " +
                "Pass an AI SDK EmbeddingModel object to embed without Workers AI, or bind a context whose `ctx.ai` is wired.",
        );
    }

    return ai.embeddingModel(input);
};

/**
 * Declare a RAG index over the two facades every Lunora action already has:
 * `ctx.ai` (embeddings) + `ctx.vectors` (Vectorize). Returns a per-request
 * factory — bind a ctx to get `{ index, retrieve, remove, asTool }`:
 *
 * ```ts
 * // lunora/rag.ts
 * export const docs = defineRag({ embeddingModel: "@cf/baai/bge-base-en-v1.5", index: "docs" });
 *
 * // inside an action:
 * await docs(ctx).index({ id: doc._id, metadata: { title: doc.title }, namespace: ctx.shardKey, text: doc.body });
 * const { chunks, context, sources } = await docs(ctx).retrieve(question, { namespace: ctx.shardKey });
 * ```
 *
 * Pure composition — no new binding, no I/O until a method runs. Chunk text
 * lives in vector metadata by default (`topK` ≤ 50 on Vectorize); supply
 * `textStore` to move it into your own storage and lift the ceiling to 100 —
 * see `RagTextStore`.
 *
 * `ctx.ai` is only needed to resolve a Workers AI `embeddingModel` id. Pass a
 * direct AI SDK `EmbeddingModel` object (`@ai-sdk/openai`, …) and the helper
 * embeds through it without `ctx.ai` — so a bring-your-own-embeddings index
 * needs no `env.AI` binding (bind any context carrying just `vectors`).
 * @experimental
 */

/**
 * Structural slice of the span handle `ctx.trace` hands its body (see the server
 * `SpanHandle`) — enough to attach an embed's post-hoc usage/cost. Declared here
 * rather than imported so `@lunora/ai/rag` takes no dependency on `@lunora/server`
 * or `@lunora/do`; the real handle is assignable to it.
 */
interface EmbedSpan {
    setAttribute: (key: string, value: unknown) => void;
    setAttributes: (fields: Record<string, unknown>) => void;
}

/**
 * Structural slice of `ctx.trace` (see the server `LunoraTracer`) — enough to
 * wrap one embed. The body receives the enclosing span's {@link EmbedSpan} as its
 * second argument, so it can attach token usage / cost that are only known after
 * the embed call resolves. Declared here rather than imported so `@lunora/ai/rag`
 * takes no dependency on `@lunora/server`; the real tracer is assignable to it.
 */
type EmbedTracer = <T>(name: string, function_: (trace: EmbedTracer, span: EmbedSpan) => Promise<T> | T, attributes?: Record<string, unknown>) => Promise<T>;

/** Read an AI SDK model's stable id for the `gen_ai.request.model` attribute, defensively. */
const modelIdOf = (model: EmbeddingModel): string | undefined => {
    const id = (model as { modelId?: unknown }).modelId;

    return typeof id === "string" && id.length > 0 ? id : undefined;
};

/**
 * Read an embed's dollar cost from AI SDK `providerMetadata`, defensively. AI
 * Gateway surfaces per-request cost there (under a provider bag's `cost` field,
 * e.g. the `cf-aig-*` / gateway metadata) once cost routing is enabled; until
 * then it is absent and this returns `undefined`, so the `gen_ai.usage.cost`
 * attribute is simply omitted. Probing rather than hard-depending keeps the embed
 * span correct with or without a gateway in front.
 */
const embedCostOf = (providerMetadata: unknown): number | undefined => {
    if (typeof providerMetadata !== "object" || providerMetadata === null) {
        return undefined;
    }

    for (const bag of Object.values(providerMetadata as Record<string, unknown>)) {
        if (typeof bag === "object" && bag !== null) {
            const { cost } = bag as { cost?: unknown };

            if (typeof cost === "number" && Number.isFinite(cost)) {
                return cost;
            }
        }
    }

    return undefined;
};

/**
 * The bound context's Vectorize facade, or a directed error. `vectors` is
 * optional on {@link RagContext} because a configured `store` never reads it;
 * without one it is the store, and its absence is a wiring mistake worth
 * naming rather than a `cannot read 'query' of undefined` three calls later.
 */
const requireVectors = (vectors: RagContext["vectors"]): NonNullable<RagContext["vectors"]> => {
    if (vectors === undefined) {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/ai/rag: the bound context has no `vectors` (env.VECTORIZE) and no `store` is configured — " +
                "bind a context whose `ctx.vectors` is wired, or configure `store` (e.g. `sqliteVectorStore`) to back this index without Vectorize.",
        );
    }

    return vectors;
};

const defineRag = (config: RagConfig): ((context: RagContext) => Rag) => {
    if (typeof config.index !== "string" || config.index.length === 0) {
        throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `index` must be a non-empty Vectorize index name");
    }

    const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkOverlap = config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
        throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `chunkSize` must be a positive integer");
    }

    if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
        throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `chunkOverlap` must be a non-negative integer smaller than `chunkSize`");
    }

    // Characters against a byte ceiling on purpose: one character is at least one
    // byte, so this rejects only sizes that cannot fit even in pure ASCII, never
    // a config that works. Gated on BOTH options because `chunkSize` reaches only
    // the built-in splitter — a custom `chunk` ignores it, so rejecting on it
    // would refuse a value that has no effect.
    //
    // Still a floor, not a guarantee: the ceiling is bytes and covers the whole
    // metadata object, so multi-byte text or heavy per-source `metadata` can
    // exceed it under this bound. What it rules out is the config that could
    // never work.
    const chunkTextBudget = VECTORIZE_METADATA_BYTES - METADATA_OVERHEAD_RESERVE;

    if (!config.chunk && !config.textStore && !config.store && chunkSize > chunkTextBudget) {
        throw new LunoraError(
            "BAD_REQUEST",
            `@lunora/ai/rag: \`chunkSize\` of ${String(chunkSize)} leaves no room under Vectorize's ${String(VECTORIZE_METADATA_BYTES)}-byte metadata limit, which also carries this chunk's bookkeeping and any \`metadata\` you attach — keep it under ${String(chunkTextBudget)}, or supply \`textStore\` to move chunk text out of metadata entirely`,
        );
    }

    const defaultTopK = config.topK ?? DEFAULT_TOP_K;

    if (!Number.isInteger(defaultTopK) || defaultTopK < 1) {
        throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `topK` must be a positive integer");
    }

    if (
        config.maxEmbeddingDimensions !== undefined &&
        config.maxEmbeddingDimensions !== false &&
        (!Number.isInteger(config.maxEmbeddingDimensions) || config.maxEmbeddingDimensions < 1)
    ) {
        throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `maxEmbeddingDimensions` must be a positive integer, or `false` to disable the check");
    }

    if (config.embeddingModelVersion !== undefined && !MODEL_VERSION_PATTERN.test(config.embeddingModelVersion)) {
        throw new LunoraError(
            "BAD_REQUEST",
            '@lunora/ai/rag: `embeddingModelVersion` must match /^[A-Za-z0-9._-]{1,40}$/ (a short, stable tag like "bge-v1.5")',
        );
    }

    if (config.candidates !== undefined && (!Number.isInteger(config.candidates) || config.candidates < 1)) {
        throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `candidates` must be a positive integer");
    }

    if (config.cacheEmbeddings !== undefined && (!Number.isInteger(config.cacheEmbeddings) || config.cacheEmbeddings < 0)) {
        throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `cacheEmbeddings` must be a non-negative integer");
    }

    /**
     * Cross-call embedding retention. Governs only what SURVIVES a call — the
     * index-path batch seeds a separate, unbounded, request-scoped map, so
     * batching never depends on this being set and never evicts what is.
     */
    const cacheLimit = config.cacheEmbeddings ?? 0;
    const reranker = config.rerank;
    const splitter = config.chunk ?? ((text: string): ReadonlyArray<string> => fixedWindowChunks(text, chunkSize, chunkOverlap));
    const { textStore } = config;

    // The embedding-model version tag partitions the vector space by folding into
    // the *effective* namespace: `withModelTag` maps the caller's (tenant)
    // namespace to the namespace/id space actually written to Vectorize + the
    // text store. Un-versioned indexes (`modelTag === undefined`) are the
    // identity map, so their chunk ids/namespaces are byte-identical to before.
    const modelTag = config.embeddingModelVersion;
    const withModelTag = (namespace: string | undefined): string | undefined => {
        if (modelTag === undefined) {
            return namespace;
        }

        return namespace === undefined ? modelTag : `${modelTag}::${namespace}`;
    };

    return (context: RagContext): Rag => {
        // The store is what decides the limits from here on. Absent a custom
        // one this wraps `ctx.vectors` and declares exactly the Vectorize
        // constants the retrieval code used to hard-code, so the default path
        // is unchanged.
        const store: RagVectorStore = config.store ? config.store(context) : vectorizeStore(requireVectors(context.vectors), config.index);
        const topKCeiling = textStore ? store.capabilities.maxTopK : store.capabilities.maxTopKWithMetadata;

        // An explicit `maxEmbeddingDimensions` always wins; otherwise the store
        // speaks for itself. That is what lets a pgvector store accept a
        // 3072-dimension model without the caller opting out of a Vectorize
        // ceiling it never had.
        const maxDimensions = config.maxEmbeddingDimensions ?? store.capabilities.maxDimensions;
        // Resolved once per bound ctx, lazily — so a misconfigured model only
        // throws when a RAG method actually runs, and index/retrieve can never
        // drift onto different models within one request.
        let model: EmbeddingModel | undefined;

        // A `ctx.trace` on the bound context (present on a real ActionCtx) turns
        // each embed into a `generation` span; absent (a test / hand-built ctx),
        // embeds run untraced. Narrowed from `unknown` — see `RagContext.trace`.
        const tracer = typeof context.trace === "function" ? (context.trace as EmbedTracer) : undefined;

        // The dimension check runs on the FIRST embedding this bound context
        // produces, then never again: a model's dimensionality is fixed, so
        // re-measuring every chunk of a 500-chunk document is pure overhead.
        let dimensionsChecked = maxDimensions === false;

        /**
         * Refuse an embedding wider than the store can hold, naming both
         * escapes. Runs against the vector actually produced rather than a
         * declared dimension count — the model id alone does not reveal it, and
         * a provider's Matryoshka `dimensions` option changes it.
         */
        const assertDimensionsFit = (dimensions: number, embeddingModel: EmbeddingModel): void => {
            if (dimensionsChecked) {
                return;
            }

            dimensionsChecked = true;

            if (maxDimensions === false || dimensions <= maxDimensions) {
                return;
            }

            const named = modelIdOf(embeddingModel);

            throw new LunoraError(
                "BAD_REQUEST",
                `@lunora/ai/rag: embedding model${named === undefined ? "" : ` "${named}"`} produces ${String(dimensions)}-dimension vectors, over the ${String(maxDimensions)}-dimension ceiling of index "${config.index}" — ` +
                    "either truncate them with the provider's `dimensions` option (Matryoshka models such as text-embedding-3-large support this), " +
                    "or set `maxEmbeddingDimensions: false` if this index is not Vectorize-backed",
            );
        };

        /**
         * Cross-call query cache (`cacheEmbeddings`), keyed by text. Matters
         * because `retrieve()` re-embeds the same question every time it is
         * asked. Bounded by {@link cacheLimit}, and empty when that is 0.
         *
         * Safe to share: an embedding is a pure function of (model, text), and a
         * hit requires already holding the exact text, so nothing leaks that the
         * caller did not supply. Scoped to the bound context — never module
         * level — so it cannot outlive the request that built it.
         */
        const embedCache = new Map<string, ReadonlyArray<number>>();

        /**
         * Embeddings produced by the in-flight `index()` batch. Deliberately
         * UNBOUNDED and separate from {@link embedCache}: the batch seeds one
         * entry per chunk of the document being indexed, and the per-chunk
         * `embed` callbacks `store.upsert` invokes must all hit it — otherwise
         * every chunk is embedded a second time and the batch is pure cost.
         * Cleared when `index()` returns, so it never grows past one document.
         */
        const batchEmbeddings = new Map<string, ReadonlyArray<number>>();

        /** Evict oldest-first once the cache passes its bound (insertion-ordered Map). */
        const rememberEmbedding = (text: string, embedding: ReadonlyArray<number>): void => {
            if (cacheLimit === 0) {
                return;
            }

            embedCache.set(text, embedding);

            while (embedCache.size > cacheLimit) {
                const oldest = embedCache.keys().next();

                if (oldest.done === true) {
                    break;
                }

                embedCache.delete(oldest.value);
            }
        };

        const embedText = async (text: string): Promise<ReadonlyArray<number>> => {
            const cached = embedCache.get(text) ?? batchEmbeddings.get(text);

            if (cached !== undefined) {
                return cached;
            }

            // Resolve once and bind to a local `const`, so the nested `run` closure
            // sees a non-nullable model without a cast.
            model ??= resolveEmbeddingModel(config.embeddingModel, context.ai);
            const resolvedModel = model;

            // `span` is present only on the traced path (post-hoc attributes). The
            // model id is stamped at span start; token usage / cost are known only
            // after the call resolves, so they are attached through the handle.
            const run = async (span?: EmbedSpan): Promise<ReadonlyArray<number>> => {
                const { embedding, providerMetadata, usage } = await aiEmbed({ model: resolvedModel, value: text });

                assertDimensionsFit(embedding.length, resolvedModel);

                if (span !== undefined) {
                    // `usage.tokens` is typed non-optional by the AI SDK; the
                    // typeof/finite guard stays defensive against a provider that
                    // returns a non-numeric value at runtime.
                    const inputTokens: unknown = usage.tokens;

                    if (typeof inputTokens === "number" && Number.isFinite(inputTokens)) {
                        span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
                    }

                    // A provider-reported cost always wins. Falling back to an
                    // estimate is what keeps spend visible without an AI
                    // Gateway — but the two are never conflated: the source is
                    // stamped alongside, so a dashboard can tell a measured
                    // cost from a derived one.
                    const reported = embedCostOf(providerMetadata);
                    const cost =
                        reported ??
                        estimateModelCost(modelIdOf(resolvedModel), {
                            inputTokens: typeof inputTokens === "number" ? inputTokens : undefined,
                        });

                    if (cost !== undefined) {
                        span.setAttribute("gen_ai.usage.cost", cost);
                        span.setAttribute("lunora.usage.cost.source", reported === undefined ? "estimated" : "provider");
                    }
                }

                rememberEmbedding(text, embedding);

                return embedding;
            };

            if (tracer === undefined) {
                return run();
            }

            const modelId = modelIdOf(resolvedModel);
            const conversationId = typeof context.conversationId === "string" && context.conversationId.length > 0 ? context.conversationId : undefined;

            return tracer("ai.embed", (_trace, span) => run(span), {
                "gen_ai.operation.name": "embeddings",
                ...(modelId === undefined ? {} : { "gen_ai.request.model": modelId }),
                // Session/thread grouping — absent unless a conversation id was set.
                ...(conversationId === undefined ? {} : { "gen_ai.conversation.id": conversationId }),
            });
        };

        /**
         * Resolve the queries a retrieval actually searches for: the caller's,
         * or whatever {@link RagConfig.transformQuery} rewrote it into.
         *
         * Always returns at least one non-empty query — a transform that
         * returns nothing usable (an empty array, blank strings, a rejected
         * promise is the caller's problem) falls back to the original rather
         * than searching for `""`, which matches everything and nothing.
         */
        const resolveQueries = async (query: string, options: RetrieveOptions | undefined, namespace: string | undefined): Promise<string[]> => {
            if (!config.transformQuery || options?.transformQuery === false) {
                return [query];
            }

            const conversationId = typeof context.conversationId === "string" && context.conversationId.length > 0 ? context.conversationId : undefined;
            const transformed = await config.transformQuery(query, { conversationId, namespace });
            const candidates = (typeof transformed === "string" ? [transformed] : [...transformed])
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);

            return candidates.length > 0 ? candidates : [query];
        };

        /**
         * Embed `texts` in one batched call and seed {@link batchEmbeddings}, so
         * the per-chunk `embed` callbacks that follow resolve without further
         * I/O.
         *
         * Best-effort: a provider that rejects the batch (or an AI SDK build
         * without `embedMany`) leaves the map empty and every chunk falls back
         * to its own single embed — the pre-existing path. A batching
         * optimisation must never be the reason indexing fails.
         */
        const prefillEmbeddings = async (texts: ReadonlyArray<string>): Promise<void> => {
            const pending = [...new Set(texts.filter((text) => !embedCache.has(text) && !batchEmbeddings.has(text)))];

            if (pending.length < 2) {
                return;
            }

            model ??= resolveEmbeddingModel(config.embeddingModel, context.ai);

            try {
                const { embeddings } = await aiEmbedMany({ model, values: pending });

                if (embeddings.length !== pending.length) {
                    return;
                }

                const [first] = embeddings;

                if (first !== undefined) {
                    assertDimensionsFit(first.length, model);
                }

                for (const [position, text] of pending.entries()) {
                    batchEmbeddings.set(text, embeddings[position] as ReadonlyArray<number>);
                }
            } catch (error) {
                // A dimension breach is a real configuration error and must
                // surface, not be swallowed as a failed optimisation.
                if (isLunoraError(error)) {
                    throw error;
                }
            }
        };

        const checkNamespace = (namespace: string | undefined): void => {
            if (namespace !== undefined) {
                return;
            }

            if (config.requireNamespace) {
                throw new LunoraError(
                    "BAD_REQUEST",
                    `@lunora/ai/rag: index "${config.index}" requires a namespace (requireNamespace is set) — pass the tenant/shard key on index()/retrieve()/remove()`,
                );
            }

            if (!config.allowSharedNamespace) {
                warnSharedNamespace(config.index);
            }
        };

        /**
         * Read chunk #0's bookkeeping metadata (content hash + chunk count) for a source.
         *
         * EVENTUALLY CONSISTENT, and both callers below inherit that. Vectorize
         * applies mutations asynchronously, so a head written moments ago may not
         * be readable yet and this returns `{}`. The consequences differ by caller:
         *
         * `index()` treats an invisible head as "changed" and re-indexes, which is
         * idempotent — a wasted embed, nothing worse. `remove()` and the
         * shrink-on-reindex path instead use `chunks` to decide HOW MANY chunks to
         * delete, so an invisible head means `remove()` deletes only chunk #0 and a
         * shrinking reindex leaves its trailing chunks searchable — silently, since
         * both report success.
         *
         * So a `remove()` (or a shrinking `index({ reindex: true })`) issued in
         * the same request as the `index()` that created the source can under-
         * delete. Re-issue it once the write has settled; a repeat is idempotent.
         * A store with read-after-write consistency (`sqliteVectorStore`, whose
         * `exec` is synchronous) has no such window.
         */
        const readHead = async (sourceId: string, namespace?: string): Promise<{ chunks?: number; hash?: string }> => {
            const [head] = await store.getByIds([chunkVectorId(namespace, sourceId, 0)], namespace);
            const hash = head?.metadata?.[HASH_KEY];
            const chunks = head?.metadata?.[COUNT_KEY];

            return {
                chunks: typeof chunks === "number" && Number.isInteger(chunks) && chunks > 0 ? chunks : undefined,
                hash: typeof hash === "string" ? hash : undefined,
            };
        };

        const deleteChunkRange = async (sourceId: string, from: number, to: number, namespace: string | undefined): Promise<void> => {
            const ids = Array.from({ length: to - from }, (_, offset) => chunkVectorId(namespace, sourceId, from + offset));

            if (ids.length === 0) {
                return;
            }

            await store.deleteByIds(ids, namespace);
            await textStore?.remove?.(ids, { namespace });
            await config.lexicalStore?.remove?.(ids, { namespace });
        };

        const index = async (input: IndexInput): Promise<IndexResult> => {
            checkNamespace(input.namespace);

            if (input.importance !== undefined && (typeof input.importance !== "number" || input.importance < 0 || input.importance > 1)) {
                throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `importance` must be a number in [0, 1]");
            }

            const effectiveNamespace = withModelTag(input.namespace);
            // Hashes the whole stored identity (body + metadata + importance),
            // not just the body — see {@link sourceIdentity}. An identity that
            // cannot be encoded still needs a stored hash, so it falls back to
            // the body and forfeits only the short-circuit below.
            const identity = sourceIdentity(input);
            const hash = await sha256Hex(identity ?? input.text);
            const previous = await readHead(input.id, effectiveNamespace);

            // Unchanged content is a no-op re-sync: skip chunking, embedding,
            // and every write. (Vectorize applies mutations asynchronously, so
            // a hash written moments ago may not be visible yet — the worst
            // case is a redundant, idempotent re-index.)
            if (input.reindex !== true && identity !== undefined && previous.hash === hash && previous.chunks !== undefined) {
                return {
                    chunks: previous.chunks,
                    ids: Array.from({ length: previous.chunks }, (_, chunkIndex) => chunkVectorId(effectiveNamespace, input.id, chunkIndex)),
                    unchanged: true,
                };
            }

            const pieces = splitter(input.text);
            const ids = pieces.map((_, chunkIndex) => chunkVectorId(effectiveNamespace, input.id, chunkIndex));
            const longestId = ids.at(-1);

            // Every id of a source shares its prefix and differs only in the
            // chunk-index suffix, so the last one is the longest — checking it
            // covers them all, before anything is embedded or written.
            if (longestId !== undefined) {
                assertIdFits(longestId, input.id, store.capabilities.maxIdBytes);
            }

            if (pieces.length === 0 && input.allowEmptySources === false) {
                throw new LunoraError("BAD_REQUEST", `@lunora/ai/rag: source "${input.id}" produced zero chunks — set allowEmptySources: true to allow this`);
            }

            // Text lands in the store(s) BEFORE the vectors: a match must never
            // point at text that does not exist yet. The reverse failure mode —
            // orphaned text after a failed upsert — is harmless and converges
            // on the (idempotent) retry.
            if (pieces.length > 0) {
                // `metadata` rides along so a filter-aware lexical store can
                // evaluate the same predicate the vector leg gets — see
                // `StoredRagChunk.metadata`. Undefined when the source carried
                // none, so a store that ignores it is unaffected.
                const storedChunks = pieces.map((text, chunkIndex) => {
                    return {
                        chunkIndex,
                        id: ids[chunkIndex] as string,
                        sourceId: input.id,
                        text,
                        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
                    };
                });

                if (textStore) {
                    await textStore.put(storedChunks, { namespace: effectiveNamespace });
                }

                // Lexical (BM25) mirror for hybrid retrieval — same chunk ids, so
                // RRF can fuse the two legs at query time.
                if (config.lexicalStore) {
                    await config.lexicalStore.index(storedChunks, { namespace: effectiveNamespace });
                }
            }

            // One `embedMany` for the whole document instead of N single embeds:
            // `ctx.vectors.upsert` invokes `embed` per chunk, and those calls now
            // hit the pre-filled batch map. A provider without a real batch
            // endpoint still fans out internally, so this is never worse — and
            // with one it collapses a 200-chunk document from 200 round-trips to
            // a handful.
            await prefillEmbeddings(pieces);

            try {
                await concurrentMap(pieces, INDEX_CONCURRENCY, async (piece, chunkIndex) => {
                    const id = ids[chunkIndex] as string;
                    const metadata: Record<string, unknown> = {
                        ...input.metadata,
                        [CHUNK_INDEX_KEY]: chunkIndex,
                        [SOURCE_KEY]: input.id,
                    };

                    if (!textStore) {
                        metadata[TEXT_KEY] = piece;
                    }

                    if (input.importance !== undefined) {
                        metadata[IMPORTANCE_KEY] = input.importance;
                    }

                    // Chunk #0 carries the source's bookkeeping so re-index and
                    // remove() need no external record of the previous state.
                    if (chunkIndex === 0) {
                        metadata[HASH_KEY] = hash;
                        metadata[COUNT_KEY] = pieces.length;

                        if (modelTag !== undefined) {
                            metadata[MODEL_KEY] = modelTag;
                        }
                    }

                    assertMetadataFits(metadata, chunkIndex, input.id, store.capabilities.maxMetadataBytes);

                    // Vector upsert
                    await store.upsert({
                        embed: embedText,
                        id,
                        input: piece,
                        metadata,
                        namespace: effectiveNamespace,
                    });

                    // Progress callback — fires after the upsert so callers see a
                    // consistent state when the callback runs.
                    input.onChunk?.({ chunkIndex, id, text: piece, total: pieces.length });
                });
            } finally {
                // Request-scoped by construction: one document's worth of
                // embeddings, released the moment its upserts are done.
                batchEmbeddings.clear();
            }

            // A shrinking re-index leaves stale trailing chunks behind — delete
            // them so they cannot keep matching. New chunks are already written,
            // so retrieval never observes a gap.
            if (previous.chunks !== undefined && previous.chunks > pieces.length) {
                await deleteChunkRange(input.id, pieces.length, previous.chunks, effectiveNamespace);
            }

            return { chunks: pieces.length, ids, unchanged: false };
        };

        const remove = async (input: RemoveInput): Promise<void> => {
            checkNamespace(input.namespace);

            const effectiveNamespace = withModelTag(input.namespace);
            const previous = await readHead(input.id, effectiveNamespace);
            const totalChunks = previous.chunks ?? 1;

            // Delete every chunk across the vector, text, and lexical stores.
            // `deleteChunkRange` fans out to `textStore.remove` + `lexicalStore.remove`.
            // Without a head record there is nothing reliable to delete; a head
            // without a count (never written by this helper) still has chunk #0
            // itself to clean up.
            await deleteChunkRange(input.id, 0, totalChunks, effectiveNamespace);
        };

        /** Fetch chunk texts by vector id — from the text store or from vector metadata. */
        const textsByIds = async (ids: ReadonlyArray<string>, namespace: string | undefined): Promise<ReadonlyMap<string, string>> => {
            const texts = new Map<string, string>();

            if (ids.length === 0) {
                return texts;
            }

            if (textStore) {
                const stored = await textStore.getMany(ids, { namespace });

                for (const [position, id] of ids.entries()) {
                    const text = stored[position];

                    if (typeof text === "string") {
                        texts.set(id, text);
                    }
                }

                return texts;
            }

            const records = await store.getByIds(ids, namespace);

            for (const record of records) {
                const text = record.metadata?.[TEXT_KEY];

                if (typeof text === "string") {
                    texts.set(record.id, text);
                }
            }

            return texts;
        };

        /**
         * Stitch each chunk's neighbours (± `chunkContext`) into its text, in
         * document order — matches stay small for embedding quality while the
         * model sees the surrounding passage.
         */
        const expandChunks = async (
            chunks: ReadonlyArray<RetrievedChunk>,
            options: RetrieveOptions | undefined,
            effectiveNamespace: string | undefined,
        ): Promise<ReadonlyArray<RetrievedChunk>> => {
            const before = options?.chunkContext?.before ?? 0;
            const after = options?.chunkContext?.after ?? 0;

            if (before === 0 && after === 0) {
                return chunks;
            }

            if (!Number.isInteger(before) || before < 0 || !Number.isInteger(after) || after < 0) {
                throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `chunkContext.before`/`chunkContext.after` must be non-negative integers");
            }

            const known = new Map(chunks.map((chunk) => [chunk.id, chunk.text]));
            const neighbourIds = new Set<string>();

            for (const chunk of chunks) {
                for (let offset = -before; offset <= after; offset += 1) {
                    const neighbourIndex = chunk.chunkIndex + offset;
                    const id = chunkVectorId(effectiveNamespace, chunk.sourceId, neighbourIndex);

                    if (offset !== 0 && neighbourIndex >= 0 && !known.has(id)) {
                        neighbourIds.add(id);
                    }
                }
            }

            const neighbourTexts = await textsByIds([...neighbourIds], effectiveNamespace);
            const textOf = (sourceId: string, chunkIndex: number): string | undefined => {
                const id = chunkVectorId(effectiveNamespace, sourceId, chunkIndex);

                return known.get(id) ?? neighbourTexts.get(id);
            };

            return chunks.map((chunk) => {
                const parts: string[] = [];

                for (let offset = -before; offset <= after; offset += 1) {
                    const text = offset === 0 ? chunk.text : textOf(chunk.sourceId, chunk.chunkIndex + offset);

                    if (text !== undefined) {
                        parts.push(text);
                    }
                }

                return { ...chunk, text: parts.join("\n") };
            });
        };

        /** Resolve a named filter or pass a literal filter through. */
        const resolveFilter = (filter: Record<string, unknown> | string | undefined): Record<string, unknown> | undefined => {
            if (typeof filter === "string") {
                const resolved = config.filters?.[filter];

                if (!resolved) {
                    throw new LunoraError(
                        "NOT_FOUND",
                        `@lunora/ai/rag: unknown named filter "${filter}" — must be one of the keys declared in RagConfig.filters`,
                    );
                }

                return resolved.filter;
            }

            return filter;
        };

        /** Convert raw vector matches into the shared RetrievedChunk shape. */
        const parseMatches = (result: import("./types").RagVectorMatches, namespace: string | undefined): RetrievedChunk[] =>
            result.matches.map((match) => {
                const metadata = match.metadata ?? {};
                const parsed = parseChunkVectorId(match.id, namespace);
                const rawText = metadata[TEXT_KEY];
                const rawImportance = metadata[IMPORTANCE_KEY];
                const importance = typeof rawImportance === "number" && rawImportance >= 0 && rawImportance <= 1 ? rawImportance : 1;

                return {
                    chunkIndex: parsed.chunkIndex,
                    id: match.id,
                    importance,
                    metadata: userMetadataOf(metadata),
                    score: match.score * importance,
                    sourceId: parsed.sourceId,
                    text: typeof rawText === "string" ? rawText : "",
                };
            });

        /**
         * Hydrate chunk texts from the text store — drops chunks whose text is
         * missing. Also recovers `importance` (the source's `__ragImportance`)
         * and caller `metadata` via a `getByIds` round-trip: `retrieve()`'s
         * `query()` call uses `returnMetadata: "indexed"` in text-store mode,
         * which returns only Vectorize-indexed fields, and neither
         * `__ragImportance` nor caller metadata are indexed — so on `query()`
         * alone they come back as `undefined`/default-1, and importance never
         * actually weights the score. `getByIds` returns full metadata
         * regardless of indexing, so reusing it here recovers both, matching
         * metadata-mode behaviour.
         */
        const hydrateFromStore = async (chunks: RetrievedChunk[], namespace: string | undefined): Promise<RetrievedChunk[]> => {
            if (!textStore) {
                return chunks;
            }

            const ids = chunks.map((chunk) => chunk.id);
            const [texts, records] = await Promise.all([textsByIds(ids, namespace), store.getByIds(ids, namespace)]);
            const fullMetadataById = new Map(records.map((record) => [record.id, record.metadata]));

            return chunks.flatMap((chunk) => {
                const text = texts.get(chunk.id);

                if (text === undefined) {
                    return [];
                }

                const fullMetadata = fullMetadataById.get(chunk.id);
                const rawImportance = fullMetadata?.[IMPORTANCE_KEY];
                const importance = typeof rawImportance === "number" && rawImportance >= 0 && rawImportance <= 1 ? rawImportance : chunk.importance;

                // `chunk.score` was computed as `match.score * chunk.importance`
                // (usually 1 in text-store mode — `query()` returns only indexed
                // metadata, so `__ragImportance` is absent — but 0 is a valid,
                // validated importance and IS returned when it was indexed).
                // Rescale to the recovered importance so weighting takes effect.
                // Guard the divide: `chunk.importance === 0` makes `chunk.score`
                // 0 too, so `0 / 0` would yield `NaN` and corrupt the whole
                // retrieval ordering, not just this chunk — treat it as base 0.
                const base = chunk.importance === 0 ? 0 : chunk.score / chunk.importance;
                const score = base * importance;

                return [{ ...chunk, importance, metadata: userMetadataOf(fullMetadata) ?? chunk.metadata, score, text }];
            });
        };

        const retrieve = async (query: string, options?: RetrieveOptions): Promise<RetrieveResult> => {
            checkNamespace(options?.namespace);

            const effectiveNamespace = withModelTag(options?.namespace);
            const resolvedFilter = resolveFilter(options?.filter);

            // Row-level security: derive a filter from the bound ctx's identity
            // and merge it OVER the caller's filter (RLS keys win) so a caller can
            // never widen past what RLS allows. Applied to both retrieval legs.
            const rlsFilter = config.rlsFilter ? await config.rlsFilter(context.auth) : undefined;
            const effectiveFilter = rlsFilter ? { ...resolvedFilter, ...rlsFilter } : resolvedFilter;
            const topK = Math.min(options?.topK ?? defaultTopK, topKCeiling);

            // Query transformation: rewrite the raw query, or expand it into
            // several that are searched independently and fused. The FIRST
            // query is the canonical one — it drives the lexical leg and is
            // what `onRetrieve` reports.
            const searchQueries = await resolveQueries(query, options, effectiveNamespace);
            const primaryQuery = searchQueries[0] as string;

            // Anything that reorders downstream — a lexical leg, multi-query
            // expansion, a reranker — can only work with what retrieval found,
            // so each leg fetches a deeper pool than the caller's `topK` and the
            // trim happens after. Fetching only `topK` per leg would defeat the
            // lexical leg entirely: its job is to surface a chunk the vector leg
            // ranked below `topK`.
            const rerankActive = reranker !== undefined && options?.rerank !== false;
            const widenPool = rerankActive || config.lexicalStore !== undefined || searchQueries.length > 1;
            const candidateK = widenPool ? Math.min(config.candidates ?? topK * CANDIDATE_POOL_FACTOR, topKCeiling) : topK;

            const minScore = options?.minScore;

            const runVectorLeg = async (searchQuery: string): Promise<RetrievedChunk[]> => {
                const vectorResult = await store.query({
                    embed: embedText,
                    filter: effectiveFilter,
                    input: searchQuery,
                    namespace: effectiveNamespace,
                    returnMetadata: textStore ? "indexed" : "all",
                    topK: candidateK,
                });

                const legChunks = await hydrateFromStore(parseMatches(vectorResult, effectiveNamespace), effectiveNamespace);

                // `minScore` is applied HERE, per leg, and nowhere else: this is
                // the only point where a chunk's score is still the cosine
                // (importance-adjusted) scale the option is documented against.
                // Every fusion below — multi-query or lexical — replaces `score`
                // with an RRF score, and thresholding an RRF score against a
                // cosine-scale number would keep or drop chunks essentially at
                // random. Filtering each leg before fusion is also the stricter
                // reading: a chunk too weak to pass on its own does not get in
                // by being surfaced twice.
                return minScore === undefined ? legChunks : aboveScore(legChunks, minScore);
            };

            // Multi-query expansion: each rewrite is its own ranking, fused by
            // RRF. Sequential rather than concurrent on purpose — each leg
            // embeds and queries, and a Worker's subrequest budget is the
            // binding constraint on a fan-out the caller controls the width of.
            let chunks = await runVectorLeg(primaryQuery);

            for (const extraQuery of searchQueries.slice(1)) {
                // eslint-disable-next-line no-await-in-loop -- bounded, caller-sized fan-out over a subrequest budget
                chunks = [...hybridRank(chunks, await runVectorLeg(extraQuery))];
            }

            // Hybrid search: also rank via the lexical (BM25) leg and fuse the
            // two rankings with RRF — recovering exact-term matches the embedding
            // misses. Lexical-only hits carry no stored metadata/importance; a hit
            // shared with the vector leg keeps the (richer) vector chunk in RRF.
            if (config.lexicalStore) {
                const lexicalMatches = await config.lexicalStore.search(primaryQuery, {
                    filter: effectiveFilter,
                    namespace: effectiveNamespace,
                    topK: config.lexicalTopK ?? candidateK,
                });

                const lexicalChunks: RetrievedChunk[] = lexicalMatches.map((match) => {
                    const parsed = parseChunkVectorId(match.id, effectiveNamespace);

                    return {
                        chunkIndex: parsed.chunkIndex,
                        id: match.id,
                        importance: 1,
                        metadata: undefined,
                        score: match.score,
                        sourceId: parsed.sourceId,
                        text: match.text,
                    };
                });

                chunks = [...hybridRank(chunks, lexicalChunks)];
            }

            // Importance weighting can reorder; re-rank on the adjusted score.
            chunks.sort((a, b) => b.score - a.score);

            // Reranking sees the full candidate pool and returns the final
            // order — so it runs after fusion, and its output is NOT re-sorted.
            if (rerankActive) {
                chunks = [...(await reranker(primaryQuery, chunks))];
            }

            // Trim to what the caller actually asked for. Each retrieval leg is
            // bounded by `candidateK`, but fusion returns their UNION — so a
            // hybrid or multi-query retrieval reaches here with more chunks than
            // `topK`, and without this a caller asking for 5 gets the whole
            // union, blowing out the prompt context that `topK` exists to bound.
            chunks = chunks.slice(0, topK);

            chunks = [...(await expandChunks(chunks, options, effectiveNamespace))];

            const sources: RagSource[] = [];
            const seen = new Set<string>();

            for (const chunk of chunks) {
                if (!seen.has(chunk.sourceId)) {
                    seen.add(chunk.sourceId);
                    sources.push({ id: chunk.sourceId, metadata: chunk.metadata, weight: chunk.importance });
                }
            }

            options?.onRetrieve?.({ matches: chunks.length, query });

            return { chunks, context: assembleContext(chunks), sources };
        };

        const asTool = (options?: RagToolOptions): ReturnType<Rag["asTool"]> =>
            tool({
                description: options?.description ?? `Search the "${config.index}" knowledge base for passages relevant to a natural-language query.`,
                execute: async ({ query }: { query: string }): Promise<RetrieveResult> =>
                    retrieve(query, { namespace: options?.namespace, topK: options?.topK }),
                inputSchema: jsonSchema<{ query: string }>({
                    properties: {
                        query: { description: "The natural-language search query.", type: "string" },
                    },
                    required: ["query"],
                    type: "object",
                }),
            });

        return { asTool, index, remove, retrieve };
    };
};

export default defineRag;
