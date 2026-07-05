import type { EmbeddingModel } from "ai";
import { embed as aiEmbed, jsonSchema, tool } from "ai";

import fixedWindowChunks from "./chunk";
import { concurrentMap, INDEX_CONCURRENCY } from "./concurrent";
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

const INTERNAL_KEYS = new Set([CHUNK_INDEX_KEY, COUNT_KEY, HASH_KEY, IMPORTANCE_KEY, SOURCE_KEY, TEXT_KEY]);

const chunkVectorId = (sourceId: string, chunkIndex: number): string => `${sourceId}#${String(chunkIndex)}`;

/** Invert {@link chunkVectorId}. The chunk suffix is the LAST `#` segment, so source ids may contain `#`. */
const parseChunkVectorId = (id: string): { chunkIndex: number; sourceId: string } => {
    const separator = id.lastIndexOf("#");
    const chunkIndex = separator === -1 ? Number.NaN : Number(id.slice(separator + 1));

    if (separator === -1 || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
        return { chunkIndex: 0, sourceId: id };
    }

    return { chunkIndex, sourceId: id.slice(0, separator) };
};

const sha256Hex = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

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
 */
const defineRag = (config: RagConfig): ((context: RagContext) => Rag) => {
    if (typeof config.index !== "string" || config.index.length === 0) {
        throw new TypeError("@lunora/ai/rag: `index` must be a non-empty Vectorize index name");
    }

    const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkOverlap = config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
        throw new TypeError("@lunora/ai/rag: `chunkSize` must be a positive integer");
    }

    if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
        throw new TypeError("@lunora/ai/rag: `chunkOverlap` must be a non-negative integer smaller than `chunkSize`");
    }

    const defaultTopK = config.topK ?? DEFAULT_TOP_K;

    if (!Number.isInteger(defaultTopK) || defaultTopK < 1) {
        throw new TypeError("@lunora/ai/rag: `topK` must be a positive integer");
    }

    const splitter = config.chunk ?? ((text: string): ReadonlyArray<string> => fixedWindowChunks(text, chunkSize, chunkOverlap));
    const { textStore } = config;
    const topKCeiling = textStore ? MAX_TOP_K : MAX_TOP_K_FULL_METADATA;

    return (context: RagContext): Rag => {
        // Resolved once per bound ctx, lazily — so a misconfigured model only
        // throws when a RAG method actually runs, and index/retrieve can never
        // drift onto different models within one request.
        let model: EmbeddingModel | undefined;

        const embedText = async (text: string): Promise<ReadonlyArray<number>> => {
            model ??= context.ai.embeddingModel(config.embeddingModel);

            const { embedding } = await aiEmbed({ model, value: text });

            return embedding;
        };

        const checkNamespace = (namespace: string | undefined): void => {
            if (namespace !== undefined) {
                return;
            }

            if (config.requireNamespace) {
                throw new TypeError(
                    `@lunora/ai/rag: index "${config.index}" requires a namespace (requireNamespace is set) — pass the tenant/shard key on index()/retrieve()/remove()`,
                );
            }

            if (!config.allowSharedNamespace) {
                warnSharedNamespace(config.index);
            }
        };

        /** Read chunk #0's bookkeeping metadata (content hash + chunk count) for a source. */
        const readHead = async (sourceId: string, namespace?: string): Promise<{ chunks?: number; hash?: string }> => {
            const [head] = await context.vectors.getByIds(config.index, [chunkVectorId(sourceId, 0)], namespace);
            const hash = head?.metadata?.[HASH_KEY];
            const chunks = head?.metadata?.[COUNT_KEY];

            return {
                chunks: typeof chunks === "number" && Number.isInteger(chunks) && chunks > 0 ? chunks : undefined,
                hash: typeof hash === "string" ? hash : undefined,
            };
        };

        const deleteChunkRange = async (sourceId: string, from: number, to: number, namespace: string | undefined): Promise<void> => {
            const ids = Array.from({ length: to - from }, (_, offset) => chunkVectorId(sourceId, from + offset));

            if (ids.length === 0) {
                return;
            }

            await context.vectors.deleteByIds(config.index, ids, namespace);
            await textStore?.remove?.(ids, { namespace });
        };

        const index = async (input: IndexInput): Promise<IndexResult> => {
            checkNamespace(input.namespace);

            if (input.importance !== undefined && (typeof input.importance !== "number" || input.importance < 0 || input.importance > 1)) {
                throw new TypeError("@lunora/ai/rag: `importance` must be a number in [0, 1]");
            }

            const hash = await sha256Hex(input.text);
            const previous = await readHead(input.id, input.namespace);

            // Unchanged content is a no-op re-sync: skip chunking, embedding,
            // and every write. (Vectorize applies mutations asynchronously, so
            // a hash written moments ago may not be visible yet — the worst
            // case is a redundant, idempotent re-index.)
            if (previous.hash === hash && previous.chunks !== undefined) {
                return {
                    chunks: previous.chunks,
                    ids: Array.from({ length: previous.chunks }, (_, chunkIndex) => chunkVectorId(input.id, chunkIndex)),
                    unchanged: true,
                };
            }

            const pieces = splitter(input.text);
            const ids = pieces.map((_, chunkIndex) => chunkVectorId(input.id, chunkIndex));

            // Text lands in the store BEFORE the vectors: a match must never
            // point at text that does not exist yet. The reverse failure mode —
            // orphaned text after a failed upsert — is harmless and converges
            // on the (idempotent) retry.
            if (textStore && pieces.length > 0) {
                await textStore.put(
                    pieces.map((text, chunkIndex) => {
                        return { chunkIndex, id: ids[chunkIndex] as string, sourceId: input.id, text };
                    }),
                    { namespace: input.namespace },
                );
            }

            await concurrentMap(pieces, INDEX_CONCURRENCY, async (piece, chunkIndex) => {
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
                }

                return context.vectors.upsert(config.index, {
                    embed: embedText,
                    id: ids[chunkIndex] as string,
                    input: piece,
                    metadata,
                    namespace: input.namespace,
                });
            });

            // A shrinking re-index leaves stale trailing chunks behind — delete
            // them so they cannot keep matching. New chunks are already written,
            // so retrieval never observes a gap.
            if (previous.chunks !== undefined && previous.chunks > pieces.length) {
                await deleteChunkRange(input.id, pieces.length, previous.chunks, input.namespace);
            }

            return { chunks: pieces.length, ids, unchanged: false };
        };

        const remove = async (input: RemoveInput): Promise<void> => {
            checkNamespace(input.namespace);

            const previous = await readHead(input.id, input.namespace);

            // Without a head record there is nothing reliable to delete; a
            // head without a count (never written by this helper) still has
            // chunk #0 itself to clean up.
            await deleteChunkRange(input.id, 0, previous.chunks ?? 1, input.namespace);
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
        const expandChunks = async (chunks: ReadonlyArray<RetrievedChunk>, options: RetrieveOptions | undefined): Promise<ReadonlyArray<RetrievedChunk>> => {
            const before = options?.chunkContext?.before ?? 0;
            const after = options?.chunkContext?.after ?? 0;

            if (before === 0 && after === 0) {
                return chunks;
            }

            if (!Number.isInteger(before) || before < 0 || !Number.isInteger(after) || after < 0) {
                throw new TypeError("@lunora/ai/rag: `chunkContext.before`/`chunkContext.after` must be non-negative integers");
            }

            const known = new Map(chunks.map((chunk) => [chunk.id, chunk.text]));
            const neighbourIds = new Set<string>();

            for (const chunk of chunks) {
                for (let offset = -before; offset <= after; offset += 1) {
                    const neighbourIndex = chunk.chunkIndex + offset;
                    const id = chunkVectorId(chunk.sourceId, neighbourIndex);

                    if (offset !== 0 && neighbourIndex >= 0 && !known.has(id)) {
                        neighbourIds.add(id);
                    }
                }
            }

            const neighbourTexts = await textsByIds([...neighbourIds], options?.namespace);
            const textOf = (sourceId: string, chunkIndex: number): string | undefined => {
                const id = chunkVectorId(sourceId, chunkIndex);

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

        const retrieve = async (query: string, options?: RetrieveOptions): Promise<RetrieveResult> => {
            checkNamespace(options?.namespace);

            const topK = Math.min(options?.topK ?? defaultTopK, topKCeiling);

            const result = await context.vectors.query(config.index, {
                embed: embedText,
                filter: options?.filter,
                input: query,
                namespace: options?.namespace,
                // Metadata mode reads chunk text back from metadata, so it must
                // request "all" (and live with the topK ceiling of 20). With a
                // text store the default "indexed" projection suffices.
                returnMetadata: textStore ? "indexed" : "all",
                topK,
            });

            let chunks: RetrievedChunk[] = result.matches.map((match) => {
                const metadata = match.metadata ?? {};
                const parsed = parseChunkVectorId(match.id);
                const rawText = metadata[TEXT_KEY];
                const rawImportance = metadata[IMPORTANCE_KEY];
                const importance = typeof rawImportance === "number" && rawImportance >= 0 && rawImportance <= 1 ? rawImportance : 1;

                return {
                    chunkIndex: parsed.chunkIndex,
                    id: match.id,
                    metadata: userMetadataOf(metadata),
                    score: match.score * importance,
                    sourceId: parsed.sourceId,
                    text: typeof rawText === "string" ? rawText : "",
                };
            });

            // Text-store mode: hydrate texts by id; a chunk whose text is gone
            // (store cleanup raced the vector delete) is useless as context and
            // is dropped rather than surfaced empty.
            if (textStore) {
                const texts = await textsByIds(
                    chunks.map((chunk) => chunk.id),
                    options?.namespace,
                );

                chunks = chunks.flatMap((chunk) => {
                    const text = texts.get(chunk.id);

                    return text === undefined ? [] : [{ ...chunk, text }];
                });
            }

            // Importance weighting can reorder; re-rank on the adjusted score
            // before applying the threshold.
            chunks.sort((a, b) => b.score - a.score);

            if (options?.minScore !== undefined) {
                chunks = chunks.filter((chunk) => chunk.score >= (options.minScore as number));
            }

            chunks = [...(await expandChunks(chunks, options))];

            const sources: RagSource[] = [];
            const seen = new Set<string>();

            for (const chunk of chunks) {
                if (!seen.has(chunk.sourceId)) {
                    seen.add(chunk.sourceId);
                    sources.push({ id: chunk.sourceId, metadata: chunk.metadata });
                }
            }

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
