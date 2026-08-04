import { LunoraError } from "@lunora/errors";
import type { EmbeddingModel } from "ai";
import { embed as aiEmbed, jsonSchema, tool } from "ai";

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

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_TOP_K = 5;

/** Vectorize `topK` ceiling when full metadata is requested (metadata mode). */
const MAX_TOP_K_FULL_METADATA = 20;
/** Vectorize `topK` ceiling otherwise (text-store mode). */
const MAX_TOP_K = 100;

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
 * lives in vector metadata by default (`topK` ≤ 20); supply `textStore` to move
 * it into your own storage and lift the ceiling to 100 — see `RagTextStore`.
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

    const defaultTopK = config.topK ?? DEFAULT_TOP_K;

    if (!Number.isInteger(defaultTopK) || defaultTopK < 1) {
        throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `topK` must be a positive integer");
    }

    if (config.embeddingModelVersion !== undefined && !MODEL_VERSION_PATTERN.test(config.embeddingModelVersion)) {
        throw new LunoraError(
            "BAD_REQUEST",
            '@lunora/ai/rag: `embeddingModelVersion` must match /^[A-Za-z0-9._-]{1,40}$/ (a short, stable tag like "bge-v1.5")',
        );
    }

    const splitter = config.chunk ?? ((text: string): ReadonlyArray<string> => fixedWindowChunks(text, chunkSize, chunkOverlap));
    const { textStore } = config;
    const topKCeiling = textStore ? MAX_TOP_K : MAX_TOP_K_FULL_METADATA;

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
        // Resolved once per bound ctx, lazily — so a misconfigured model only
        // throws when a RAG method actually runs, and index/retrieve can never
        // drift onto different models within one request.
        let model: EmbeddingModel | undefined;

        // A `ctx.trace` on the bound context (present on a real ActionCtx) turns
        // each embed into a `generation` span; absent (a test / hand-built ctx),
        // embeds run untraced. Narrowed from `unknown` — see `RagContext.trace`.
        const tracer = typeof context.trace === "function" ? (context.trace as EmbedTracer) : undefined;

        const embedText = async (text: string): Promise<ReadonlyArray<number>> => {
            // Resolve once and bind to a local `const`, so the nested `run` closure
            // sees a non-nullable model without a cast.
            model ??= resolveEmbeddingModel(config.embeddingModel, context.ai);
            const resolvedModel = model;

            // `span` is present only on the traced path (post-hoc attributes). The
            // model id is stamped at span start; token usage / cost are known only
            // after the call resolves, so they are attached through the handle.
            const run = async (span?: EmbedSpan): Promise<ReadonlyArray<number>> => {
                const { embedding, providerMetadata, usage } = await aiEmbed({ model: resolvedModel, value: text });

                if (span !== undefined) {
                    // `usage.tokens` is typed non-optional by the AI SDK; the
                    // typeof/finite guard stays defensive against a provider that
                    // returns a non-numeric value at runtime.
                    const inputTokens: unknown = usage.tokens;

                    if (typeof inputTokens === "number" && Number.isFinite(inputTokens)) {
                        span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
                    }

                    const cost = embedCostOf(providerMetadata);

                    if (cost !== undefined) {
                        span.setAttribute("gen_ai.usage.cost", cost);
                    }
                }

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

        /** Read chunk #0's bookkeeping metadata (content hash + chunk count) for a source. */
        const readHead = async (sourceId: string, namespace?: string): Promise<{ chunks?: number; hash?: string }> => {
            const [head] = await context.vectors.getByIds(config.index, [chunkVectorId(namespace, sourceId, 0)], namespace);
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

            await context.vectors.deleteByIds(config.index, ids, namespace);
            await textStore?.remove?.(ids, { namespace });
            await config.lexicalStore?.remove?.(ids, { namespace });
        };

        const index = async (input: IndexInput): Promise<IndexResult> => {
            checkNamespace(input.namespace);

            if (input.importance !== undefined && (typeof input.importance !== "number" || input.importance < 0 || input.importance > 1)) {
                throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `importance` must be a number in [0, 1]");
            }

            const effectiveNamespace = withModelTag(input.namespace);
            const hash = await sha256Hex(input.text);
            const previous = await readHead(input.id, effectiveNamespace);

            // Unchanged content is a no-op re-sync: skip chunking, embedding,
            // and every write. (Vectorize applies mutations asynchronously, so
            // a hash written moments ago may not be visible yet — the worst
            // case is a redundant, idempotent re-index.)
            if (previous.hash === hash && previous.chunks !== undefined) {
                return {
                    chunks: previous.chunks,
                    ids: Array.from({ length: previous.chunks }, (_, chunkIndex) => chunkVectorId(effectiveNamespace, input.id, chunkIndex)),
                    unchanged: true,
                };
            }

            const pieces = splitter(input.text);
            const ids = pieces.map((_, chunkIndex) => chunkVectorId(effectiveNamespace, input.id, chunkIndex));

            if (pieces.length === 0 && input.allowEmptySources === false) {
                throw new LunoraError("BAD_REQUEST", `@lunora/ai/rag: source "${input.id}" produced zero chunks — set allowEmptySources: true to allow this`);
            }

            // Text lands in the store(s) BEFORE the vectors: a match must never
            // point at text that does not exist yet. The reverse failure mode —
            // orphaned text after a failed upsert — is harmless and converges
            // on the (idempotent) retry.
            if (pieces.length > 0) {
                const storedChunks = pieces.map((text, chunkIndex) => {
                    return { chunkIndex, id: ids[chunkIndex] as string, sourceId: input.id, text };
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

                // Vector upsert
                await context.vectors.upsert(config.index, {
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

            const records = await context.vectors.getByIds(config.index, ids, namespace);

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
            const [texts, records] = await Promise.all([textsByIds(ids, namespace), context.vectors.getByIds(config.index, ids, namespace)]);
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

            // Vector query (primary, semantic leg)
            const vectorResult = await context.vectors.query(config.index, {
                embed: embedText,
                filter: effectiveFilter,
                input: query,
                namespace: effectiveNamespace,
                returnMetadata: textStore ? "indexed" : "all",
                topK,
            });

            let chunks = await hydrateFromStore(parseMatches(vectorResult, effectiveNamespace), effectiveNamespace);

            const minScore = options?.minScore;

            // Apply `minScore` to the vector leg here, before any hybrid
            // fusion — its score is the cosine (importance-adjusted) scale the
            // option is documented against. When a lexical (BM25) leg is also
            // configured, this is the ONLY place `minScore` is applied: after
            // fusion the chunk set mixes this cosine-scale score with the
            // lexical leg's raw, unbounded BM25 score for lexical-only hits
            // (scores that, per `hybridRank`'s own docs, "are not comparable
            // across different search methods"), so filtering that mixed set
            // against one cosine-scale threshold would arbitrarily keep/drop
            // chunks depending on which leg happened to surface them. Non-
            // hybrid retrieval is unaffected: it never reaches the fusion
            // branch below, and filtering here selects the exact same set as
            // filtering after the later re-sort would.
            if (minScore !== undefined) {
                chunks = chunks.filter((chunk) => chunk.score >= minScore);
            }

            // Hybrid search: also rank via the lexical (BM25) leg and fuse the
            // two rankings with RRF — recovering exact-term matches the embedding
            // misses. Lexical-only hits carry no stored metadata/importance; a hit
            // shared with the vector leg keeps the (richer) vector chunk in RRF.
            if (config.lexicalStore) {
                const lexicalMatches = await config.lexicalStore.search(query, {
                    filter: effectiveFilter,
                    namespace: effectiveNamespace,
                    topK: config.lexicalTopK ?? topK,
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
