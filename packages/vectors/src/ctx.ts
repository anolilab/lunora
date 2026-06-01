import type { CirrusVectors } from "./types.js";

/**
 * `(input: string) => vector`. Matches `@cirrus/server`'s `VectorEmbedder` so
 * the bridged surface is assignable to the server's `VectorSearch` contract.
 */
export type VectorEmbedderLike = (input: string) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

export interface VectorMatchLike {
    id: string;
    metadata?: Record<string, unknown>;
    score: number;
}

export interface VectorMatchesLike {
    count: number;
    matches: ReadonlyArray<VectorMatchLike>;
}

export interface VectorRecordLike {
    id: string;
    metadata?: Record<string, unknown>;
    values: ReadonlyArray<number>;
}

export interface VectorQueryInputLike {
    embed?: VectorEmbedderLike;
    filter?: Record<string, unknown>;
    input?: string;
    namespace?: string;
    topK?: number;
    vector?: ReadonlyArray<number>;
}

export interface VectorUpsertInputLike {
    embed: VectorEmbedderLike;
    id: string;
    input: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
}

/**
 * Structural mirror of `@cirrus/server`'s `VectorSearch`. Declared here so the
 * adapter never imports `@cirrus/server` (keeps the dependency edge one-way:
 * the generated DO depends on both, neither depends on the other).
 */
export interface VectorSearchLike {
    deleteByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<void>;
    getByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<ReadonlyArray<VectorRecordLike>>;
    query: (indexName: string, input: VectorQueryInputLike) => Promise<VectorMatchesLike>;
    upsert: (indexName: string, input: VectorUpsertInputLike) => Promise<void>;
    upsertNow: (indexName: string, input: VectorUpsertInputLike) => Promise<void>;
}

/**
 * Bridge `CirrusVectors` (returns Vectorize mutation receipts) to the server's
 * `VectorSearch` contract (void mutations, server match/record shapes). Both
 * `upsert` and `upsertNow` write inline — this design has no post-commit queue,
 * so "now" and "deferred" collapse to the same synchronous call.
 */
export const createCtxVectors = (cirrus: CirrusVectors): VectorSearchLike => {
    const upsert = async (indexName: string, input: VectorUpsertInputLike): Promise<void> => {
        await cirrus.upsert(indexName, {
            id: input.id,
            input: input.input,
            embed: input.embed,
            metadata: input.metadata,
            namespace: input.namespace,
        });
    };

    return {
        upsert,
        upsertNow: upsert,
        query: async (indexName: string, input: VectorQueryInputLike): Promise<VectorMatchesLike> => {
            const result = await cirrus.query(indexName, {
                vector: input.vector,
                input: input.input,
                embed: input.embed,
                topK: input.topK,
                namespace: input.namespace,
                filter: input.filter,
                // Default to "indexed" rather than "all": returning every
                // metadata field by default leaks whatever was stored on the
                // vector (potentially cross-tenant if namespaces aren't wired).
                // Callers that need full metadata opt in explicitly.
                returnMetadata: "indexed",
            });

            return {
                count: result.count,
                matches: result.matches.map((match) => { return { id: match.id, score: match.score, metadata: match.metadata }; }),
            };
        },
        getByIds: async (indexName: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorRecordLike>> => {
            const records = await cirrus.getByIds(indexName, ids);

            return records.map((record) => { return { id: record.id, values: record.values, metadata: record.metadata }; });
        },
        deleteByIds: async (indexName: string, ids: ReadonlyArray<string>): Promise<void> => {
            await cirrus.deleteByIds(indexName, ids);
        },
    };
};

/** A single row mutation observed by the ctx-db, fed to {@link createVectorSyncHook}. */
export interface WriteEvent {
    doc?: Record<string, unknown>;
    id: string;
    op: "delete" | "insert" | "update";
    table: string;
}

export type WriteHook = (event: WriteEvent) => Promise<void>;

/** Inline vector index declared via `.vectorize(field, ...)` (DSL Shape A). */
export interface TableVectorIndexLike {
    embed: VectorEmbedderLike;
    field: string;
    metadata?: ReadonlyArray<string>;
    name: string;
}

export interface TableDefinitionLike {
    vectorIndexes?: ReadonlyArray<TableVectorIndexLike>;
}

/** Standalone vector index declared via `defineVectorIndex(...)` (DSL Shape B). */
export interface VectorIndexDefinitionLike {
    embed: VectorEmbedderLike;
    metadata?: (row: Record<string, unknown>) => Record<string, unknown>;
    select: (row: Record<string, unknown>) => string;
    table: string;
}

/**
 * Structural mirror of `@cirrus/server`'s `Schema`, narrowed to the fields the
 * sync hook reads. Carries live `embed`/`select` closures, so the hook must be
 * built from the imported `schema` value — never a serialized descriptor.
 */
export interface SchemaLike {
    tables: Record<string, TableDefinitionLike>;
    vectorIndexes: Record<string, VectorIndexDefinitionLike>;
}

const pickMetadata = (row: Record<string, unknown>, fields: ReadonlyArray<string>): Record<string, unknown> => {
    const result: Record<string, unknown> = {};

    for (const field of fields) {
        if (field in row) {
            result[field] = row[field];
        }
    }

    return result;
};

/**
 * Build a {@link WriteHook} that keeps Vectorize in sync with row writes. On
 * insert/update it embeds each matching index's source (Shape A `row[field]`,
 * Shape B `select(row)`) and upserts; on delete it removes the row's id from
 * every index sourced from the table. Runs inline within the write path.
 *
 * Tenant isolation — IMPORTANT: Vectorize indexes are account-global and shared
 * by every shard DO. Without a `namespace`, a multi-tenant sharded app has NO
 * isolation between tenants in the vector index — one tenant's vectors are
 * queryable by another. The caller MUST pass `options.namespace` (the shard /
 * tenant key) so upserts are scoped, and MUST apply the same namespace on the
 * query side. The namespace is threaded onto upserts here; pass it from the
 * shard DO that owns this hook. When it genuinely cannot be supplied, the hook
 * still functions but offers no cross-tenant isolation.
 *
 * Consistency — IMPORTANT: this hook runs inline within the mutation but talks
 * to Vectorize, which is external and non-transactional. The per-index calls
 * fan out; if one fails after others have already applied, the SQLite write may
 * roll back while the applied Vectorize mutations cannot — leaving SQLite and
 * Vectorize diverged. We mitigate, not eliminate: upserts/deletes are
 * idempotent (keyed by row id), so a retry of the same write converges; and on
 * a fan-out failure we attempt a best-effort compensating delete of the row's
 * id from every affected index before re-throwing. A delete after a failed
 * upsert can itself fail — this is best-effort, the authoritative recovery is
 * re-running the (idempotent) write.
 */
export const createVectorSyncHook = (options: { namespace?: string; schema: SchemaLike; vectors: VectorSearchLike }): WriteHook => {
    const { namespace, schema, vectors } = options;

    return async (event: WriteEvent): Promise<void> => {
        const tableDefinition = schema.tables[event.table];
        const inlineIndexes = tableDefinition?.vectorIndexes ?? [];
        const standaloneIndexes = Object.entries(schema.vectorIndexes).filter(([, definition]) => definition.table === event.table);

        if (inlineIndexes.length === 0 && standaloneIndexes.length === 0) {
            return;
        }

        // Every index sourced from this table, by name — used both to fan out
        // deletes and to compensate after a partial upsert failure.
        const allIndexNames = [...inlineIndexes.map((index) => index.name), ...standaloneIndexes.map(([name]) => name)];

        if (event.op === "delete") {
            // Each Vectorize index is independent: a delete on index A can't
            // observe a delete on index B, so the per-index calls run in
            // parallel rather than serially.
            await Promise.all(allIndexNames.map((name) => vectors.deleteByIds(name, [event.id])));

            return;
        }

        const row = event.doc;

        if (!row) {
            return;
        }

        // event.doc on update is the FULL merged row, so an inline (Shape A)
        // index whose source field was just cleared (now nullish) must be
        // PURGED — skipping the upsert would otherwise leave the stale vector
        // searchable. Split inline indexes into "has a value -> upsert" and
        // "cleared -> delete". Shape B has no per-field source to clear; its
        // `select` defines the value, so it always upserts.
        const inlineToUpsert = inlineIndexes.filter((index) => row[index.field] !== undefined && row[index.field] !== null);
        const inlineToClear = inlineIndexes.filter((index) => row[index.field] === undefined || row[index.field] === null);

        // Same per-index independence on the write path — fan the upserts out
        // (plus any clears) and await as a group. Embedders may make remote
        // calls, so the serial loop was a hidden N× latency multiplier.
        const operations: Promise<void>[] = [
            ...inlineToClear.map((index) => vectors.deleteByIds(index.name, [event.id])),
            ...inlineToUpsert.map((index) =>
                vectors.upsert(index.name, {
                    id: event.id,
                    input: String(row[index.field]),
                    embed: index.embed,
                    metadata: index.metadata ? pickMetadata(row, index.metadata) : undefined,
                    namespace,
                }),
            ),
            ...standaloneIndexes.map(([name, definition]) =>
                vectors.upsert(name, {
                    id: event.id,
                    input: definition.select(row),
                    embed: definition.embed,
                    metadata: definition.metadata?.(row),
                    namespace,
                }),
            ),
        ];

        try {
            await Promise.all(operations);
        } catch (error) {
            // Best-effort compensation: a partial fan-out leaves some indexes
            // mutated. Purge this row's id from every affected index so the
            // diverged state is at least empty rather than stale-but-present,
            // then surface the original failure to the write path.
            await Promise.allSettled(allIndexNames.map((name) => vectors.deleteByIds(name, [event.id])));

            throw error;
        }
    };
};
