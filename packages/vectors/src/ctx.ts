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
                returnMetadata: "all",
            });

            return {
                count: result.count,
                matches: result.matches.map((match) => ({ id: match.id, score: match.score, metadata: match.metadata })),
            };
        },
        getByIds: async (indexName: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorRecordLike>> => {
            const records = await cirrus.getByIds(indexName, ids);

            return records.map((record) => ({ id: record.id, values: record.values, metadata: record.metadata }));
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
 */
export const createVectorSyncHook = (options: { schema: SchemaLike; vectors: VectorSearchLike }): WriteHook => {
    const { schema, vectors } = options;

    return async (event: WriteEvent): Promise<void> => {
        const tableDefinition = schema.tables[event.table];
        const inlineIndexes = tableDefinition?.vectorIndexes ?? [];
        const standaloneIndexes = Object.entries(schema.vectorIndexes).filter(([, definition]) => definition.table === event.table);

        if (inlineIndexes.length === 0 && standaloneIndexes.length === 0) {
            return;
        }

        if (event.op === "delete") {
            // Each Vectorize index is independent: a delete on index A can't
            // observe a delete on index B, so the per-index calls run in
            // parallel rather than serially.
            await Promise.all([
                ...inlineIndexes.map((index) => vectors.deleteByIds(index.name, [event.id])),
                ...standaloneIndexes.map(([name]) => vectors.deleteByIds(name, [event.id])),
            ]);

            return;
        }

        const row = event.doc;

        if (!row) {
            return;
        }

        // Same per-index independence on the write path — fan the upserts out
        // and await as a group. Embedders may make remote calls, so the
        // serial loop was a hidden N× latency multiplier per write.
        await Promise.all([
            ...inlineIndexes
                .filter((index) => row[index.field] !== undefined && row[index.field] !== null)
                .map((index) =>
                    vectors.upsert(index.name, {
                        id: event.id,
                        input: String(row[index.field]),
                        embed: index.embed,
                        metadata: index.metadata ? pickMetadata(row, index.metadata) : undefined,
                    }),
                ),
            ...standaloneIndexes.map(([name, definition]) =>
                vectors.upsert(name, {
                    id: event.id,
                    input: definition.select(row),
                    embed: definition.embed,
                    metadata: definition.metadata?.(row),
                }),
            ),
        ]);
    };
};
